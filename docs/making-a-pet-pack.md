# 🎨 Making an animayte pet pack

A pet is **a folder**: `pets/<name>/` with a `pet.json` manifest (and, for a drawn pet,
a `sheet.png` spritesheet + optional `props.png`). Drop a valid folder in `pets/` and the
loader (`lib/anim/loader.mjs`) finds it; set `ANIMAYTE_PET=<name>` to wear it. The format
is `animayte-pet/1` — a thin superset of Aseprite JSON (frame tags + durations) plus the
procedural pieces a living cartoon needs.

This guide is for authoring a pack by hand or from a generator. The slime is the worked
example — its manifest is **generated** from `lib/expressions.mjs` by
`lib/anim/manifest.mjs#buildSlimeManifest()` (run `npm run assets`), and `pets/bean/pet.json`
is a hand-authored stub that proves the format is reusable.

---

## 1. The manifest at a glance

```jsonc
{
  "format": "animayte-pet/1",
  "name": "slime",
  "cell": 64,                 // sprite cell size in px (one frame)
  "anchor": [0.5, 1],         // where the pet sits (bottom-centre)
  "sheet": "sheet.png",       // spritesheet: rows = expressions, cols = baked frames
  "propSheet": "props.png",   // optional prop/emote strip
  "propCell": 24,
  "layers": ["shadow","outline","body","eyes","mouth","brows","prop"],
  "palettes": { "calm": { "base": "#5BC661", ... }, "tired": {...}, "error": {...} },
  "defaultPalette": "calm",
  "expressions": { "neutral": { "eyes": "dots", "mouth": "slight_smile" }, ... },
  "clips": { "idle": { "loop": true, "frames": [{ "dur": 460, "cell": 0 }], "tracks": {...} } },
  "props": { "glasses": { "cell": 0, "anchor": [0.5, 0.42], "pop": 2 } },
  "reactions": { "Reading": { "clip": "reading", "expression": "thinking", "prop": "glasses", "priority": 2, "return": "idle" } },
  "idle": { "base": "idle", "secondary": ["sway","stretch","bounce"], "boredClip": "doze", "boredAfterMs": 30000 }
}
```

Validate any manifest with the schema in `lib/anim/manifest.mjs`:

```js
import { validateManifest } from './lib/anim/manifest.mjs';
const errors = validateManifest(myManifest);   // [] means valid; each error names its path
```

The loader runs this for you and refuses to load a malformed pack with a clear message.

---

## 2. The pieces

- **`palettes`** — each is a `role → hex` map (`#rrggbb` or `#rrggbbaa`). Every palette must
  expose the **same roles** so a mood swap is a clean re-index. `calm` is the resting look;
  the runtime cross-fades to `tired` as the context window fills and flashes `error` briefly.
- **`expressions`** — face-layer states (`eyes`, `mouth`, optional `brows`, optional
  `accents` like `blush`/`sweat`/`zzz`). One row of the spritesheet per expression, **in key
  order** (row 0 = first key). Keep the eye↔eye / eye↔mouth spacing constant across poses.
- **`clips`** — `frames: [{ dur, cell? }]` (durations in ms; `cell` picks the spritesheet
  column, default = frame index; **column 3 is the blink frame** — breathing avoids it so the
  runtime can blink on its own randomized timer). Optional `tracks.body` is a keyframed
  transform timeline `[{ t, sx?, sy?, tx?, ty?, rot?, ease? }]` (t in 0..1; `ease` is any name
  from `lib/anim/easing.mjs`). **80% of "alive" lives in these procedural tracks** — squash &
  stretch conserves volume (`lib/anim/transform.mjs#squash`).
- **`props`** — overlay sprites: `cell` (column in `props.png`), `anchor` (`[ax, ay]` in 0..1
  of the body cell), `pop` (pop-in frames). The runtime scales the prop in with `easeOutBack`.
- **`reactions`** — event → `{ clip, expression, prop, palette, priority, return }`. The daemon
  classifies session events (see `lib/anim/events.mjs`) and the renderer plays the matching
  reaction; higher `priority` interrupts lower; everything `return`s to idle (recovery, never
  stuck). Event names follow `docs/animation-library.md`.
- **`idle`** — `base` breathing clip + a `secondary` pool (anti-repetition, personality-weighted)
  + a `boredClip` after `boredAfterMs`. This is where a desktop pet actually lives.

---

## 3. Authoring loop

1. **Write** `pets/<name>/pet.json` (copy `pets/bean/pet.json` as a starting skeleton).
2. **Draw** `sheet.png` (rows = expressions in key order, cols = frames; `cell`×`cell` each)
   and optional `props.png` (`propCell`×N). Or generate them like the slime does in
   `tools/make-assets.mjs` + `tools/draw-props.mjs`.
3. **Validate & preview:**
   ```
   ANIMAYTE_PET=<name> npm start         # daemon serves http://127.0.0.1:4321
   npm run preview                        # contact-sheet + clip filmstrips → tools/preview-out/
   npm run simulate                       # replay sessions → state timeline
   ```
   `npm test` runs the schema validator, the engine, and the conformance golden.
4. **Wear it:** `ANIMAYTE_PET=<name>` (env), or set `"pet": "<name>"` in your config
   (`~/.config/animayte/config.json`, see `lib/anim/config.mjs`).

---

## 4. Renderer support

The web renderer (`animayte.html` + `lib/anim/runtime.mjs`) is the rich reference: it plays
clips, procedural transforms, indexed palette swap, props, the idle state machine, and bird
orbit. The native Swift/Python pets are thinner tiers (mood row + birds). What each tier
supports — and how the conformance golden keeps them honest — is documented in
`docs/renderer-runtime.md`.

> Guardrails for any pet: **recovery never punishment** (no guilt/decay/death — bad beats
> bounce back), **ambient never Clippy** (react, never initiate, never steal focus),
> **honest mirror** (every animation ties to a real measured signal), **zero runtime deps**.
