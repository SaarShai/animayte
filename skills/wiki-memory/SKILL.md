---
name: wiki-memory
description: Repo-local markdown wiki with progressive retrieval (search → timeline → fetch) and gated writes (verified facts only). Use when the task references past work, decisions, memory, "have we done X", project facts, or when you need to record a durable finding. Tiered: L0 rules · L1 pointer index · L2 facts · L3 SOPs · L4 archive. Replaces note-app sprawl; no global agent config.
effort: low
tools: [Bash, Read, Write, Glob, Grep]
---

# wiki-memory

Long-term repo-local memory. One skill, two modes: **retrieve** (read) and **write** (gated).

## First-time bootstrap (per project)

If `wiki/` doesn't exist in the project root, run once:

```bash
python3 skills/wiki-memory/tools/wiki.py init
```

Creates the `wiki/` tree (`L0_rules.md`, `L1_index.md`, `schema.md`, `L2_facts/`, `L3_sops/`, `L4_archive/`, `raw/`, `concepts/`, `patterns/`, `projects/`, `people/`, `queries/`, `templates/`) seeded from the skill's bundled defaults. Idempotent — re-running after content lands is safe and writes nothing. Default target is `./wiki` in cwd; override with `--root <path>` or `WIKI_ROOT=<path>`.

## Retrieve

Use when the task references past work, decisions, docs, memory, project facts, or "have we done X".

1. Read `wiki/L1_index.md` first.
2. Run `python skills/wiki-memory/tools/wiki.py search "<query>"`.
3. For relevant hits, `python ... timeline "<id>"`.
4. Fetch ≤3 pages first with `python ... fetch "<id>"`.
5. If insufficient, fetch ≤2 more pages.
6. Cite page paths/IDs in your response.

Never:
- load the whole wiki
- speculatively fetch raw/ archives
- cite a superseded page without noting the newer one

## Write

**Trigger — the self-improvement sources (harvest a lesson from each):**
- **failure / bug / issue** — a non-trivial failure, wrong approach, or bug. Record what went wrong + the exact prevention rule (error/lesson page; decay-protected).
- **feedback / correction** — the user corrected you, a review rejected an approach, or a test/tool signal contradicted your plan. Record the corrected rule and *why* the original was wrong.
- **successful execution** — a non-trivial task solved with a reusable procedure. Distill the playbook (SOP/procedure page).
- also: verified finding · user-confirmed decision · source ingested.

**Reflexive harvest (close the loop):** self-improvement compounds only if lessons get *written*, not merely write-able. At the **end of any non-trivial task** — and right after a failure, a correction, or a clean success — actively run the gated write for whichever sources fired. This is a reflex at the task boundary, not an optional afterthought; [`verify-before-completion`](../verify-before-completion/SKILL.md) triggers it. (Adopts the post-session learning-extraction intent of EveryInc ce-compound / kw-compound, now in scope under the project's explicit self-improvement goal; `write-gate` keeps the harvest from polluting.)

**Fire condition (one-line test):** harvest **iff** the task produced a *durable, project-specific* lesson you'd want a FUTURE session to recall. **Do NOT harvest** plain acknowledgements, ephemeral / general-knowledge questions (arithmetic, definitions, one-off lookups), or anything with no new project-specific fact — `write-gate` filters *low-signal* noise but not *off-topic* writes, so the should-fire judgement is yours. (Cross-model testing — `eval/exp7_wiring/` — showed models both over-fire on trivial prompts and under-fire on real lessons without this explicit gate.)

Protocol:
1. Search existing pages first.
2. Prefer updating an existing page over creating a new one; fewer rich pages beat many thin one-off pages. **Dedup-at-write:** `python skills/wiki-memory/tools/wiki.py overlap --title "<title>" --tags "a,b" [--body-file <draft>]`. `high` → update the reported `best_match` instead of creating (two pages on one subject inevitably drift apart). `moderate` → create, but it's a Consolidate candidate for [`wiki-refresh`](../wiki-refresh/SKILL.md). `low` → create.
3. **Pre-check the candidate with [`write-gate`](../write-gate/SKILL.md)** — `python skills/write-gate/tools/write_gate.py gate --kind <kind> --file <candidate>`. If it rejects, revise or drop; do not bypass.
4. If no page, run `python skills/wiki-memory/tools/wiki.py new --template page --title "<title>" --domain "<domain>"`.
5. Name new pages at domain/category level, not task-specific bug names.
6. Fill v2 frontmatter completely.
7. **Why-clause requirement (decisions / conventions):** the page body must contain at least one of `because …`, `so that …`, `to avoid …`, `in order to …`, `due to …`. (`since` is intentionally *not* accepted — it reads as temporal and was bypassing the gate; write a causal `because`/`in order to` instead. See `write_gate.py` `WHY_CLAUSES`.) Reasonless decisions are rejected by write-gate. Source: [codenamev/claude_memory](https://github.com/codenamev/claude_memory) (100% on a 100-case FEVER-derived test).
8. For procedures/failures, include when it applies and the exact prevention rule.
9. Add ≥2 useful wikilinks when possible.
10. Append `wiki/log.md`.
11. Run `python ... index`; for new v2 pages run `python ... lint --strict`.
12. **Selective refresh on write (compounding loop):** if this write *contradicts* or *supersedes* an existing page, or a refactor/rename invalidated refs a related page cites, invoke [`wiki-refresh`](../wiki-refresh/SKILL.md) with the **narrowest** scope hint (the affected page id / tag / dir) — don't wait for the periodic sweep. A new fact that invalidates an old one is exactly when reconcile pays off. Fire only on contradiction/supersession/refactor signals, not on every write. (Port of EveryInc ce-compound Phase 2.5 selective-refresh-check.)

**Conflict & trust — the poison defense (`write-gate` is NOT a truth filter).** The gate scores *signal/quality*, not *truth*: a confident, well-formed but WRONG lesson passes it (measured — 8/8 adversarial lessons passed at mean score 4.88; `eval/exp5_adversarial/`). So before writing a fact that may **contradict** an existing same-subject page, run the trust-gated check:
```bash
python3 skills/wiki-memory/tools/wiki.py resolve --title "<t>" --body-file <draft> --tags "a,b" --trust <tier>
```
Tiers: `asserted` (default) < `corroborated` (independently re-seen) < `verified` (checked against code/test/fs, cf. `audit-refs`) < `user_confirmed`. Stamp each page's tier at creation with `new --trust <tier>`. `resolve` returns an action: **create** (no same-subject page) · **replace** (your higher-trust correction supersedes — wire `supersedes`/`superseded-by`) · **reject** (a higher-trust page exists; do NOT overwrite — raise trust by verifying, or record `contradicts:[[…]]`) · **dispute** (equal trust — mark `contradicts:` both ways so retrieval surfaces the conflict instead of serving one as truth). This recovers the truth+poison coexistence case (measured — dependent accuracy 0.5→1.0). **Honest limit:** with no competing truth and no verifier, a lie can only be *flagged unverified*, not corrected — that hand-off is [`verify-before-completion`](../verify-before-completion/SKILL.md) + code-grounded checks. (Pure logic in [`provenance.py`](tools/provenance.py).)

## Lint

```
python3 skills/wiki-memory/tools/wiki.py lint [--strict] [--stale-days N] [--hub-threshold N] [--scope PATH ...]
```

Always-on findings: broken `[[wikilinks]]`, orphans (0 inbound), duplicate titles, stale `verified:` (>`--stale-days`, default 180, with `age_days`), gravity-well hubs (inbound > `--hub-threshold`, default 20). `--scope` adds extra roots so trees outside the wiki (concepts/, runbooks/, designs/foo/ledger.md) participate in the link graph and get hygiene-scanned. `--strict` adds v2-frontmatter enforcement, missing-provenance / missing-backlinks warnings, and supersession-reverse-link checks.

Write-gate (two layers). Both are **procedure gates** — agent steps in the write protocol above, not code auto-invoked by `wiki.py`. `wiki.py` enforces only the structural guard (a duplicate filename raises `FileExistsError`); the rest is agent discipline plus `lint`/`lint --strict` flagging violations after the fact.

**Execution gate** (agent discipline — see [`verify-before-completion`](../verify-before-completion/SKILL.md)):
- No durable memory from unexecuted plans.
- No trivial lookups inflated into fake procedures.
- `wiki/raw/` is immutable after creation (convention; not enforced by the write path).
- No duplicate page without supersession.

**Content gate** (run [`write-gate`](../write-gate/SKILL.md) before the write, per protocol step 3):
- Candidate must score above the signal threshold (decisions / errors / architecture / code / numbers, minus filler / speculation).
- Decisions and conventions must embed a why-clause.

## Aging & reconcile

Once a page is in the wiki, two companions maintain it:
- Page `confidence` and the `verified:` date carry staleness signal; `wiki-refresh` reconciles drifted pages against the codebase, and `lint --strict` flags pages whose `verified:` date is stale.
- [`wiki-refresh`](../wiki-refresh/SKILL.md) reconciles pages against the *current codebase* (Keep/Update/Consolidate/Replace/Delete) and emits typed `contradicts:` edges. Drift signal: `python skills/wiki-memory/tools/wiki.py audit-refs [--code-root PATH]` lists pages whose cited code paths no longer exist. Run decay weekly (cheap), refresh monthly or after a refactor/rename (costs reads).

## Tier layout

```
wiki/
├── L0_rules.md        # stable behavior rules
├── L1_index.md        # compact pointer catalog
├── L2_facts/          # durable facts
├── L3_sops/           # solved-task playbooks
├── L4_archive/        # cold session archives
├── concepts/          # atomic technique pages
├── patterns/          # reusable workflows
├── projects/          # target-project pages
├── people/            # referenced humans
├── queries/           # durable Q&A
├── raw/               # immutable sources
├── index.md           # rich catalog
├── log.md             # append-only timeline
└── schema.md          # contract for page types
```

## Boundary with graphify

If the project has `graphify-out/graph.json` (auto-extracted code graph), do not duplicate its content here. Split:

- **`graphify-out/`** owns the *what / how / connected-to* layer: symbols, callers, modules, communities. Auto-extracted, refreshed on commit, ephemeral.
- **`wiki/`** owns the *why / decision / failure-lesson* layer: rationale, trade-offs, incidents, durable procedures. Hand-curated, gated, permanent.

When writing a new page, first run `graphify query "<topic>"` (or grep `graphify-out/GRAPH_REPORT.md`); if the answer is already covered by the auto-graph, the page is redundant — skip the write. The reverse also holds: don't try to make graphify carry the *why*; it can't.

## Optional MCP

`tools/wiki_mcp/` exposes `wiki_search`, `wiki_fetch`, `wiki_timeline`, `wiki_new` for MCP-aware hosts.

## Files

```
tools/
├── wiki.py            # search/fetch/timeline/new/index/lint
├── code_map.py        # symbol-level navigation aid
├── config.py          # path + threshold defaults
├── tokens.py          # shared token estimator
├── wiki_mcp/          # optional MCP server
├── test_lint_hygiene.py
└── README.md
```
