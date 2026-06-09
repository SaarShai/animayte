#!/usr/bin/env python3
"""MCP server for Brainer wiki-search.

Requires `mcp` package. The core retrieval API has no external dependencies.
"""
from __future__ import annotations

from wiki_search import code_map, wiki_context, wiki_fetch, wiki_search, wiki_timeline

try:
    from mcp.server.fastmcp import FastMCP
except Exception as exc:  # pragma: no cover - runtime dependency
    raise SystemExit(f"mcp package unavailable: {exc}")


mcp = FastMCP("brainer-wiki-search")


@mcp.tool()
def wiki_search_tool(query: str, k: int = 10) -> list[dict]:
    """Tier 1: compact search hits."""
    return wiki_search(query, k)


@mcp.tool()
def wiki_timeline_tool(item_id: str, window: int = 3) -> dict:
    """Tier 2: backlinks, neighbors, and log context."""
    return wiki_timeline(item_id, window)


@mcp.tool()
def wiki_fetch_tool(item_id: str) -> dict:
    """Tier 3: fetch one full page after relevance is established."""
    return wiki_fetch(item_id)


@mcp.tool()
def wiki_context_tool(task: str, max_pages: int = 5, max_tokens: int = 4000) -> dict:
    """Audited context packet: loaded, uncertain, and rejected wiki citations."""
    return wiki_context(task, max_pages=max_pages, max_tokens=max_tokens)


@mcp.tool()
def code_map_tool(query: str = "", max_files: int = 20, max_symbols: int = 200) -> dict:
    """Compact structural code map before loading full files."""
    return code_map(query=query, max_files=max_files, max_symbols=max_symbols)


if __name__ == "__main__":
    mcp.run()
