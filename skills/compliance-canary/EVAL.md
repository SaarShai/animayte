# compliance-canary — eval status

**Status:** v1.5.1. Hook correctness verified by [tools/test.sh](tools/test.sh) (25 cases including code-block false-positive guard and multi-probe cooldown interleaving); offline drift baselining via [tools/measure.py](tools/measure.py); multi-hook chaining with `skill-pulse` verified live; canary p99 latency 41 ms on a 400-line synthetic transcript.

## Verified — unit

See [tools/test.sh](tools/test.sh). Headline cases:

- Each detector kind triggers when it should and stays silent when it shouldn't
- Anti-spam cooldown suppresses repeat fires
- Custom regex + custom claim_pattern honored
- Bootstrap probes (`caveman-ultra` filler + word-creep, `verify-before-completion` unverified-done) fire on synthesized transcripts
- Malformed `drift_probes.json` → skill skipped, hook proceeds
- Empty / missing transcript → silent
- Two sessions interleaved → independent probe-history
- 10 parallel invocations → state-locked
- State GC at session-start

## Verified — live e2e

**Run 1 — canary detects and the model adapts.** `claude -p` haiku session, 2 turns:

- Turn 1 prompt induced "Certainly! ... I'd be happy to ... Sounds good ... Looking forward to collaborating" — 70 words of filler.
- Turn 2 (resume): hook fired, transcript records the corrective as `attachment.type="hook_success"` with the full `<system-reminder>` referencing `caveman-ultra [forbidden_regex]`.
- **Model response on turn 2: "Acked. I understand." (3 words.)** The corrective demonstrably changed behavior.

**Run 2 — multi-hook UserPromptSubmit chaining.** Same project with BOTH `skill-pulse` and `compliance-canary` wired to UserPromptSubmit. Single user prompt where state was primed so both hooks should fire (skill-pulse at turn 4, canary fresh with prior filler in transcript):

| Hook | Fired | Bytes emitted | Attachment in transcript |
|---|---|---|---|
| skill-pulse | ✓ | 769 | ✓ |
| compliance-canary | ✓ | 541 | ✓ |

Canary's `probe_history` logged two probes firing simultaneously (`caveman-ultra:filler-phrases` + `verify-before-completion:claim-without-evidence`). Both hooks' stdout was captured by Claude Code; no clobbering.

## Verified — latency

n=100 invocations against a synthetic 400-line transcript with 2 active probes (forbidden_regex + word_count_per_message):

| min | p50 | p95 | p99 | max | mean |
|---|---|---|---|---|---|
| 34.0 ms | 36.2 ms | 39.5 ms | 40.9 ms | 41.9 ms | 36.7 ms |

Comparable to `skill-pulse`. Python cold-start dominates; transcript scan + regex are in the noise.

## Verified — measure.py paths

- Single file, human-readable output ✓
- Multi-file `--summary` (no per-fire details, totals only) ✓
- Glob expansion (`*.jsonl`) ✓
- `--json` produces parseable JSON ✓
- Nonexistent file gracefully skipped, others still processed ✓

## What this gives you that nothing else does

- [delta-hq/cc-canary](https://github.com/delta-hq/cc-canary) reads transcripts **offline** and reports drift after the fact. Useful for analysis, useless mid-session.
- Cursor `alwaysApply` re-injects the same rule every turn, regardless of whether the rule was followed.
- `skill-pulse` re-anchors unconditionally every N turns.

`compliance-canary` is the only piece that **detects drift in the running session and intervenes with a targeted, evidence-quoting reminder**.

## Offline measurement (addresses out-of-scope item 2)

`tools/measure.py` runs the production detectors against any transcript JSONL with no side effects:

```bash
python3 tools/measure.py ~/.claude/projects/<proj>/<sid>.jsonl
python3 tools/measure.py ~/.claude/projects/*/*.jsonl --summary
```

Lets a user:

1. **Baseline before installing** — measure how much drift their existing sessions show
2. **Tune thresholds** — adjust `word_count_per_message.threshold` based on actual session distributions
3. **Validate new probes** — sanity-check a new regex against past transcripts before declaring it in `drift_probes.json`
4. **A/B compare** — run measure.py on sessions captured pre-install vs. post-install to quantify uplift

The data plan for in-the-wild measurement (paper-style):

1. Capture N=50+ long sessions (>20 turns) without the hook → baseline drift rates per probe
2. Install hook, capture N=50+ matched sessions → post-install drift rates
3. Compare trigger-rate distributions; expected outcome: probe trigger rates drop because the corrective text reduces repeat violations within a session

## Self-test

```bash
bash skills/compliance-canary/tools/test.sh
```

## Out of scope

- LLM-judge probes (semantic, not syntactic). Cleanest v2 add.
- Edit-vs-Write tool-choice drift detector. Easy v2 add.
- Cross-session drift trends (week-over-week regression in a project). Belongs in `wiki-memory` long-term, not here.
