#!/usr/bin/env bash
# Builda browser UI (rrweb/dist-web), bridge varijantu RapidRAW-a i relay.
# BUNDLES=deb,rpm,appimage ./rrweb/build.sh  → i instalacijski paketi
# Na Windowsu (Git Bash) bridge dobije ugrađeni node.exe + relay + web UI (rrweb/win/prepare.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."
node rrweb/check-shims.mjs
npm ci --no-audit --no-fund
npx vite build --config rrweb/vite.web.config.mjs
(cd rrweb/relay && npm install --omit=dev --no-audit --no-fund)
CONFIGS=(--config rrweb/tauri.bridge.json)
if [ "${OS:-}" = Windows_NT ]; then
  node rrweb/win/prepare.mjs
  CONFIGS+=(--config rrweb/win/tauri.windows.json)
fi
if [ -n "${BUNDLES:-}" ]; then
  npx tauri build --bundles "$BUNDLES" "${CONFIGS[@]}"
else
  npx tauri build --no-bundle "${CONFIGS[@]}"
fi
echo "OK → src-tauri/target/release/rapidraw-web-bridge, rrweb/dist-web/, rrweb/relay/"
