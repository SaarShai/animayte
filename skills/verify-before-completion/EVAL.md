# EVAL — `verify-before-completion`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **34 tokens** (170 chars) |
| body (loaded on trigger)      | **209 tokens** (910 chars) |
| tools/ payload                 | 0.0 KB |
| model pin                      | `any` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## A/B savings (output deltas N=50 × 5 prompts; judge only N=15 — N=50 judge pending), model=mimo-v2-flash

| metric | without skill | with skill | Δ | 95% CI |
|---|---|---|---|---|
| input tokens (mean)  | 118 | 326 | +176.6% | n/a |
| output tokens (mean) | 316 | 210 | -33.5% | n/a |
| latency (ms)         | 5349 | 4764 | n/a | n/a |
| judge score (0–5)    | 4.07 | 3.67 | **-0.40 (N=15 only)** | n/a |

> ⚠ The judge row is **N=15, not N=50**: the N=50 judge pass died on `MiMo 402: Insufficient balance` and was never re-run (see `eval/FINDINGS.md`). The committed `verify-before-completion.judged.json` is the N=15 partial. Treat −0.40 as a provisional, small-N signal (and a likely rubric artifact — the rubric scored "demands fresh evidence" below "affirms confidently"), not a settled N=50 result.


Raw: [`eval/results/verify-before-completion.json`](../../eval/results/verify-before-completion.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/verify-before-completion.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
