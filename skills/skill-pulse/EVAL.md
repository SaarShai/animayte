# skill-pulse — eval status

**Status:** v1.5.0. Hook correctness verified by [tools/test.sh](tools/test.sh) (24/24 cases, including corrupt-state recovery and flock-safe concurrent invocations — both read state by the hook's SHA-256(session_id)[:16] filename); in-the-wild compliance-uplift measurement pending.

## Empirical basis (not our measurement — published)

arXiv [2510.07777](https://arxiv.org/html/2510.07777), "Drift No More?", tests reminder injections at turns 4 and 7 of 10-turn agent conversations:

| Model | KL drop | Judge score (5-pt scale) |
|---|---|---|
| LLaMA-3.1-8B | 5.827 → 5.392 (-7.5%) | 2.837 → 3.302 (+0.46) |
| Across models | 6.45 – 11.81% | +0.5 – 0.6 (+16 – 27%) |

The paper does NOT compare cadences (only tests turns 4 + 7), does NOT compare formats (only "restate the goal"), and does NOT test rotated phrasings. The v1 defaults here (cadence=4, fixed text) are the most paper-validated configuration.

## Posture: opt-in, do not re-promote without a measured cadence sweep (2026-06-06 SOTA scan)

skill-pulse is the **unconditional-periodic** anti-drift pattern. A SOTA scan (see `wiki/log.md`) found the practitioner/vendor consensus is **reactive > periodic**: Claude Code's own drift defense fires on conversation-state conditions, not a fixed cadence ([michaellivs.com teardown](https://michaellivs.com/blog/system-reminders-steering-agents/)), and Anthropic's guidance is to *curate/shrink* context, not blanket-re-inject ([effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Worse, the host **already** ships a periodic `<system-reminder>` task-nudge, so skill-pulse partially duplicates a built-in (and over-injection is a filed anti-pattern). Context-rot + lost-in-the-middle findings say the active ingredient is *recency-slot placement*, not periodicity. **Therefore:** keep opt-in (`auto-install: false`); re-promote only after a measured cadence sweep on THIS catalog beats the host baseline. Leaner alternative on the table: fold the rule-re-anchoring into `compliance-canary` as a *reactive* "rule-staleness" probe (one reactive hook instead of two). The reactive hook (`compliance-canary`) is the better-shaped anti-drift bet — it should run its `measure.py` on ~20 real >20-turn transcripts before re-promotion.

## What to measure in this catalog

Compliance decay is a session-length phenomenon — most sessions are too short for it to matter. The measurement plan:

1. **Decay baseline** — instrument long sessions (>20 turns) with the hook in log-only mode. Per active skill, define a simple drift signal (caveman: words/msg slope; verify-before-completion: ratio of "done"-claims with prior tool_use). Plot drift trajectory.
2. **Pulse uplift** — re-run the same task corpus with the hook in normal mode. Compare drift signals turn-by-turn. Target: 15%+ improvement on caveman word-count slope post-turn-10.
3. **False-load rate** — fraction of pulses where the user's next reply indicates the reminder was unwanted ("yes I know"). Target: <5%.
4. **Cadence sweep** — at scale, test cadence ∈ {3, 4, 6, 8} against the same corpus. Pick the lowest-cost cadence that retains 80%+ of the uplift.

## Verified — unit (test.sh)

See [tools/test.sh](tools/test.sh) for the full list. Headline cases:

| Check | Result |
|---|---|
| Pulse fires on turn 4 (default cadence), silent on 1-3 | ✓ |
| Pulse fires again on turn 8, 12, ... | ✓ |
| `SKILL_PULSE_EVERY=2` doubles cadence | ✓ |
| `SKILL_PULSE_EVERY=1` clamps to floor=2 | ✓ |
| `SKILL_PULSE_DISABLED=1` → never fires | ✓ |
| `SKILL_PULSE_SKILLS` allowlist override | ✓ |
| Skill with `pulse_reminder` → included | ✓ |
| Skill without `pulse_reminder` and not in allowlist → excluded | ✓ |
| Allowlist + no `pulse_reminder` → falls back to description first sentence | ✓ |
| Skills dedup by `name:` field across multiple SKILL.md files | ✓ |
| Pulse caps at MAX_SKILLS_IN_PULSE=8 | ✓ |
| No .claude/skills dir → silent | ✓ |
| Empty / malformed stdin → exit 0 | ✓ |
| Corrupt state file → recover, exit 0 | ✓ |
| Unwritable state dir → exit 0 + stderr log | ✓ |
| Two-session isolation (independent turn counts) | ✓ |
| State GC at session-start: 8-day-old files purged | ✓ |
| Concurrent invocations → flock-safe | ✓ |

## Verified — live e2e

`claude -p` 8-turn conversation with skill-pulse installed:
- Pulse JSONL `<system-reminder>` appears in the transcript after user turn 4 + user turn 8
- Content includes the `pulse_reminder` lines for caveman-ultra + verify-before-completion (the two bootstrapped skills)
- No pulse on turns 1, 2, 3, 5, 6, 7 (silent confirmation)

## Self-test

```bash
bash skills/skill-pulse/tools/test.sh
```

Should print `skill-pulse test.sh: N/N PASS` at the end.

## Out of scope

- Cross-session compliance tracking (handled by `wiki-memory` / SessionStart pattern in `rohitg00/pro-workflow`)
- Per-skill drift detection (`compliance-canary` — held for v2)
- Style judging via LLM (forensic, post-hoc; see `delta-hq/cc-canary`)
- Eliminating drift entirely (the paper explicitly says interventions reduce, not remove)
