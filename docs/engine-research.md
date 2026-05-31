# 🔎 Graphics/animation engine research — pick the runtime to replace the custom Canvas2D engine

> **Method.** Deep multi-source research (2026-05-30): 5 search angles → 23 sources fetched → 110
> claims → **25 adversarially verified** (3-vote, needs 2/3 to kill) → **24 confirmed, 1 killed**.
> Scope locked with Saar: **stay 2D** (pixel or vector), **OK to adopt a dependency + consolidate
> renderers**, judged on **established · runtime feature-swap · authoring · lightweight**.
> Sources are mostly primary (vendor LICENSE files fetched raw, official API docs, repo example code).

## TL;DR — adopt **Rive**

| | **Rive** ✅ #1 | **Spine** (spine-pixi) · runner-up | **PixiJS** · lightest-touch | Live2D Cubism · ⚠️ flag |
|---|---|---|---|---|
| License | **Unconditional MIT** runtimes (editor = paid SaaS ~$9/mo) | Runtime tied to a **paid per-seat editor** ($69–$2,499+); non-MIT | **MIT** | Free dev, **paid release**; "expandable" (VTuber/pet) review at any scale |
| Runtime feature-swap | **State Machines + Data Binding** — recolor/rescale/swap parts/expressions live via bound vars | AnimationState tracks + **skin-swap** + `addSlotObject` props | None built-in (renderer only) | Parameter-driven deform |
| Authoring | Visual editor (state machines + data-bind, designer-friendly) | Visual editor (skeletal) | **Code only** (no editor) | Visual editor |
| Lightweight / always-on | GPU vector; **self-pauses to ~negligible CPU when idle** | GPU via Pixi | Fast GPU renderer | GPU |
| Web + native macOS | **Both**: WebGL web **+ native Apple (AppKit/SwiftUI) runtime** + C++ | Web (via Pixi); native via wrappers | Web only (needs Tauri/Electron) | Web + native SDKs |
| Maps to our design | **Near 1:1** (see below) | Good (imperative tracks) | We keep our own SM | Different model |

**Why Rive wins on all four of your criteria:** its runtime license is genuinely permissive (byte-for-byte
MIT, verified against the OSI template — no royalty, per-seat, or revenue trigger), its **State Machine +
Data Binding** model is exactly the "drive features from events, don't pre-bake" capability you asked for,
it has a **visual editor**, and it's built for an always-on surface (GPU vector renderer that **self-pauses
to negligible CPU when idle**). Crucially it ships an **official native Apple runtime** *and* a web runtime —
so one `.riv` asset serves both of animayte's surfaces.

## The architectural unlock (this is the big one)

Because Rive ships a **native AppKit/SwiftUI runtime** (`rive-ios`, supports macOS ≥13.1) **and** a web
runtime, animayte can **keep its existing native Swift floating window** — which already does
transparent / always-on-top / click-through — and just **host the Rive view inside it**, reusing the same
`.riv` on the browser surface. That sidesteps every Tauri/Electron macOS headache the research surfaced:
- macOS transparency needs `macOSPrivateApi` (blocks Mac App Store),
- click-through is **not** a native Tauri API (needs a ~60fps Rust cursor-polling loop),
- open Tauri bug #13415 (2025-05) — transparency works in dev, renders **solid white in production DMG**.

→ **We don't need Tauri.** Keep the Swift shell, swap the *rendering+animation engine* to Rive.

## How it maps onto what we already built (migration sketch)

Our session's data model is, pleasantly, almost exactly Rive's model — the engine work isn't wasted, it
**becomes the integration layer**:

| animayte today (`lib/anim/*`) | Rive equivalent | Migration |
|---|---|---|
| `manifest.mjs` clips / expressions / props / palettes | Artboard + LinearAnimations + State Machine + Data-Bind **View Model** | Re-author the *art* in the Rive editor; the manifest's *structure* informs the View Model "contract" |
| `state-machine.mjs` (idle↔reaction↔return, priority interrupts) | Rive **State Machine** inputs (`setBooleanState`/`setNumberState`/`fireState`) + `artboard.advance()` | Our daemon keeps the **decision logic**; it sets SM inputs instead of driving a Canvas |
| `events.mjs` `classifyTool` → reaction | App pushes values into the View Model | Unchanged — same daemon, same SSE; just different "last mile" |
| palette swap, squash/stretch, prop overlay | Data-bound color / scale / nested-artboard swap | Authored once in-editor, driven by one bound value (the canonical Rive demo: one "health" var shrinks a bar, makes a character limp, glows UI red — = one session value driving expression+palette+scale) |

So: **keep the daemon, the event vocabulary, the state-machine *decisions*, and the conformance discipline**;
move *rendering + art authoring* into Rive; the renderer drift problem disappears (one engine, one asset).

## Runner-up & lightest-touch — and when you'd pick them

- **Spine (spine-pixi)** — technically excellent (mature `AnimationState` track/mixing API maps onto our
  idle↔reaction↔return + interrupts; live skin-swap; `addSlotObject` prop overlay). **Why it's #2, not #1:**
  the **runtime ships under the non-permissive Spine Runtimes License tethered to a paid per-seat editor**
  (Essential $69 / Pro $379 / **Enterprise $2,499+ base**, and **Enterprise is mandatory + annually-renewing
  for businesses with ≥$500k revenue *or VC/financing***). Pick Spine only if you specifically want
  skeletal/cutout animation and are comfortable under $500k + paying per editor seat.
- **PixiJS (MIT)** — the lightest migration: it's a *fast GPU 2D renderer only* (no state machine, no editor),
  so you'd **keep our existing `lib/anim` state-machine + feature-swap logic almost verbatim** and just swap
  Canvas2D → PixiJS for speed. But it's **web-only** (needs a wrapper for the native window) and doesn't give
  you Rive's runtime state-machine/data-binding or visual editor. Best seen as the **host layer** under
  spine-pixi / pixi-live2d-display — or as the smallest possible upgrade if you want to keep everything custom.
- **Live2D Cubism — flag, don't adopt blindly.** Free to develop, but a **paid Publication License** triggers
  on release for entities >10M JPY, and for **"expandable" apps (explicitly incl. VTuber-style tracking)** an
  agreement/review is required **at any publisher size** with payment past 20M JPY. A pet that loads/visualizes
  is closer to "expandable." (The "small businesses are exempt" claim was the **one claim killed** in
  verification, 1-2.)

## Honest caveats (verify before committing)

- **"Rive is MIT" = the RUNTIMES only.** The Rive **editor** is a separate proprietary SaaS (~$9/mo). That's
  the *only* cost — and unlike Spine/Live2D, the runtime license is unconditional (no per-seat/royalty/revenue
  trigger). Net cost comparison: *editor seat only* (Rive) vs *editor seat + runtime-license conditions* (Spine/Live2D).
- **"Negligible CPU when idle" is vendor wording**, corroborated mechanically (the self-pause is real) but
  **not an independent benchmark** (2-1 vote). → **Profile a sample `.riv` idle+active on macOS Metal and in a
  browser tab before committing** (the one open question from the research).
- **Native data-binding SM nudge bug**: on iOS/macOS a *settled* state machine may not advance on a data change
  without a `play()`/loop nudge (`rive-ios #383`) — works on web/React. **Verify on the macOS surface.**
- **Web render quality**: Rive's fastest web path needs a draft WebGL2 extension (pixel-local-storage), else
  MSAA fallback. Affects web *quality* only, not the Metal/native path.
- **Aesthetic**: Rive is **vector-first**. It can do a pixel look and import rasters, but if you want a strictly
  pixel-art idiom, that's slightly against its grain (PixiJS + our sprite pipeline keeps pixel-art native).
- **Not independently evaluated this round** (absence of evidence, not against): DragonBones, Lottie/dotLottie,
  Phaser, Cocos, Godot-embeddable, Defold, Theatre.js/GSAP, and pixel-art pipelines (Aseprite/LDtk/libGDX/MonoGame).

## Recommended next step — a 1-day de-risking spike (before any rewrite)

1. Build **one** simple Rive pet in the editor: an artboard + a State Machine (idle/react/return) + a View
   Model exposing `mood` (enum), `fullness` (0–1 → body scale), `paletteTint` (color). Export `.riv`.
2. Drop it into **(a)** the existing **Swift window** via `rive-ios` and **(b)** a web page via the JS runtime.
3. From the daemon, drive the SM inputs / bound vars over the existing SSE — confirm expression/color/scale
   change live on **both** surfaces.
4. **Profile idle + active CPU/GPU/mem** on macOS Metal and in a browser tab.
   - ✅ if idle CPU is genuinely low and the macOS data-binding nudge bug is a non-issue → commit to Rive.
   - ❌ if idle cost is too high or the native path is buggy → fall back to **PixiJS** (keep our `lib/anim`
     state machine, web-only via the Swift WKWebView/Tauri) as the pragmatic upgrade.

## Key sources
- Rive runtime license (raw MIT): https://github.com/rive-app/rive-runtime/blob/main/LICENSE · runtimes: https://rive.app/runtimes · data binding: https://rive.app/docs/runtimes/data-binding · state machines: https://rive.app/docs/runtimes/state-machines · best practices (self-pause): https://rive.app/docs/getting-started/best-practices · native macOS runtime: https://github.com/rive-app/rive-ios
- Spine pricing/license: https://esotericsoftware.com/spine-purchase · https://en.esotericsoftware.com/spine-runtimes-license · spine-pixi: https://en.esotericsoftware.com/spine-pixi
- PixiJS: https://pixijs.com/8.x/guides/getting-started/intro · https://github.com/pixijs/pixijs
- Live2D licensing: https://www.live2d.com/en/sdk/license/ · expandable: https://www.live2d.com/en/sdk/license/expandable/
- Tauri transparent/click-through: https://v2.tauri.app/learn/window-customization/ · click-through issue #13070 · prod-DMG transparency bug #13415
- OSS desktop-pet prior art to borrow: vscode-pets (https://github.com/tonybaloney/vscode-pets) · Shimeji-ee (https://github.com/gil/shimeji-ee) · WindowPet (https://github.com/SeakMengs/WindowPet) · BongoCat Live2D (https://deepwiki.com/ayangweb/BongoCat/3-live2d-model-system) · Rive mascot state-machine writeup (https://dev.to/uianimation/engineering-interactive-mascots-with-rives-state-machine-and-runtime-architecture-4e2h)
