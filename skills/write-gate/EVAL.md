# write-gate — EVAL

## Mechanism in one line

Score candidate text on signal features (decisions / errors / architecture / code / numbers / entity overlap, minus filler / speculation); reject if below threshold; additionally reject decision-class facts that lack a why-clause.

## Published numbers from lineage projects

| Source | Reported |
|---|---|
| [ogham-mcp/ogham-mcp](https://github.com/ogham-mcp/ogham-mcp) | 91.8% QA, 97.2% R@10 on LongMemEval with signal-score lifecycle (FRESH→STABLE→EDITING + 5%/30d decay) |
| [codenamev/claude_memory](https://github.com/codenamev/claude_memory) | 100% truth-maintenance on a 100-case FEVER-derived test set; why-clause requirement is core to that result |

## Built-in smoke tests

`python tools/test_write_gate.py` — 7 tests covering:

- decisions without why-clause are rejected
- decisions with why-clause pass
- pure filler / recap is rejected
- concrete error+fix passes
- architecture + code + numbers passes
- pure speculation is rejected
- entity-overlap is capped at +1.5 (cannot single-handedly satisfy the gate)

## Project-local A/B (target)

Once write-gate is wired into `wiki-memory`'s `new` path:

- **Acceptance rate** — fraction of candidate writes that pass. Target: 50–70%. Higher means the gate is too loose; lower means we're starving the wiki.
- **Retrieval evidence-rate** — measured by existing `runner_wiki.py`. Target: no drop vs the pre-gate baseline, ideally a small uptick from less noise in the index.
- **Page-creation rate** — pages added per session. Target: down ≥40% with no drop in evidence-rate.

Status: design + smoke tests shipped; project-local A/B pending the wiki-memory integration commit.

## Anti-falsifications

- If acceptance rate falls below 30% in real use, the threshold is too high. Lower to 2.5 and re-run.
- If retrieval evidence-rate drops despite acceptance staying healthy, the gate is rejecting useful facts — likely the speculation / filler weights are over-aggressive. Inspect rejected candidates for false positives.
- If the wiki accumulates decisions WITHOUT reasons over a 50-page sample, the why-clause check is being bypassed. Trace `wiki/log.md` for override entries.

## Known limits

- Heuristic regex / phrase matching; cannot catch a decision phrased entirely in metaphor.
- English-only. Phrase tables would need translation for non-English wikis.
- No semantic novelty check — a write that scores high but duplicates an existing page still passes the gate. Dedup is `wiki-memory`'s job.
