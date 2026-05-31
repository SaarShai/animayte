# 🛠️ Build the animayte pet in the Rive editor (from our library)

This guide reproduces the **existing animayte library** (8 expressions, the clips, the §4.2 palettes, the
props, the idle/reaction behaviour) as a Rive `.riv`, wired to the [contract](rive-contract.md) so the daemon
drives it with zero extra code. It is generated-data-driven: the exact specs live in **`rive-export/build-spec.json`**
(run `npm run rive:export` to regenerate), and the body silhouettes are pre-vectorized in
**`rive-export/slime-body.svg`** / **`rive-export/bean-body.svg`**.

> **Why this is a guide, not a file:** Rive content is authored in Rive's visual editor (a proprietary SaaS) —
> it can't be emitted from code without hand-rolling the binary `.riv` format, which would produce crude shapes
> and throw away the editor's whole advantage. So we hand you our library as import-ready art + an exact build
> plan. Budget ~half a day for a first pass.

## 0. You'll need
- A Rive account + the editor (rive.app). The runtimes we ship are MIT; the editor is a separate ~$9/mo SaaS.
- `rive-export/build-spec.json` and the two body SVGs (in this repo).

## 1. Artboard + base body
1. New file → **Artboard** named exactly **`Pet`**.
2. **Import** `rive-export/slime-body.svg` → it gives you the slime silhouette with the §4.2 vertical gradient
   (warm rim → highlight → base → cool shadow) and a soft sheen. This preserves animayte's identity. (Pixel-art
   look is fine too — trace it as crisp rects if you prefer the original aesthetic.)
3. Group it as `Body`. Set the origin at the **bottom-centre** (the pet sits on its base; squash plants there).

## 2. Face features (from `build-spec.json` → `expressions`)
Each expression is `{ eyes, mouth, brows?, accents? }` keyed by its **mood index** (0 neutral … 7 sleepy). Draw
each feature type once as a reusable group so expressions compose:
- **Eyes:** `dots · open · look_up · wide · happy_arc · closed · stars` (big pupils / little white = cuter;
  2px-flat = sleepy). A blink = the eye filled with body colour for ~110ms.
- **Mouth:** `slight_smile · open_smile · big_grin · flat_skew · awkward · frown · small`.
- **Brows (overlay):** `one_raised · worried · sad` (the cheapest expressiveness).
- **Accents:** `blush · flush · sweat · zzz` (toggle per expression).
Keep eye↔eye and eye↔mouth spacing constant across expressions (the "Kirby rule" — identity survives squash).

## 3. Palettes (from `build-spec.json` → `palettes`)
Three ramps share the SAME roles so a mood swap is a clean re-index: **calm** (green), **tired** (cool teal),
**error** (red). Define them as editor **Color** properties / a data-bound View Model (`tint`) so `fullness`
can cross-fade calm→tired and `error` can flash. Roles: `shadowCool · shadow · base · highlight · rim ·
outline · dropShadow · eyeDark · catchlight · blush`.

## 4. State Machine `animayte` + the 12 inputs
Create a State Machine named **`animayte`** and add these inputs **with these exact names/types** (the driver
grabs them by name — see `build-spec.json` → `inputs`):

| Number | Boolean | Trigger |
|---|---|---|
| `mood` (0–7) · `fullness` (0–100) · `tool` (0–9) · `birds` (0–5) · `moodLevel` (−100–100) | `sleeping` · `reduceMotion` | `react` · `win` · `error` · `compact` · `wake` |

## 5. Wire the graph (from `build-spec.json` → `stateMachineGraph`)
- **Mood layer** — a state per expression (or one face group whose eyes/mouth/brows swap by the `mood` value);
  use **blend transitions** for a soft change. MOODS index order matches §2.
- **Tool layer** — a gag pose per `tool` category (`0 none → hidden`): 📖 read · 🔍 search · ✏️ edit · 🦵💨 run ·
  🧪 test · 📦 install · ✔ git · 🔭 fetch · 📋 plan. Show the matching prop (build-spec `props`).
- **One-shots** — `react`/`win`/`error`/`compact`/`wake` triggers fire transient timelines that **auto-return to
  idle** (recovery, never stuck). Use the `clips` transform tracks (each has keyframes `t, sx, sy, tx, ty, ease`)
  as your timeline shapes — e.g. `react` = squash `sy 0.88` → stretch `1.16 easeOutBack` → settle `easeOutBounce`.
- **Data binds** — `fullness` → body Y-scale (swell) + calm→tired tint; `moodLevel` → cool/warm floor;
  `birds` → N orbiting birds (a nested artboard, count-driven); `sleeping` → curl-down idle; `reduceMotion` →
  reduce timeline amplitude.

## 6. Idle life
Default state = a breathing loop (~1.8s, sy 1→1.03) + a randomized blink (3–6s) + a small secondary-idle pool
(sway / stretch / hop, never repeat back-to-back) + a bored doze after ~30s. (These are the `idle/sway/stretch/
bounce/doze` clips in `build-spec.json`.)

## 7. Export + verify
1. Export runtime → save it into the pack folder as `pet.riv` (i.e. into `pets/slime/`, and later `pets/bean/`).
2. `npm start`, open **`/rive-lab.html?src=/pets/slime/pet.riv`** → the **Contract check** should turn the 12
   input pills green, and the **Drive via our controller** buttons should move the pet. Fix any red pills (input
   name/type mismatches) in the editor.
3. Open **`/`** (animayte.html) → it auto-prefers the `.riv`; drive it from a real session.

## 8. Native window (after the .riv works)
Host it in a floating macOS window via `rive-ios` — the SPM package in `desktop/rive/` (build:
`cd desktop/rive && swift build -c release`). It loads the same `.riv` the daemon serves and drives the
contract inputs from `/health`. One `.riv` serves both the web page and the native pet. See `docs/rive-contract.md` §5.
