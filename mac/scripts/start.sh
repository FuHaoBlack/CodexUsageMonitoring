#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BIN=${NODE_BIN:-node}

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "未找到 Node.js 24+，无法启动 macOS 用量显示。" >&2
  exit 3
fi

exec "$NODE_BIN" "$INSTALL_ROOT/src/launcher.mjs"
