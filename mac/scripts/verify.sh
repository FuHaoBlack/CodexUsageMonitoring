#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BIN=${NODE_BIN:-node}

command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "未找到 Node.js。" >&2; exit 1; }
for file in "$PROJECT_ROOT"/src/*.mjs "$PROJECT_ROOT"/src/inject.js; do
  "$NODE_BIN" --check "$file"
done
test -x "$PROJECT_ROOT/scripts/start.sh"
test -x "$PROJECT_ROOT/scripts/install.sh"
test -x "$PROJECT_ROOT/scripts/uninstall.sh"
echo "macOS 源码语法与启动脚本检查通过。"
