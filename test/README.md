# animayte tests

Run everything:

```bash
npm test          # or: node test/run.mjs
```

Three layers, **174 checks**, no external dependencies (Node built-ins only).
Tests use a throwaway port (4399) so they never touch a live pet on 4321.

## `expressions.test.mjs` — detection + consistency (149 checks)

**Layer 1 — detection** (`lib/expressions.mjs`):
- every dictionary emoji resolves to a valid expression
- canonical emoji → expected expression (🎉→excited, ✅→happy, 😟→sad, …)
- keyword fallback when no emoji ("failed"→sad, "my mistake"→oops, …)
- **adversarial**: negation guard ("zero errors" ≠ sad), neutral narration → null,
  empty/whitespace/non-string → null, variation-selector emoji (✔️), skin-tone/ZWJ
  noise (👍🏽), priority (celebration beats a stray ✅), **negative-wins-when-mixed**
  (success + error → sad, order-independent)

**Layer 2 — renderer consistency** (catches drift between files):
- generated `slime.json` rows == dictionary ids, in order
- every `setMood('x')` the daemon emits is a real expression id or documented alias
- Swift `moodRow` handles every daemon mood; `ROWS` count matches; rows in range
- HTML `STATES`/`moodState` map every daemon mood

## `integration.test.mjs` — end-to-end (25 checks)

Boots a **real daemon**, writes fixture transcript `.jsonl` files, fires real
hook-event JSON at `POST /event` + statusline at `POST /status`, asserts `/health`:

- SessionStart → fresh living pet; UserPromptSubmit → thinking
- **real context %** from transcript `usage` (277k/1M opus = 28%; 190k/200k haiku = 95%)
- **sentiment end-to-end**: Stop reads agent text → excited/happy/oops/sad/thinking
- **buried emotion**: a win two lines back still beats trailing neutral narration
  (this caught a real bug — newest-text-wins shadowed stronger emotions)
- tool error (object + string) → sad; sub-agents → birds (spawn/finish, capped at 5)
- PreCompact → sleepy; statusline drives ctx%/cost/rate-limit/effort/thinking
- negation guard end-to-end ("zero errors" → happy, not sad)

## Design principles the tests lock in

1. **A face never hides a real error** — negative signals outrank positive when mixed.
2. **Most-salient emotion wins**, recency breaks ties (not just newest-with-any-feeling).
3. **Negation guard** — "no/zero errors" is not sadness.
4. **One dictionary, all renderers** — `lib/expressions.mjs` is the single source of
   truth; consistency tests fail if any renderer drifts from it.
