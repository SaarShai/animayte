---
name: context-keeper
description: PreCompact hook that extracts structured state (files, commands, errors, numbers, decisions, failures) from the transcript before compaction. Preserves grep-able recovery memory so the summarizer can't silently drop facts. Use when the host supports project-local PreCompact hooks.
model: haiku
effort: low
tools: [Bash, Read, Write]
---

# context-keeper — structured memory before compaction

## What it does

Parses the transcript JSONL, regex-extracts structured state (goals, files touched, commands, errors, numbers, URLs, failure signals). Optional LLM pass (local `gemma4:31b` by default, off by default in the hook) pulls out decisions and next-steps. Writes a terse markdown packet to `.brainer/sessions/<YYYY-MM-DD-HHMM>-<sid8>.md` and emits a multi-line pointer on the hook's stdout — Claude Code prepends that pointer to the compaction prompt so the summarizer references the checkpoint path.

Measured on an 893-line transcript: 100 files, 40 commands, 30 errors logged in ~290 lines. See [`EVAL.md`](EVAL.md).

## Install

Claude Code (project-local):

```bash
bash skills/context-keeper/tools/install.sh --project
```

Wires `tools/hook.sh` into `.claude/settings.json` under `PreCompact`.

## Rules

- Don't load the full transcript in the hook — read JSONL incrementally.
- Output stays terse.
- Preserve exact paths, commands, numbers, error strings verbatim.

## Files

```
tools/
├── extract.py     # regex extractor + optional LLM pass
├── hook.py        # PreCompact worker: parses stdin payload, invokes extract.py
├── hook.sh        # PreCompact shell shim (settings.json points here)
├── tokens.py      # token estimator helper
└── install.sh     # wires into project-local .claude/
```

## Reliability contract

The hook MUST exit 0 on every input. A failing PreCompact hook would block compaction and corrupt the session. Edge cases all verified to exit 0:

- empty stdin payload
- malformed JSON
- missing `transcript_path` field
- transcript file does not exist
- empty transcript file
- malformed JSONL lines mid-file
- extract.py timeout (30s cap)

Errors are logged to stderr with an ISO timestamp prefix; Claude Code captures them in the session transcript without aborting compaction.

## Lineage

Pattern aligned with coleam00/claude-memory-compiler (SessionEnd → distillation). This skill targets PreCompact specifically — intra-session memory survival, not cross-session synthesis.
