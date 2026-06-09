---
type: project
tags: [semantic-diff, ast, context-compression]
confidence: med
evidence_count: 2
---

# semdiff — AST-node-level diff for LLM file re-reads

Saves tokens when agents re-read files. First call: full file. Subsequent: only changed/added nodes + unchanged-stub list.

## Measured (argparse.py, 2575 lines)

| scenario | tokens | savings vs naive re-read |
|---|---:|---:|
| first read (full) | 19,280 | baseline |
| re-read after 2 method edits | **859** | **95.5%** |
| stable re-read (no changes) | **101** | **99.5%** |

## Languages (v1)
python, javascript, typescript, rust (tree-sitter grammars).

## Usage
```bash
python3 -m semdiff.cli read path/to/file.py --session my-session
```

Or as library:
```python
from semdiff import read_smart
text, meta = read_smart("foo.py", session_id="s1")
# meta: {mode: full|diff, added, removed, changed, unchanged, lang}
```

## Design
- **AST extract**: tree-sitter → top-level fns/classes + nested methods. Qualified names (`Widget.render`).
- **Hash**: SHA1 of node source bytes, 12 hex chars.
- **Cache**: JSON file at `.brainer/semdiff/<session>.json`. Per-session isolation.
- **Diff render**: changed/added nodes full source + unchanged stubs (`// [unchanged: foo, bar, +90 more]`).
- **Parent/child dedup**: if method changed, skip redundant class-body emit.

## Known caveats
- Class-level hash changes whenever any descendant changes → parent appears in "changed" list. Current dedup skips re-emit but the name still lists. Cosmetic.
- Small files: overhead > savings. Only use on files >~500 tok.
- Refactors that rename a function show as one removed + one added, losing history.
- Comment-only edits show as full node change. Could add "signature-only hash" mode.

## Novelty vs prior art
- **LeanCTX**: AST-strip + session cache, but strip-and-compress not diff-since-last-read.
- **Aider udiff**: output-side edit format, reads full file every time.
- **Morph Fast Apply**: applies edits, doesn't compress reads.
- **Codebase-Memory**: graph query, not diff.

Unique combo: (a) per-session AST snapshot (b) node-granularity diff on re-read (c) pluggable CLI/MCP.

## Distribution (built 2026-04-17)
- **MCP server** at `semdiff_mcp/server.py` — works with Claude Code, Cursor, Cline, Zed, Windsurf, any MCP client.
- Tools exposed: `read_file_smart`, `snapshot_clear`, `snapshot_status`.
- **Claude Code plugin** wrapper at `plugin/` — one-command install for CC users.
- Protocol roundtrip tested: initialize, tools/list, tools/call all pass.
- Install guide: [[INSTALL]]

## Next
- Publish plugin to marketplace (requires git repo + manifest registration).
- Signature-hash mode (ignore whitespace/comment-only diffs).
- Cross-file dedup (shared imports, type definitions).
- Rust/TS eval on large real files.
- Integration bench: Claude Code session log with N edits, measure cumulative savings.
- End-to-end quality eval: LLM given diff view vs full re-read, compare edit accuracy.
