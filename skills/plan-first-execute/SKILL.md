---
name: plan-first-execute
description: Plan before executing non-trivial tasks. Trigger when the task has more than 3 steps, unclear scope, multiple files, real risk, or architecture decisions. Inspect reality first, draft a phased plan with verification gates, simplify, then execute.
effort: medium
---

# Plan First Execute

Use for tasks with >3 steps, unclear scope, multiple files, risk, or architecture.

**Confidence pre-flight** (before committing): name what you're confident about and what you're not (understanding, info sufficiency, approach, risk). If under-confident, make the gap-closing action concrete and retrieval-shaped (read file X, `wiki.py search/fetch Y`, `graphify explain Z`) — never "gather more data". Then proceed / proceed-with-caveat / pause-to-close-the-gap.

Steps:
1. Inspect discoverable facts.
2. Identify unknowns. Ask the user only the 1–3 **load-bearing** questions whose answer changes the plan's shape; resolve nice-to-knows during execution.
3. Draft plan with phases and verification.
4. Simplify (see `lean-execution`): drop ceremony, duplicate checks, speculative docs, any step that doesn't reduce risk or produce evidence.
5. Get approval if host workflow requires it.
6. Execute.
7. Verify.
8. Document durable facts.

Do not assume APIs exist. Retrieve docs or code first.

Bypass for tasks that are clear, low-risk, and describable as a one-sentence diff: inspect reality, execute, verify.
