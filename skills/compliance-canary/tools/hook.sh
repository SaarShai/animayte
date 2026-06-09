#!/usr/bin/env bash
# UserPromptSubmit hook entry for compliance-canary. Thin shim around hook.py.
# Always exit 0 — a failing UserPromptSubmit hook would block the user's prompt.
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$TOOLS_DIR/hook.py" || true
exit 0
