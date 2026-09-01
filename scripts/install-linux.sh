#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/jwgmpi-wolff/wolfman.git"
SOURCE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wolfman/source"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wolfman"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wolfman/app"

if [[ $(id -u) -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  echo "Wolfman needs sudo to add system tools. Ask the owner of this PC for help."
  exit 1
fi

install_base_tools() {
  if command -v apt-get >/dev/null 2>&1; then
    "${SUDO[@]}" apt-get update
    "${SUDO[@]}" apt-get install -y ca-certificates curl git build-essential
  elif command -v dnf >/dev/null 2>&1; then
    "${SUDO[@]}" dnf install -y ca-certificates curl git gcc-c++ make
  elif command -v pacman >/dev/null 2>&1; then
    "${SUDO[@]}" pacman -Sy --needed --noconfirm ca-certificates curl git base-devel
  elif command -v zypper >/dev/null 2>&1; then
    "${SUDO[@]}" zypper --non-interactive install ca-certificates curl git gcc-c++ make
  else
    echo "This Linux system is not supported yet. Wolfman supports Ubuntu, Debian, Fedora, Arch, and openSUSE."
    exit 1
  fi
}

echo "Checking the small tools Wolfman needs..."
install_base_tools

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
fi
if (( node_major < 22 )); then
  echo "Adding Node.js 22..."
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "Adding Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

mkdir -p "$STATE_DIR"
if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  nohup ollama serve >"$STATE_DIR/ollama.log" 2>&1 &
  for _ in {1..20}; do
    if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama did not start. Restart this PC, then run the install command again."
  exit 1
fi

echo "Getting Wolfman's text model. This can take a while..."
ollama pull llama3.1:8b
echo "Getting Wolfman's picture model. This is a big download..."
ollama pull gemma4:26b

mkdir -p "$(dirname "$SOURCE_DIR")"
if [[ -d "$SOURCE_DIR/.git" ]]; then
  echo "Getting the newest Wolfman files..."
  git -C "$SOURCE_DIR" pull --ff-only
else
  rm -rf "$SOURCE_DIR"
  echo "Getting Wolfman..."
  git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
fi

cd "$SOURCE_DIR"
[[ -f .env.local ]] || cp .env.example .env.local
echo "Building Wolfman..."
npm ci
npm run build
npx electron-builder --linux AppImage

appimage="$(find "$SOURCE_DIR/release" -maxdepth 1 -type f -name '*.AppImage' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)"
if [[ -z "$appimage" ]]; then
  echo "The Wolfman app file was not made."
  exit 1
fi
chmod +x "$appimage"

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
(
  cd "$temp_dir"
  "$appimage" --appimage-extract >/dev/null
)
rm -rf "$APP_DIR"
mkdir -p "$(dirname "$APP_DIR")"
mv "$temp_dir/squashfs-root" "$APP_DIR"

mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
ln -sfn "$APP_DIR/AppRun" "$HOME/.local/bin/wolfman"
cp "$SOURCE_DIR/public/wolfman-icon-512.png" "$HOME/.local/share/icons/hicolor/512x512/apps/wolfman.png"
cat >"$HOME/.local/share/applications/wolfman.desktop" <<EOF
[Desktop Entry]
Name=Wolfman
Comment=Local-first financial and personal assistant
Exec=$HOME/.local/bin/wolfman
Icon=wolfman
Terminal=false
Type=Application
Categories=Office;Finance;
EOF

echo "Wolfman is ready."
nohup "$HOME/.local/bin/wolfman" >"$STATE_DIR/wolfman.log" 2>&1 &