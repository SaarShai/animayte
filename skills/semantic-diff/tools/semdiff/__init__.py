"""semdiff — AST-node-level diff for LLM file re-reads.

Public API:
  read_smart(path, session_id, cache_dir=None) -> (output_text, meta)
  snapshot(path) -> dict[name_path, hash]
"""
from .core import read_smart, snapshot, render_diff, extract_nodes
from .cache import SessionCache

__all__ = ["read_smart", "snapshot", "render_diff", "extract_nodes", "SessionCache"]
