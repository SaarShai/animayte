# 🎬 animayte → Rive — adoption plan & status

> **Goal (Saar, 2026-05-31):** "set up everything we need with Rive and adapt what we already have."
> Decision basis: `docs/engine-research.md` (deep, adversarially-verified research → Rive is the #1 pick:
> unconditional-MIT runtimes, State-Machine + Data-Binding feature-swap, native Apple + web runtimes, idle
> self-pause). Scope locked with Saar: **stay 2D**, **OK to adopt a dependency + consolidate renderers**.

## The judgment call: what we keep, adapt, rebuild

| | Verdict | Why |
|---|---|---|
| `animayte.mjs` daemon (context %, sentiment, tool classify, birds, mood drift) | **KEEP** | It's the brain; Rive is just the renderer. Unchanged except `.wasm`/`.riv` MIME. |
| `lib/anim/events.mjs`, sentiment, the whole event vocabulary | **KEEP** | Feeds Rive inputs verbatim. |
| `lib/anim/*` Canvas2D engine (runtime/state-machine/manifest/compositor/…) | **KEEP as fallback** | Stays the renderer until a `.riv` exists; then it's the graceful fallback. No regression. |
| The *rendering + art authoring* | **REBUILD in Rive** | The `.riv` (editor-authored) replaces hand-plotted pixels + the Canvas2D draw loop. |
| The pet "contract" (manifest/state-machine concepts) | **ADAPT → `lib/rive/contract.mjs`** | Our manifest/FrameResult model maps ~1:1 to Rive SM inputs + data-bind. |

→ Net: **all the daemon intelligence + event vocabulary is reused**; only the last mile (pixels) moves to Rive.

## What's built (this session) — ✅

- **Vendored Rive runtime** locally: `assets/vendor/rive/rive.js` + `rive.wasm` (@rive-app/canvas v2.37.8, **MIT**)
  + `sample.riv` (Rive's public demo, for the lab only). Daemon now serves `application/wasm` + `.riv`.
- **`lib/rive/contract.mjs`** — the State-Machine input contract (12 inputs) + the PURE daemon→Rive mapping
  (`commandToOps`/`moodToIndex`/`reactionToToolIndex`/`nextBirds`). Fully unit-tested.
- **`lib/rive/driver.mjs`** — browser driver: exposes the SAME controller interface as the Canvas2D runtime,
  implemented by setting Rive inputs. Missing inputs are skipped (partial `.riv` still loads).
- **`rive-lab.html`** — dev page: loads any `.riv`, lists its state machines/inputs, **contract-checks** it,
  and **drives it live from the daemon SSE**. (Validated: vendored WASM loads offline, sample renders, SSE forwards.)
- **`animayte.html`** — boot now prefers Rive when `pets/<pet>/pet.riv` exists, else Canvas2D, else legacy.
  Verified non-regressive (no `.riv` → the slime renders as before).
- **`test/rive.test.mjs`** — 54 checks over the contract/mapping. `npm test`: **796 checks green**.
- **`docs/rive-contract.md`** — the spec a designer builds the `.riv` to + the native-Swift hosting path.
- **`tools/rive-export.mjs`** (`npm run rive:export`) → **`rive-export/`**: `build-spec.json` (our WHOLE library —
  8 expressions, 18 clips, 12 inputs, palettes, props, the SM graph — as a Rive build plan) + `slime-body.svg`
  / `bean-body.svg` (our silhouettes as import-ready vector art). This is "import/adapt our library" without the editor.
- **`docs/rive-build-guide.md`** — step-by-step editor build FROM that export (artboard → import the SVG →
  faces → palettes → the `animayte` state machine + 12 inputs → wire the graph → export `pet.riv`). ~half-day build.
- **`desktop/rive/`** — Swift SPM package (`AnimaytePetRive`) that hosts the `.riv` in a floating macOS window
  (reuses the transparent/click-through window setup) and drives the contract inputs from `/health`. The Rive SPM
  dep **resolves cleanly** (rive-ios **6.20.5**, `Package.resolved` committed) and compilation starts without API
  errors; the full link couldn't finish *in this sandbox* (Rive's ~100MB+ prebuilt `RiveRuntime.xcframework`
  download timed out — an environment limit, not the code). **Build on a Mac:** `cd desktop/rive && swift build -c release`.
- **More tests**: `test/rive.test.mjs` now 66 checks (mapping + build-spec coverage + SVG); integration +5 (Rive
  asset MIME, driver served, no-`.riv`→404 fallback). `npm test` green: **827 checks**.

## What's pending — ⏳ (needs a human + the proprietary Rive editor)

1. **Author the character `.riv`** in the Rive editor. *No automated path exists* (researched 2026): the
   `.riv` format has readers but **no public writer** (codegen = multi-week reverse-engineering, not worth
   it); Rive's AI does **logic/state-machines only, not artwork**; text/image→Rive doesn't exist; Lottie
   import is Enterprise-only + discouraged. **The realistic fastest path = import an SVG → finish in the
   FREE editor** (SVG import preserves paths/groups/named-IDs/gradients; the only manual work is rigging +
   the state machine, which we already have a contract for). Candidate designs ready: **`rive-pets/`**
   (Mochi/Pip/Boo — cute, import-clean SVGs) + `rive-export/` (our existing slime/bean as SVG + build-spec).
   The moment a `pet.riv` lands in a pack, `animayte.html` uses it automatically.
2. **Compile + run `desktop/rive/`** once a `.riv` exists (`swift build`; the code is written). Then optionally
   add SSE streaming (vs /health polling) for crisper trigger timing.
3. **De-risk profile** (research open question): on a Mac, run the `.riv` in `desktop/rive/` and in a browser tab,
   open Activity Monitor / Xcode Instruments (Time Profiler), and confirm **idle CPU is low** (Rive self-pauses
   when no looping animation/SM transition is active) and active CPU is acceptable for an always-on pet. ✅ if low →
   commit the native path; ❌ if high → keep Canvas2D / consider PixiJS. (Can't be measured from here — needs a real `.riv` + Mac.)

## How to try it now
- `npm start` → open `http://127.0.0.1:4321/rive-lab.html` — see Rive render the sample, driven by this session.
- Drop a contract-conforming `pets/slime/pet.riv` → `http://127.0.0.1:4321/` auto-switches to Rive.
