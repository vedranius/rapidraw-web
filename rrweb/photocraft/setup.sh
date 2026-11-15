#!/usr/bin/env bash
# Connects PhotoCraft (https://github.com/storytold/photocraft, open-source layered editor) to Claude Code next to
# the rapidraw MCP server, for the `photo-studio` and `stage-looks` skills of the rapidraw plugin.
#
#   rrweb/photocraft/setup.sh [--root DIR]... [--out DIR] [--version X.Y.Z] [--scope user|project|local] [--force]
#
#   --root DIR   folder PhotoCraft may read (repeatable; default ~/Pictures). Put your RapidRAW exports below it.
#   --out DIR    the only folder PhotoCraft may write (default ~/Pictures/studio). Created if missing.
#   --version    PhotoCraft release to install when photocraft-cli is missing (default: the latest release).
#   --scope      claude mcp scope (default user).
#   --force      replace an existing "photocraft" MCP entry.
#
# Linux x86_64/aarch64 only: uses photocraft-cli from PATH (the .deb/.rpm put it in /usr/bin) or installs the
# release tarball into ~/.local/opt/photocraft with links in ~/.local/bin. No sudo, nothing outside your home.
set -euo pipefail

roots=() out="" version="" scope="user" force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --root) roots+=("$(realpath -m "$2")"); shift 2 ;;
    --out) out="$(realpath -m "$2")"; shift 2 ;;
    --version) version="${2#v}"; shift 2 ;;
    --scope) scope="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ ${#roots[@]} -gt 0 ] || roots=("$HOME/Pictures")
[ -n "$out" ] || out="$HOME/Pictures/studio"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# 1. photocraft-cli
cli="$(command -v photocraft-cli || true)"
if [ -z "$cli" ] && [ -x "$HOME/.local/opt/photocraft/bin/photocraft-cli" ]; then cli="$HOME/.local/opt/photocraft/bin/photocraft-cli"; fi
if [ -z "$cli" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) arch=x86_64 ;;
    Linux-aarch64|Linux-arm64) arch=aarch64 ;;
    *) echo "Install PhotoCraft from https://github.com/storytold/photocraft/releases and run this again." >&2; exit 1 ;;
  esac
  if [ -z "$version" ]; then
    version="$(curl -fsSL https://api.github.com/repos/storytold/photocraft/releases/latest | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)"
    [ -n "$version" ] || { echo "Could not find the latest PhotoCraft release; pass --version." >&2; exit 1; }
  fi
  url="https://github.com/storytold/photocraft/releases/download/v$version/photocraft-$version-linux-$arch.tar.gz"
  say "Installing PhotoCraft $version into ~/.local/opt/photocraft"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/pc.tar.gz" "$url"
  mkdir -p "$tmp/x" && tar -xzf "$tmp/pc.tar.gz" -C "$tmp/x"
  top="$(find "$tmp/x" -type f -name photocraft-cli -path '*/bin/*' -print -quit)"
  [ -n "$top" ] || { echo "photocraft-cli not found in $url" >&2; exit 1; }
  rm -rf "$HOME/.local/opt/photocraft" && mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
  mv "$(dirname "$(dirname "$top")")" "$HOME/.local/opt/photocraft"
  for b in "$HOME/.local/opt/photocraft/bin/"photocraft*; do ln -sf "$b" "$HOME/.local/bin/$(basename "$b")"; done
  cli="$HOME/.local/opt/photocraft/bin/photocraft-cli"
fi
cli="$(realpath "$cli")"
say "PhotoCraft CLI: $cli ($("$cli" --version 2>/dev/null | head -1))"

# 2. folders (PhotoCraft refuses a root that does not exist)
mkdir -p "$out"
for r in "${roots[@]}"; do [ -d "$r" ] || { echo "Read folder $r does not exist." >&2; exit 1; }; done
# the write folder is readable too, so a saved .pcraft can be opened again
args=(mcp --headless)
for r in "${roots[@]}" "$out"; do args+=(--automation-read-root "$r"); done
args+=(--automation-write-root "$out")

# 3. register next to rapidraw
if ! command -v claude >/dev/null; then
  echo; say "Claude Code is not on PATH. Add this MCP server to your client by hand:"
  printf '  {"mcpServers":{"photocraft":{"command":"%s","args":[' "$cli"; printf '"%s",' "${args[@]}" | sed 's/,$//'; echo ']}}}'
  exit 0
fi
if claude mcp get photocraft >/dev/null 2>&1; then
  if [ "$force" = 1 ]; then claude mcp remove photocraft -s "$scope" >/dev/null 2>&1 || true
  else say "An MCP server named photocraft already exists (claude mcp get photocraft). Use --force to replace it."; exit 0; fi
fi
claude mcp add photocraft --scope "$scope" -- "$cli" "${args[@]}"
command -v exiftool >/dev/null || echo "Tip: install exiftool (perl-image-exiftool on Arch/CachyOS) so the photo-studio skill can copy EXIF into composites."
say "Done. Start a new Claude Code session; PhotoCraft reads ${roots[*]} and writes only to $out."
