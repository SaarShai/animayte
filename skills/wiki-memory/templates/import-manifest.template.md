---
schema_version: 2
title: "{{title}}"
type: source-summary
domain: project
tier: episodic
confidence: 0.7
created: "{{date}}"
updated: "{{date}}"
verified: "{{date}}"
sources: []
supersedes: []
superseded-by:
tags: [import, wiki-transplant, source-summary]
---

# {{title}}

## Purpose

Coverage manifest for recreating the source project wiki inside this repo-local Brainer wiki.

## Rules

- Every original wiki item gets one row.
- Use `adapted` when information was rewritten into a local Brainer page.
- Use `archived` when material is kept only as warning/history under `L4_archive/`.
- Use `discarded` only with a concrete rationale.
- Original paths are provenance only; do not use them as operational instructions after import.

## Coverage

| Original page/path | Summary | Target local page | Status | Rationale | Provenance |
|---|---|---|---|---|---|
|  |  |  | adapted |  |  |

## Audit

Run after import:

```bash
./te wiki lint --strict --fail-on-error
./te wiki import-audit --manifest raw/{{date}}-import-manifest.md
```
