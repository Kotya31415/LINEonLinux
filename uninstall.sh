#!/usr/bin/env bash
# line-wine — uninstaller
#
#   ./uninstall.sh           remove ONLY the launcher registration
#                            (symlink, desktop entry, icon). The prefix,
#                            chats, login, runner and signing files stay,
#                            so a later ./installer.sh brings the menu
#                            entry back in seconds.
#   ./uninstall.sh --purge   additionally delete all of ~/.linewine —
#                            prefix (including chat data and login),
#                            Wine runner, certificate and caches.
#                            Asks for confirmation unless --yes.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
# shellcheck source=deps.sh
source "$KIT_DIR/deps.sh"
# shellcheck source=compat.sh
source "$KIT_DIR/compat.sh"

PURGE=0
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --purge) PURGE=1 ;;
    *) printf 'usage: uninstall.sh [--purge] [--yes]\n' >&2; exit 2 ;;
  esac
done

(( EUID != 0 )) || die "Run as your normal user, not root/sudo"

printf '========================================\n'
printf ' LINE on Wine — Uninstaller\n'
printf '========================================\n'

# Stop a running watcher so it does not linger after removal.
if [[ -f "$STATE_DIR/window-fix.pid" ]]; then
  pid=$(cat "$STATE_DIR/window-fix.pid" 2>/dev/null || true)
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    log "Stopped the window watcher"
  fi
  rm -f "$STATE_DIR/window-fix.pid"
fi

removed=0
for f in "$LAUNCHER_LINK" "$DESKTOP_FILE" "$ICON_FILE"; do
  if [[ -e "$f" || -L "$f" ]]; then
    rm -f "$f"
    log "Removed: $f"
    removed=1
  fi
done
(( removed )) || log "Launcher registration was not present"
command -v update-desktop-database >/dev/null 2>&1 \
  && update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true
ok "Launcher registration removed (app menu entry, line-wine command, icon)"

if (( PURGE )); then
  warn "This deletes ALL of $LINEWINE_HOME:"
  warn "  the Wine prefix INCLUDING chat data and your LINE login,"
  warn "  the downloaded Wine runner, the signing certificate and caches."
  warn "LINE chats are not restored by logging in again on desktop."
  confirm "Really delete everything?" || die "Aborted — nothing deleted"
  lw_resolve_wine
  "$WINESERVER_BIN" -k 2>/dev/null || true
  rm -rf "$LINEWINE_HOME"
  ok "Deleted $LINEWINE_HOME"
  log "System packages installed by the kit (e.g. osslsigncode, fonts) were left as they are."
else
  log "Kept: $LINEWINE_HOME (prefix, chats, runner). Re-register any time with ./installer.sh"
  log "To remove everything including chat data: ./uninstall.sh --purge"
fi
