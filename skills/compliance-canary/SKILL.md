---
name: compliance-canary
description: UserPromptSubmit hook that scans recent assistant messages for per-skill drift signals (filler phrases, word-count creep, "done"-without-verification, custom regex). Injects a targeted corrective <system-reminder> when a probe fires. Complement to skill-pulse — pulse re-anchors unconditionally; canary intervenes only when symptoms appear.
model: haiku
effort: low
tools: [Bash, Read, Write]
auto-install: true
pulse_reminder: drift detectors are watching — your recent reply is scanned each user turn against the active skills' drift_probes.json files.
---

# compliance-canary — symptomatic drift detector

## What it does

Every UserPromptSubmit, reads the last few assistant messages and recent tool calls from the session transcript, then runs **per-skill drift probes** against them. When a probe fires, injects a targeted corrective `<system-reminder>` naming the violated rule and quoting the specific evidence.

Probes are declared by each skill in `<.claude/skills>/<skill>/drift_probes.json`. The canary discovers them on every run — no central registry.

## Why it exists

`skill-pulse` re-anchors active skill rules unconditionally every N turns. That's good for slow attention decay but spends tokens on turns where the model is actually compliant. `compliance-canary` is the **symptomatic complement**: it stays silent until measurable drift shows up in the assistant's output, then pinpoints which rule was broken and how.

Together: pulse for prevention, canary for detection.

## Probe kinds (v1)

### `forbidden_regex`

Pattern match on recent assistant text. Fires on first match in the message window.

```json
{
  "kind": "forbidden_regex",
  "id": "filler-phrases",
  "pattern": "(?i)\\b(certainly|absolutely|of course)\\b",
  "message": "filler/pleasantry phrase detected — drop hedges, soft closings",
  "severity": "warn"
}
```

Use for: style drift (caveman pleasantries, marketing fluff, "as an AI" hedges, emoji creep).

### `word_count_per_message`

Average words per assistant message over a sliding window. Fires when average exceeds threshold.

```json
{
  "kind": "word_count_per_message",
  "id": "word-creep",
  "threshold": 120,
  "window": 3,
  "severity": "warn"
}
```

Use for: terseness drift (caveman-ultra creep, explanation bloat).

### `claim_without_evidence`

Looks for claim words in the last assistant message AND checks that a verification-style tool call appears in the recent tool-use history. Fires when claim present but evidence absent.

```json
{
  "kind": "claim_without_evidence",
  "id": "unverified-done",
  "claim_pattern": "(?i)\\b(done|fixed|complete|passes|verified)\\b",
  "verify_tools": ["Bash"],
  "verify_keywords": ["test", "pytest", "make", "build", "check", "curl"],
  "lookback_tool_uses": 5,
  "severity": "warn"
}
```

Use for: verify-before-completion drift (claiming success without running a check).

## Install

Claude Code (project-local):

```bash
bash skills/compliance-canary/tools/install.sh --project
```

Wires `tools/hook.sh` into `.claude/settings.json` under `UserPromptSubmit`. Coexists with `skill-pulse` (both hooks fire in sequence under the same event).

## How a skill opts in

Drop a `drift_probes.json` file next to the skill's `SKILL.md`. Example for caveman-ultra:

```json
[
  {
    "kind": "forbidden_regex",
    "id": "filler-phrases",
    "pattern": "(?i)\\b(certainly|sounds good|i'll go ahead)\\b",
    "message": "filler phrase — drop it"
  },
  {
    "kind": "word_count_per_message",
    "id": "word-creep",
    "threshold": 120,
    "window": 3
  }
]
```

Two bootstrapped skills ship probes out of the box: `caveman-ultra` (filler-regex + word-creep) and `verify-before-completion` (claim-without-evidence). Other skills opt in over time.

## Tuning

Env vars (all optional):

- `COMPLIANCE_CANARY_DISABLED=1` — global off-switch.
- `COMPLIANCE_CANARY_COOLDOWN=3` — turns to suppress the same probe after it fires. Default 3.
- `COMPLIANCE_CANARY_STATE_DIR` — override state location.
- `COMPLIANCE_CANARY_SKILLS_ROOT` — override skills lookup root.

## Offline analyzer (`measure.py`)

Runs the same probes against any transcript JSONL without installing the hook. Useful for baselining past sessions and tuning thresholds:

```bash
python3 skills/compliance-canary/tools/measure.py ~/.claude/projects/<proj>/<sid>.jsonl
```

Prints per-probe trigger counts and the offending snippets. No state writes, no side effects.

## Rules

- Read at most `TRANSCRIPT_LINE_CAP=400` trailing lines of the transcript (bound transcript-read cost).
- Anti-spam: each probe is suppressed for `COMPLIANCE_CANARY_COOLDOWN` turns after it fires.
- Cap output at `MAX_PROBES_TRIGGERED=4` probes per pulse.
- State updates flock-guarded. Always exit 0.

## Files

```
tools/
├── hook.sh        # UserPromptSubmit shell shim
├── hook.py        # transcript reader + detectors + state
├── install.sh     # wires UserPromptSubmit into project-local .claude/
├── test.sh        # unit-gap regression suite
└── measure.py     # standalone offline analyzer (same detectors)
```

## Compatibility

**Claude Code only** — `UserPromptSubmit` is a Claude-Code-specific event. The top-level `./install.sh` symlinks the folder into all four host dirs for description visibility; only Claude Code wires the hook.

## Lineage

- [delta-hq/cc-canary](https://github.com/delta-hq/cc-canary) (65★) — direct forerunner. Forensic JSONL drift detector with no in-loop intervention. `compliance-canary` is essentially "cc-canary's probes, but in-loop and per-skill-declared."
- [`skill-pulse`](../skill-pulse/SKILL.md) — sibling skill, same hook event, complementary pattern.
- arXiv [2512.10172 — Offscript](https://arxiv.org/abs/2512.10172) — auditor LLM identifies adherence failures in 86.4% of conversations. Validates that drift is widespread and worth detecting.
- [Michaelliv/pi-system-reminders](https://github.com/Michaelliv/pi-system-reminders) — reactive system-reminders SDK; same intervention shape as this hook's output.

## Known gaps (v1)

- Detectors are syntactic — they catch keyword/structural signals but miss semantic drift (a paraphrased "done" without claim-word match). A judge-style probe using a tiny LLM is the natural v2.
- `edit_count_per_turn` (lean-execution drift) and `tool_choice_drift` (model picks Write when rule says Edit) are not yet detector kinds. Easy adds when needed.
- Cooldown is per-probe; no global "stop nagging" cap. If multiple probes fire on every turn, the user could see consecutive correctives.
