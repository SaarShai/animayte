# animayte · Route 2 — Art ("the body") · parallel session launch

**One-liner:** Make the pet *look and move* right — render any FeatureSpec beautifully at ~30px. Own the visual vocabulary (faces, items, animation) and the axes→pixels compositor. This is the taste-heavy, eyeball-iterated route.

**Branch:** from `feat/anim-engine`, work on `feat/art`. **Keep going until the Goal is met.** Review with Saar **one family at a time** — he is the creative director on the look.

---

## The seam is already cut (read this first)
- `lib/vocabulary.mjs` — the contract you render against: the expression families, the axes, and the `ITEMS` (props) you must be able to draw. **Do not edit it** (it's Route 1's); if you need a new family/item, coordinate with the Translation session.
- `grid/compose.mjs` — **your main file.** `composeExpression(spec) → {face, fx, item}`: turns the axes into renderable channels. v1 maps the dictionary face + modulates accents/FX by cause/arousal/expectedness. Your job is to make this *the* mapping and make it read.
- `grid/face.mjs` / `grid/props.mjs` — the feature primitives (eyes/brows/mouth/accents char-grids) and item sprites. Inert placeholders already exist (`determined`/`set`/`focused`) — Saar said the first Determined "looks more evil than determined", so **redesign it**.
- `grid/runtime.mjs` — the live renderer; today it does `setMood(id)→MOOD_EXPRESSION→face`. Add an `applySpec(spec)` path that uses `composeExpression` so the pet renders the full spec (cause/intensity/expectedness), not just the base mood.

## Goal (done =)
1. **The renderer consumes specs.** `grid/runtime.mjs` gains `applySpec(spec)` (via `composeExpression`); the spec's axes visibly drive the face/FX. (Route 3 will wire the SSE `express` cmd to call it — coordinate on that one line; you provide `pet.applySpec`.)
2. **The new face set is authored and reads at ~30px** (Saar already ruled the families): a **Determined** that reads as resolve not menace, a **positive intensity ladder** (content→pleased→thrilled), and the **external-vs-self split** (concerned vs sheepish). Review each family in `grid/facelab.html` (the lab is built — swap its `CANDIDATES`), get Saar's sign-off, lock, next.
3. **The item set is legible** — every name in `vocabulary.ITEMS` has a clear sprite; add ones Translation needs.
4. **Composition reads, not clutters** — at 30px the axis combinations are distinguishable and don't flicker. The compositor is the source of truth for "which axis drives which channel" (mouth/eyes/brows/accents/FX/prop).

## Why this is safe in parallel
- **You OWN:** `grid/face.mjs`, `grid/props.mjs`, `grid/creature.mjs`, `grid/engine.mjs`, `grid/geom.mjs`, `grid/motion.mjs`, `grid/manifest.mjs`, `grid/runtime.mjs`, `grid/compose.mjs`, the review surfaces `grid/sheet.html` + `grid/facelab.html`, and `assets/`.
- **READ-ONLY CONTRACT:** the FeatureSpec + vocabulary (Route 1 emits it). You must render every spec Translation can emit; you don't decide *when* a feeling fires.
- **DO NOT EDIT:** `lib/**` (Translation — incl. `lib/vocabulary.mjs`; propose changes, don't make them), `animayte.mjs`/`hooks/`/`bin/`/`.claude/`/`docs/` (Plugin). **`pet.html` is Plugin's host** — you only provide `pet.applySpec()` in `grid/runtime.mjs`; Plugin adds the one dispatch line that calls it.

## Verification gate
Serve `node grid/serve.mjs 4370`; review faces in `grid/facelab.html` + `grid/sheet.html` and the live pet in `grid/pet.html`; screenshot each family for Saar. Keep `node test/expressions.test.mjs` (217), `node test/anim.test.mjs` (284), `node test/conformance.mjs` (124) green (conformance guards the legacy renderer — don't disturb it). Definition of done: the renderer applies specs, the new families are authored + Saar-approved, every item draws, and the whole set reads at 30px.
