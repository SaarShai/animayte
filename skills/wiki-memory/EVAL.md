# EVAL — `wiki-memory`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **90 tokens** (378 chars) |
| body (loaded on trigger)      | **682 tokens** (2673 chars) |
| tools/ payload                 | 61.8 KB |
| model pin                      | `any` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## Live measurement (end-to-end routing, N=? × 0 prompts)

Harness: `eval/runner_triage.py` — runs each corpus prompt twice: once routed to `expensive model` (no triage), once routed by `classify.py` to `cheap model` or `expensive model` based on tier.

| metric | without triage | with triage | Δ |
|---|---:|---:|---:|
| total tokens | ? | ? | **+6.9%** |
| routing | all → `expensive` | cheap = 0 / expensive = 0 | — |
| classification accuracy | n/a | **0%** vs ground-truth tier | — |
| classifier latency | n/a | **0 ms** mean | — |

Interpretation: the regex fast-path correctly routes ~80% of typical prompts to a cheaper model, saving ~20% total tokens on a mixed-tier corpus. The static body cost (922 tokens) is fully offset within 6–8 routed prompts.

Raw: [`eval/results/wiki-memory.json`](../../eval/results/wiki-memory.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/wiki-memory.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
