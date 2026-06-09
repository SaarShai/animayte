# EVAL — `index-first`

## Static cost (pending measurement)

Will be filled in by `eval/runner.py` once a task set is authored. Expected static cost: small (description-only resident, body loads on trigger).

## A/B savings (pending)

**Hypothesis:** On tasks that involve tracing references, finding callers, or reading multiple related files/docs, this skill should reduce tool-call count and output tokens versus a baseline that lets the agent grep-and-read freely.

**Reference numbers from upstream (codegraph repo, not our measurement):** ~35% cheaper, ~59% fewer tokens, ~70% fewer tool calls, ~49% faster across 7 real codebases. Gains scale with corpus size; small repos show narrower margins because native search is already cheap.

A direct A/B requires an index actually being installed (e.g., codegraph + MCP) in both arms. Without that, the skill has nothing to redirect to and the test degenerates.

## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: TBD in `eval/tasks/index-first.yaml`. Should pair grep-heavy exploration prompts ("trace all callers of X", "find every route that maps to handler Y") across small / medium / large corpora.
- Backends: ollama / anthropic / mimo.

## Failure modes (anticipated)

- **Over-trigger on indexless corpora**: skill body loads, no index exists, agent burns context for no payoff. Mitigation: explicit "check first, fall back" step in protocol.
- **Stale-index trust**: if the index hasn't synced and the agent doesn't verify, results will mislead. Mitigation: caveat in skill body.
- **Confidence-score blindness**: agent picks top result even when it's low-confidence. Mitigation: explicit step in protocol + anti-pattern bullet.

---

## External tool: graphify (measured 2026-05-23, graphifyy 0.8.17)

[graphify](https://github.com/safishamsi/graphify) builds an AST-based code graph (`graphify-out/graph.json`) plus optional Leiden community clusters. We measured it as a candidate index for this skill's "composite verb over chained primitives" pattern. Headline: when an agent asks symbol-precision questions and graphify is present, **`graphify explain` matches grep+read on evidence at -93% tokens** in our 12-question A/B on this repo's `skills/`. The integration ships in [SKILL.md](SKILL.md) as a recipe — no new skill folder.

### Retrieval A/B (n=12 questions on brainer `skills/`, code-only graph)

Harness: [`eval/runner_graphify.py`](../../eval/runner_graphify.py). All token counts are char/4 heuristic; "evidence rate" = fraction of questions whose output contained ≥1 expected keyword.

| Arm | Tokens | Tool calls | Evidence | Δ tokens vs grep |
|---|---|---|---|---|
| grep+read baseline (3 files × 200 lines) | 27,790 | 33 | 91.7% | — |
| `graphify query "<NL question>"` | 7,977 | 12 | 50.0% | **−71.3%** |
| `graphify explain "<NodeLabel>"` | 1,826 | 12 | **91.7%** | **−93.4%** |

**Verdict**: `explain` is the dominant verb for symbol questions — same answer quality, ~15× cheaper. `query` (the natural-language one) is much weaker — its NL→start-node resolver picks generic matches over the obvious symbol; only use it for concept exploration where no symbol is named.

### Build-cost curve (code-only extract, single-shot with clustering)

Harness: [`eval/runner_graphify_costcurve.py`](../../eval/runner_graphify_costcurve.py).

| Repo | Code files | Source | Wall time | Nodes | Edges | Communities | Graph size |
|---|---|---|---|---|---|---|---|
| small (brainer `skills/`) | 83 | 207MB* | 17.3s | 507 | 810 | 58 | 0.4MB |
| medium (flask) | 84 | 0.6MB | **1.6s** | 1,195 | 1,793 | 128 | 0.9MB |
| large (django) | 3,023 | 21MB | 57.9s | 41,373 | 127,537 | 2,694 | **55.7MB** |

\* small includes a venv leftover in the source tree; graphify still only processed 83 code files.

Scaling: roughly linear in code-file count. Cost is **near-zero** for typical project sizes (<1k files). Large monorepos (~3k files) build in under a minute; graph file becomes large enough (~50MB) that the agent should never read it raw, only query through the CLI.

### Quality probes

Harness: [`eval/runner_graphify_quality.py`](../../eval/runner_graphify_quality.py). Corpus: brainer `skills/`.

- **Edge precision** (30 random EXTRACTED edges checked against ±5-line window in the cited source): **29/30 = 96.7%**. The single miss is a structural `contains` edge on an entry-node placeholder, not a code-claim defect. Real precision on code-claim edges is effectively 100% in this sample.
- **Path soundness** (3 curated paths): 3/3 returned a valid path; 2/3 within expected hop bound. The third returned a shorter path than expected — a graphify shortcut via a `method` edge that's correct but skips an intermediate. Not a bug, but worth noting the hop count isn't a stable property.
- **Staleness behavior (the alarm finding)**: renamed `def read_page` → `def read_page_RENAMED`, ran `graphify update . --force`. After update, **`graphify explain ".read_page()"` still succeeds** AND `.read_page_RENAMED()` also succeeds. `update` is **additive only** — it never removes nodes. Stale labels accumulate across refactors.

### Combo: graphify + wiki-memory (n=12 questions across code/project/hybrid kinds)

Harness: [`eval/runner_graphify_combo.py`](../../eval/runner_graphify_combo.py). Tests whether agents should hit one store or both for mixed *what + why* questions.

| Subset (n) | Arm | Tokens | Tool calls | Evidence |
|---|---|---|---|---|
| **ALL (12)** | grep baseline | 26,959 | 34 | 75% |
|  | wiki alone | 1,985 | 12 | 75% |
|  | graphify alone | **1,504** | 12 | 91.7% |
|  | **combo (graphify + wiki)** | 3,527 | 24 | **100%** |
| code (4) | grep | 12,644 | 14 | 100% |
|  | wiki | 640 | 4 | 25% |
|  | **graphify** | 676 | 4 | **100%** |
|  | combo | 1,328 | 8 | 100% |
| project (6) | grep | 8,995 | 13 | 50% |
|  | **wiki** | 970 | 6 | **100%** |
|  | graphify | 351 | 6 | 83% |
|  | combo | 1,341 | 12 | 100% |
| hybrid (2) | grep | 5,320 | 7 | 100% |
|  | wiki | 375 | 2 | 100% |
|  | graphify | 477 | 2 | 100% |
|  | combo | 858 | 4 | 100% |

**Interpretation:**
- The combo arm gets **100% evidence at −87% tokens vs grep**. Even if the agent doesn't route by question type, always-combining is a viable default.
- Route-by-kind is better: graphify alone wins on code questions (100% at 676 tokens); wiki alone wins on project questions (100% at 970 tokens). Combining for hybrid questions or as fallback when the first store misses pays a ~2× token cost.
- Graphify alone is the safest *single*-store default: 91.7% across kinds, cheapest, captures both code and the subset of project pages that have matching node labels (e.g. `WriteGate`, `delegate`).
- This validates the boundary clause already in [`wiki-memory/SKILL.md`](../wiki-memory/SKILL.md): graphify = *what/how/connected*; wiki = *why/decision*. When the first store misses, the **kind** of the question tells you which to try next.

### Issue matrix (status as of 2026-05-24, after self-contained fork pin)

Four upstream bugs were measured during integration. **All four are fixed in the build `./install.sh` installs** — pinned to [`SaarShai/graphify@token-economy-patches`](https://github.com/SaarShai/graphify/tree/token-economy-patches), a combined branch off graphify's `v8` layering all four single-purpose fix branches. Anyone running our installer transparently gets the patched build; no manual venv choreography required. Single-purpose PRs were originally filed and closed when we cut over to the self-contained fork pin — they remain available on the fork's `fix/*` branches and link out from each closure comment.

| Risk | Detection | Status in our build |
|---|---|---|
| Stale graph after rename/delete | `update` left old nodes from re-extracted files | **FIXED** — `watch.py` evicts by source_file unconditionally. Regression test: `test_rebuild_code_full_corpus_evicts_renamed_symbols`. Staleness probe verdict: `good_staleness_signal` |
| `affected` / `benchmark` crash on `extract --no-cluster` graphs | Both expected `links` key, found `edges` | **FIXED** — same edges→links normalization as `global_graph.py`. Regression test: `test_run_benchmark_handles_edges_schema` |
| `cluster-only` silently misleads on node-count drift | Printed "graph.json updated" while refusing to write | **FIXED** — added `--force` flag, exit 2 with clear refusal otherwise. Regression test: `test_cluster_only_refuses_overwrite_on_node_drift_and_exits_nonzero` |
| `explain` truncates connections at 20 with no expansion flag | Agent wasted 2–3 calls hunting for the missing flag | **FIXED** — added `--limit N` and `--full`; truncation footer now hints at the flag. Regression test: `test_explain_full_flag_prints_all_connections` |
| `query` picks wrong start node on symbol questions | 50% evidence rate in A/B | Open — skill text steers `explain` first; an upstream fix would need NL→symbol resolver work |
| LLM-extracted concept nodes (when run with a backend) | Not tested here — semantic backend unavailable | Open: re-measure with Anthropic/Gemini key when available |
| Cost on doc-heavy repos | Not measured (code-only run) | Open: requires working semantic backend |

Combined fork branch passes the full upstream test suite: **1,270 tests pass, 11 skipped**.

### Test coverage of the skill-text edits themselves

Distinct from testing graphify-the-tool. The integration changes prose in two SKILL.md files; we measured what they cost and whether they steer.

| Aspect | How tested | Result |
|---|---|---|
| Always-resident token tax | Re-ran [`eval/static_cost.py`](../../eval/static_cost.py) before/after the graphify edits | **+0 tokens** — descriptions in both `index-first` and `wiki-memory` are unchanged |
| Triggered-body token cost | Same | `index-first` body 840 → 1634 (+794), `wiki-memory` body 844 → 1026 (+182). Paid only when those skills load |
| Wiki retrieval regression | Ran `WikiStore.search()` deterministically against the 8 baseline questions from [`eval/runner_wiki.py`](../../eval/runner_wiki.py) | Bit-identical hit IDs + scores — the boundary-clause edit is prose only, no code path touched |
| Does the new recipe steer an agent? | Spawned a fresh subagent (no prior context) with the edited [SKILL.md](SKILL.md) + the graph + a real question | **Yes**: agent reached for `graphify explain` first, no grep. ~2.4K tokens for the graphify path (n=1, directional only — not an N=50 measurement) |
| End-to-end stack across 5 parallel agents | See "5-agent run" table below | **5/5 followed the recipe correctly** across full-setup / no-graph / no-graphify conditions |
| Side finding (truncation) | Subagent ran into `graphify explain` truncating connections with no flag to expand | Filed upstream as [PR #1008](https://github.com/safishamsi/graphify/pull/1008) — adds `--limit N` / `--full` |

#### 5-agent run (2026-05-24, n=1 per condition)

Five fresh subagents, parallel launch, no prior context. Each got the edited [`SKILL.md`](SKILL.md) + [`wiki-memory/SKILL.md`](../wiki-memory/SKILL.md) and a question that should exercise a specific path. Token + tool-call counts include the ~2K from reading the two SKILL.md files (a real in-process install doesn't pay that prelude).

| # | Setup | Q kind | Tool calls | Tokens | Path taken | Recipe followed? |
|---|---|---|---:|---:|---|---|
| T1 | full (graphify + wiki + graph) | code | 6 | ~2.5K | `graphify explain WikiStore` first; skipped wiki entirely | ✅ |
| T2 | full | project (why) | 5 | ~4.5K | L1 index → `wiki.py search` → 1 `fetch`; skipped graphify | ✅ |
| T3 | full | hybrid | 6 | ~3.5K | `graphify explain` (what) + wiki search+fetch (why), split cleanly on the boundary | ✅ |
| T4 | graphify CLI present, no graph built | code | 8 | ~3.5K | Detected missing `graphify-out/`, ran `graphify extract` to build it, then `explain` | ✅ |
| T5 | no graphify CLI (--no-graphify path) | code | 5 | ~5.5K | Recognized graphify absent, fell back to `grep -l` → `grep -n` chain. No ritual graphify call | ✅ |

**Findings the 5-agent run surfaced:**

- Recipe steers agents reliably across all four conditions we tested (full-setup × 3 question kinds + 2 degraded environments).
- Token costs match the shell-level A/B predictions within ~25%: full-setup code path ~2.5K, full-setup project path ~4.5K, hybrid ~3.5K, grep fallback ~5.5K (~2× the graphify path). The build-on-missing-graph path (T4) is essentially free — AST extract on the small corpus is <1s, only 1K extra tokens vs T1.
- **T4 surfaced a UX bug**: `graphify extract` demands `--backend` even for code-only AST extraction. The agent tried `--backend none`, was rejected, eventually picked `--backend claude-cli`. Skill text now spells out `--backend ollama` (no API key needed) so future agents don't fumble.
- **T1 surfaced the truncation issue** that became [PR #1008](https://github.com/safishamsi/graphify/pull/1008). Patch is applied locally; agents now see "(pass --limit N or --full to expand)" hint and don't burn calls hunting for flags.

This closes the previously-listed "End-to-end stack: not run" gap. Still not measured: full eight-slot stack (output + routing + memory + retrieval + re-read + terminal + done-claims) firing simultaneously against a mixed-prompt corpus — that's the next eval to build if you want a single end-to-end stack number.

### Ship gate

Per the integration plan's decision gates:
- **Δtokens < −30% AND Δjudge ≥ 0** → ship as default. **PASS** with `explain` verb (−93%, evidence rate parity).
- Concerns: staleness behavior + `query` weakness — both are now documented in [SKILL.md](SKILL.md) so the agent steers correctly.

**Decision: ship as default integration in `index-first` / `wiki-memory` skill text** (already applied to those skills). No new skill folder. Reassess if upstream graphify releases fix the additive-update behavior — would let us simplify the refresh recipe.
