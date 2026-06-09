---
name: wiki-refresh
description: Reconcile wiki-memory pages against the current codebase — Keep / Update / Consolidate / Replace / Delete drifted ones. Use on "refresh the wiki", "audit wiki against code", "are these facts still true", "clean up stale pages", or after a refactor/rename/migration that invalidated cited paths. Ground-truth reconcile; emits typed contradicts: edges.
effort: medium
tools: [Bash, Read, Edit, Glob, Grep]
pulse_reminder: a wiki page whose cited code paths are gone is drifting against ground truth, not just the clock. Reconcile vs the codebase, don't just decay confidence.
---

# wiki-refresh

Ground-truth maintenance for `wiki-memory`: reconciles a page against the *current codebase* and takes an action.

Division of labor:
- `write-gate` — what enters the wiki.
- **`wiki-refresh`** — whether a page still matches reality (heavier, monthly / post-refactor / pre-audit). `lint --strict` flags stale `verified:` dates between runs.

## Two modes

| Mode | When | Behavior |
|------|------|----------|
| **interactive** (default) | human present | ask only on genuinely ambiguous calls; lead with a recommendation |
| **headless** (`mode:headless`) | automation / cron | apply unambiguous actions; mark ambiguous as stale; print a report. Never write a Replace successor unattended. |

## Signal sources (read these first — don't eyeball the tree)

Run all three, then reason over the union:

```bash
python3 skills/wiki-memory/tools/wiki.py --root wiki audit-refs          # code-grounded: pages whose cited paths vanished
python3 skills/wiki-memory/tools/wiki.py --root wiki lint --strict        # broken links, stale verified, duplicate titles, supersession gaps, contradictions
graphify query "<page subject>"   # OR Grep — confirm where the code lives NOW (see index-first)
```

`audit-refs` returns `drifted[]` with `missing_refs`, `present_refs`, `signal` (`some-refs-gone` | `all-refs-gone`), `age_days`, `protected`. That is the primary drift evidence — a path the page cites that no longer exists on disk.

**`protected: true` pages** (type ∈ error/lesson/sop/procedure, or `L3_sops/`) report drift but are not auto-actioned — a lesson stays protective even when its example code is gone. Surface, never auto-delete.

## Scope

Default: all material pages (`L2_facts/`, `concepts/`, `patterns/`, `projects/`, `queries/`). Exclude `raw/` (immutable), index/log/schema/L0/L1, and support dirs. A scope hint (module, dir, tag, filename) narrows via `wiki.py search` first.

## Investigate (per candidate)

A page drifts on independent axes — check each, don't stop at the first:
- **refs** — do cited paths still exist? (`audit-refs` answers this)
- **solution** — does the page's recommendation still match how the code works *today*? A renamed file with a different implementation is not a path rename.
- **links / supersession** — are `[[wikilinks]]` and `superseded-by` still consistent? (`lint --strict`)
- **cross-page** — does another in-scope page now make an incompatible claim about the same subject?

Match depth to specificity: a page citing exact paths + snippets needs more verification than one stating a general principle. Age alone is **not** drift — a 2-yr-old page that still matches code is Keep.

## The five outcomes

| Outcome | When | Action |
|---|---|---|
| **Keep** | accurate + useful | no write (don't churn for a breadcrumb) |
| **Update** | refs/paths/links drifted, core claim still correct | `Edit` the page in place; bump `updated:` and `verified:` to today |
| **Consolidate** | two pages cover the same subject, both correct, one subsumes the other | merge unique content into the canonical page, then delete the subsumed one (git is the archive); fix inbound `[[links]]` |
| **Replace** | the page's claim is now *misleading* — implementation/architecture changed | write the successor (new page via `wiki.py new`), set `supersedes:`/`superseded-by:` both directions, delete or leave old superseded. **Headless: mark stale instead, never auto-write a successor.** |
| **Delete** | code gone **and** problem domain gone **and** no substantive inbound links | delete the file |

**Update vs Replace boundary (the rule that matters):** if you find yourself rewriting the *claim/solution* section, it's Replace, not Update. Update only touches references.

**Retrieval-Value Test (the Consolidate gate):** before merging two *correct, overlapping* pages, ask — *would a maintainer searching 6 months out be better served by two separately-findable pages, or by one (and merely spared the drift risk between them)?* Consolidate only when one genuinely subsumes the other, or the split adds drift risk without distinct retrieval value. Keep them separate when each answers a different query a future searcher would actually issue. Prevents both over-consolidating distinct sub-problems and under-consolidating true duplicates. (Port of EveryInc ce-compound-refresh Phase 1.75.)

**Before Delete, three gates (all must hold):**
1. implementation gone (cited code absent),
2. problem *domain* gone — the repo no longer deals with what the page is about (reason about the concept, don't keyword-match),
3. inbound `[[links]]` absent or only decorative ("see also"). A *substantive* citation (another page relies on this one for content) downgrades Delete → Replace or Keep-with-narrowed-scope.

Implementation-gone ≠ domain-gone: if `auth_token.rb` is deleted but the app still handles auth tokens, that's **Replace**, not Delete.

## Emit contradiction edges

When investigation finds a page that conflicts with current reality **or** with another page — and you cannot immediately resolve it (Replace evidence insufficient, or both pages partly right) — do **not** silently drop it. Record a typed edge so retrieval flags it instead of serving both as truth:

1. In the stale page's frontmatter, add the target to `contradicts: [[other-page]]` (or `[[<canonical>]]`).
2. Add the reverse edge on the other page (`lint --strict` emits `contradiction_missing_reverse` if you forget).
3. `lint --strict` then surfaces the pair on every future audit until an agent resolves it.

These contradictions become durable graph state (not just sweep-time detection): retrieval keeps flagging the pair until an agent resolves it. (Dedup-at-write and store-discoverability are `wiki-memory`'s job, not repeated here.)

## Execute

1. Apply Keep (no-op) / Update / Consolidate directly when evidence is clear.
2. Replace: interactive only (headless → stale-mark). Write successor, wire supersession both ways, re-run `lint --strict`.
3. Delete: re-check the three gates, then remove.
4. After any write: `python3 skills/wiki-memory/tools/wiki.py --root wiki index` then `lint --strict`. Resolve new broken links / missing reverse edges before finishing.
5. Append a `wiki/log.md` entry summarizing the pass.

## Stale-marking (headless ambiguous cases)

Add to frontmatter, do not guess an action:
```yaml
status: stale
stale_reason: "<what drifted / what's missing>"
stale_date: <today>
```

## Report (always print)

```
wiki-refresh — <scope>
scanned: N   kept: K  updated: U  consolidated: C  replaced: R  deleted: D  stale-marked: S
contradiction edges added: E
[per page: id — outcome — evidence (missing refs / conflicting page) — action taken]
```
In headless, split into **Applied** (writes that succeeded) and **Recommended** (writes that need a human / failed). The report is the deliverable.

## Relationship

- `wiki-memory` writes; `write-gate` gates; **`wiki-refresh` reconciles vs code**.
- Run `wiki-refresh` monthly or after a refactor/rename/migration (it costs reads).
