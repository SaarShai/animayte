# semdiff — Install

## Option A: MCP server (universal — works with any MCP-compatible client)

Requires Python ≥ 3.10 (MCP SDK requirement).

```bash
# 1. Install deps
pip install mcp 'tree-sitter<0.22' tree-sitter-languages

# 2. Clone this repo (or copy the semdiff/ directory)
git clone https://github.com/<org>/semdiff
cd semdiff

# 3. Register with your MCP client
```

### Claude Code

```bash
claude mcp add semdiff \
  --scope project \
  -- python /absolute/path/to/semdiff/semdiff_mcp/server.py
```

Or add manually to the project-local MCP config supported by your client:
```json
{
  "semdiff": {
    "command": "python",
    "args": ["/absolute/path/to/semdiff/semdiff_mcp/server.py"]
  }
}
```

### Cursor / Cline / Zed / Windsurf / Continue

Add to your client's MCP config (format varies slightly per client). All use the
same `command + args` pattern:
```json
{
  "semdiff": {
    "command": "python",
    "args": ["/path/to/semdiff_mcp/server.py"]
  }
}
```

## Option B: Claude Code plugin (one-click install for CC users)

*(Planned — wraps the MCP server with a Claude Code plugin manifest so users
can run `/plugin install semdiff` without editing config.)*

## Option C: CLI-only (no agent integration)

```bash
python -m semdiff.cli read /path/to/file.py --session my-session
```

## Usage — what the agent sees

After install, the agent has access to three new tools:

- `read_file_smart(path, session_id)` — AST-aware file read with session-level
  diff-on-reread.
- `snapshot_clear(session_id)` — drop cached snapshots.
- `snapshot_status(session_id)` — list currently-cached files.

On first read of a file within a session: full file contents.
On subsequent reads: only changed functions/classes + stubs of unchanged ones.

### Measured savings

argparse.py, 2575 lines:
| scenario | tokens | savings |
|---|---:|---:|
| first read (full) | 19,280 | — |
| re-read after 2 method edits | **859** | **95.5%** |
| stable re-read (no changes) | **101** | **99.5%** |

## Option B (built): Claude Code plugin directory

The `plugin/` subdirectory contains a Claude Code plugin manifest that wraps the MCP server.

To install locally:
```bash
# Point Claude Code at the plugin directory
claude plugin install /absolute/path/to/semdiff/plugin
```

Or publish via a plugin marketplace. After install, `/plugin list` shows semdiff
and the MCP tools become available automatically.

The plugin `.mcp.json` launches `semdiff_mcp/server.py` via Python. Requires Python ≥ 3.10 and `pip install mcp 'tree-sitter<0.22' tree-sitter-languages` on the user's system.

## Project-local installer

Use the bundled helper to print or apply the relevant install path:

```bash
bash projects/semdiff/install.sh --project
```

It prefers the plugin path when `claude` is available and falls back to the MCP server command.
