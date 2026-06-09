"""MCP server exposing semdiff tools.

Run: python -m semdiff_mcp.server
Or:  python path/to/server.py

Tools exposed:
  - read_file_smart(path, session_id)  → full file on first read, AST-diff on re-read
  - snapshot_clear(session_id)         → drop session cache
  - snapshot_status(session_id)        → list cached files for a session

Any MCP-compatible client (Claude Code, Cursor, Cline, Zed, Windsurf) can consume this.
"""
from __future__ import annotations
import sys
from pathlib import Path

# Allow `python semdiff_mcp/server.py` without install
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcp.server.fastmcp import FastMCP
from semdiff import read_smart
from semdiff.cache import SessionCache

mcp = FastMCP("semdiff")


@mcp.tool()
def read_file_smart(path: str, session_id: str = "default") -> str:
    """Read a code file token-efficiently.

    On first read in a session: returns full file.
    On subsequent reads: returns only changed/added functions + class headers,
    with unchanged definitions stubbed (e.g. `// [unchanged: foo, bar, +3 more]`).

    Supported languages: Python, JavaScript, TypeScript, Rust (by file extension).
    Non-supported files return an error; caller should fall back to standard Read.

    Args:
      path: absolute path to source file.
      session_id: groups reads within one logical session. Use a stable id
        (e.g. conversation id) so re-reads diff against prior snapshot.

    Returns:
      File content or AST-diff view as markdown/source text.
    """
    p = Path(path).resolve()
    if not p.exists():
        return f"ERROR: file not found: {p}"
    try:
        text, meta = read_smart(p, session_id)
        header = (f"[semdiff mode={meta['mode']}"
                  + (f" +{len(meta.get('added',[]))} ~{len(meta.get('changed',[]))}"
                     f" -{len(meta.get('removed',[]))} ={len(meta.get('unchanged',[]))}"
                     if meta['mode'] == 'diff' else "")
                  + "]\n")
        return header + text
    except ValueError as e:
        return f"ERROR: {e} — use standard Read for this file type."


@mcp.tool()
def snapshot_clear(session_id: str = "default") -> str:
    """Drop all cached file snapshots for a session. Next reads return full files."""
    SessionCache(session_id).clear()
    return f"cleared snapshot cache for session {session_id}"


@mcp.tool()
def snapshot_status(session_id: str = "default") -> str:
    """List files currently cached for a session + node counts."""
    c = SessionCache(session_id)
    if not c._data:
        return f"session {session_id}: no cached files"
    lines = [f"session {session_id} — {len(c._data)} files cached:"]
    for path, snap in c._data.items():
        lines.append(f"  {path}  ({len(snap)} nodes)")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run()
