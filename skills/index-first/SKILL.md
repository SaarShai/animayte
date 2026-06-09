---
name: index-first
description: Prefer pre-built indexes over chains of grep/read/scan. Use when about to look up symbols, callers, references, routes, or "where is X used / what depends on Y" — query the index (codegraph, ctags, wiki search) before scanning raw text. Batch related lookups into one capped call. Applies to code and any indexed corpus (wiki, tickets, docs).
effort: low
---

# Index-First Retrieval

## Principle

If a structured index already answers the question, scanning raw text repeats work the index did. Default agent behavior is grep → read → grep → read; most "find references / trace flow / show related" tasks have a one-shot answer if the right index is in scope.

## Triggers

- Question shape: "where is X used?", "what calls Y?", "what depends on Z?", "show me the route handlers for /api/...", "what changed about this symbol?", "find all docs that reference this decision."
- About to grep + read multiple files (or threads, or tickets) to trace something.
- About to read N related items sequentially.
- An index is in scope: `codegraph`, `repomap`, `ctags`, `semantic-diff` snapshot, **`graphify-out/graph.json`** (see Recipe below), a wiki search endpoint, Linear/Jira/GitHub Issues APIs, an email/thread search tool.

## Protocol

1. Before any grep/read loop, ask: is there an index for this corpus?
2. If yes, call the composite verb (e.g., `context`, `explore`, `impact`) — not chained primitives. One call beats `search` → `read` → `search` → `read`.
3. If the index returns ranked candidates with confidence scores, surface ambiguity to the user instead of picking one and guessing.
4. When you must read N related items, batch: one capped composite call, or parallel reads in a single message — never sequential loops.
5. Pass natural-language queries through. Indexes that extract symbols (CamelCase, snake_case, dot.path, SCREAMING_SNAKE) will pull them out; you don't need to pre-parse.
6. Use structured filters (`kind:function path:src/api`, `state:open label:bug`) to narrow before content search; full-text scoring runs within the narrowed set.
7. If no index exists for a corpus you query often, build one once — the upfront cost amortizes over future queries.

## Anti-patterns

- `search` → `read` → `search` → `read` chains when a `context` verb does it in one.
- Looping `Read` over N files when a batched / parallel / composite alternative exists.
- Grepping for symbols, callers, or "what depends on X" when `graphify-out/graph.json` exists and is fresh — use `graphify query|explain|path` instead.
- Spawning a sub-agent for exploration that the index could answer directly — codegraph's own findings: this guidance confuses non-Claude models and repeats work the index already did.
- Grepping for a symbol that an AST/symbol index can resolve precisely.
- Picking the top-ranked candidate silently when the index returned multiple low-confidence matches.
- Hand-extracting symbols from a user prompt before passing to an index that already does this.

## Caveats

- Initial-index cost amortizes over many queries. On tiny corpora (<200 files / <50 docs) grep is already cheap — skip this skill.
- Indexes go stale. If the corpus changed since last build and there is no watcher, rebuild or trust grep instead.
- Confidence matters: a top-result confidence of ~0.4 means "I don't know" — treat as ambiguous, do not silently pick.
- Don't push agents toward an index that isn't installed. Check first, fall back to grep+read if absent.

## Recipe: graphify (external)

If the project has `graphify-out/graph.json` (built via [graphify](https://github.com/safishamsi/graphify)), prefer these one-shot verbs over grep+read. Pick the verb that matches the question shape:

- **Symbol question** ("what calls X / what methods of X / what imports X") → `graphify explain "<NodeLabel>"`. Returns the node's degree, type, and all in/out connections by relation. **Use exact label** (e.g. `WikiStore`, `_cli_main()`). Measured: -93% tokens vs grep+read at parity evidence rate (12-question A/B on this repo).
- **Path question** ("how does A reach B") → `graphify path "<A>" "<B>"`. Shortest path between two exact labels.
- **Exploration / concept question** ("show me the auth neighborhood") → `graphify query "<question>"`. Natural-language BFS — fastest but **unreliable for symbol-precision** questions (50% evidence rate on the same A/B): graphify's NL→start-node resolver picks generic matches over the obvious symbol. If the question names a symbol, prefer `explain`.

Build: `graphify extract . --backend ollama` (single shot; clustering is built in — do NOT pass `--no-cluster` then `cluster-only`, the two-step path refuses to overwrite on node-count drift). The `--backend` flag is mandatory even for code-only corpora (graphify's argparse requires it); `ollama` is the lightest dummy choice — **no API key needed** for code-only AST extraction. The flag only matters when graphify hits a non-code file (docs/PDFs/images) — set a real backend (`gemini`, `claude`, `openai`, `kimi`) if you want those processed too.

Refresh after edits:
- `graphify update . --force` — fast AST refresh **for additions and modifications only**.
- For renames, deletions, or any refactor where a symbol *no longer exists*, `update` is NOT enough — it leaves the old node in the graph and adds the new one alongside it. Measured behavior: rename `def foo → def bar`, run `update`, then `graphify explain foo` still succeeds. **Wipe `graphify-out/` and re-`extract`** after refactors.
- `graphify hook install` keeps it current on commit, but suffers the same additive-update behavior — verify after big refactors.

Staleness rule: if the graph is older than the last `git HEAD` move on files you care about, run `update` for adds/edits, **re-extract from scratch for renames/deletes**, or fall back to grep+read. Crosscheck: if `graphify explain` returns a node whose source line no longer contains the label, the graph is stale.

Known issues (graphify 0.8.17, measured 2026-05-23):
- `graphify query` (NL) picks weak start nodes for symbol-precision questions (50% evidence rate vs 92% for `explain`) — prefer `explain` whenever the question names a symbol.

(Four other 0.8.17 bugs that affected this skill — `affected`/`benchmark` schema crash, `cluster-only` silent refusal on node-count drift, `update` not evicting stale nodes, `explain` truncating connections with no expansion flag — are fixed in the build that `./install.sh` installs. See [EVAL.md](EVAL.md) for the bug list, regression tests, and the install source.)

## Lineage

Distilled from `colbymchenry/codegraph` — the generalizable parts of its agent-instruction template: one-call composition, batched exploration, confidence-scored name resolution, structured-filter + FTS composition. Their measured savings on real codebases (VS Code, Django, Tokio, …): ~59% fewer tokens, ~70% fewer tool calls, scaling with corpus size. Pattern applies to any indexed corpus, not just code.

Related skills: [`semantic-diff`](../semantic-diff/SKILL.md) (file-re-read diff — a per-file index), [`wiki-memory`](../wiki-memory/SKILL.md) (the manually-curated prose analog), [`lean-execution`](../lean-execution/SKILL.md) (general scope pruning).
