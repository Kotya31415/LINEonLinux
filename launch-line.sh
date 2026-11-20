#!/usr/bin/env bash
# launch-line.sh — start LINE from the dedicated Wine prefix.
# Re-signs Wine DLLs first if a Wine upgrade made the signatures stale.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
if [[ -f "$SELF_DIR/compat.sh" ]]; then
  # shellcheck source=compat.sh
  source "$SELF_DIR/compat.sh"
elif [[ -f "${LINEWINE_DIR:-$HOME/.linewine}/app/compat.sh" ]]; then
  # shellcheck source=/dev/null
  source "${LINEWINE_DIR:-$HOME/.linewine}/app/compat.sh"
else
  printf '[✗] compat.sh not found (looked in %s and ~/.linewine/app)\n' "$SELF_DIR" >&2
  exit 1
fi

[[ -f "$LINE_LAUNCHER" ]] || die "LINE is not installed in $PREFIX — run ./installer.sh first"

ensure_font_view
apply_registry_profile
apply_user_folders

if ! signing_is_current; then
  log "Wine DLL signatures are stale (Wine update?) — re-signing"
  if ! sign_wine_dlls >"$STATE_DIR/last-sign.log" 2>&1; then
    cat "$STATE_DIR/last-sign.log" >&2
    die "Re-signing failed; see $STATE_DIR/last-sign.log"
  fi
fi

# ------------------------------------------------------- Japanese input --
# Wine's X11 driver receives Japanese text through XIM, which needs:
#   1. a Japanese locale for the Wine process (XIM won't engage under C)
#   2. XMODIFIERS pointing at the host IME (@im=ibus / @im=fcitx)
# Both are set here, process-locally, and only when not already set.
# Opt out entirely with LINEWINE_NO_IME_ENV=1.
if [[ "${LINEWINE_NO_IME_ENV:-0}" != 1 ]]; then
  if [[ "${LC_ALL:-}" != ja_JP* && "${LANG:-}" != ja_JP* ]]; then
    if locale -a 2>/dev/null | grep -i 'ja_JP' >/dev/null; then
      export LC_ALL=ja_JP.UTF-8
    else
      warn "ja_JP locale not found on this system — Japanese input may not work (Fedora: glibc-langpack-ja)"
    fi
  fi
  if [[ -z "${XMODIFIERS:-}" ]]; then
    if pgrep -f 'fcitx' >/dev/null 2>&1; then
      export XMODIFIERS=@im=fcitx
    elif pgrep -f 'ibus-daemon' >/dev/null 2>&1; then
      export XMODIFIERS=@im=ibus
    else
      warn "No IBus/fcitx process found — Japanese input needs one of them running"
    fi
  fi
fi

# Force Wine's X11 driver path through XWayland on Wayland sessions: the
# native path can render LINE transparent (see compat.sh registry notes).
# Opt out with LINEWINE_KEEP_WAYLAND=1.
if [[ "${LINEWINE_KEEP_WAYLAND:-0}" != 1 ]]; then
  unset WAYLAND_DISPLAY
fi

cd "$LINE_DIR/bin"
exec "$WINE_BIN" LineLauncher.exe "$@"
