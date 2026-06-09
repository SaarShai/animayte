# EVAL — `caveman-ultra`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **68 tokens** (284 chars) |
| body (loaded on trigger)      | **204 tokens** (824 chars) |
| tools/ payload                 | 0.0 KB |
| model pin                      | `any` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## A/B savings (measured, N=50 × 5 prompts, model=mimo-v2-flash)

| metric | without skill | with skill | Δ | 95% CI |
|---|---|---|---|---|
| input tokens (mean)  | 36 | 240 | +560.4% | n/a |
| output tokens (mean) | 570 | 77 | -86.4% | n/a |
| latency (ms)         | 6759 | 3336 | n/a | n/a |
| judge score (0–5)    | +4.73 | +4.87 | +0.13 |   |


Raw: [`eval/results/caveman-ultra.json`](../../eval/results/caveman-ultra.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/caveman-ultra.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
