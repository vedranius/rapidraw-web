#!/usr/bin/env bash
# Pokreće relay + RapidRAW Web Bridge. Ctrl+C gasi oboje.
#   RR_PHOTOS=/mnt/photos ./run.sh
# Env: RR_PHOTOS (obavezno), RR_PORT, RR_HOST, RR_AUTH=user:pass, RR_VERBOSE=1, RR_BRIDGE_BIN
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ID=io.github.vedranius.rapidrawweb
: "${RR_PHOTOS:?postavi RR_PHOTOS=/putanja/do/fotografija}"
command -v node >/dev/null || { echo "Node.js 20+ nije instaliran"; exit 1; }

BIN="${RR_BRIDGE_BIN:-}"
for c in "$HERE/../src-tauri/target/release/rapidraw-web-bridge" "$(command -v rapidraw-web-bridge || true)" "$HERE"/*.AppImage; do
  [ -z "$BIN" ] && [ -n "$c" ] && [ -x "$c" ] && BIN="$c"
done
[ -n "$BIN" ] || { echo "Ne nalazim rapidraw-web-bridge (postavi RR_BRIDGE_BIN)"; exit 1; }

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/$ID"; CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/$ID"
mkdir -p "$DATA" "$CACHE"
export RR_ROOTS="${RR_ROOTS:-$RR_PHOTOS:$DATA:$CACHE}"
export RR_CONFIG="${RR_CONFIG:-$DATA/rrweb.json}"   # photo library folder iz RapidRAW Web prozora

# Headless server bez ekrana → Xvfb (WebKitGTK treba display; wgpu/Vulkan ga ne treba)
LAUNCH=()
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  command -v xvfb-run >/dev/null || { echo "Nema displaya: instaliraj xvfb (xvfb-run)"; exit 1; }
  LAUNCH=(xvfb-run -a)
fi

node "$HERE/relay/relay.mjs" & RELAY=$!
trap 'kill $RELAY $APP 2>/dev/null' EXIT INT TERM
sleep 0.5
"${LAUNCH[@]}" "$BIN" & APP=$!
wait -n
