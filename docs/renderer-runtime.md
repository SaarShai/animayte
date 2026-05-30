# 🎛️ animayte — Renderer-Runtime Contract (the no-drift spec)

> **Milestone C2.** This is the shared runtime spec that keeps animayte's renderers
> honest. It pairs with `test/conformance.golden.json` (the golden fixtures) and
> `test/conformance.mjs` (the check, run by `npm test`). **Spec + test only — no
> renderer logic lives here.**

There are several renderers (the web Canvas2D reference, the offline preview, the
native Swift + Python pets) and exactly **one** behaviour. This document is the
contract between them: given the same pet state at the same time, every renderer
that *claims* a capability must produce the same draw decision. The golden test
guards that property — it was hard-won (the 3 renderers drifted once; see
`plan_animayte.md` §1/§11), and the contract is how we keep them from drifting again.

**Status legend:** ✅ full · ◐ partial · ✗ not-yet.

---

## 1. Purpose — one contract, `(petState, t) → draw list`

The whole architecture (`plan_animayte.md` §3) keeps **complexity in authoring** and
the **runtime thin**: a pet is data (`pets/<name>/pet.json`, the format defined by
`lib/anim/manifest.mjs`), and a tiny shared engine resolves that data + the live
session state into *what to draw this frame*. The engine math lives once, in pure
modules under `lib/anim/`, and is consumed by:

- **The web reference renderer** — `lib/anim/runtime.mjs` (Canvas2D, served by the
  daemon). The rich, validated reference; the others are kept honest against it.
- **The offline preview / compositor** — `lib/anim/compositor.mjs` + `tools/preview.mjs`
  (Node-side; bakes filmstrips/contact-sheets so the art can be read and QA'd).
- **The native pets** — `desktop/AnimaytePet.swift` (AppKit) and
  `desktop/animayte_pet.py` (Tk). Thin players that blit the shared spritesheet.

The **no-drift goal:** because the body is a *baked* spritesheet (the compiler bakes
it, the runtime never redraws it) and the resolution rules below are spec'd exactly,
two renderers given the same state must pick the **same sheet cell + same transform**.
Where a thin renderer can't do a capability (live palette swap, procedural transform
tracks, props, secondary idles), it degrades gracefully — and §4 documents that
honestly, per renderer.

---

## 2. The runtime contract

### 2.1 State inputs

The engine resolves from this state (produced by the daemon's `/health`+SSE feed, see §5):

| Input | Source | Meaning |
|---|---|---|
| **expression** | one of the 8 ids (`neutral · thinking · happy · excited · oops · embarrassed · sad · sleepy`) | which face → which sheet **row** |
| **active clip** | a manifest `clips[...]` name (idle / react / a tool gag / a secondary / doze) | the frame sequence + transform track playing |
| **clip-local time `t`** | `frameAt(clip, elapsedMs).t` ∈ [0,1] | progress across the *whole* clip; drives the transform track |
| **fullness** | context-window % ÷ window (0..1) | body swell + the `calm→tired` palette cross-fade |
| **mood / palette** | daemon mood → expression + a palette name (`calm/tired/error`) | indexed palette swap |
| **prop** | a manifest `props[...]` name or `null` | overlay sprite + anchor |
| **birds** | sub-agent count (cap 5) | orbiting `bird.png` |
| **phase** | `alive` / `sleeping` | sleeping forces the `sleepy` row + Z particles |

### 2.2 Resolution rules (the canonical mapping)

These are the rules every renderer must agree on. The web reference implements them in
`runtime.mjs#drawPet`; the conformance golden pins their outputs.

1. **Expression → sheet ROW.** The row is the **index of the expression id in
   `Object.keys(manifest.expressions)`** (which is `EXPRESSIONS` order from
   `lib/expressions.mjs`). `runtime.mjs` computes this via `rowOf(expr)`; Swift/Python
   hard-code the same order in `moodRow()` / `ROWS`. While `phase === 'sleeping'` the
   row is forced to `sleepy`.

2. **Clip frame → sheet COLUMN** via `frame.cell`. The state machine's
   `frameAt(clip, elapsedMs)` returns the current `{index, t}`; the drawn column is
   `clip.frames[index].cell` (falling back to `index % cols` when a frame omits `cell`),
   clamped to `[0, cols-1]`. Breathing/idle clips deliberately use cells `[0,1,2,1]` and
   **avoid column 3** so the runtime owns blink (next rule).

3. **Blink = column 3, on a randomized timer.** Blink is a runtime overlay, not a clip
   frame: every ~3–6s (jittered) the renderer forces `col = 3` (closed eyes) for ~110ms.
   Guardrail: **never blink mid-reaction** — `runtime.mjs` only applies it when
   `cur.kind !== 'reaction'` and `phase === 'alive'`.

4. **Body transform = `sampleTrack(clip.tracks.body, t)`** (from `lib/anim/transform.mjs`),
   **composed with the fullness swell.** The track is a keyframed `{sx,sy,tx,ty,rot}`
   sampled at clip-local `t` (each segment eased by its destination key's `ease`, via
   `lib/anim/easing.mjs`). The swell multiplies scale by `1 + fullness*0.22`. Offsets are
   scaled by the resulting `sx/sy`; `rot` is applied about the ground anchor
   (`manifest.anchor`, default `[0.5,1]`). Squash/stretch is **volume-conserving**
   (`squash(k)` keeps `sx·sy ≡ 1` — see `transform.mjs`), the single most load-bearing
   "alive" property.

5. **Palette = indexed swap, cross-faded by fullness, + error flash.** Every palette in
   the manifest exposes the **same roles** (the validator enforces it), so a mood is a
   clean re-index. The reference pre-bakes one recolored sheet per palette
   (`recolorSheet`/`buildSwapB` in `runtime.mjs`; the Node-side equivalents are
   `swapPalette`/`buildSwap` in `compositor.mjs`), then **alpha-cross-fades** the cool
   `tired` sheet in as `fullness` rises (`smoothstep(0.5, 0.95, fullness)`) and flashes
   the `error` sheet briefly on a bad result. The `error` palette **never stays** — it
   decays each frame (`S.errFlash *= 0.94`).

6. **Prop = overlay at `prop.anchor`, with an `easeOutBack` 2-frame pop-in.** When a
   prop is active and the prop strip loaded, the renderer draws `props[name].cell` from
   the prop sheet at `anchor [ax,ay]` (0..1 of the body cell), scaled by the body and by
   `easeOutBack(elapsed/170)` for a quick overshoot-settle pop. Props compose on top of
   any pose/expression (top of the layer stack).

7. **Drop shadow scales with the body.** The ground shadow widens when the body is flat
   and shrinks when airborne — it tracks the body transform (wider on squash, smaller on
   stretch/hop), per the `plan_animayte.md` §4.1 layer rule.

Canonical layer order (bottom→top, `LAYERS` in `manifest.mjs`):
`shadow → outline → body → eyes → mouth → brows → prop`.

### 2.3 The FrameResult state machine (`lib/anim/state-machine.mjs`)

Behaviour is arbitrated by `createStateMachine(manifest)` — pure, deterministic (time
via `tick(dt)`, randomness via `opts.rng`), so a test can replay an exact timeline.
`FrameResult = { CONTINUE, COMPLETE, CANCEL }`. The lifecycle:

```
        ┌──────────── secondary idle ─────────────┐   (anti-repetition: never
        │   (sway / stretch / bounce, one-shot)    │    the same one twice in a row)
        ▼                                          │
   ┌─────────┐   no activity ≥ boredAfterMs   ┌────┴────┐
   │  IDLE   │ ───────────────────────────►   │  BORED  │  (doze clip)
   │breathing│ ◄───────────────────────────   └─────────┘
   │ + blink │      any reaction / activity
   └────┬────┘
        │  react(event)  → integer priority
        ▼
   ┌──────────────┐   one-shot finishes  →  return: 'idle' (or a named settle clip)
   │  REACTION    │ ─────────────────────────────────────────────────────►  IDLE
   │ (tool gag /  │   higher-priority react() interrupts; lower is dropped
   │  success /   │   while a higher one plays. release() drops a looping gag → idle.
   │  error …)    │
   └──────────────┘
```

- **Reactions are transient** and always `return` to idle (or a named settle clip) —
  *no state is a dead end*. This makes **recovery-never-punishment structural**, not just
  a convention (`plan_animayte.md` §2, `docs/animation-library.md` §1).
- **Priority interrupts:** `react(r)` preempts the active state unless a strictly-higher
  reaction is mid-play (`state.priority > r.priority && !isOneShotDone()`). Equal/lower
  priority lets the newer event take over once the higher one finishes.
- **Idle life:** a base breathing loop + randomized **secondary idles** picked with
  **anti-repetition** (`playSecondary()` filters out `lastSecondary`), slipping into
  **bored** (`idle.boredClip`, default `doze`) after `idle.boredAfterMs` (30s) of no
  activity.
- `setIdleExpression(expr)` lets a sticky mood (thinking while working, sad after an
  error) persist through idle life without forcing a transient each tick.
- `release()` drops a looping gag back to idle when its driver stops (e.g. a tool
  finished) — recovery, never stuck.

`frameAt(clip, elapsedMs)` resolves `{index, t}` (looping wraps; non-looping holds the
last frame); `clipDuration(clip)` = Σ frame `dur`.

---

## 3. The golden fixtures (`test/conformance.golden.json`)

The golden is the executable form of §2. `test/conformance.mjs` (wired into
`test/run.mjs`, so it runs under `npm test`) pins two things:

1. **Per-sample frame resolution.** For a set of canonical `(clip, t)` samples it pins
   the expected `{ cell, transform { sx, sy, tx, ty, rot } }` — i.e. the column the
   renderer must blit (rule 2) and the exact body transform `sampleTrack` must produce
   (rule 4). Any change to the manifest clips, the easing curves, or `sampleTrack`/
   `frameAt` math that shifts a sampled value fails the test.

2. **A replayed session timeline.** A canned event stream (the kind `tools/simulate.mjs`
   replays) is fed through the shared classifier (`lib/anim/events.mjs#classifyTool`) and
   the state machine, and the resulting `(kind, clip, expression, prop, birds)` sequence
   is pinned. This catches drift in *behaviour* (priority arbitration, returns,
   anti-repetition, bored) as well as in geometry.

Because both halves derive from the same pure modules the renderers consume, a renderer
or engine change that diverges from the spec **breaks `npm test`** — that's the whole
point.

**Intentionally regenerating the golden** (after a deliberate, reviewed change to the
clips or the math):

```sh
node test/conformance.mjs --update
```

Regenerate **only** when the change is intended; eyeball the diff (it's the contract
moving). Never `--update` to "make the test pass" — that defeats the drift guard.

---

## 4. Renderer tiers — supported-subset table

One row per renderer × the capabilities in §2. This is **honest per what the source does
today** — the native pets are deliberately thin (mood row + birds, plus a couple of
procedural extras on Swift); the rich tier is the web runtime's job for now (the rest is
follow-up, noted below).

| Capability | Web Canvas2D `runtime.mjs` (reference) | Offline preview `compositor.mjs` + `tools/preview.mjs` | Swift native `AnimaytePet.swift` | Python/Tk `animayte_pet.py` |
|---|:--:|:--:|:--:|:--:|
| Baked spritesheet frames | ✅ | ✅ | ✅ | ✅ |
| Expression → row (8 ids) | ✅ | ✅ | ✅ | ✅ |
| Procedural transform tracks (`sampleTrack`) | ✅ | ✅ | ✗ (own `sin` wobble + hop) | ✗ (own `sin` wobble) |
| Fullness swell (context → body) | ✅ | ◐ (sweep only) | ◐ (own head-swell + sweat beads, ≥60%) | ✗ |
| Indexed palette swap (`calm/tired/error`) | ✅ (pre-baked sheets, cross-fade) | ✅ (`swapPalette`) | ✗ | ✗ |
| Props / emote overlays | ✅ | ✅ | ✗ | ✗ |
| Secondary idles + bored (state machine) | ✅ | ◐ (filmstrip a clip) | ✗ | ✗ |
| Randomized blink (col 3 timer) | ✅ | ✗ | ✗ (column from `t`, may hit col 3) | ✗ (column from `t`) |
| Bird orbit (sub-agents, cap 5) | ✅ | ✗ | ✅ | ✅ |
| Particles (burst / poof / steam / Z) | ✅ | ✗ | ◐ (compact-relief steam only) | ✗ |
| Compact-relief beat | ✅ (`relief()` steam) | ✗ | ✅ (steam from "ears", `reliefSeq`) | ✗ (reads `reliefSeq`, no FX) |

**Honest notes (what the native sources actually do today):**
- **Swift** is thinner than the web tier but **richer than "mood row + birds"**: it
  blits one `slime.png` cell (`col = Int(t*5) % FRAMES`, *not* the manifest tracks), and
  adds its own procedural **head-swell + forehead sweat above 60% fullness** and
  **compact-relief steam from the "ears"** (driven by `reliefSeq`). It does **not** read
  the manifest, transform tracks, palette swaps, props, or secondary idles. Because its
  column comes from `t` (not from `frame.cell`), it can land on the blink column (3)
  during normal wobble — acceptable for the thin tier, but a reason the golden pins the
  rich tier, not Swift.
- **Python/Tk** is the thinnest: **mood row + orbiting birds**, with its own `sin`
  wobble. It reads `reliefSeq` from `/health` but draws no relief FX, no swell, no sweat,
  no palette/props. Its standout is robustness — a stdlib PNG decoder fallback so the
  shared `slime.png` renders even on Tk 8.5.
- Both native pets share the **same `assets/slime.png`** the compiler bakes from
  `pets/slime/sheet.png` (kept byte-identical), so their **row/column choice is the
  contract's common ground** even though they skip the procedural layers.
- **Follow-up:** richer native parity (manifest-driven transform tracks, palette swap,
  props) is deferred; the rich behaviour is the web tier's job for v1, and this table is
  the honest record of the gap.

---

## 5. SSE command protocol (daemon → renderer)

The daemon (`animayte.mjs`) classifies the live session and broadcasts SSE commands on
`/events` (plus the full state on `/health`, which the native pets poll every 1.5s). The
commands come from the `broadcast({ cmd, … })` calls in `animayte.mjs`:

| Command | Payload | What the renderer should do |
|---|---|---|
| `mood` | `{ value, ms? }` | set the sticky mood → expression row (`setMood`); thin pets read it from `/health.state.mood` |
| `fullness` | `{ value }` (0..1) | set context fullness → body swell + `calm→tired` cross-fade (`setFullness`) |
| `addBird` | `{ label }` | spawn an orbiting sub-agent bird (cap 5) |
| `removeBird` | — | one sub-agent finished → bird flies off (poof) |
| `clearBirds` | — | remove all birds |
| `relief` | — | **compact relief**: steam puffs + a happy beat; deflate the swell (daemon also lerps `fullness`→0.30) |
| `react` | `{ name }` | play the named manifest reaction / tool gag (`reactByName`) — rich tier only; thin pets still get a `mood:'thinking'` alongside |
| `endReact` | — | the tool finished → drop the looping gag, return to idle (`toIdle()` → `sm.release()`) |
| `sleep` | — | `phase='sleeping'`: curl to the `sleepy` row, emit Z particles |
| `wake` / `hatch` / `reset` | — | wake from sleep / re-enable / reset to a fresh idle |
| `say` | `{ text, ms }` | show an ambient speech bubble (secrets pre-filtered by the daemon) |

Tool gags are derived once, in `lib/anim/events.mjs#classifyTool` (shared by the daemon
and `tools/simulate.mjs` so classification can't drift): `PreToolUse` `tool_name` →
`Reading/Searching/Writing/Running`, with `Bash` sub-classified by argv into
`Testing/Installing/Committing`. The daemon emits the matching `react` **and** keeps the
legacy `mood:'thinking'` so thin renderers still react.

---

## 6. How to add a renderer without drifting

A short checklist for any new renderer (a Tauri shell, a different toolkit, a port):

1. **Consume the manifest** (`pets/<name>/pet.json`, validated by
   `validateManifest` in `lib/anim/manifest.mjs`). Don't hard-code clips, palettes, or
   props — read them. (Expression→row order is `Object.keys(manifest.expressions)`.)
2. **Use the shared resolution rules (§2.2)** for every capability you implement:
   row from the expression id, column from `frame.cell`, body transform from
   `sampleTrack(clip.tracks.body, t)` composed with the fullness swell, palette via the
   manifest's shared roles, props at `prop.anchor` with the `easeOutBack` pop-in, blink as
   a col-3 timer that never fires mid-reaction.
3. **Drive behaviour through the state machine** (`createStateMachine`) if you do idle
   life / reactions — don't re-invent priority/return/anti-repetition. Reuse
   `classifyTool` for the event vocabulary.
4. **Declare your tier honestly** — add a column to §4 marking ✅/◐/✗ per capability.
   Degrade gracefully for what you don't do (a thin renderer = baked row + birds is a
   valid tier).
5. **Pass the golden subset you claim to support.** Run `npm test`; the golden
   (`test/conformance.golden.json`) is the source of truth for cell + transform + the
   replayed timeline. If you implement a capability, your output for the pinned samples
   must match. If a deliberate engine change moves the contract, regenerate with
   `node test/conformance.mjs --update` and review the diff.

---

*C2 of `plan_animayte.md` (§7, Phase 3). Pairs with `docs/animation-library.md` (the
event→animation design) and `docs/session-signals.md` (the signals the pet can see).
The engine lives in `lib/anim/*.mjs`; the reference renderer is `lib/anim/runtime.mjs`.*
