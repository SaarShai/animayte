#!/usr/bin/env bash
# PreCompact hook entry. Thin shim around hook.py.
# Always exit 0 — compaction must not be blocked by a hook failure.
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$TOOLS_DIR/hook.py" || true
exit 0
