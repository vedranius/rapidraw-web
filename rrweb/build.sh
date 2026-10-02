#!/usr/bin/env bash
# Builda browser UI (rrweb/dist-web), bridge varijantu RapidRAW-a i relay.
# BUNDLES=deb,rpm,appimage ./rrweb/build.sh  → i instalacijski paketi
set -euo pipefail
cd "$(dirname "$0")/.."
node rrweb/check-shims.mjs
npm ci --no-audit --no-fund
npx vite build --config rrweb/vite.web.config.mjs
if [ -n "${BUNDLES:-}" ]; then
  npx tauri build --bundles "$BUNDLES" --config rrweb/tauri.bridge.json
else
  npx tauri build --no-bundle --config rrweb/tauri.bridge.json
fi
(cd rrweb/relay && npm install --omit=dev --no-audit --no-fund)
echo "OK → src-tauri/target/release/rapidraw-web-bridge, rrweb/dist-web/, rrweb/relay/"
