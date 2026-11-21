#!/usr/bin/env bash
# compat.sh — the LINEonLinux compatibility profile, shared by
# installer.sh, launch-line.sh, update.sh and diagnose.sh:
#   ・paths (~/.linewine layout)
#   ・DLL signing (LINE 26.x NO_SIGNATURE workaround)
#   ・font view (color emoji fonts hidden from Wine; they crash LINE)
#   ・registry profile (fonts, DPI, window/media fixes)
#   ・official-installer verification (LY Corporation signature)

LINEWINE_HOME="${LINEWINE_DIR:-$HOME/.linewine}"
PREFIX="${LINEWINE_PREFIX:-$LINEWINE_HOME/prefix}"
SIGNING_HOME="$LINEWINE_HOME/signing"
CACHE_DIR="$LINEWINE_HOME/cache"
STATE_DIR="$LINEWINE_HOME/state"
# Wine binary resolution: $LINEWINE_WINE override, else the pinned runner
# under ~/.linewine/runners/ (RUNNER_NAME in deps.sh — keep in sync), else
# a plain "wine" so pre-install diagnose still works.
WINE_BIN="wine"
WINESERVER_BIN="wineserver"
lw_resolve_wine() {
  if [[ -n "${LINEWINE_WINE:-}" ]]; then
    WINE_BIN="$LINEWINE_WINE"
  elif [[ -x "$LINEWINE_HOME/runners/wine-11.22-amd64/bin/wine" ]]; then
    WINE_BIN="$LINEWINE_HOME/runners/wine-11.22-amd64/bin/wine"
  else
    local d=""
    d=$(ls -d "$LINEWINE_HOME"/runners/wine-*-amd64 2>/dev/null | sort -V | tail -1 || true)
    if [[ -n "$d" && -x "$d/bin/wine" ]]; then WINE_BIN="$d/bin/wine"; else WINE_BIN="wine"; fi
  fi
  if [[ "$WINE_BIN" == */* && -x "$(dirname "$WINE_BIN")/wineserver" ]]; then
    WINESERVER_BIN="$(dirname "$WINE_BIN")/wineserver"
  else
    WINESERVER_BIN="wineserver"
  fi
  export WINE_BIN WINESERVER_BIN
}
lw_resolve_wine
SIGNING_PROFILE_VERSION=1
COMPAT_PROFILE_VERSION=2

# DPI (Wine LogPixels): $LINEWINE_DPI wins, else the value saved by
# `installer.sh --dpi`, else 120. The compat-profile marker includes the
# DPI, so changing it re-applies the registry profile on next launch.
lw_dpi() {
  local d="${LINEWINE_DPI:-}"
  if [[ -z "$d" && -f "$LINEWINE_HOME/dpi" ]]; then
    d=$(head -1 "$LINEWINE_HOME/dpi" 2>/dev/null || true)
  fi
  [[ "$d" =~ ^[0-9]+$ ]] || d=120
  if (( d < 48 || d > 480 )); then d=120; fi
  printf '%s' "$d"
}
compat_marker_path() {
  printf '%s/.linewine-compat-profile-%s-dpi%s' "$PREFIX" "$COMPAT_PROFILE_VERSION" "$(lw_dpi)"
}
KIT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
LINE_DIR="$PREFIX/drive_c/users/${USER:-$(id -un)}/AppData/Local/LINE"
LINE_LAUNCHER="$LINE_DIR/bin/LineLauncher.exe"

# Launcher registration — all per-user, nothing system-wide.
LAUNCHER_LINK="$HOME/.local/bin/line-wine"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/line-wine.desktop"
ICON_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps/line-wine.png"
LINE_INSTALLER_URL="https://desktop.line-scdn.net/win/new/LineInst.exe"

if ! declare -F log >/dev/null 2>&1; then
  log()  { printf '[>] %s\n' "$*"; }
  ok()   { printf '[✓] %s\n' "$*"; }
  warn() { printf '[!] %s\n' "$*" >&2; }
  die()  { printf '[✗] %s\n' "$*" >&2; exit 1; }
fi

export WINEPREFIX="$PREFIX"
export WINEDEBUG="${WINEDEBUG:--all}"

# ---------------------------------------------------------------- signing --
generate_compat_certificate() {
  local cert="$SIGNING_HOME/cert.pem" key="$SIGNING_HOME/key.pem"
  [[ -s "$cert" && -s "$key" ]] && return 0
  warn "Creating a LOCAL self-signed compatibility certificate (NOT issued by Microsoft)"
  mkdir -p "$SIGNING_HOME"
  chmod 0700 "$SIGNING_HOME"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$key" -out "$cert" -config "$KIT_DIR/signing.cnf" 2>/dev/null \
    || die "openssl failed to create the signing certificate"
  chmod 0600 "$key"
}

has_compat_signature() { # file
  local out current calculated
  out=$(osslsigncode verify -in "$1" 2>&1 || true)
  grep -Fq 'CN=Microsoft Windows' <<<"$out" || return 1
  current=$(awk '/Current message digest/{print $NF; exit}' <<<"$out")
  calculated=$(awk '/Calculated message digest/{print $NF; exit}' <<<"$out")
  [[ -n "$current" && "$current" == "$calculated" ]]
}

sign_one_dll() { # file
  local dll=$1 tmp="${1}.linewine.$$"
  has_compat_signature "$dll" && return 0
  if osslsigncode sign -certs "$SIGNING_HOME/cert.pem" -key "$SIGNING_HOME/key.pem" \
       -h sha256 -n 'Microsoft Windows' -in "$dll" -out "$tmp" >/dev/null 2>&1; then
    chmod --reference="$dll" "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$dll"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

critical_signatures_ok() {
  local dll path
  for dll in crypt32.dll winhttp.dll version.dll gdiplus.dll; do
    path="$PREFIX/drive_c/windows/system32/$dll"
    [[ -f "$path" ]] || continue
    has_compat_signature "$path" || return 1
  done
  [[ -f "$PREFIX/drive_c/windows/system32/crypt32.dll" ]] || return 1
  has_compat_signature "$PREFIX/drive_c/windows/system32/crypt32.dll"
}

signing_marker_path() { printf '%s/.linewine-signing-profile-%s' "$PREFIX" "$SIGNING_PROFILE_VERSION"; }

signing_is_current() {
  local marker; marker=$(signing_marker_path)
  [[ -f "$marker" ]] || return 1
  critical_signatures_ok || return 1
  ! find "$PREFIX/drive_c/windows/system32" "$PREFIX/drive_c/windows/syswow64" \
      -type f \( -iname '*.dll' -o -iname '*.drv' \) -newer "$marker" -print -quit 2>/dev/null | grep -q .
}

sign_wine_dlls() {
  command -v osslsigncode >/dev/null 2>&1 || die "osslsigncode is missing (run ./deps.sh)"
  [[ -f "$PREFIX/system.reg" ]] || die "No Wine prefix at $PREFIX (run ./installer.sh)"
  generate_compat_certificate
  if signing_is_current; then
    ok "Wine DLL signatures are already current"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  local failed_log="$STATE_DIR/signing-failures.txt"
  : > "$failed_log"
  # Wine may still be rewriting DLLs right after prefix creation or an
  # upgrade (pending renames land with old mtimes), so repeat until a
  # full pass signs nothing new (max 3 passes).
  local pass total_signed=0
  for pass in 1 2 3; do
    local signed_now=0 dll
    while IFS= read -r -d '' dll; do
      if has_compat_signature "$dll"; then
        :
      elif sign_one_dll "$dll"; then
        signed_now=$((signed_now + 1))
      else
        printf '%s\n' "$dll" >> "$failed_log"
      fi
    done < <(find "$PREFIX/drive_c/windows/system32" "$PREFIX/drive_c/windows/syswow64" \
               -type f \( -iname '*.dll' -o -iname '*.drv' \) -print0 2>/dev/null)
    total_signed=$((total_signed + signed_now))
    (( signed_now == 0 )) && break
  done
  critical_signatures_ok || die "Critical Wine DLLs are still unsigned (see $failed_log)"
  touch "$(signing_marker_path)"
  ok "DLL signing complete: $total_signed file(s) signed in $PREFIX"
  if [[ -s "$failed_log" ]]; then
    warn "Some non-critical files could not be signed; list: $failed_log"
  fi
}

# ------------------------------------------------------------- font view --
# LINE 26.x (Qt GDI font engine) crashes after login when it falls back
# to a color bitmap emoji font. Wine reads font dirs straight from
# fontconfig's cache and ignores <rejectfont>, so Wine gets a private
# directory of symlinks to every system font EXCEPT color fonts.
FONT_VIEW="$STATE_DIR/fonts"
export FONTCONFIG_FILE="$STATE_DIR/fontconfig.conf"

font_view_current() {
  [[ -f "$FONTCONFIG_FILE" && -f "$FONT_VIEW/.stamp" ]] || return 1
  local d
  for d in /usr/share/fonts /usr/local/share/fonts "${XDG_DATA_HOME:-$HOME/.local/share}/fonts" "$HOME/.fonts"; do
    [[ -d "$d" ]] && find "$d" -type d -newer "$FONT_VIEW/.stamp" -print -quit 2>/dev/null | grep -q . && return 1
  done
  return 0
}

ensure_font_view() {
  font_view_current && return 0
  command -v fc-list >/dev/null 2>&1 || { warn "fc-list not found; font view skipped"; return 0; }
  local tmp="$FONT_VIEW.new" f n=0
  rm -rf "$tmp"; mkdir -p "$tmp" "$STATE_DIR"
  while IFS= read -r f; do
    f=${f%: }; f=${f%:}
    [[ -f "$f" ]] || continue
    mkdir -p "$tmp$(dirname "$f")"
    ln -sfn "$f" "$tmp$f"
    n=$((n + 1))
  done < <(env -u FONTCONFIG_FILE fc-list ':color=False' file 2>/dev/null)
  if (( n == 0 )); then
    rm -rf "$tmp"
    warn "fontconfig listed no fonts; font view skipped"
    return 0
  fi
  touch "$tmp/.stamp"
  rm -rf "$FONT_VIEW"; mv "$tmp" "$FONT_VIEW"
  {
    printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
    printf '<!-- Generated by line-wine kit: system fonts minus color fonts, for Wine only. -->\n<fontconfig>\n'
    printf '  <dir>%s</dir>\n' "$FONT_VIEW"
    printf '  <cachedir>%s/linewine/fontconfig</cachedir>\n' "${XDG_CACHE_HOME:-$HOME/.cache}"
    local c
    for c in /etc/fonts/conf.d/*.conf; do
      [[ "$(basename "$c")" == 50-user.conf ]] || printf '  <include ignore_missing="yes">%s</include>\n' "$c"
    done
    printf '</fontconfig>\n'
  } > "$FONTCONFIG_FILE"
  fc-cache "$FONT_VIEW" >/dev/null 2>&1 || true
  log "Font view for Wine: $n fonts (color fonts left out)"
}

# -------------------------------------------------------- registry profile --
reg_add() { # key value type data
  "$WINE_BIN" reg add "$1" /v "$2" /t "$3" /d "$4" /f >/dev/null 2>&1 \
    || warn "reg add failed: $1 $2"
}

apply_registry_profile() {
  [[ -f "$PREFIX/system.reg" ]] || die "No Wine prefix at $PREFIX"
  local marker; marker=$(compat_marker_path)
  [[ -f "$marker" ]] && return 0
  log "Applying registry compat profile (fonts / DPI $(lw_dpi) / window / media)"

  # Font smoothing + DPI (default 120; override with installer --dpi or LINEWINE_DPI).
  reg_add 'HKCU\Control Panel\Desktop' FontSmoothing REG_SZ 2
  reg_add 'HKCU\Control Panel\Desktop' FontSmoothingType REG_DWORD 2
  reg_add 'HKCU\Control Panel\Desktop' FontSmoothingGamma REG_DWORD 1400
  reg_add 'HKCU\Control Panel\Desktop' FontSmoothingOrientation REG_DWORD 1
  reg_add 'HKCU\Control Panel\Desktop' LogPixels REG_DWORD "$(lw_dpi)"

  # Font replacements: Segoe UI Emoji must resolve to an outline font.
  local rep='HKCU\Software\Wine\Fonts\Replacements'
  reg_add "$rep" 'Segoe UI Emoji' REG_SZ 'Symbola'
  reg_add "$rep" 'Segoe UI' REG_SZ 'Noto Sans CJK JP'
  reg_add "$rep" 'Tahoma' REG_SZ 'Noto Sans CJK JP'
  reg_add "$rep" 'MS UI Gothic' REG_SZ 'Noto Sans CJK JP'
  reg_add "$rep" 'ＭＳ Ｐゴシック' REG_SZ 'Noto Sans CJK JP'

  # X11 driver: on Wayland/XWayland sessions Wine's EGL path can make the
  # LINE window transparent (Zenn Hyprland report). Force the X11 driver
  # with EGL off. LINEWINE_KEEP_WAYLAND=1 skips this.
  if [[ "${LINEWINE_KEEP_WAYLAND:-0}" != 1 ]]; then
    reg_add 'HKCU\Software\Wine\Drivers' Graphics REG_SZ 'x11'
    reg_add 'HKCU\Software\Wine\X11 Driver' UseEGL REG_SZ 'N'
  fi

  # LINE draws its own title bar; WM decorations make maximize hide it.
  reg_add 'HKCU\Software\Wine\AppDefaults\LINE.exe\X11 Driver' Decorated REG_SZ 'N'
  # MSVC runtime: Wine's msvcp140_2 lacks __std_smf_cyl_bessel_i, which
  # LINE's binaries call (first seen in LineMediaPlayer, but the same
  # abort fires inside the installer/LINE itself). Prefer the native
  # DLL bundled with LINE for every LINE executable.
  local exe
  for exe in LineMediaPlayer.exe LINE.exe LineLauncher.exe LineInst.exe; do
    reg_add "HKCU\\Software\\Wine\\AppDefaults\\$exe\\DllOverrides" msvcp140_2 REG_SZ 'native,builtin'
  done
  # Keep Wine from creating its own menu/desktop entries for this prefix.
  reg_add 'HKCU\Software\Wine\DllOverrides' winemenubuilder.exe REG_SZ ''

  touch "$marker"
  ok "Registry compat profile applied"
}

apply_user_folders() {
  # Point the Windows user folders at the real XDG folders so LINE
  # downloads never hide inside the prefix.
  local users="$PREFIX/drive_c/users/${USER:-$(id -un)}"
  [[ -d "$users" ]] || return 0
  local pair name target link
  local pairs=(Desktop:DESKTOP Documents:DOCUMENTS Downloads:DOWNLOAD Music:MUSIC Pictures:PICTURES Videos:VIDEOS)
  for pair in "${pairs[@]}"; do
    name=${pair%%:*}
    if command -v xdg-user-dir >/dev/null 2>&1; then
      target=$(xdg-user-dir "${pair#*:}" 2>/dev/null || true)
    fi
    [[ -n "${target:-}" && "$target" != "$HOME" && "$target" != "$HOME/" ]] || target="$HOME/$name"
    mkdir -p "$target"
    link="$users/$name"
    if [[ -L "$link" ]]; then
      [[ "$(readlink -f "$link")" == "$(readlink -f "$target")" ]] && continue
      rm -f "$link"
    elif [[ -d "$link" ]]; then
      find "$link" -mindepth 1 -maxdepth 1 -exec mv -n -t "$target" {} + 2>/dev/null || true
      rmdir "$link" 2>/dev/null || { warn "Kept $link (name clash in $target)"; continue; }
    fi
    ln -s "$target" "$link"
    log "$name in LINE -> $target"
  done
}

# ------------------------------------------------------- installer verify --
verify_line_installer() { # path
  local file=$1
  [[ "$(head -c2 "$file" 2>/dev/null)" == 'MZ' ]] || die "LINE installer is not a Windows executable"
  local out cur calc
  out=$(osslsigncode verify -in "$file" 2>&1 || true)
  cur=$(awk '/Current message digest/{print $NF; exit}' <<<"$out")
  calc=$(awk '/Calculated message digest/{print $NF; exit}' <<<"$out")
  [[ -n "$cur" && "$cur" == "$calc" ]] || die "LINE installer signature digest mismatch — refusing to run it"
  sed -n '/Signer #0:/,/Subject:/p' <<<"$out" | \
    grep -qE 'CN=(LY|LINE) Corporation' || die "LINE installer is not signed by LY Corporation — refusing to run it"
  ok "LINE installer verified: LY Corporation signature, sha256 $(sha256sum "$file" | cut -c1-16)..."
}

line_version() { # prints installed LINE version from LINE.exe PE info
  local exe="$LINE_DIR/bin/current/LINE.exe"
  [[ -f "$exe" ]] || return 0
  python3 -I - "$exe" <<'PY' 2>/dev/null || true
import struct, sys
data = open(sys.argv[1], "rb").read()
i = data.find(b"\xbd\x04\xef\xfe")
if i >= 0:
    ms, ls = struct.unpack_from("<II", data, i + 8)
    print(f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}")
PY
}
