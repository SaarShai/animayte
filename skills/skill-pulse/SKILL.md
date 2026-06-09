---
name: skill-pulse
description: UserPromptSubmit hook that periodically re-injects active skill rules to fight instruction drift. Every N user turns (default 4), emits a <system-reminder> listing skills currently in scope and their rule summaries. Use when long sessions cause earlier-loaded skill rules to fade from effective attention.
model: haiku
effort: low
tools: [Bash, Read, Write]
auto-install: true
pulse_reminder: every N turns, re-inject active skill rules so they stay in effective attention. Curated via `pulse_reminder:` frontmatter on each skill.
---

# skill-pulse — periodic skill-rule re-anchor

## What it does

Tracks the number of user prompts in a session. Every `SKILL_PULSE_EVERY` prompts (default 4), emits a compact `<system-reminder>` block on stdout listing the rules of all currently-active skills that opted in to pulsing.

UserPromptSubmit hooks are stdout-prepended to the next model turn — Anthropic docs verified — so the reminder lands in the model's context right after the user's message, where it has maximum attention weight.

## Why it exists

Skills load on trigger; their full body is read once and then buried in context. As the session grows past a few dozen turns, the rules fade from effective attention. Symptoms:

- `caveman-ultra`-active session gets gradually verbose, with hedging and soft closings creeping back in
- `verify-before-completion`-active session ships "done!" claims without running the verification command
- A "use Edit, not Write" rule from system context slips back to Write

This is **compliance decay** — distinct from in-loop *tool-call* looping (a separate failure mode, left to host loop-protection). Different mechanism, different fix.

## Empirical basis

Calibrated against arXiv [2510.07777](https://arxiv.org/html/2510.07777) ("Drift No More?"), which tests reminder injections at turns 4 and 7 of 10-turn agent conversations and reports:

- KL divergence reductions of **6.45 – 11.81%** across models
- Judge-score improvements of **+0.5 – 0.6 points on a 5-point scale** (16 – 27% relative)
- Drift visible by turn 2 – 3; stabilizes at a "noise-limited equilibrium" rather than a fixed plateau
- Late-turn drift resumes after intervention, so continued pulses (not a single one) are required

The paper does **not** test phrasing variation or compare cadences. The defaults here (cadence 4, fixed text) are the most paper-validated configuration; variations are env-knob territory.

## Install

Claude Code (project-local):

```bash
bash skills/skill-pulse/tools/install.sh --project
```

Wires `tools/hook.sh` into `.claude/settings.json` under `UserPromptSubmit` with matcher `*`.

## How a skill opts in

The pulse is **curated, not noisy** — a skill participates iff its `SKILL.md` frontmatter has a `pulse_reminder:` field. Example:

```yaml
---
name: caveman-ultra
description: Terse output style ...
pulse_reminder: terse output — drop filler, hedging, pleasantries, and soft closings.
---
```

Skills without `pulse_reminder` are silent in pulses. This keeps the reminder block tight and prevents passive-hook skills (like `context-keeper`) from cluttering it.

Override at runtime: set `SKILL_PULSE_SKILLS=name1,name2` to force-include skills (their `description` first sentence is used as fallback content).

## Tuning

Environment variables (all optional):

- `SKILL_PULSE_EVERY` — cadence in user prompts. Default `4`. Floored to `2`.
- `SKILL_PULSE_DISABLED=1` — global off-switch.
- `SKILL_PULSE_SKILLS=a,b` — manual allowlist override (uses `description` fallback for skills without `pulse_reminder`).
- `SKILL_PULSE_STATE_DIR` — override state dir. Default `.brainer/skill-pulse/`.
- `SKILL_PULSE_SKILLS_ROOT` — override skills lookup root. Default `.claude/skills/`.

## Rules

- Pulse only on turns where `turn_count % cadence == 0` and `turn_count >= cadence`. Cold start is silent.
- Cap at `MAX_SKILLS_IN_PULSE = 8` entries per pulse to keep payload tight.
- State updates are `fcntl.flock`-guarded (UserPromptSubmit is usually serial but cheap insurance).
- Hook MUST exit 0 on every input — a failing UserPromptSubmit would block the user's prompt.

## Files

```
tools/
├── hook.sh        # UserPromptSubmit shell shim
├── hook.py        # turn counter + skill discovery + reminder builder
├── install.sh     # wires UserPromptSubmit into project-local .claude/
└── test.sh        # unit-gap regression suite
```

## Compatibility

**Claude Code only.** `UserPromptSubmit` is a Claude-Code-specific hook event (Codex/Cursor/Gemini don't fire it). The top-level `./install.sh` still symlinks the folder into all four host dirs so the description shows in skill indexes; only the Claude Code installer wires the actual hook.

## Reliability contract

Always exits 0. Verified edge cases:

- empty stdin
- malformed JSON
- missing session_id
- corrupt state file
- state dir unwritable
- no .claude/skills directory
- skill SKILL.md files with malformed frontmatter

Errors are logged to stderr with ISO timestamps; the user's prompt proceeds.

## Lineage

- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — adjacent: in-loop loop detection (a different failure mode; left to host loop-protection)
- [Cline Focus Chain](https://docs.cline.bot/features/focus-chain) — closest production analog (re-injects every 6 messages) but pulses todos, not skill rules
- [Cursor `alwaysApply: true`](https://forum.cursor.com/t/alwaysapply-true-rules-are-being-completely-ignored-now/158551) — every-prompt re-inject, widely reported failure mode in long sessions
- [delta-hq/cc-canary](https://github.com/delta-hq/cc-canary) — forensic drift detector (offline post-hoc), no in-loop intervention
- [anthropics/claude-code#22421](https://github.com/anthropics/claude-code/issues/22421) — closed feature request documenting the gap this fills
- arXiv [2510.07777](https://arxiv.org/html/2510.07777) — empirical basis for timed reminders
- arXiv [2411.07037 LIFBench](https://arxiv.org/abs/2411.07037), [2402.10962](https://arxiv.org/abs/2402.10962) — instruction-stability benchmarks
- [Michaelliv/pi-system-reminders](https://github.com/Michaelliv/pi-system-reminders) — reactive system-reminders SDK (related but condition-triggered, not periodic)

## Known gaps (v1)

- No drift detector. A `Stop` hook scanning recent assistant messages for per-skill drift signals (`caveman` verbosity, `done!`-without-verify, etc.) is the natural v2 (`compliance-canary`).
- Phrasing is fixed per pulse — the paper didn't validate rotation, but Cursor's failures suggest variation might help in *very* long sessions. Add only if measurement shows degradation.
