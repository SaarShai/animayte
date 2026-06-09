# EVAL — `context-keeper`

## Static cost (measured)

| field | tokens / size |
|---|---|
| description (always resident) | **55 tokens** (281 chars) |
| body (loaded on trigger)      | **304 tokens** (1261 chars) |
| tools/ payload                 | 14.3 KB |
| model pin                      | `haiku` |
| effort pin                     | `low` |

agentskills.io budget reference: description ≤ 1,536 chars (1% of a 200K context window).

## Live measurement (extraction fidelity, N=1 real transcript)

Harness: `eval/runner_keeper.py` — feeds the extract.py script a transcript JSONL and counts (a) compression vs raw transcript, (b) per-category recall against a regex ground-truth count.

Input: 970-event transcript at `7523878a-45a4-4402-b4f1-2021683b7d51.jsonl`.

| metric | value |
|---|---|
| raw transcript | **493.7 KB** (970 events) |
| extracted sidecar | **11.3 KB** |
| **compression vs raw** | **2.3% of original (-97.7%)** |
| extract latency | 973 ms |
| URL recall | **100%** of 22 distinct URLs |
| Number-fact recall | **67%** of 63 numeric facts |
| Command recall | 46% of 87 distinct `Bash` cmds |
| Error recall | 25% of 111 error lines (de-duped) |
| File recall | 22% of 264 path mentions (top-N) |

Interpretation: the sidecar is **~44× smaller** than the raw transcript while capturing the high-leverage tail (URLs, measurements, frequent commands) that a generic `/compact` summariser drops. The full raw transcript wouldn't survive compaction; this sidecar does.

Raw: [`eval/results/context-keeper.json`](../../eval/results/context-keeper.json)


## Methodology

- Sample size: N=3-10 local smoke; N≥50 on Kaggle T4 for any >20% savings claim.
- Tasks: 3–5 representative prompts in `eval/tasks/context-keeper.yaml`.
- Backends supported: `ollama`, `anthropic`, `mimo`, `mlx` (`--backend` arg).
- Judge: Xiaomi MiMo via `https://api.xiaomimimo.com/v1` (preferred for quality) or local Ollama.
- Rubric: per-task rubric embedded in the YAML.

## Failure modes

To be filled in after analysis of result outputs (see raw JSON for individual trial outputs).

## 2026-05-23 — hook revival + quality fixes

Pre-change state: `tools/hook.sh` had been an orphaned stub since the catalog restructure (`184645b`). It `exec`-ed `$ROOT/hooks/pre-compact.sh` — a path that was never checked into the repo at any point in its history. Every PreCompact event in this project exited 1 with `No such file or directory` and produced no checkpoint. The fix below is what made this skill actually run.

### Reliability — 6 / 6 edge cases pass

Hook must always exit 0 — a failing PreCompact hook blocks compaction.

| Input | Behavior | exit |
|---|---|---|
| empty stdin | log `empty-payload` | 0 |
| malformed JSON | log `json-decode-error: …` | 0 |
| missing `transcript_path` field | log `missing-transcript path=''` | 0 |
| transcript path does not exist | log `missing-transcript path=…` | 0 |
| empty transcript file | empty checkpoint written | 0 |
| malformed JSONL lines | tolerated, extracted what parses | 0 |

### Live extraction (real transcript)

Transcript: 893-line JSONL session that included Kaggle setup, an `model: any` SKILL.md frontmatter bug, secrets handling, and eval runs.

| Section | Items |
|---|---|
| User goals | 2 |
| Files created (Write tool) | 6 |
| Files touched (any tool/text) | 100 (capped) |
| Commands run (Bash tool_use) | 40 (capped) |
| Errors seen | 30 (capped) |

High-leverage facts preserved verbatim — examples: `Error("MIMO_API_KEY not set …")`, `Error: Unauthorized for url: https://www.kaggle.com/api/v1/kernels/list?…`, the `model: any` frontmatter bug as both error string and pending goal.

### Quality fixes this round

| Bug | Before | After |
|---|---|---|
| `PATH_RE` over-matched: `/dir/file.ext` from `skills/*/SKILL.md` produced phantom paths `/SKILL.md`, `/handoff/SKILL.md`, etc. | 18 phantoms among 100 entries | 0 phantoms (added `(?<![\w\-])` lookbehind) |
| `IMPERATIVE_RE` ran against tool_result blocks (Claude Code stores them as `type:user`), producing junk goals: `"Run the"`, `"INSTALL"`, `"eval/runner_compress"` | 18 goals, 16 junk | 2 real goals |

### Not measured here (open work)

- **Pointer survival under real compaction.** Whether the summarizer preserves the `[context-keeper] structured memory saved → …` line requires an actual auto-compact or `/compact` invocation. The simulated `echo … | hook.sh` test confirms the pointer is generated; not that the summarizer keeps it.
- **A/B post-compaction quality.** Sessions with vs without the hook, judged on whether key facts survive the summarizer.
