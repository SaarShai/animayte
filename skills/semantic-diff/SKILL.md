---
name: semantic-diff
description: AST-node-level diff for file re-reads. Use whenever you'd re-read a file you've read before — the skill returns only the changed AST nodes, not the full file. 95.5% token savings measured on argparse.py (2575 lines, 2 method edits). MCP server exposes read_file_smart, snapshot_clear, snapshot_status. Supports Python, JavaScript, TypeScript, Rust.
effort: low
tools: [Bash, Read]
---

# semantic-diff (semdiff)

## What it does

Maintains a per-session AST snapshot of every file you read via the MCP tool `read_file_smart`. On subsequent reads of the same file, it returns only the changed nodes (functions, classes, methods, variables) plus a compact summary of unchanged structure. Tree-sitter under the hood.

Measured on argparse.py (2575 lines, 19,280 tokens unfiltered):
- 2 method edits → 859 tokens returned (95.5% savings).
- No edits, stable re-read → ~100 tokens returned (99.5% savings).

## Supported languages

Python, JavaScript, TypeScript, Rust. Additional grammars by PR.

## Install (Claude Code)

```bash
bash skills/semantic-diff/tools/install.sh
# or manually:
claude mcp add semdiff -- python skills/semantic-diff/tools/semdiff_mcp/server.py
```

For Codex / Cursor / Gemini, see `tools/INSTALL.md` for the MCP add command for each.

## Usage

Once installed, agents call `read_file_smart(path)` instead of regular Read. First call returns the full file + caches AST. Subsequent calls return only changed nodes.

Clear the cache when you want a fresh full read:

```python
snapshot_clear(session_id="default")     # drop all cached snapshots for session
```

Inspect cache state:

```python
snapshot_status(session_id="default")    # returns a text summary of cached files
```

Both tools accept a `session_id` (default `"default"`) and return a human-readable
text string. See `tools/semdiff_mcp/server.py` for the exact signatures.

## Files

```
tools/
├── semdiff/          # AST diff library
├── semdiff_mcp/      # MCP server
├── plugin/           # CC plugin wrapper (.claude-plugin/, .mcp.json)
├── tests/
├── install.sh
└── INSTALL.md        # per-host install
```

## Lineage

Inspired by cocoindex-code (AST MCP, claims 70% reduction + 80-90% cache hit). Our scope is narrower (file re-read diff, not full codebase index) and our measurements are repeatable on the published dataset.
