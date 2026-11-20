#!/usr/bin/env bash
# update.sh — refresh this kit and the compat profile.
# LINE itself auto-updates inside the prefix; this updates the kit files,
# redeploys the launcher, and re-signs Wine DLLs after Wine upgrades.
set -euo pipefail

KIT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=deps.sh
source "$KIT_DIR/deps.sh"
# shellcheck source=compat.sh
source "$KIT_DIR/compat.sh"

if [[ -d "$KIT_DIR/.git" ]]; then
  log "Updating kit (git pull)"
  git -C "$KIT_DIR" pull --ff-only || warn "git pull failed; continuing with the current files"
else
  log "Not a git checkout; skipping pull"
fi

APP_DIR="$LINEWINE_HOME/app"
if [[ -f "$PREFIX/system.reg" ]]; then
  ensure_wine_runner
  lw_resolve_wine
  log "Redeploying launcher into $APP_DIR"
  mkdir -p "$APP_DIR" "$HOME/.local/bin"
  cp -f "$KIT_DIR/launch-line.sh" "$KIT_DIR/compat.sh" "$KIT_DIR/signing.cnf" \
        "$KIT_DIR/diagnose.sh" "$KIT_DIR/uninstall.sh" "$APP_DIR/"
  rm -f "$APP_DIR/line-window-fix.py"  # removed in v2.8; drop stale copies on upgrade
  chmod +x "$APP_DIR/launch-line.sh" "$APP_DIR/diagnose.sh" "$APP_DIR/uninstall.sh"
  ln -sfn "$APP_DIR/launch-line.sh" "$HOME/.local/bin/line-wine"

  ensure_font_view
  # Force the registry profile to re-apply after a kit update.
  rm -f "$PREFIX"/.linewine-compat-profile-*
  apply_registry_profile
  log "Re-checking DLL signatures"
  sign_wine_dlls
  ok "Kit updated. LINE version in prefix: $(line_version || echo unknown)"
else
  warn "No prefix yet at $PREFIX — run ./installer.sh"
fi
