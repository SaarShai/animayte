---
name: cache-lint
description: Audit a Claude Code project for prompt-cache hygiene against Anthropic's six cache rules (ordering, dynamic-content injection, tool stability, model switching, breakpoint sizing, fork safety). Use before shipping new hooks or skills, after a costly session, or when cache-bust costs spike. Produces a typed report; exit codes signal pass / warn / fail.
effort: low
tools: [Bash, Read, Glob, Grep]
pulse_reminder: prompt cache silently dies when CLAUDE.md grows dynamic content above a breakpoint. Run cache-lint before believing cache-hit numbers.
---

# cache-lint

Static linter for prompt-cache hygiene. Reads a project's Claude Code surface (`CLAUDE.md`, `AGENTS.md`, `.claude/settings*.json`, hook configs, skill bodies) and checks for the six failure modes that silently bust Anthropic's prompt cache.

Lineage: [ussumant/cache-audit](https://github.com/ussumant/cache-audit) (52★) — same six-rule framing, applied per-project as a precheck.

## When to run

- **Before merging a new hook** that injects to UserPromptSubmit / SessionStart / PreToolUse / PreCompact.
- **After a session where you noticed cache-bust costs** — `ccmeter` or the Anthropic dashboard shows the symptom; cache-lint finds the cause.
- **As CI** on changes to `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, or anything under `skills/`.

Quick check:

```bash
python skills/cache-lint/tools/cache_lint.py audit .
```

## The six rules

| # | Rule | Failure mode | What this skill checks |
|---|---|---|---|
| 1 | Stable ordering above breakpoints | Reordering CLAUDE.md sections busts cache for every session | flags large reorderings via mtime + heading-position diff |
| 2 | No dynamic content above breakpoints | Timestamps, RNG, env-dependent strings invalidate every call | regex scan for shell substitution `$(...)`, `{{env.X}}` templates, wall-clock calls, RNG, hostname injection. Inline-code typography is exempted; matches inside fenced blocks downgrade to WARN. |
| 3 | Tool definition stability | Tool list/order/description changes ⇒ cache miss | hash skill descriptions, warn on drift since last audit |
| 4 | Model switching | Switching Sonnet ↔ Haiku ↔ Opus busts cache (per-model namespace) | scan settings + hook configs for `model:` overrides on the hot path |
| 5 | Breakpoint sizing | Very small or very large cached blocks waste cache budget | warn if CLAUDE.md > 4K tokens or < 1K (over-eager caching wastes a slot) |
| 6 | Fork safety | Mutating a prefix mid-session corrupts forks | warn on writes to CLAUDE.md / settings.json by Stop / SessionEnd hooks |

## Severity

| Severity | Exit code | Meaning |
|---|---:|---|
| OK | 0 | all rules pass |
| WARN | 1 | at least one rule flags a smell; cache might still mostly hit |
| FAIL | 2 | confirmed cache-bust pattern; expect ≥1 full-context resend per session |
| USAGE | 3 | wrong invocation |

## Protocol

1. Run `python skills/cache-lint/tools/cache_lint.py audit .` in the project root.
2. Read the report top-down. Each finding cites a rule number and a file:line anchor.
3. For each FAIL, fix or document the trade-off in `wiki/L0_rules.md`.
4. WARN findings are advisory — judgment call. Common reasonable WARNs: a CLAUDE.md just under 1K (project is new), a SessionStart hook that injects a daily-rotating tip.
5. Re-run; aim for OK before merging.

## CLI

```bash
# default: audit cwd
python skills/cache-lint/tools/cache_lint.py audit

# explicit root
python skills/cache-lint/tools/cache_lint.py audit /path/to/project

# JSON output for CI
python skills/cache-lint/tools/cache_lint.py audit . --json

# check a single rule
python skills/cache-lint/tools/cache_lint.py audit . --rule 2

# show what files would be scanned, no checks
python skills/cache-lint/tools/cache_lint.py audit . --list-targets
```

## What it does NOT do

- Doesn't read Anthropic's live cache stats — that's `ccmeter`'s job ([vnmoorthy/ccmeter](https://github.com/vnmoorthy/ccmeter)). cache-lint is **static**; ccmeter is **dynamic**. Pair them.
- Doesn't transform files. It tells you; you fix it.
- Doesn't know about MCP-server-provided tools (they aren't in the repo). Tool stability is approximated from `skills/*/SKILL.md`.
- Doesn't catch every form of dynamic content — regex heuristics only. A FAIL is high-confidence; an OK is "no smells detected," not a guarantee. In particular, legacy POSIX backtick command substitution is **not** checked — Markdown prose uses identical syntax for inline-code typography, and the false-positive rate is too high to be useful.

## Related

- [`verify-before-completion`](../verify-before-completion/SKILL.md) — same shape: evidence before claims, run before merging.
- [`compliance-canary`](../compliance-canary/SKILL.md) — complementary live-session monitor; pair with `cache-lint` for static + dynamic coverage.
- [`prompt-triage`](../prompt-triage/SKILL.md) — routes to cheaper models, but routing decisions on the *hot path* (Rule 4) are cache-busts. cache-lint flags this conflict.

## Status

Skill body + linter shipped with heuristics for rules 2, 4, 5, 6 (deterministic) and 1, 3 (mtime-based diff). Eval target: identify ≥1 cache-bust smell in 3 of 5 real-world Claude Code projects sampled.
