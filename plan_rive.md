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

## What's pending — ⏳ (needs a human + the proprietary Rive editor)

1. **Author the character `.riv`** (`pets/<name>/pet.riv` for slime + bean) in the Rive editor, exposing the
   §2 inputs from `docs/rive-contract.md`. *This is the one thing an agent can't do — the editor is a visual
   SaaS tool.* The moment the file lands in the pack, `animayte.html` uses it automatically.
2. **Wire `rive-ios` into `desktop/AnimaytePet.swift`** (host the Rive view in the existing floating window;
   set the same inputs from `/health`). Follow-up once a `.riv` exists (research-recommended path; avoids Tauri).
3. **De-risk** (from the research's open question): profile a real `.riv`'s idle CPU on macOS Metal before
   fully committing the native path.

## How to try it now
- `npm start` → open `http://127.0.0.1:4321/rive-lab.html` — see Rive render the sample, driven by this session.
- Drop a contract-conforming `pets/slime/pet.riv` → `http://127.0.0.1:4321/` auto-switches to Rive.
