# EVAL — `plan-first-execute`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **50 tokens** (246 chars) |
| body (loaded on trigger)      | **142 tokens** (617 chars) |
| tools/ payload                 | 0.0 KB |
| model pin                      | `any` |
| effort pin                     | `medium` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## A/B savings (measured, N=3 × 5 prompts, model=mimo-v2-flash)

| metric | without skill | with skill | Δ | 95% CI |
|---|---|---|---|---|
| input tokens (mean)  | 37 | 178 | +377.0% | n/a |
| output tokens (mean) | 1024 | 815 | -20.4% | n/a |
| latency (ms)         | 11235 | 10967 | n/a | n/a |
| judge score (0–5)    | +4.00 | +4.20 | +0.20 |   |


Raw: [`eval/results/plan-first-execute.json`](../../eval/results/plan-first-execute.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/plan-first-execute.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
