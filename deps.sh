#!/usr/bin/env bash
# deps.sh — dependencies for running the official Windows LINE on Linux.
#
# Wine itself is NOT installed from the distro: a pinned
# portable Wine build is downloaded from Kron4ek/Wine-Builds, verified by
# SHA-256, and placed under ~/.linewine/runners/. The distro package
# manager is only used for small tools (osslsigncode, openssl, curl,
# python3, xz) and CJK fonts, and only after an explicit confirmation
# (or ASSUME_YES=1 / --yes). Host libraries the runner needs are
# reported and, like tools and fonts, offered for installation after
# confirmation — never installed silently; unmapped sonames are report-only.
#
# Can be sourced (functions only) or executed directly:
#   ./deps.sh           check + offer to fetch/install what is missing
#   ./deps.sh --check   check only, never install
#   ./deps.sh --yes     install without asking

# --- Pinned portable Wine (Kron4ek vanilla build; NOT the Proton fork) ---
RUNNER_NAME="wine-11.22-amd64"
RUNNER_VERSION="11.22"
RUNNER_URL="https://github.com/Kron4ek/Wine-Builds/releases/download/11.22/wine-11.22-amd64.tar.xz"
RUNNER_SHA256="cdaaa76c218359d486eb35968892a4c466623b137ed0931ee3f31465ec6539e0"
RUNNER_SIZE_MB=96
# Minimum Wine: LINE's installer stalls at 1% on Wine < 9.
MIN_WINE_MAJOR=9

LINEWINE_HOME="${LINEWINE_DIR:-$HOME/.linewine}"
RUNNERS_HOME="$LINEWINE_HOME/runners"
RUNNER_DIR="$RUNNERS_HOME/$RUNNER_NAME"
RUNNER_WINE="$RUNNER_DIR/bin/wine"

if ! declare -F log >/dev/null 2>&1; then
  log()  { printf '[>] %s\n' "$*"; }
  ok()   { printf '[✓] %s\n' "$*"; }
  warn() { printf '[!] %s\n' "$*" >&2; }
  die()  { printf '[✗] %s\n' "$*" >&2; exit 1; }
fi

ASSUME_YES="${ASSUME_YES:-0}"

confirm() { # confirm "question"
  [[ "$ASSUME_YES" == 1 ]] && return 0
  [[ -t 0 ]] || return 1
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" == [yY] || "$ans" == [yY][eE][sS] ]]
}

detect_distro() { # echoes: fedora|debian|arch|suse|unknown
  local id="" like=""
  if [[ -r /etc/os-release ]]; then
    id=$(. /etc/os-release; printf '%s' "${ID:-}")
    like=$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")
  fi
  case " $id $like " in
    *" fedora "*|*" rhel "*|*" centos "*) printf 'fedora' ;;
    *" debian "*|*" ubuntu "*)           printf 'debian' ;;
    *" arch "*|*" cachyos "*|*" manjaro "*) printf 'arch' ;;
    *" suse "*|*" opensuse "*)           printf 'suse' ;;
    *) printf 'unknown' ;;
  esac
}

run_priv() { # run_priv cmd...
  if (( EUID == 0 )); then "$@"; else sudo "$@"; fi
}

# The wine binary this kit uses: $LINEWINE_WINE override, else the runner.
kit_wine() {
  if [[ -n "${LINEWINE_WINE:-}" ]]; then printf '%s' "$LINEWINE_WINE"
  elif [[ -x "$RUNNER_WINE" ]]; then printf '%s' "$RUNNER_WINE"
  else return 1; fi
}

wine_major_of() { # wine-binary
  local v
  v=$("$1" --version 2>/dev/null) || return 1
  v=${v#wine-}
  v=${v%%.*}
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$v"
}

ensure_wine_runner() {
  if [[ -n "${LINEWINE_WINE:-}" ]]; then
    local major
    major=$(wine_major_of "$LINEWINE_WINE") || die "LINEWINE_WINE=$LINEWINE_WINE does not run"
    (( major >= MIN_WINE_MAJOR )) || die "LINEWINE_WINE is Wine $major (< $MIN_WINE_MAJOR); LINE's installer needs >= $MIN_WINE_MAJOR"
    ok "Wine (override): $("$LINEWINE_WINE" --version) at $LINEWINE_WINE"
    return 0
  fi
  if [[ -x "$RUNNER_WINE" ]]; then
    ok "Wine runner present: $("$RUNNER_WINE" --version) ($RUNNER_DIR)"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || die "curl is required to download the Wine runner"
  command -v xz >/dev/null 2>&1 || die "xz is required to extract the Wine runner (install the xz package first)"
  confirm "Download portable Wine $RUNNER_VERSION (about ${RUNNER_SIZE_MB} MB) from GitHub (Kron4ek/Wine-Builds) into $RUNNERS_HOME?" \
    || die "Wine runner is required. Re-run and accept the download, or set LINEWINE_WINE to your own Wine >= $MIN_WINE_MAJOR."

  local cache="$LINEWINE_HOME/cache"
  local archive="$cache/$RUNNER_NAME.tar.xz"
  mkdir -p "$cache" "$RUNNERS_HOME"
  log "Downloading Wine $RUNNER_VERSION from GitHub"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL --retry 3 \
    --connect-timeout 15 -o "$archive" "$RUNNER_URL" || die "Runner download failed"

  local got
  got=$(sha256sum "$archive" | awk '{print $1}')
  [[ "$got" == "$RUNNER_SHA256" ]] || die "Runner SHA-256 mismatch. Expected $RUNNER_SHA256, got $got — refusing to use it"
  ok "Runner SHA-256 verified"

  local tmp="$cache/runner-extract.$$"
  rm -rf "$tmp"; mkdir -p "$tmp"
  tar -xJf "$archive" -C "$tmp" --no-same-owner || die "Runner extraction failed"
  local root
  root=$(find "$tmp" -maxdepth 3 -type f -path '*/bin/wine' -print -quit)
  [[ -n "$root" ]] || die "Downloaded runner does not contain bin/wine"
  root=${root%/bin/wine}
  rm -rf "$RUNNER_DIR"
  mv "$root" "$RUNNER_DIR"
  rm -rf "$tmp"
  [[ -x "$RUNNER_WINE" ]] || die "Runner installation failed"
  local major
  major=$(wine_major_of "$RUNNER_WINE") || die "Installed runner does not run (missing host libraries? see check_runner_libs)"
  (( major >= MIN_WINE_MAJOR )) || die "Runner Wine $major is unexpectedly < $MIN_WINE_MAJOR"
  ok "Wine runner installed: $("$RUNNER_WINE" --version)"
}

runner_missing_libs() { # echoes "ARCH:SONAME" lines (ARCH = 64 | 32)
  # bin/wine + bin/wineserver only need glibc; the real requirements
  # live in the unix-side driver modules — winex11.so (display/input)
  # and winepulse.so (call audio) — so check those too, both widths.
  # (On a system without a 32-bit loader, ldd on the i386 modules just
  # errors and contributes nothing.)
  local wine; wine=$(kit_wine) || return 0
  local bindir root; bindir=$(dirname "$wine"); root=$(dirname "$bindir")
  local missing="" f
  for f in "$wine" "$bindir/wineserver" \
           "$root/lib/wine/x86_64-unix/winex11.so" \
           "$root/lib/wine/x86_64-unix/winepulse.so"; do
    [[ -e "$f" ]] || continue
    missing+=$(ldd "$f" 2>/dev/null | awk '/not found/{print "64:" $1}' || true)
    missing+=$'\n'
  done
  for f in "$root/lib/wine/i386-unix/winex11.so" \
           "$root/lib/wine/i386-unix/winepulse.so"; do
    [[ -e "$f" ]] || continue
    missing+=$(ldd "$f" 2>/dev/null | awk '/not found/{print "32:" $1}' || true)
    missing+=$'\n'
  done
  printf '%s' "$missing" | sort -u | grep -v '^$' || true
}

# lib_pkg_for SONAME DISTRO [ARCH] -> install spec for the providing
# package (empty = no known mapping; Fedora resolves sonames via dnf
# provides — plain soname = 32-bit, soname()(64bit) = 64-bit).
lib_pkg_for() {
  local so="$1" distro="$2" arch="${3:-64}"
  local p=""
  case "$distro:$so" in
    debian:libX11.so.6) p=libx11-6 ;;        debian:libxcb.so.1) p=libxcb1 ;;
    debian:libXext.so.6) p=libxext6 ;;       debian:libXrender.so.1) p=libxrender1 ;;
    debian:libXrandr.so.2) p=libxrandr2 ;;   debian:libXi.so.6) p=libxi6 ;;
    debian:libXcursor.so.1) p=libxcursor1 ;; debian:libXxf86vm.so.1) p=libxxf86vm1 ;;
    debian:libfreetype.so.6) p=libfreetype6 ;;
    debian:libfontconfig.so.1) p=libfontconfig1 ;;
    debian:libz.so.1) p=zlib1g ;;            debian:libGL.so.1) p=libgl1 ;;
    debian:libudev.so.1) p=libudev1 ;;       debian:libvulkan.so.1) p=libvulkan1 ;;
    debian:libdbus-1.so.3) p=libdbus-1-3 ;;  debian:libpulse.so.0) p=libpulse0 ;;
    debian:libasound.so.2) p=libasound2 ;;   debian:libpng16.so.16) p=libpng16-16 ;;
    arch:libX11.so.6) p=libx11 ;;            arch:libxcb.so.1) p=libxcb ;;
    arch:libXext.so.6) p=libxext ;;          arch:libXrender.so.1) p=libxrender ;;
    arch:libXrandr.so.2) p=libxrandr ;;      arch:libXi.so.6) p=libxi ;;
    arch:libXcursor.so.1) p=libxcursor ;;    arch:libXxf86vm.so.1) p=libxxf86vm ;;
    arch:libfreetype.so.6) p=freetype2 ;;    arch:libfontconfig.so.1) p=fontconfig ;;
    arch:libz.so.1) p=zlib ;;                arch:libGL.so.1) p=libglvnd ;;
    arch:libudev.so.1) p=systemd-libs ;;     arch:libvulkan.so.1) p=vulkan-icd-loader ;;
    arch:libdbus-1.so.3) p=dbus ;;           arch:libpulse.so.0) p=libpulse ;;
    arch:libasound.so.2) p=alsa-lib ;;       arch:libpng16.so.16) p=libpng ;;
  esac
  case "$distro" in
    fedora)
      # dnf resolves sonames directly: plain = 32-bit, ()(64bit) = 64-bit.
      if [[ "$arch" == 32 ]]; then printf '%s' "$so"; else printf '%s()(64bit)' "$so"; fi ;;
    debian)
      [[ -z "$p" ]] && return 0
      if [[ "$arch" == 32 ]]; then printf '%s:i386' "$p"; else printf '%s' "$p"; fi ;;
    arch)
      # 32-bit package names (lib32-*) vary too much; report-only.
      [[ "$arch" == 32 ]] && return 0
      printf '%s' "$p" ;;
    *) printf '' ;;
  esac
}

pkg_install() { # DISTRO PKG... — the one place packages get installed
  local distro="$1"; shift
  case "$distro" in
    fedora) run_priv dnf install -y "$@" ;;
    debian) run_priv apt-get update && run_priv apt-get install -y "$@" ;;
    arch)   run_priv pacman -S --needed --noconfirm "$@" ;;
    suse)   run_priv zypper --non-interactive install "$@" ;;
    *) return 1 ;;
  esac
}

check_runner_libs() {
  # Missing host libraries for the runner binaries are reported, and —
  # like tools and fonts — offered for installation after confirmation.
  # Nothing is installed silently, and an unknown soname is only ever
  # reported (its package name differs too much across distros to guess).
  local missing; missing=$(runner_missing_libs)
  if [[ -z "$missing" ]]; then
    ok "Runner host libraries: all resolved"
    return 0
  fi
  warn "Host libraries missing for the Wine runner:"
  local distro; distro=$(detect_distro)
  local pkgs=() unmapped=() line arch so spec
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    arch=${line%%:*}; so=${line#*:}
    if [[ "$arch" == 32 ]]; then printf '      %s (32-bit)\n' "$so" >&2; else printf '      %s\n' "$so" >&2; fi
    spec=$(lib_pkg_for "$so" "$distro" "$arch")
    if [[ -n "$spec" ]]; then pkgs+=("$spec"); else unmapped+=("$so ($arch-bit)"); fi
  done <<< "$missing"
  if (( ${#pkgs[@]} )) \
     && confirm "Install the packages providing the missing libraries (${pkgs[*]})?"; then
    pkg_install "$distro" "${pkgs[@]}" || warn "Package installation failed"
    hash -r
    missing=$(runner_missing_libs)
    if [[ -z "$missing" ]]; then
      ok "Runner host libraries: all resolved (after install)"
      return 0
    fi
    warn "Still missing after install:"
    printf '%s\n' "$missing" | sed -e 's/^64:/      /' -e 's/^32:/      /' >&2
  fi
  if (( ${#unmapped[@]} )); then
    warn "No known package for: ${unmapped[*]} — install the providing package with your package manager"
  fi
  warn "Continuing anyway; if Wine does not start, install the libraries above first"
}

# pkg_for TOOL DISTRO -> package name (empty = not in distro repos)
pkg_for() {
  case "$1:$2" in
    osslsigncode:fedora) printf 'osslsigncode' ;;
    osslsigncode:debian) printf 'osslsigncode' ;;
    osslsigncode:suse)   printf 'osslsigncode' ;;
    osslsigncode:arch)   printf '' ;; # AUR only
    openssl:*)           printf 'openssl' ;;
    curl:*)              printf 'curl' ;;
    xz:*)                printf 'xz' ;;
    python3:fedora)      printf 'python3' ;;
    python3:debian)      printf 'python3' ;;
    python3:arch)        printf 'python' ;;
    python3:suse)        printf 'python3' ;;
    *)                   printf '' ;;
  esac
}

ensure_tools() {
  local distro; distro=$(detect_distro)
  local missing=() tool pkg
  for tool in osslsigncode openssl curl python3 xz; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if (( ${#missing[@]} == 0 )); then
    ok "Tools detected: osslsigncode, openssl, curl, python3, xz"
    return 0
  fi
  warn "Missing tools: ${missing[*]}"
  local pkgs=() aur=()
  for tool in "${missing[@]}"; do
    pkg=$(pkg_for "$tool" "$distro")
    if [[ -n "$pkg" ]]; then pkgs+=("$pkg"); else aur+=("$tool"); fi
  done
  if (( ${#pkgs[@]} )); then
    confirm "Install packages (${pkgs[*]})?" || die "Install the missing tools yourself: ${missing[*]}"
    pkg_install "$distro" "${pkgs[@]}" || die "Unsupported distro for automatic installs"
    hash -r
  fi
  if (( ${#aur[@]} )); then
    warn "These are not in your distro's repos: ${aur[*]} (Arch: AUR, e.g. 'paru -S osslsigncode')"
  fi
  for tool in "${missing[@]}"; do
    command -v "$tool" >/dev/null 2>&1 || die "Still missing: $tool"
  done
  ok "Tools installed"
}

has_font() { # family-name — fc-list, with fc-match as a second opinion.
  # Always measure the HOST font set: FONTCONFIG_FILE points at Wine's
  # filtered view, which is derived from the host fonts (and may not
  # exist yet during install), so it must not filter this check.
  # NOTE: `grep PATTERN >/dev/null`, never `grep -q`, on these pipes:
  # grep -q exits at the first match, fc-list then dies with SIGPIPE,
  # and under pipefail the pipeline reports failure despite the match
  # (this made Noto CJK "not found" on Fedora for a long time).
  env -u FONTCONFIG_FILE fc-list 2>/dev/null | grep -i "$1" >/dev/null && return 0
  command -v fc-match >/dev/null 2>&1 \
    && env -u FONTCONFIG_FILE fc-match "$1" 2>/dev/null | grep -i "$1" >/dev/null
}

check_fonts() {
  # Hard requirement: a CJK font, or chats render as tofu.
  # Soft requirement: Symbola — LINE's emoji replacement target (color emoji
  # fonts crash LINE after login; see compat.sh font view).
  local distro; distro=$(detect_distro)
  if ! command -v fc-list >/dev/null 2>&1; then
    warn "fontconfig (fc-list) not found; font checks skipped"
    return 0
  fi
  if has_font 'Noto Sans CJK'; then
    ok "Noto Sans CJK detected"
  else
    warn "Noto Sans CJK not found — Japanese text in LINE will be tofu"
    local pkg=""
    case "$distro" in
      fedora) pkg=google-noto-sans-cjk-fonts ;;
      debian) pkg=fonts-noto-cjk ;;
      arch)   pkg=noto-fonts-cjk ;;
      suse)   pkg=noto-sans-cjk-fonts ;;
    esac
    if [[ -n "$pkg" ]] && confirm "Install CJK font package ($pkg)?"; then
      pkg_install "$distro" "$pkg" || warn "Font package installation failed"
    fi
  fi
  if has_font 'Symbola'; then
    ok "Symbola detected (emoji fallback)"
  else
    warn "Symbola not found — emoji may show as boxes. Package: Fedora gdouros-symbola-fonts / Debian fonts-symbola / Arch AUR ttf-symbola"
  fi
}

check_session() {
  if [[ -n "${DISPLAY:-}" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    ok "Desktop session: type=${XDG_SESSION_TYPE:-unknown} DISPLAY=${DISPLAY:-unset} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-unset}"
  else
    warn "No DISPLAY/WAYLAND_DISPLAY — run the installer from a desktop terminal"
  fi
  [[ "$(uname -m)" == x86_64 ]] || warn "This kit targets x86_64 (detected: $(uname -m))"
  (( EUID != 0 )) || warn "Running as root is not recommended; Wine prefixes should belong to your user"
}

deps_main() {
  local check_only=0
  for a in "$@"; do
    case "$a" in
      --check) check_only=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      *) printf 'usage: deps.sh [--check] [--yes]\n' >&2; return 2 ;;
    esac
  done
  if (( check_only )); then
    local rc=0
    if [[ -n "${LINEWINE_WINE:-}" ]]; then
      ok "wine (override): $("${LINEWINE_WINE}" --version 2>/dev/null || echo 'does not run')"
    elif [[ -x "$RUNNER_WINE" ]]; then
      ok "wine runner: $("$RUNNER_WINE" --version 2>/dev/null) at $RUNNER_DIR"
    else
      warn "wine runner: not downloaded yet (installer.sh will fetch it, ~${RUNNER_SIZE_MB} MB)"; rc=1
    fi
    for t in osslsigncode openssl curl python3 xz; do
      command -v "$t" >/dev/null 2>&1 && ok "$t: present" || { warn "$t: missing"; rc=1; }
    done
    check_fonts
    check_session
    return $rc
  fi
  ensure_tools
  ensure_wine_runner
  check_runner_libs
  check_fonts
  check_session
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  deps_main "$@"
fi
