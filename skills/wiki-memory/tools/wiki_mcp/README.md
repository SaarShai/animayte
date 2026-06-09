---
type: project
axis: knowledge_org
tags: [retrieval, progressive-disclosure, mcp, wiki]
confidence: med
evidence_count: 0
---

# wiki-search — progressive-disclosure retrieval over the Brainer wiki

**Status: IMPLEMENTED v1.** Adopts claude-mem's 3-layer retrieval pattern (index -> timeline -> fetch) for any repo-local markdown wiki. Adds an audited context packet for task-scoped loading.

## Problem

Our wiki is 70+ markdown files, ~400KB. Loading whole pages into context is wasteful. Grep alone returns fragments without structure. Need tiered retrieval that exposes the minimum necessary.

## 3-layer API (CLI + importable + MCP adapter)

```
wiki_search(query, k=10)    → tier-1: IDs + one-line previews (~50-100 tok each)
wiki_timeline(id, window=3) → tier-2: neighbor pages + backlinks
wiki_fetch(id)              → tier-3: full page content
wiki_context(task)          → bounded packet: loaded / uncertain / rejected citations
code_map(query)             → compact source structure before file reads
```

Agent uses tier-1 → evaluates relevance → tier-2 or tier-3 only on hits.

CLI:

```bash
./te wiki index
./te wiki search "context refresh"
./te wiki timeline projects/context-keeper-v2/README
./te wiki fetch projects/context-keeper-v2/README
./te wiki context "context refresh implementation"
./te code map "WikiStore context"
```

Python:

```python
import sys
sys.path.insert(0, "projects/wiki-search")
from wiki_search import wiki_search, wiki_timeline, wiki_fetch, wiki_context, code_map
```

MCP:

```bash
python projects/wiki-search/mcp_server.py
```

## Implementation

- Core code: `token_economy/wiki.py`.
- Wrapper: `projects/wiki-search/wiki_search.py`.
- MCP adapter: `projects/wiki-search/mcp_server.py`.
- SQLite FTS5 index at `.brainer/wiki.sqlite3`.
- L1 pointer index at `L1_index.md`.
- Ranking uses title/tag/path matches, tier weighting, backlinks, confidence, recency, raw downranking, and supersession rejection.
- Code maps use Python AST plus lightweight JS/TS/shell symbol extraction; they are structural pointers, not source substitutes.
- The `code_map` layer is the repo-map style pre-read gate: use it before broad source loads when you only need structure.

## Stores

- SQLite at repo-local `.brainer/wiki.sqlite3`.
- Rebuilds on file modification (watchdog).
- Vector index via sentence-transformers for heavier installations.

## Borrowed

- **claude-mem**: 3-layer retrieval + ID-based citations.
- **GenericAgent**: L1 pointer-index discipline.
- **Karpathy wiki**: index.md as canonical catalog.
