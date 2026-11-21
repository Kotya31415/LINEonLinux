#!/usr/bin/env bash
# installer.sh — install the official Windows LINE into a dedicated Wine
# prefix (~/.linewine/prefix) with the compat profile applied.
#
#   ./installer.sh [--yes] [--reinstall] [--dpi N]
#   --dpi N: Wine DPI (LogPixels), default 120 (125%). 96 = 100%, 144 = 150%,
#   192 = 200%. Saved to ~/.linewine/dpi and used by launch/update too;
#   the LINEWINE_DPI env var overrides it per launch.
#
# Flow: deps -> prefix -> sign DLLs -> download+verify
# the official installer -> run it -> sign again -> registry/fonts ->
# launcher + desktop entry.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=deps.sh
source "$KIT_DIR/deps.sh"
# shellcheck source=compat.sh
source "$KIT_DIR/compat.sh"

REINSTALL=0
DPI_OPT=""
while (( $# )); do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --reinstall) REINSTALL=1 ;;
    --dpi) shift; DPI_OPT="${1:-}" ;;
    --dpi=*) DPI_OPT="${1#*=}" ;;
    *) printf 'usage: installer.sh [--yes] [--reinstall] [--dpi N]\n' >&2; exit 2 ;;
  esac
  shift
done

printf '========================================\n'
printf ' LINE on Wine — Installer\n'
printf '========================================\n'

(( EUID != 0 )) || die "Run as your normal user, not root/sudo"

if [[ -n "$DPI_OPT" ]]; then
  [[ "$DPI_OPT" =~ ^[0-9]+$ ]] && (( DPI_OPT >= 48 && DPI_OPT <= 480 )) \
    || die "--dpi needs a number between 48 and 480 (e.g. 96, 120, 144, 192)"
  mkdir -p "$LINEWINE_HOME"
  printf '%s\n' "$DPI_OPT" > "$LINEWINE_HOME/dpi"
  log "DPI set to $DPI_OPT (saved in $LINEWINE_HOME/dpi; env LINEWINE_DPI overrides it)"
fi

log "Checking environment"
ensure_tools
ensure_wine_runner
lw_resolve_wine
check_runner_libs
check_fonts
check_session
[[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] || die "No desktop session detected; run from a terminal on your desktop"

if [[ -f "$LINE_LAUNCHER" && "$REINSTALL" != 1 ]]; then
  ok "LINE is already installed ($(line_version)); it updates itself on launch"
  log "Refreshing compat profile and launcher only"
else
  # -- prefix --
  if [[ -f "$PREFIX/system.reg" && ! -f "$PREFIX/drive_c/windows/syswow64/ntdll.dll" && ! -d "$LINE_DIR" ]]; then
    warn "Existing prefix has no 32-bit support (LINE's installer is 32-bit); recreating it"
    "$WINESERVER_BIN" -k 2>/dev/null || true
    rm -rf "$PREFIX"
  fi
  if [[ ! -f "$PREFIX/system.reg" ]]; then
    log "Creating Wine prefix: $PREFIX"
    mkdir -p "$PREFIX"
    WINEARCH=win64 WINEDLLOVERRIDES="mscoree,mshtml=;winemenubuilder.exe=d" \
      "$WINE_BIN" wineboot -i >/dev/null 2>&1 || true
    "$WINESERVER_BIN" -w 2>/dev/null || true
  fi
  [[ -f "$PREFIX/drive_c/windows/syswow64/ntdll.dll" ]] || die "Prefix has no 32-bit support (syswow64 is empty). On Debian/Ubuntu install wine32:i386; otherwise use WineHQ builds, then run this again."

  # -- sign before installing --
  # LINE's installer itself already checks DLL signatures.
  ensure_font_view
  log "Signing Wine DLLs (LINE 26.x signature check)"
  sign_wine_dlls

  # -- compat profile BEFORE installing --
  # The registry profile must already be in place while the installer
  # runs: the msvcp140_2 override and the X11/EGL settings apply to the
  # installer's own processes too (an unimplemented msvcp140_2 call
  # aborts them otherwise). The calls after the install are no-ops then.
  apply_registry_profile
  apply_user_folders

  # -- download LINE --
  mkdir -p "$CACHE_DIR"
  INSTALLER_EXE=""
  if [[ -n "${LINE_INSTALLER:-}" && -f "${LINE_INSTALLER:-}" ]]; then
    INSTALLER_EXE="$LINE_INSTALLER"
  elif [[ -f "$HOME/Downloads/LineInst.exe" ]]; then
    INSTALLER_EXE="$HOME/Downloads/LineInst.exe"
    log "Using installer found in ~/Downloads"
  elif [[ -f "$CACHE_DIR/LineInst.exe" ]]; then
    INSTALLER_EXE="$CACHE_DIR/LineInst.exe"
    log "Using cached installer: $INSTALLER_EXE"
  else
    log "Downloading the official LINE installer"
    eff=$(curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fL --retry 3 \
            --connect-timeout 15 --max-filesize 52428800 \
            -w '%{url_effective}' -o "$CACHE_DIR/LineInst.exe" "$LINE_INSTALLER_URL") \
      || die "Download failed: $LINE_INSTALLER_URL"
    host=${eff#*://}; host=${host%%/*}; host=${host%%:*}
    case "$host" in
      line-scdn.net|*.line-scdn.net) ;;
      *) rm -f "$CACHE_DIR/LineInst.exe"; die "Download redirected outside LINE's CDN: $eff" ;;
    esac
    INSTALLER_EXE="$CACHE_DIR/LineInst.exe"
  fi
  verify_line_installer "$INSTALLER_EXE"

  # -- run installer --
  log "Starting the official LINE installer — click through it"
  log "Note: the installer usually launches LINE when it finishes. Close LINE's window so this script can complete the remaining steps."
  WINEDLLOVERRIDES="winemenubuilder.exe=d" "$WINE_BIN" "$INSTALLER_EXE" || true
  # The installer usually auto-launches LINE, and an unbounded
  # `wineserver -w` then waits forever — the setup used to hang here
  # and never reach the launcher registration. Bound the wait; the
  # remaining steps are safe either way, and launch-line.sh re-checks
  # DLL signatures on the next start regardless.
  log "Waiting briefly for Wine processes to settle (close LINE if it opened)"
  timeout "${LINEWINE_SETTLE_TIMEOUT:-90}" "$WINESERVER_BIN" -w 2>/dev/null \
    || warn "LINE seems to still be running — continuing anyway. If anything looks off, close LINE and run ./installer.sh once more."

  for _ in $(seq 1 60); do
    [[ -f "$LINE_LAUNCHER" ]] && break
    sleep 1
  done
  [[ -f "$LINE_LAUNCHER" ]] || die "LINE's installer closed before LINE was installed. Run ./installer.sh again to retry."

  # The installer starts LINE, which may make Wine rewrite DLLs again.
  log "Re-checking DLL signatures after install"
  sign_wine_dlls
fi

# -- compat profile --
ensure_font_view
apply_registry_profile
apply_user_folders

# -- deploy launcher --
APP_DIR="$LINEWINE_HOME/app"
log "Installing launcher into $APP_DIR"
mkdir -p "$APP_DIR" "$HOME/.local/bin"
cp -f "$KIT_DIR/launch-line.sh" "$KIT_DIR/compat.sh" "$KIT_DIR/line-window-fix.py" "$KIT_DIR/signing.cnf" \
      "$KIT_DIR/diagnose.sh" "$KIT_DIR/uninstall.sh" "$APP_DIR/"
chmod +x "$APP_DIR/launch-line.sh" "$APP_DIR/diagnose.sh" "$APP_DIR/uninstall.sh"
ln -sfn "$APP_DIR/launch-line.sh" "$HOME/.local/bin/line-wine"

ICON_DST="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
mkdir -p "$ICON_DST"
ICON_SRC="$LINE_DIR/bin/current/assets/Square44x44Logo.targetsize-256.png"
if [[ -f "$ICON_SRC" ]]; then
  cp -f "$ICON_SRC" "$ICON_DST/line-wine.png"
fi

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/line-wine.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=LINE (Wine)
Comment=LINE messenger — official Windows version under Wine
Exec=$HOME/.local/bin/line-wine
Icon=line-wine
Categories=Network;InstantMessaging;
StartupNotify=true
StartupWMClass=line.exe
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null || true

printf '\n'
ok "Done. Start LINE from the app menu (LINE (Wine)) or run: line-wine"
log "Log in with QR code or email. If you are logged out on every start, use email + password with 'keep me logged in'."
log "Data: prefix $PREFIX — chats live there; back it up before experiments."
