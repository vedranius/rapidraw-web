#!/bin/sh
# One-line install of the latest RapidRAW Web on Linux:
#   curl -fsSL https://raw.githubusercontent.com/vedranius/rapidraw-web/main/rrweb/install.sh | sh
#   … | sh -s -- --server          also start it as a service now and at boot (server without a screen)
#   … | sh -s -- --appimage        AppImage in ~/.local/bin instead of a .deb/.rpm (no sudo needed)
# Picks .deb (Debian/Ubuntu), .rpm (Fedora/openSUSE) or the AppImage for x64/arm64, checks its SHA-256 against
# GitHub, installs it. Later versions update from inside the app with one click.
set -eu
REPO="${RR_UPDATE_REPO:-vedranius/rapidraw-web}"
SERVER=0
APPIMAGE=0
for a in "$@"; do
  case "$a" in
    --server) SERVER=1 ;;
    --appimage) APPIMAGE=1 ;;
    -h|--help) sed -n '2,7p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || die "this script is for Linux; on Windows and macOS download the installer from https://github.com/$REPO/releases/latest"
command -v curl >/dev/null || die "curl is required"

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
if [ "$APPIMAGE" -eq 0 ]; then
  if command -v apt-get >/dev/null; then KIND=deb
  elif command -v dnf >/dev/null || command -v zypper >/dev/null || command -v rpm >/dev/null; then KIND=rpm
  else KIND=AppImage; fi
else
  KIND=AppImage
fi

say "Looking up the latest RapidRAW Web release…"
JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")
TAG=$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$TAG" ] || die "could not read the latest release from GitHub"
NAME="${TAG}_linux_${ARCH}.${KIND}"
URL="https://github.com/$REPO/releases/download/$TAG/$NAME"
SHA=""
if command -v jq >/dev/null; then
  SHA=$(printf '%s' "$JSON" | jq -r --arg n "$NAME" '.assets[] | select(.name == $n) | .digest // ""' | sed 's/^sha256://')
elif command -v python3 >/dev/null; then
  SHA=$(printf '%s' "$JSON" | python3 -c 'import json,sys; n=sys.argv[1]; print(next((a.get("digest") or "" for a in json.load(sys.stdin)["assets"] if a["name"]==n), "").removeprefix("sha256:"))' "$NAME")
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "Downloading $NAME…"
curl -fL --progress-bar -o "$TMP/$NAME" "$URL" || die "download failed: $URL"
if [ -n "$SHA" ] && command -v sha256sum >/dev/null; then
  echo "$SHA  $TMP/$NAME" | sha256sum -c --quiet - || die "the download is damaged (SHA-256 does not match)"
  echo "SHA-256 OK"
fi

case "$KIND" in
  deb)
    $SUDO apt-get install -y "$TMP/$NAME" ;;
  rpm)
    if command -v dnf >/dev/null; then $SUDO dnf install -y "$TMP/$NAME"
    elif command -v zypper >/dev/null; then $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/$NAME"
    else $SUDO rpm -U "$TMP/$NAME"; fi ;;
  AppImage)
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$TMP/$NAME" "$HOME/.local/bin/RapidRAW-Web.AppImage"
    say "Installed: ~/.local/bin/RapidRAW-Web.AppImage (run it to start RapidRAW Web)" ;;
esac

if [ "$SERVER" -eq 1 ]; then
  [ "$KIND" != AppImage ] || die "--server needs the .deb/.rpm package (it installs the systemd service)"
  systemctl --user daemon-reload
  systemctl --user enable --now rapidraw-web
  $SUDO loginctl enable-linger "$(id -un)" || true
  say "RapidRAW Web runs as a service. Open http://$(hostname):8780 in a browser on your network."
  echo "Photo folder: ~/Pictures (change: systemctl --user edit rapidraw-web, see the README)."
elif [ "$KIND" != AppImage ]; then
  say "Installed $TAG. Start \"RapidRAW Web Bridge\" from the menu, or run with --server on a machine without a screen."
fi
