# EVAL — `lean-execution`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **51 tokens** (222 chars) |
| body (loaded on trigger)      | **290 tokens** (1431 chars) |
| tools/ payload                 | 0.0 KB |
| model pin                      | `any` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## A/B savings (measured, N=3 × 5 prompts, model=mimo-v2-flash)

| metric | without skill | with skill | Δ | 95% CI |
|---|---|---|---|---|
| input tokens (mean)  | 40 | 329 | +722.5% | n/a |
| output tokens (mean) | 896 | 396 | -55.8% | n/a |
| latency (ms)         | 9646 | 6499 | n/a | n/a |
| judge score (0–5)    | +4.53 | +4.53 | +0.00 |   |


Raw: [`eval/results/lean-execution.json`](../../eval/results/lean-execution.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/lean-execution.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
