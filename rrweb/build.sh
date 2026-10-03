#!/usr/bin/env bash
# Builda browser UI (rrweb/dist-web), bridge varijantu RapidRAW-a i relay.
# BUNDLES=deb,rpm,appimage ./rrweb/build.sh  → i instalacijski paketi
# Bridge je all-in-one: ugrađeni Node.js + relay + web UI (rrweb/bundle/prepare.mjs), na Linuxu i rrweb-fuse.
# RR_PLAIN=1 → samo bridge bez ugrađenog relaya (relay se onda pokreće s run.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
node rrweb/check-shims.mjs
npm ci --no-audit --no-fund
npx vite build --config rrweb/vite.web.config.mjs
(cd rrweb/relay && npm install --omit=dev --no-audit --no-fund)
if [ "$(uname -s)" = Linux ] || [ "${OS:-}" = Windows_NT ]; then   # folder s klijenta "na zahtjev" (FUSE / WinFsp)
  cargo build --release --manifest-path rrweb/fuse/Cargo.toml
  if [ "$(uname -s)" = Linux ]; then   # za run.sh iz repoa
    mkdir -p "rrweb/fuse/$(uname -m)" && cp rrweb/fuse/target/release/rrweb-fuse "rrweb/fuse/$(uname -m)/"
  fi
fi
echo "rrweb: $(node rrweb/version.mjs)"
CONFIGS=(--config rrweb/tauri.bridge.json --config rrweb/tauri.version.json)
if [ -z "${RR_PLAIN:-}" ]; then
  node rrweb/bundle/prepare.mjs
  CONFIGS+=(--config rrweb/bundle/tauri.bundle.json)
fi
if [ -n "${BUNDLES:-}" ]; then
  npx tauri build --bundles "$BUNDLES" "${CONFIGS[@]}"
else
  npx tauri build --no-bundle "${CONFIGS[@]}"
fi
echo "OK → src-tauri/target/release/rapidraw-web-bridge, rrweb/dist-web/, rrweb/relay/"
