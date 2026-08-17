#!/bin/sh
# CodexUsageToolbar macOS desktop entry
set -eu
DATA_ROOT=${CODEX_USAGE_TOOLBAR_HOME:-"$HOME/Library/Application Support/CodexUsageToolbar"}
exec "$DATA_ROOT/mac/scripts/start.sh"
