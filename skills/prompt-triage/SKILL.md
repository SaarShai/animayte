---
name: prompt-triage
description: Use on every UserPromptSubmit (pre-model hook) to classify the prompt and emit a directive telling the main model which subagent/model should handle it. Regex fast-path then local-Ollama fallback. Goal: avoid spending opus tokens on tasks solvable by haiku/sonnet/local. Override per prompt by typing NO TRIAGE.
effort: low
tools: [Bash]
---

# prompt-triage — bypass opus for simple tasks

## Problem

Heavy default model (opus, high-effort) burns tokens deciding what model a task needs. Many tasks — wiki notes, one-line fixes, factual lookups — don't need opus.

## Approach (3-layer)

### Layer 1: pre-model hook (`UserPromptSubmit`)

`tools/hook.sh` runs BEFORE main model sees prompt. Calls `tools/classify.py`:
- **Regex fast-path** (<5ms) matches known patterns.
- **Ollama fallback** (<1.5s) — local `qwen3:8b` classifies if regex uncertain.

Outputs JSON + directive block appended to context:

```json
{"tier": "simple|medium|hard",
 "agent": "wiki-note|quick-fix|local-ollama|research-lite|none",
 "model": "haiku|sonnet|opus|local:<model>",
 "confidence": 0-1,
 "reason": "...",
 "lean_context": [...]}
```

### Layer 2: main model sees directive, dispatches

Main model reads `⚡ [prompt-triage] ...` block → emits `Task(subagent_type, model, prompt)` immediately. Minimal thinking because the directive already specifies what to do.

Full opus bypass isn't possible (the host always routes through main), but the directive keeps thinking budget near zero on simple tasks.

### Layer 3: specialized subagents

Five bundled agents, each minimal-context:
- **wiki-note** (haiku) — repo-local wiki edits only.
- **quick-fix** (haiku) — small scoped edits, one Bash verify max.
- **local-ollama** (haiku coordinator) — shells out to local Ollama models.
- **research-lite** (haiku) — ≤5 web calls, ≤800-word output.
- **kaggle-feeder** (haiku) — archived Kaggle eval pipeline maintainer.

## Install

Claude Code:
```bash
bash skills/prompt-triage/tools/install.sh
```

Wires:
- skill → `.claude/skills/prompt-triage/`
- agent defs → `.claude/agents/`
- `UserPromptSubmit` hook → `.claude/settings.json`

## Override

Type `NO TRIAGE` anywhere in the prompt → hook exits silently → main model handles normally.

## Environment vars

- `AGENTS_TRIAGE_NO_OLLAMA=1` — skip Ollama fallback, regex-only.

## Cost math (informal)

- Without triage: opus reads prompt → thinks → acts → writes → verifies. ~3-8K tokens.
- With triage: hook (0 tokens) → opus reads directive + prompt → emits Task (~200 tokens) → haiku subagent does work (~500-2000 tokens).
- Net: ~70-90% token cost reduction on simple tasks (informal estimate; see EVAL.md for measured numbers).

## Known failure modes

1. False-positive classification → wrong subagent → returns "escalate" → main re-handles. Small wasted round-trip.
2. Ollama down → regex-only. Coverage narrower.
3. Adversarial prompt ("this is simple: [complex thing]") → mis-routes. Mitigation: main can override directive.
4. Subagent can't escalate mid-task → returns "escalate" and stops.

## Lineage

- OpenRouter / Not Diamond routing layer.
- RouteLLM (ICLR 2025).
- Anthropic SDK Task tool + subagent_type.
- Orchestrator-worker multi-agent papers 2024-2026.

## Files

```
tools/
├── classify.py     # regex + Ollama classifier
├── hook.sh         # UserPromptSubmit entry
├── install.sh      # wires into project-local .claude/
└── agents/
    ├── wiki-note.md
    ├── quick-fix.md
    ├── local-ollama.md
    ├── research-lite.md
    └── kaggle-feeder.md
```
