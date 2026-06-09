# cache-lint — EVAL

## What it does

Static linter for prompt-cache hygiene against Anthropic's six prompt-cache rules. Reads `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.claude/settings*.json` / `skills/*/SKILL.md`, applies six rule-checkers, emits typed findings + exit codes.

## Lineage

[ussumant/cache-audit](https://github.com/ussumant/cache-audit) (52★) — same six-rule framing. Brainer ports it as a precheck skill rather than a post-hoc CLI.

## Rule coverage

| # | Rule | Detection | Confidence |
|---|---|---|---|
| 1 | Stable ordering | mtime + heading-position fingerprint | medium (catches reorderings since last audit) |
| 2 | No dynamic content | regex for `$(…)`, `{{env.X}}`, wall-clock, RNG, hostname, session-shaped tokens | high on FAILs (inline-code typography exempted) |
| 3 | Tool stability | SHA256 of `skills/*/SKILL.md` descriptions | medium (catches drift since last audit) |
| 4 | Model switching | scan for `"model": "..."` across hook configs | high |
| 5 | Breakpoint sizing | byte-size heuristic (token estimate /4) | medium |
| 6 | Fork safety | scan terminal-hook commands for prefix-file writes | high |

Backtick command substitution (`` `date` ``) is intentionally not checked — see SKILL.md "What it does NOT do".

## Built-in tests

`python tools/test_cache_lint.py` — 8 tests:

- clean project passes
- `$(date)` and `{{env.USER}}` flagged as FAIL
- inline-code typography (`` `CLAUDE.md` ``) not flagged
- dynamic content inside ``` fence ``` downgraded to WARN
- tiny CLAUDE.md triggers Rule 5 WARN
- multi-model settings trigger Rule 4 WARN
- Stop hook writing CLAUDE.md triggers Rule 6 FAIL
- fingerprint baseline creates, then catches description drift

## Real-world calibration

Run against Brainer itself: 0 FAIL, 3 WARN. The WARNs are legitimate: `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` are deliberately tiny pointer files (~56 tokens each), trading cache-slot efficiency for progressive-disclosure. Documented and accepted in [`eval/FINDINGS.md`](../../eval/FINDINGS.md).

## Target metrics

For external eval:

- **True-positive rate** on a hand-labeled set of 20 Claude Code projects with known cache-bust patterns. Target: ≥80%.
- **False-positive rate** on the same projects. Target: ≤10%. The dropped backtick check was a direct response to FP overhead.
- **$/session impact** when paired with `vnmoorthy/ccmeter` telemetry on a project before/after fixing FAILs. Target: ≥30% cache-hit-rate uplift on a project that previously had a Rule 2 or Rule 6 FAIL.

## Known limits

- Doesn't catch MCP-provided tool drift (tools aren't in the repo).
- Doesn't catch dynamic content injected by hooks at runtime (only static files).
- Fingerprint baseline is per-project; can't compare two projects.
- 4-chars-per-token estimate (Rule 5) is rough — fine for "tiny vs huge" but not for precise sizing decisions.
