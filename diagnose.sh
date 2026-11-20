#!/usr/bin/env bash
# diagnose.sh — print the state of the LINE-on-Wine install for support.
# Read-only: it never installs, signs, or changes anything.
DIAG_VERSION="0.2.5"

SELF_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
if [[ -f "$SELF_DIR/compat.sh" ]]; then
  # shellcheck source=compat.sh
  source "$SELF_DIR/compat.sh"
elif [[ -f "${LINEWINE_DIR:-$HOME/.linewine}/app/compat.sh" ]]; then
  # shellcheck source=/dev/null
  source "${LINEWINE_DIR:-$HOME/.linewine}/app/compat.sh"
else
  printf 'compat.sh not found\n' >&2
  exit 1
fi

yn() { if "$@" >/dev/null 2>&1; then printf 'ok'; else printf 'MISSING'; fi; }

printf 'line-wine diagnose %s\n' "$DIAG_VERSION"
printf 'Date:          %s\n' "$(date -Is)"
printf 'Distro:        %s\n' "$(. /etc/os-release 2>/dev/null; printf '%s %s' "${ID:-?}" "${VERSION_ID:-}")"
printf 'Session:       type=%s DISPLAY=%s WAYLAND_DISPLAY=%s\n' "${XDG_SESSION_TYPE:-?}" "${DISPLAY:-unset}" "${WAYLAND_DISPLAY:-unset}"
WINE_VER="not found"
[[ -x "$WINE_BIN" || "$WINE_BIN" == wine ]] && WINE_VER=$("$WINE_BIN" --version 2>/dev/null || echo 'not found')
OSSL_VER="not found"
command -v osslsigncode >/dev/null 2>&1 && OSSL_VER=$(osslsigncode --version 2>&1 | head -1)
printf 'Wine:          %s\n' "$WINE_VER"
printf 'Wine binary:   %s\n' "$WINE_BIN"
printf 'osslsigncode:  %s\n' "$OSSL_VER"
printf 'Prefix:        %s\n' "$PREFIX"
printf 'LINE launcher: %s (%s)\n' "$(yn test -f "$LINE_LAUNCHER")" "$LINE_LAUNCHER"
printf 'LINE version:  %s\n' "$(line_version || true)"
printf 'Certificate:   %s (%s)\n' "$(yn test -s "$SIGNING_HOME/cert.pem")" "$SIGNING_HOME/cert.pem"
if signing_is_current; then
  printf 'DLL signatures: ok (current)\n'
else
  printf 'DLL signatures: STALE or unsigned (next launch re-signs; or run update.sh)\n'
fi
printf 'Font view:     %s (%s fonts)\n' "$(yn font_view_current)" "$(find "$FONT_VIEW" -type l 2>/dev/null | wc -l)"
has_font() { env -u FONTCONFIG_FILE fc-list 2>/dev/null | grep -i "$1" >/dev/null && return 0; command -v fc-match >/dev/null 2>&1 && env -u FONTCONFIG_FILE fc-match "$1" 2>/dev/null | grep -i "$1" >/dev/null; }
printf 'Noto CJK font: %s\n' "$(has_font 'Noto Sans CJK' && echo ok || echo MISSING)"
printf 'Symbola font:  %s\n' "$(has_font 'Symbola' && echo ok || echo 'MISSING (emoji may be boxes)')"
printf 'DPI:           %s (LogPixels; LINEWINE_DPI > ~/.linewine/dpi > 120)\n' "$(lw_dpi)"
ime_detected="none (Japanese input needs IBus or fcitx running)"
pgrep -f 'fcitx' >/dev/null 2>&1 && ime_detected="fcitx"
pgrep -f 'ibus-daemon' >/dev/null 2>&1 && ime_detected="ibus"
printf 'IME:           %s (XMODIFIERS=%s)\n' "$ime_detected" "${XMODIFIERS:-(unset — set automatically at launch)}"
printf 'ja locale:     %s\n' "$(locale -a 2>/dev/null | grep -i 'ja_JP' >/dev/null && echo available || echo 'MISSING (ja_JP.UTF-8 — Fedora: glibc-langpack-ja)')"
printf 'Compat profile: %s\n' "$(yn test -f "$(compat_marker_path)")"
printf 'Desktop entry: %s\n' "$(yn test -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/line-wine.desktop")"
printf 'Launcher link: %s\n' "$(yn test -L "$HOME/.local/bin/line-wine")"
printf 'LINE running:  %s\n' "$(pgrep -f 'LINE\\.exe' >/dev/null 2>&1 && echo yes || echo no)"
if [[ -s "$STATE_DIR/signing-failures.txt" ]]; then
  printf 'Signing failures: %s file(s), see %s\n' "$(wc -l < "$STATE_DIR/signing-failures.txt")" "$STATE_DIR/signing-failures.txt"
fi
