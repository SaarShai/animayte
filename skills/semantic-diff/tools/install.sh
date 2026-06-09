#!/usr/bin/env bash
# semantic-diff — install Python deps + register MCP server.
# Best-effort: prints clear next-steps on failure but exits 0 so a parent
# installer can keep going.
set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$TOOLS_DIR/semdiff_mcp/server.py"
REQS="$TOOLS_DIR/requirements.txt"

find_py() {
  # Prefer 3.10–3.12: tree-sitter-languages has no 3.13 wheel as of writing.
  for c in python3.12 python3.11 python3.10 python3.13 python3; do
    if command -v "$c" >/dev/null 2>&1; then
      "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null \
        && { echo "$c"; return 0; }
    fi
  done
  return 1
}

PY="$(find_py || true)"
if [ -z "$PY" ]; then
  echo "[semantic-diff] skip: need Python >= 3.10 (MCP SDK requirement)." >&2
  echo "  install one, then re-run: bash $0" >&2
  exit 0
fi
echo "[semantic-diff] using $PY ($($PY --version 2>&1))"

VENV="$TOOLS_DIR/.venv"
RUN_PY="$PY"
if "$PY" -m pip install -q -r "$REQS" 2>/dev/null; then
  echo "[semantic-diff] deps installed (system)."
else
  echo "[semantic-diff] system pip blocked (PEP 668?); creating venv at $VENV"
  if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV" || { echo "[semantic-diff] venv create failed" >&2; exit 0; }
  fi
  "$VENV/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true
  if ! "$VENV/bin/python" -m pip install -q -r "$REQS"; then
    echo "[semantic-diff] venv pip install failed; install manually:" >&2
    echo "  $VENV/bin/pip install -r $REQS" >&2
    exit 0
  fi
  RUN_PY="$VENV/bin/python"
  echo "[semantic-diff] deps installed (venv)."
fi

if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^semdiff\b'; then
    echo "[semantic-diff] MCP server 'semdiff' already registered."
  elif claude mcp add semdiff --scope user -- "$RUN_PY" "$SERVER" >/dev/null 2>&1; then
    echo "[semantic-diff] registered MCP server 'semdiff' (user scope, $RUN_PY)."
  else
    echo "[semantic-diff] could not register MCP server — run manually:" >&2
    echo "  claude mcp add semdiff --scope user -- $RUN_PY $SERVER" >&2
  fi
else
  echo "[semantic-diff] claude CLI not found; to register manually later:"
  echo "  claude mcp add semdiff --scope user -- $RUN_PY $SERVER"
fi
