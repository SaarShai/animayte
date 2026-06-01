---
name: animayte-lint
description: Validate an animayte pet's art manifest against the daemon's live command + reaction vocabulary. Use when an art author asks "validate my pet / manifest", "does my pet cover every reaction", "animayte lint", "check the art contract", or after editing grid/manifest.mjs (or shipping a new pet pack). Catches the SILENT no-op class of bug — a session signal the daemon emits that the pet has no clip for — and prints a clear ✓/✗ report with the exact fix.
effort: low
tools: [Bash, Read]
pulse_reminder: a pet that "doesn't react" is usually a manifest missing a clip for a react name the daemon emits — a silent no-op. Run ${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs before trusting an art change.
---

# animayte-lint

The **art-facing guardrail** for animayte's wiring contract. An art author can add or change pets,
faces, props, and palettes without ever touching the plumbing — this is the one command that tells
them whether their manifest still satisfies the daemon's contract.

Read `docs/ARCHITECTURE.md` §5 (command vocabulary) and §6 (reaction manifest) for the contract this
enforces.

## The problem it solves

The pet only reacts to a session signal if an **unbroken chain** holds:

```
daemon broadcasts cmd ─▶ renderer dispatch routes cmd ─▶ pet.method() exists
                      └─▶ react NAME exists in the art manifest (grid/manifest.mjs)
```

If a `react` name the daemon can emit (e.g. `Committing`) is missing from `MANIFEST.reactions`, the
pet **silently doesn't react** — no error, the daemon looks healthy, and the failure is invisible
until someone notices the pet sitting still during a git commit. This linter makes that drift loud.

It is **complementary to `test/contract.test.mjs`**, not a replacement: the test guards *this repo's*
manifest on every `node test/run.mjs`; the linter is the portable, manifest-targetable, JSON-emitting
front door an art team points at *their own* pack (and wires into *their own* CI / pre-commit) without
learning the test harness.

## How to run

```bash
# lint the live grid manifest (the default)
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs"

# lint a pet author's own manifest / renderer
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs" --manifest path/to/your/manifest.mjs
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs" --runtime  path/to/your/runtime.mjs

# machine-readable report for CI
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs" --json
```

Exit code is **0** when every contract check passes, **1** on any violation (a silent no-op). Run it,
then relay the ✓/✗ report and, on a ✗, the named missing reaction and its one-line fix.

## What it checks

The daemon's vocabulary is parsed from the **real** plumbing sources (`animayte.mjs`,
`lib/anim/events.mjs`) using the exact same logic as `test/contract.test.mjs`, so the two can never
disagree. Against a target manifest + runtime it asserts:

1. **manifest covers every react the daemon emits** — every `react` NAME (`Reading`, `Running`,
   `Committing`, …, `Asking`, `Waiting`) has a `MANIFEST.reactions[name]` entry. A miss is a **hard
   failure** with a copy-pasteable fix: *"add `Committing: { clip: 'react', … }` — without it the
   pet won't react when the daemon emits 'Committing' (a git commit)."*
2. **dead art (informational)** — reactions the manifest defines that the daemon will *never* emit.
   Not a failure (an author may stage clips ahead of a new daemon signal), just surfaced.
3. **dispatch covers every cmd** — `grid/dispatch.mjs` routes every SSE `cmd` the daemon broadcasts
   (or explicitly ignores it, like `ping`/`moodLevel`).
4. **runtime exposes every method** — instantiates the runtime headlessly and asserts every
   `pet.method()` the dispatch calls exists. `applySpec` is treated as **guarded-optional** (the
   `express` rich face degrades to the legacy mood face without it), exactly as the contract test does.

It also prints the runtime's public API and the daemon's full cmd/react vocabulary as facts.

## Interpreting the result

- **✅ all checks passed** → the manifest covers the daemon's full vocabulary; the pet will react to
  every session signal it can.
- **❌ a ✗ on "manifest covers every react"** → the named reaction is missing; add it to
  `MANIFEST.reactions` (even a stub clip makes it go green; art fills real frames later).
- **A ✗ on dispatch/runtime** → that's a *plumbing* drift, not an art one — escalate to a Route-3
  owner rather than editing the manifest.

## Wiring it into a gate

- **pre-commit** (art repo): `node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs" --manifest grid/manifest.mjs || exit 1`
- **CI**: run `node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs" --json`, fail the job on a non-zero exit, archive the
  JSON as the build artifact.
