# animayte · Route 1 — Translation ("the brain") · parallel session launch

**One-liner:** Make the pet *understand* the session — turn every signal (assistant text, tool calls, errors, the user's tone, context%) into a rich, faithful **FeatureSpec**. You own the logic; you never draw and never transport.

**Branch:** from `feat/anim-engine`, work on `feat/translation`. **Keep going until the Goal is met.** You may ask Saar questions any time (this is taste-laden — calibration of cause/intensity is a judgment call).

---

## The seam is already cut (read this first)
The contract exists and is committed:
- `lib/vocabulary.mjs` — the shared agreement: `EXPRESSION_IDS`, the axes (`FAMILY_AXES`, `AROUSAL`, `CAUSE`, `EXPECTEDNESS`), `ITEMS`, `EMOJI_ITEM`. **The FeatureSpec shape is documented at the top.**
- `lib/appraise.mjs` — **your main file.** `appraise(signal, prev) → FeatureSpec`. Already handles tool-error / user-tone / agent-text (recency-first) and derives valence + arousal + cause + expectedness + item. v1 — your job is to make it *faithful and rich*.
- `grid/compose.mjs` & `animayte.mjs` are the CONSUMERS (Route 2 / Route 3) — read them to see how your spec is used, but **do not edit them.**
- Tests: `test/appraise.test.mjs` (31), `test/detection-sim.test.mjs` (157), `test/expressions.test.mjs` (217). Keep all green.

## Goal (done =)
1. **Every signal produces a faithful spec.** Re-map the two real sessions (`node grid/map-session.mjs <transcript> --json grid/maps/x.json`, view in `grid/session-map.html`) and show the over-collapse is resolved: the 9/22 Codex `sad` rows now differ by cause/intensity; "thanks" reads as content not a grin; a minor/expected error reads unbothered, a blocking one concerned, a self-slip sheepish.
2. **The axes are calibrated.** valence/arousal/cause/expectedness are sensible across the corpus and both real sessions — verified, not guessed. Lock the calibration in `test/appraise.test.mjs` cases.
3. **Translation is consolidated in `lib/`.** Anything still deciding "what to express" outside appraise gets folded in or exposed as a pure function: the tool-activity → item mapping (today the daemon's `classifyTool`→item bridge), `PostToolUseFailure`, expectedness using real recent-history. The daemon should only ever *call* your functions.
4. **Richer translation** (your call with Saar): better intensity signals (intensifier words, stacked matches, big `linesAdded`), an "own-fault vs external" refinement beyond keywords, and the item vocabulary for more activities.

## Why this is safe in parallel
- **You OWN:** `lib/expressions.mjs`, `lib/sentiment.mjs`, `lib/appraise.mjs`, `lib/vocabulary.mjs`, `lib/anim/events.mjs` (classifyTool), `lib/anim/mood.mjs` (the slow valence meter — wire it into expectedness/history), `lib/codex/mapping.mjs`, and the tests above + `test/expression-corpus.mjs`.
- **READ-ONLY CONTRACT:** the FeatureSpec shape + vocabulary. Whatever you emit, Route 2 must be able to render — if you need a NEW expression family or item, propose it in `lib/vocabulary.mjs` and **tell the Art session** (it adds the sprite). Don't invent values Art can't draw.
- **DO NOT EDIT:** `grid/**` (Art), `animayte.mjs`/`hooks/`/`bin/`/`pet.html`/`.claude/` (Plugin), `desktop/**`, `pets/**`.

## Verification gate
Every change: `node test/appraise.test.mjs && node test/detection-sim.test.mjs && node test/expressions.test.mjs` green, then re-map both real sessions and eyeball the timeline improvement. Definition of done: the two real sessions read faithfully, calibration is locked in tests, and no "what to express" logic lives outside `lib/`.
