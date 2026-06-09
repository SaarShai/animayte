# EVAL — `<skill-name>`

Methodology and measured token/context deltas. Updated each time the eval suite re-runs.

## Task suite

3-5 representative tasks from `bench/`:

- `<task-id>`: <one-line description>
- ...

## Protocol

- Host under test: Claude Code (`claude --no-interactive`) | Codex | Cursor | Gemini.
- Model under test: <model>.
- Judge: Xiaomi MiMo-7B (HF inference).
- Sample size: N=<n>.
- Smoke runs on Ollama N≤10; production runs on Kaggle T4 N≥50.

Run:

```bash
python eval/runner.py --task <skill-name> --n 50 --judge mimo --host claude-code
```

## Results

| Metric | Without skill | With skill | Δ | 95% CI |
|---|---|---|---|---|
| input tokens | | | | |
| output tokens | | | | |
| latency (ms) | | | | |
| judge score (0-5) | | | | |

## Failure modes

- ...

## Notes

- ...

## Lineage / sources

- ...
