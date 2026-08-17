#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
DATA_ROOT=${CODEX_USAGE_TOOLBAR_HOME:-"$HOME/Library/Application Support/CodexUsageToolbar"}
INSTALL_ROOT="$DATA_ROOT/mac"
TEMP_ROOT="$DATA_ROOT/.mac-install.$$"
BACKUP_ROOT="$DATA_ROOT/mac.backup.$(date +%Y%m%d%H%M%S)"
DESKTOP_ENTRY="$HOME/Desktop/Codex（用量显示）.command"

mkdir -p "$DATA_ROOT"
mkdir "$TEMP_ROOT"
cp -R "$SOURCE_ROOT/src" "$TEMP_ROOT/src"
cp -R "$SOURCE_ROOT/scripts" "$TEMP_ROOT/scripts"
cp "$SOURCE_ROOT/README.md" "$TEMP_ROOT/README.md"
chmod +x "$TEMP_ROOT/scripts/"*.sh "$TEMP_ROOT/scripts/"*.command

if [ -e "$INSTALL_ROOT" ]; then
  mv "$INSTALL_ROOT" "$BACKUP_ROOT"
fi
mv "$TEMP_ROOT" "$INSTALL_ROOT"

mkdir -p "$HOME/Desktop"
cp "$INSTALL_ROOT/scripts/start.command" "$DESKTOP_ENTRY"
chmod +x "$DESKTOP_ENTRY"
echo "macOS 用量显示已安装到：$INSTALL_ROOT"
echo "启动入口：$DESKTOP_ENTRY"
