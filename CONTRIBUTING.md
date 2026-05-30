# Contributing to animayte

Thanks for wanting to help! animayte is small and hackable on purpose.

## Project shape

- `animayte.mjs` — zero-dependency Node daemon (events → pet state → SSE/`/health`)
- `lib/expressions.mjs` — **the emotion dictionary** (single source of truth for feelings)
- `lib/sentiment.mjs` — thin wrapper used by the daemon
- `lib/anim/` — **the animation engine** (zero-dep, pure + testable): `easing.mjs`,
  `transform.mjs` (volume-conserving squash + tracks), `manifest.mjs` (the pet-pack schema),
  `compositor.mjs`, `state-machine.mjs`, `runtime.mjs` (web reference renderer), `events.mjs`
  (tool classification), `personality.mjs`, `mood.mjs`, `sound.mjs`, `config.mjs`, `loader.mjs`
- `pets/<name>/` — **pet packs** (a pet = a folder: `pet.json` + `sheet.png`). See
  [`docs/making-a-pet-pack.md`](docs/making-a-pet-pack.md)
- `tools/make-assets.mjs` — generates spritesheet + manifest (`npm run assets`);
  `tools/preview.mjs` (`npm run preview`), `tools/simulate.mjs` (`npm run simulate`),
  `tools/make-sounds.mjs` (`npm run sounds`)
- `desktop/AnimaytePet.swift` — native macOS floating pet · `desktop/animayte_pet.py` — Tk fallback
- `animayte.html` — browser renderer + standalone demo
- `bin/animayte` — universal launcher (`start` / `stop` / `status`)
- `test/` — run with `npm test` (696 checks, no external deps; includes the conformance
  golden in `test/conformance.mjs` and the doc-lint in `test/docs.test.mjs`)

## Adding or changing an expression

1. Edit `lib/expressions.mjs` — add emoji, keywords, and a `face` spec.
2. `npm run assets` to regenerate the spritesheet.
3. `npm test` — must stay green (the suite checks detection **and** that every renderer
   stays in sync with the dictionary).
4. Eyeball it: `http://localhost:4321/tester.html`.

## Making a new pet

A pet is a folder — `pets/<name>/pet.json` (+ `sheet.png`). Copy `pets/bean/pet.json` as a
skeleton, validate with the schema in `lib/anim/manifest.mjs`, and follow the full guide:
[`docs/making-a-pet-pack.md`](docs/making-a-pet-pack.md). `npm test` validates every pack.

## Principles (please keep these)

- **Recovery, never punishment.** No death/decay/guilt mechanics.
- **Ambient, never interrupting.** The pet must never steal focus.
- **Zero telemetry.** Nothing leaves the machine.
- **Honest mirror.** Every reaction maps to a real measured signal.

## Pull requests

Keep them focused; include a line in the PR about what you verified (`npm test` output
is great). Be kind in reviews.
