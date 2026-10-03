#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(dirname "$(realpath "$0")")")"
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required" >&2
  exit 1
fi
printf '%s\n' '@jsr:registry=https://npm.jsr.io' > .npmrc
rm -rf node_modules package-lock.json
npm install
