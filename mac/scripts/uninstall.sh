#!/bin/sh
set -eu

DATA_ROOT=${CODEX_USAGE_TOOLBAR_HOME:-"$HOME/Library/Application Support/CodexUsageToolbar"}
INSTALL_ROOT="$DATA_ROOT/mac"
DESKTOP_ENTRY="$HOME/Desktop/Codex（用量显示）.command"

if [ -e "$INSTALL_ROOT" ]; then
  rm -rf "$INSTALL_ROOT"
fi
if [ -f "$DESKTOP_ENTRY" ] && grep -q "CodexUsageToolbar" "$DESKTOP_ENTRY" 2>/dev/null; then
  rm -f "$DESKTOP_ENTRY"
fi
echo "macOS 用量显示已卸载。"
