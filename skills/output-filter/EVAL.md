# EVAL — `output-filter`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **70 tokens** (347 chars) |
| body (loaded on trigger)      | **308 tokens** (1294 chars) |
| tools/ payload                 | 15.8 KB |
| model pin                      | `any` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## Savings (measured, N=4 noisy samples — deterministic, no LLM)

output-filter is a byte-level tool-stdout filter, not an LLM A/B, so the metric is **bytes filtered + error-line fidelity**, not token deltas. Re-run live via `python3 eval/runner_filter.py` (RC=0, byte-identical to committed).

| metric | raw | filtered | Δ |
|---|---|---|---|
| total bytes | 6074 | 679 | **−88.8%** |
| error lines preserved | 5 | 5 | **5/5 verbatim** |

Per-sample: ansi_progress −89.9% · ci_log −84.9% · dup_stdout −97.1% · mixed_signal −83.1%.

Raw: [`eval/results/output-filter.json`](../../eval/results/output-filter.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/output-filter.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).
