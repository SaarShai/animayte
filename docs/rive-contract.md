# 🎛️ The animayte ⇄ Rive contract

animayte is adopting **Rive** as its renderer (rationale + cited research: `docs/engine-research.md`).
The split is clean and keeps everything we already built:

- **The daemon stays the brain.** `animayte.mjs` already computes real context %, sentiment→mood, tool
  classification (`lib/anim/events.mjs`), sub-agent birds, and mood drift, and broadcasts them over SSE.
- **The `.riv` is the renderer + visual state machine**, authored in the Rive editor.
- **This contract is the seam.** A `.riv` exposes the State-Machine **inputs** below; the daemon's
  signals are mapped onto them by the pure `lib/rive/contract.mjs` and applied by `lib/rive/driver.mjs`.

> **The one step that needs a human + the Rive editor:** drawing the character and wiring its visual state
> machine. Everything *around* it (runtime, driver, mapping, contract, tests, fallback, desktop hosting) is
> built. Author an artboard to this contract, export `pets/<name>/pet.riv`, and animayte uses it automatically.

---

## 1. What to build in the Rive editor

- **Artboard:** `Pet` (any size; the runtime fits it to the window).
- **State Machine:** `animayte` — the visual graph that reacts to the inputs below.
- Export to **`pets/<name>/pet.riv`** (e.g. a `pet.riv` inside the `pets/slime/` folder). The web page HEAD-checks for it and
  prefers Rive when present, else falls back to the current Canvas2D pet — so dropping the file in is the
  whole integration. (Names are overridable; defaults live in `lib/rive/contract.mjs` `ARTBOARD`/`STATE_MACHINE`.)

## 2. State-Machine inputs (the contract)

The driver grabs these by name; **any it can't find are skipped** (so a partial `.riv` still loads). Names
are case-sensitive.

| Input | Type | Range / default | Meaning |
|---|---|---|---|
| `mood` | Number | 0–7 (0) | the sticky expression — index into MOODS (below) |
| `fullness` | Number | 0–100 (0) | context window % → body swell + cool "tired" tint |
| `tool` | Number | 0–9 (0) | active tool category → the tool gag pose; 0 = none |
| `birds` | Number | 0–5 (0) | orbiting sub-agents |
| `moodLevel` | Number | −100–100 (0) | slow mood drift (stressed … up) |
| `sleeping` | Boolean | false | session ended → curl down, Z's |
| `reduceMotion` | Boolean | false | OS "reduce motion" → dampen movement |
| `react` | Trigger | — | generic emphasis bounce (fired on happy / oops) |
| `win` | Trigger | — | big celebration (fired on excited) — confetti, star eyes |
| `error` | Trigger | — | flinch then recover (fired on sad / tool error) |
| `compact` | Trigger | — | `/compact` relief: big inhale → exhale, steam from ears |
| `wake` | Trigger | — | wake from sleep — stretch, blink awake |

**MOODS** (the `mood` number): `0 neutral · 1 thinking · 2 happy · 3 excited · 4 oops · 5 embarrassed · 6 sad · 7 sleepy`

**TOOLS** (the `tool` number): `0 none · 1 read · 2 search · 3 edit · 4 run · 5 test · 6 install · 7 git · 8 fetch · 9 plan`
→ design the tool gags (📖 read, 🔍 search, ✏️ edit, 🦵💨 run, 🧪 test, 📦 install, ✔ git, 🔭 fetch, 📋 plan).

## 3. How the daemon drives it (already implemented)

`lib/rive/driver.mjs` exposes the *same* controller interface as the Canvas2D runtime, so the page, SSE
dispatch, buttons, and demo are unchanged. The pure mapping (`commandToOps`, tested in `test/rive.test.mjs`):

| Daemon SSE command | Rive input op |
|---|---|
| `mood:'thinking'` | `mood = 1` |
| `mood:'excited'` | `mood = 3` **+ fire `win`** |
| `mood:'happy'` / `'oops'` | set `mood` **+ fire `react`** |
| `mood:'sad'` | `mood = 6` **+ fire `error`** |
| `fullness:0.6` | `fullness = 60` |
| `react:{name:'Reading'}` | `tool = 1` (read) |
| `endReact` | `tool = 0` |
| `relief` | fire `compact` |
| `addBird`/`removeBird`/`clearBirds` | `birds = <count 0–5>` |
| `sleep` / `wake` | `sleeping = true` / `false` + fire `wake` |
| `moodLevel:0.5` | `moodLevel = 50` |

Daemon mood aliases are normalised first (`idle→neutral`, `working/listening→thinking`, `bashful→oops`,
`tired→sleepy`).

## 4. Optional enhancement — Data Binding (color/scale)

Inputs above are the floor (supported by every Rive runtime). Rive **Data Binding / View Models** can
additionally drive **color** and **scale** directly from bound variables — ideal for the palette tint and
the fullness swell without baking states. If you author a View Model, expose `tint` (Color) and `scale`
(Number) and we'll bind `fullness`/`moodLevel` to them in the driver. (See `docs/engine-research.md` §data-binding.)

## 5. Desktop hosting (the floating macOS pet)

Two paths — the research recommends the first (avoids all of Tauri's macOS transparency/click-through friction):

1. **Native Apple runtime (recommended).** Rive ships `rive-ios` (AppKit + SwiftUI, macOS ≥13.1). A starting
   implementation is in **`desktop/rive/`** (an SPM package): it reuses the `desktop/AnimaytePet.swift` floating
   window setup (transparent / always-on-top / click-through), hosts a `RiveViewModel` loaded from the daemon's
   `/pets/<pet>/pet.riv`, and sets the contract inputs from `/health` via `setInput(_:value:)` / `triggerInput(_:)`
   (indices mirror §2). Build: `cd desktop/rive && swift build -c release` (fetches the Rive SPM dep). One `.riv`
   serves both the native window and the web page. *(Untested-compile until a real `.riv` exists + the Rive dep is fetched.)*
2. **Web in a wrapper.** Load `animayte.html` (which already prefers Rive) inside a `WKWebView` or Tauri/Electron
   window. Simpler to ship, but macOS transparency/click-through needs extra work (documented in `engine-research.md`).

## 6. What's built vs. what's pending

- ✅ Rive runtime vendored locally (`assets/vendor/rive/`, MIT) + correct `.wasm`/`.riv` MIME in the daemon.
- ✅ `lib/rive/contract.mjs` (the spec + pure mapping) + `lib/rive/driver.mjs` (browser driver, shared controller interface).
- ✅ `rive-lab.html` — loads any `.riv`, lists its state machines/inputs, contract-checks it, and drives it live from the daemon.
- ✅ `animayte.html` prefers Rive (`pets/<pet>/pet.riv`) and falls back to Canvas2D — verified non-regressive.
- ✅ `test/rive.test.mjs` — 54 checks over the mapping/contract.
- ⏳ **Author the `.riv`** (`pets/<name>/pet.riv` for slime + bean) in the Rive editor to this contract — the human/design step.
- ⏳ Swift host (`rive-ios`) wired into `desktop/AnimaytePet.swift` (path 1 above) — a follow-up once a `.riv` exists.
