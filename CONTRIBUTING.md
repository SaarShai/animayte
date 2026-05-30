# Contributing to animayte

Thanks for wanting to help! animayte is small and hackable on purpose.

## Project shape

- `animayte.mjs` — zero-dependency Node daemon (events → pet state → SSE/`/health`)
- `lib/expressions.mjs` — **the emotion dictionary** (single source of truth)
- `lib/sentiment.mjs` — thin wrapper used by the daemon
- `tools/make-assets.mjs` — generates the pixel spritesheet (run `npm run assets`)
- `desktop/AnimaytePet.swift` — native macOS floating pet (the best renderer)
- `desktop/animayte_pet.py` — cross-platform Tk fallback
- `animayte.html` — browser renderer + standalone demo
- `bin/animayte` — universal launcher (`start` / `stop` / `status`)
- `test/` — run with `npm test` (211 checks, no external deps)

## Adding or changing an expression

1. Edit `lib/expressions.mjs` — add emoji, keywords, and a `face` spec.
2. `npm run assets` to regenerate the spritesheet.
3. `npm test` — must stay green (the suite checks detection **and** that every renderer
   stays in sync with the dictionary).
4. Eyeball it: `http://localhost:4321/tester.html`.

## Principles (please keep these)

- **Recovery, never punishment.** No death/decay/guilt mechanics.
- **Ambient, never interrupting.** The pet must never steal focus.
- **Zero telemetry.** Nothing leaves the machine.
- **Honest mirror.** Every reaction maps to a real measured signal.

## Pull requests

Keep them focused; include a line in the PR about what you verified (`npm test` output
is great). Be kind in reviews.
