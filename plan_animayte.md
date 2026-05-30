# 🫧 animayte — Autonomous Build Plan: *The Living Cartoon Engine*

> **Status:** PLAN ONLY — not executed yet. Authored 2026-05-30 for an unattended, open-ended autonomous build (runs continuously until Saar says stop).
> **Source of truth for execution.** The agent running this should treat the milestones, guardrails,
> and validation discipline below as binding, check off progress in §10, and log decisions in §11.

---

## 0. How to use this file (and the "/goal" question)

**Launch this with `/goal`** (Claude Code desktop) — this file *is* the goal definition: the headline
**Goals** in §2 are the achievements, each decomposing into **Milestones** in §7 with explicit
done-criteria and autonomous tests. The plan is launch-agnostic — it works equally if you drive it via
**`/loop`** (self-paced) or paste the [Execution Prompt](#13-the-execution-prompt-paste-this-to-run)
into a fresh session. For the content-heavy phase you may fan out with a **dynamic Workflow** (§8).

> ⚠️ **PRIME DIRECTIVE — whatever the launcher, this is a continuous, open-ended run.** The agent does
> **not** stop when the milestones are done. It keeps choosing and executing the next most valuable work
> by its own **best judgment** — milestones → backlog → newly-invented work — **indefinitely, until Saar
> explicitly says stop.** Finishing the listed milestones is *not* a stopping condition; idle is not an
> option. (First non-negotiable in §2; fuelled by §12.)

**The whole bet of this plan:** the current MVP is good but *shallow* — the pet wobbles + blinks and
swaps one of 8 baked faces. We are turning it into a **living cartoon**: a small, elegant, **data-driven
animation framework** + a **library of expressive, event-mapped animations**, built so 80% of the
"aliveness" comes from *procedural* squash/stretch/easing/props rather than hand-drawn frames — and so the
same library re-skins onto any future pet.

---

## 1. Where we are starting from (grounding)

Verified by reading the repo on 2026-05-30:

| Piece | File | What it does today | Gap we're closing |
|---|---|---|---|
| Feeling dictionary | `lib/expressions.mjs` | 8 expressions (neutral/thinking/happy/excited/oops/embarrassed/sad/sleepy); each = emojis+keywords+events+priority+`face{eyes,brows,mouth,accents}` | Faces are good but **static per row**; no clips, no idle life, no tool poses, no props beyond sweat/zzz/blush |
| Detector | `lib/sentiment.mjs` | `detectMood(text)` → expression id | Solid. Keep + extend. |
| Asset compiler | `tools/make-assets.mjs` | Zero-dep: hand-plots pixels → `slime.png` (8 rows × 4 frames, 64px) + `slime.json` + `bird.png`. Body squashes via `sin` wobble + hop; blink on frame 3 | **Faces are baked in** → can't combine pose × face × prop × palette at runtime. Becomes our **compiler**. |
| Daemon | `animayte.mjs` | Zero-dep Node server (:4321). Hooks→`/event`, statusline→`/status`, SSE `/events`, `/health`, `/detect`, `/set`, `/demo`. Real context %, sentiment, birds, `/compact` relief | Maps `PreToolUse`→generic "thinking"; only `Task` is special. **No tool category** emitted → no read/run/search poses. |
| Renderers | `desktop/AnimaytePet.swift` (native, preferred), `desktop/animayte_pet.py` (Tk fallback), `animayte.html` (browser) | All blit the shared `slime.png` row for the current mood + orbit birds | **3 renderers = drift risk** (just fixed once). No shared runtime *contract*. |
| Entry | `bin/animayte {start\|stop\|restart\|status}` | Launches daemon + best renderer | Fine. |
| Signals catalog | `docs/session-signals.md` | Everything the pet *can* see; flags `💡 tool-specific poses (Bash=run, Read=read, Grep=search)` as unbuilt | This plan builds those. |
| Tests | `test/*.mjs` | README claims **211 checks** (detection, renderer-consistency, e2e) | Must stay green; we extend heavily. |

**Architecture (unchanged, good):** `Claude Code hooks → curl POST → animayte.mjs (:4321) → SSE + /health → renderer`.

---

## 2. Goals (the "achievements") 🏆

Each is a real, demonstrable capability. Done-criteria are in the milestones.

- **🏆 G1 — A dynamic animation framework.** A lean, data-driven engine that changes **expressions,
  colors, outlines, and element sizes at runtime** via layered compositing + palette-swap + procedural
  squash/stretch/easing — not by pre-baking every combination. *(Track A)*
- **🏆 G2 — A living-cartoon animation library.** A reusable library of **idle behaviors, expressions,
  tool-call animations, and prop/emote overlays** mapped to real LLM/session events ("reading" → glasses
  + look down; "running" → tiny legs run-in-place; "asking" → head-tilt + "?"). Playful, Looney-Tunes
  energy, grounded in 8–16-bit game craft. *(Track B)*
- **🏆 G3 — Infrastructure for the future.** A **pet-pack format** (a pet = a folder), a
  **renderer-conformance contract** (kills drift), a **personality** layer (data that biases reactions),
  a **mood** layer, optional **sound** infra, and an extended **event vocabulary** — all lean, all
  set up for user-made pets / new releases / richer interaction. *(Track C)*
- **🏆 G4 — Autonomously validated.** Everything above provable **without Saar in the loop**: logic unit
  tests, generated contact-sheets/filmstrips I can *see*, browser screenshots, and event-stream
  simulations. *(cross-cutting — see [§9](#9-autonomous-validation-toolkit-the-priority))*

**Non-negotiables (inherited guardrails):**
- **🔁 Never stop until Saar says so (prime directive).** This is a continuous, open-ended engagement.
  Work the milestones → then the §12 backlog → then keep generating and executing new high-value work by
  your own best judgment (research and apply it, build, test, harden, polish, invent new
  pets/animations/features). **Completing the listed milestones is NOT a stopping condition. Idle is not
  an option.** Only an explicit "stop" from Saar ends the run. If genuinely blocked on one task, pick a
  different valuable one and proceed — never wait.
- **Recovery, never punishment** — errors → worried-but-hopeful, the payoff is the bounce-back. No
  guilt/decay/death.
- **Ambient, never Clippy** — the pet *reacts*, it never initiates during silence, never steals focus,
  never blocks clicks.
- **Zero runtime dependencies** — the daemon, PNG encoder, and engine stay dependency-free (the repo's
  proud stance). Author-time tools may use Node built-ins only. *(Borrow ideas/formats, vendor tiny
  permissively-licensed snippets — never add a heavy runtime dep.)*
- **Honest mirror** — every animation ties to a *real measured* signal.
- **Don't regress.** Keep `npm test` green; the native + browser pets keep working at every commit.
- **Filesystem safety** (Google Drive synced `~/Documents`): **create/edit files only**. No folder
  move/rename/delete, no `.git` relocation, no bulk `mv`/`rm`/`find -exec`. New dirs come into being by
  *writing a file into them*, one at a time.

---

## 3. Architecture decision (technical default — rationale for Saar's async review)

**The problem:** "change features at runtime" + "3 renderers" + "stay lean" are in tension. Pre-baking
every pose × face × prop × palette explodes; re-implementing a rich engine 3× causes drift (just fixed).

**The decision — keep complexity in *authoring*, keep *runtime* thin, make the web renderer the rich
reference, and protect everyone with a golden contract:**

1. **A pet is data.** `pets/<name>/pet.json` (a thin superset of the de-facto **Aseprite JSON** format)
   describes: **layers**, **clips** (frame sequences w/ per-frame durations + procedural transform
   tracks), **expressions** (face-layer states), **props** (overlay sprites + anchor + pop animation),
   **palettes** (mood/color swaps), **reactions** (event → clip+expression+prop+palette+priority+return),
   and **idle** behavior. → *This is what makes the library reusable across pet designs.* (Format
   inspiration: Aseprite tags+durations; Spine's "named keyed-transform timelines"; Shimeji/VPet's
   foldered, data-driven pets.)

2. **One small shared runtime *spec*.** `(petState, t) → draw list`. ~150 lines of logic: a
   `FrameResult{CONTINUE,COMPLETE,CANCEL}` state machine (idle ↔ transient-reaction ↔ return-to-idle,
   integer priorities for interrupts), layered compositing, procedural transforms via easing, palette
   swap, prop overlays. Pattern stolen wholesale from **vscode-pets** (MIT, 2.5M installs).

3. **The web renderer (`animayte.html`, Canvas2D, zero-dep) is the rich reference** — and the future
   production renderer (Tauri wrapper was already the deferred v2 path). *Crucially, it's the one I can
   visually validate autonomously* via the Preview MCP (screenshots + scripted state drives).

4. **The compiler (`tools/make-assets.mjs` v2) bakes a richer spritesheet + emits the manifest**, so the
   **native Swift / Python pets keep working and get richer for free** (more clips/frames baked in).
   They degrade gracefully (they may not do live palette-swap/secondary-idle/props — fine for now; the
   conformance contract documents exactly what each tier supports).

5. **Renderer-conformance contract** (`test/conformance.mjs` + golden JSON): "given this state at this
   time → these active layers / this frame / this transform." Any renderer that drifts fails the test.
   *This is how we keep 3 renderers honest instead of hoping.*

6. **Engine logic lives in `lib/anim/*.mjs` (pure, testable)** and is consumed by both the web runtime
   and the offline preview/compiler — so the math is unit-tested once and shared.

**Why not PixiJS / Rive (from `docs/frameworks-research.md`)?** They're powerful but add a CDN/runtime
dep and cut against the repo's zero-dep identity. A tiny custom Canvas2D runtime covers everything here.
*Keep PixiJS as an optional accelerator only if particle FX (confetti) get heavy; Rive stays the v2
"smooth vector morph" differentiator.* — **flagged for Saar.**

**Why not move the engine server-side (daemon composites + streams frames)?** Heavier, couples render to
network, and the native pets already poll fine. Data-down + thin-runtime is leaner.

> **Net:** the *visual language & framework* (the hard part) lives in **data + one shared logic module +
> the compiler**; every renderer stays a near-dumb player; a golden contract prevents drift.

---

## 4. Visual language spec (the animator's brief)

Distilled from a 3-track research sweep (Kirby/Owlboy/Celeste/Stardew craft; Lospec/SLYNYRD palettes;
Game-Anim 12-principles; vscode-pets/Shimeji/VPet patterns). **Art = basic 8–16-bit, few colors, VERY
expressive, shadow pixels for depth.**

### 4.1 Layer stack (bottom → top)
`drop-shadow → outline → body(+internal shading) → eyes → mouth → brows → accessory/prop`
- **Body** carries squash/stretch (the slime *is* squash & stretch).
- **Eyes/mouth/brows** are independent → any expression composes onto any pose; a **blink** is one frame
  of the eye filled with body color.
- **Props** are separate overlays that pop in/out (2-frame scale).
- **Outline:** full dark silhouette outline (desktop background is unknown) + optional faint outer halo
  for contrast on dark wallpapers. Do **not** anti-alias the outer edge against an assumed background.
- **Drop shadow** squashes/widens *in sync* with the body (wider when flat, smaller when airborne).

### 4.2 Palette (target — hue-shifted ramp w/ shadow pixels)
Cool, desaturated shadows → warm, saturated mid → near-yellow rim highlight (this reads as real light).
~9 colors total = squarely 8–16-bit. *(Current `make-assets.mjs` palette is close; evolve toward this.)*

| Role | Hex | Note |
|---|---|---|
| Core shadow (cool) | `#1E4D3B` | darkest, slightly blue-green, bottom interior |
| Shadow | `#2E7D4F` | |
| Base green (most saturated) | `#5BC661` | local color |
| Highlight (warmer) | `#9BE86A` | top-left lit |
| Rim / translucency | `#E8FBB0` | thin bright edge (gel look) |
| Outline | `#16352B` | full silhouette (softer than pure black) |
| Outer halo | `#FFFFFF` @ ~30% | dark-wallpaper contrast only |
| Desktop drop shadow | `#10231C` @ ~35% | ellipse beneath pet |
| Eye dark / catchlight | `#16352B` / `#F2FBE9` | 1px catchlight, upper-left |
| Blush (cute) | `#F6757A` | optional |
Prop accents (reuse, max +1): warm `#FEE761` (Z/sparkle/!), alert `#E43B44` (error, sparingly), neutral `#3A4466` (glasses/?/book).

**Mood = palette swap:** `calm` (greens above), `tired` (shift cool blue-green as context fills),
`error` (brief red flash → snap back to green — never *stay* red). Group colors as ramps so a mood is one
small array (indexed-palette swap = instant, cheap).

### 4.3 Expression craft (few pixels, big feeling)
- **Eyes + mouth carry ~90% of emotion.** Lock the eye↔eye and eye↔mouth spacing across all poses
  (the "Kirby rule") so identity/cuteness survive squash.
- Eyes ≈ 3×3–4×4 dark ovals + 1×1 catchlight; **big pupils / little white = cuter**; 2px horizontal =
  sleepy/bored.
- Mouth = 1px line, 3–6px wide: flat/▵up/▿down/open-O/cat-w.
- **Brows are the cheapest expressiveness** (1–2 overlay px): down-in = focused/angry, up-in = worried,
  raised = surprised.
- **Exaggerate** — push every pose 1–2px past "correct"; subtlety vanishes at this size.

### 4.4 Motion principles & timing budgets
- **Squash & stretch with conserved volume** (wider when short, taller when narrow — never both).
- **Anticipation** (one opposite frame first), **easing** (hold extremes, fast middles — *timing IS the
  easing at pixel scale*), **follow-through** (jiggle settles a beat late).
- Easing curves to favor for bounce: `easeOutBack` (overshoot-settle), `easeOutBounce`, `easeOutElastic`.
- **Frame budgets (cheap but alive):** idle 2–4 frames (~6fps / 400–500ms holds, randomized blink);
  reactions 3–5 frames (anticipation→extreme→settle); runs 3–6 frames; **props pop in 2 frames**. Reuse
  & mirror frames aggressively. Vary frame durations — *never* constant timing.

### 4.5 Prop / emote library (iconographic shorthand)
`!` alert · `?` confused · `…` waiting/unsure · 💧 sweat (stress) · `Z` sleep · ✨ sparkles/♪ success ·
💡 idea · ❤ affection · 👓 glasses (reading) · ✏️ pencil (writing) · 🔍 magnifier (searching) · 📖 book ·
🦵 tiny legs (running) · 💨 steam (compact relief) · 🐦 bird (sub-agent) · 🎉 confetti (big win) · hat (flavor).
Each: 1–2px outline, ≤4 colors, animates in with a 2-frame scale.

---

## 5. Event → animation taxonomy (the library design)

The heart of Track B. Grounded in `docs/session-signals.md` (real Claude Code events) + LLM-output
patterns + game idle/idle-secondary craft. **Cute & quirky on purpose.**

| State / event | Trigger (Claude Code) | Body clip | Face | Prop | Mood/palette |
|---|---|---|---|---|---|
| **Greet** | `SessionStart` | pop-in bounce + wave | happy | ✨ | calm |
| **Listening** (read prompt) | `UserPromptSubmit` | perk up, lean toward user | attentive | `!`→`…` | calm |
| **Thinking** | reasoning / `Stop` w/ thinking on | look up, brow furrow, slow sway | thinking | `?`/💭 | calm |
| **Reading** | `PreToolUse` Read/Grep/Glob | **put on glasses, look down, eyes scan L↔R** | focused | 👓 + 📖 | calm |
| **Searching** | Grep/Glob/WebSearch | peer around w/ magnifier | focused | 🔍 | calm |
| **Writing/editing** | Edit/Write/NotebookEdit | tiny pencil, scribble bob | determined | ✏️ + paper | calm |
| **Running a command** | `PreToolUse` Bash | **sprout little legs, run-in-place, dust puffs** | determined | 🦵 + 💨 | lively |
| **Testing** | Bash(test) → Post | bite nails / crossed fingers → cheer or wince | nervous→happy/sad | 💧 / ✨ | — |
| **Installing** | Bash(npm/pip/brew) | watch, tap foot | waiting | `…` / 📦 | calm |
| **Committing/git** | Bash(git) | stamp/seal, proud nod | happy | ✔/🚩 | lively |
| **Asking the user** | `Notification` / permission | turn to user, head-tilt, raise "hand" | curious | `?` | gentle bob |
| **Waiting** (model latency) | gap between Pre/Post | idle fidget, glance around | neutral | `…` | calm |
| **Sub-agent spawned** | `PreToolUse` Task | bird hatches from a thought, orbits (≤5) | proud | 🐦 | lively |
| **Sub-agent done** | `SubagentStop` | bird flies off | happy | — | — |
| **Success** | sentiment happy / Post ok | stretch-up bounce | happy | ✨/♪ | warm |
| **Big win** | sentiment excited | jump + confetti, star eyes; **rare special dance** | excited | 🎉/⭐ | warm |
| **Own slip** | sentiment oops | flinch, sheepish scratch | oops | 💧 | slight |
| **Embarrassed** | sentiment embarrassed | hide face, peek | embarrassed | flush | warm-red cheeks |
| **Error / bad news** | Post error / sentiment sad | flinch-squash → **perk back (recovery)** | sad→hopeful | `!`→resolve | brief red → back to green |
| **Context filling** | rising `fullness` | body swells, eyes droop, sweat | tired-ish | 💧 | shift toward "tired" |
| **Compact relief** ★ | `PreCompact` | **big inhale (stretch) → long exhale squash, steam from ears, satisfied sigh** | blissful | 💨 + 😮‍💨 | snap back to fresh |
| **Idle** | quiet N s | breathing + blink + weight-shift | neutral | — | calm |
| **Bored** | quiet ~30s+ | yawn, look around, tap, doze | sleepy-ish | faint `Z` | calm |
| **Sleep / end** | `SessionEnd` | curl down, Z's | sleepy | 💤 | dim |
| **Wake** | event after sleep | stretch, blink awake | neutral→happy | — | brighten |
| **Cursor glance** (flair) | mouse near pet | pupils track cursor | — | — | — |

**Idle system spec:** base breathing loop (≈4–6s) + randomized blink (3–6s) + a small **secondary-idle**
pool (look-around / wobble / yawn / scratch) on a randomized timer + **bored idle** after session
inactivity. **Anti-repetition:** never repeat the same secondary twice; weight by personality. *(This is
where a desktop pet actually lives — invest here.)*

---

## 6. Tracks at a glance → milestone map

| Track | Goal | Milestones |
|---|---|---|
| **A — Framework** | G1 | A1 schema · A2 easing/transforms · A3 compositor+palette · A4 state machine · A5 web runtime · A6 compiler+preview |
| **B — Library** | G2 | B1 taxonomy doc · B2 expressions-v2 · B3 idle system · B4 tool-call anims · B5 prop library · B6 reaction wiring |
| **C — Infra** | G3 | C1 pet-pack format · C2 conformance contract · C3 personality · C4 mood layer · C5 sound infra · C6 daemon event vocab · C7 config/persistence · C8 docs/packaging |

Phases below encode the dependency order; within a phase, milestones are parallelizable.

---

## 7. Milestones (phased, each with autonomous tests + done-criteria)

> Convention: every milestone ends green (`npm test`), is committed on branch `feat/anim-engine`
> (don't push unless asked), and updates §10/§11. Prefer **evolving** existing files over rewrites.

### Phase 0 — Foundation & the "I can SEE it" loop *(mostly serial; do first)*
- [ ] **A1 · Pet manifest schema** — define `pets/slime/pet.json` (superset of Aseprite JSON: layers,
  clips{frames,durations,transform tracks}, expressions, props, palettes, reactions, idle). Write
  `lib/anim/manifest.mjs` (load + validate, friendly errors). Generate the slime's manifest **from the
  existing `EXPRESSIONS`** so it stays the source of truth.
  *Tests:* schema validator unit tests (valid loads; each invalid field rejected with a clear message);
  round-trip the 8 existing expressions. **Done:** `pet.json` validates; old expressions represented.
- [ ] **A2 · Easing + transform core** — `lib/anim/easing.mjs` (vendor ~8 pure-stdlib funcs incl.
  `easeOutBack/Bounce/Elastic`, BSD/MIT-clean) + `lib/anim/transform.mjs` (squash/stretch/scale/offset/
  rotate, **volume-conserving** squash helper).
  *Tests:* easing values vs known reference points (t=0→0, t=1→1, midpoints); `squash(k)` width×height
  ≈ const invariant. **Done:** unit tests pass.
- [ ] **A6 · Compiler v2 + offline preview** *(prioritized early — it's how I validate everything)* —
  evolve `tools/make-assets.mjs` to (a) still emit a back-compatible `assets/slime.png`+`slime.json` for
  thin renderers, (b) emit the manifest, (c) **render any clip to a filmstrip PNG and/or GIF**
  (`tools/preview.mjs`) so frames can be *read and judged*.
  *Tests:* `npm run assets` produces valid PNGs (decode header check); preview emits a filmstrip whose
  dimensions match frame-count×cell. **Done:** I can run preview and **Read the image** to QA art.

### Phase 1 — Engine core *(parallel after Phase 0)*
- [ ] **A3 · Compositor + palette swap** — `lib/anim/compositor.mjs`: composite the layer stack (alpha),
  **indexed-palette swap** for mood/color, precomputed outline from the alpha mask.
  *Tests:* compose a known 3-layer fixture → assert exact pixels; palette-swap maps every ramp color;
  outline appears 1px around silhouette. **Done:** tests pass; a swapped-palette filmstrip reads correct.
- [ ] **A4 · State machine** — `lib/anim/state-machine.mjs`: `FrameResult{CONTINUE,COMPLETE,CANCEL}`,
  per-state `priority`, **transient reactions auto-return to idle**, idle base + randomized secondary +
  **bored after inactivity**, interrupt-by-priority, **anti-repetition**.
  *Tests:* feed event sequences → assert the state timeline (e.g. `error` interrupts `reading`, then
  returns to `idle`; two secondaries never repeat back-to-back; bored fires after N idle ticks).
  **Done:** simulation timelines match intent.
- [ ] **B1 · Event→animation taxonomy doc** — formalize §5 into `docs/animation-library.md` (the design
  reference the content milestones build against). **Done:** doc complete + reviewed against
  `session-signals.md` (no event left unmapped; nothing requires a signal we can't get).
- [ ] **C1 · Pet-pack format & loader** — a pet = `pets/<name>/` (manifest + sheet[s]). Move the slime
  into `pets/slime/` *by writing new files* (leave `assets/` working; do **not** `mv`). Loader resolves
  packs; `bin/animayte`/daemon learn an optional `ANIMAYTE_PET` env.
  *Tests:* loader lists packs, loads slime, rejects a malformed pack. **Done:** slime loads as a pack;
  a second stub pack proves reusability.

### Phase 2 — The living cartoon (content + reference runtime) *(the bulk; parallelize heavily — see §8)*
- [ ] **A5 · Web reference runtime** — rewrite `animayte.html`'s draw loop to consume the manifest via
  `lib/anim/runtime.mjs` (Canvas2D, zero-dep): play clips, composite layers, procedural transforms,
  palette swap, props, idle state machine, bird orbit. Keep the standalone-file demo working.
  *Validation:* **Preview MCP** — start daemon, open the page, drive `/set`+`/detect`, **screenshot**
  each state; eval `new Function(scriptSrc)` parse-check (per env trick). **Done:** screenshots show
  every taxonomy state rendering correctly.
- [ ] **B2 · Expressions v2** — upgrade the 8 faces with §4.3 craft + the hue-shifted palette + shadow
  pixels; split blink into its own layer/frame. Keep ids/priorities stable (don't break detection).
  *Validation:* contact-sheet of all faces → Read & judge; `expressions.test.mjs` still green. **Done:**
  faces visibly more expressive; tests green.
- [ ] **B3 · Idle system** — breathing loop + randomized blink + secondary-idle pool + bored idle (+
  optional cursor glance in web). *Validation:* filmstrip/GIF of a 60s idle timeline → Read; simulation
  asserts secondary variety + bored trigger. **Done:** idle reads "alive," not looped.
- [ ] **B4 · Tool-call animations** — build the clips from §5: **reading** (glasses+look-down+scan),
  **running** (legs+run-in-place+dust), searching, writing, testing, installing, committing, asking,
  waiting. *Validation:* per-clip filmstrips → Read & judge; each maps from a real event. **Done:** the
  signature "reading/running" gags land visibly.
- [ ] **B5 · Prop / emote library** — the §4.5 overlays as reusable, anchored, pop-in sprites, shared
  across pets. *Validation:* a prop contact-sheet → Read; props anchor correctly on the slime in
  browser screenshots. **Done:** props compose onto any pose/expression.

### Phase 3 — Systems & polish *(parallel)*
- [ ] **B6 · Reaction wiring + tuning** — fill the manifest `reactions` map (event →
  clip+expression+prop+palette+priority+return) with weighting + anti-repetition; wire the new tool
  poses end-to-end (needs C6). *Tests:* simulate a full session event stream → assert reaction timeline;
  no stuck states. **Done:** a replayed real session looks right end-to-end.
- [ ] **C6 · Daemon event vocabulary** — extend `animayte.mjs`: classify `PreToolUse` tool → category
  (`read/search/edit/run/test/install/git`) and expose `activeTool` in `/health`+SSE; add idle ticks;
  keep zero-dep + backwards-compatible. *Tests:* POST sample hook JSONs → assert classified state; old
  fields unchanged. **Done:** renderers can pick tool poses from `/health`.
- [ ] **C3 · Personality (data)** — `personalities/{calm,chipper,grumpy}.json`: a tiny object that
  **re-weights reaction selection + idle bias** (+ later sound). Selection reads it. *Tests:* same event
  stream under 3 personalities → measurably different reaction distributions; weights honored. **Done:**
  personalities visibly bias behavior; default = "Adaptive (calm working / lively at milestones)".
- [ ] **C4 · Mood layer** — one global mood var derived from recent events, tinting reaction intensity +
  idle variant (+ palette nudge). *Tests:* run of errors → "stressed" tint; wins → "up". **Done:** mood
  coheres the feel without new content.
- [ ] **C2 · Renderer-conformance contract** — `docs/renderer-runtime.md` (the shared spec) +
  `test/conformance.mjs` golden `(state,t)→{layers,frame,transform,palette}` fixtures. Document each
  renderer tier's supported subset. *Tests:* web runtime passes golden; (Swift/Python noted as
  follow-up). **Done:** golden contract exists & web conforms.

### Phase 4 — Optional / lower-confidence *(do if time; default-safe)*
- [ ] **C5 · Sound infra (default OFF)** — event→one-shot map, master volume, pitch-by-mood; generate
  placeholder chiptune blips offline (sfxr-style), wire into web runtime muted by default. *Tests:*
  mapping unit test; WAV header valid; **silent unless explicitly enabled**. **Done:** infra ready;
  *cuteness of the actual sounds is a Saar call.*
- [ ] **C7 · Config & persistence** — small config (chosen pet, personality, sound on/off, remembered
  position; per-project pet = stretch). *Tests:* round-trip load/save; bad config → safe defaults.
- [ ] **C8 · Docs & packaging** — update `README.md`, `docs/`, plugin manifest; write
  `CONTRIBUTING`-style **"How to make a pet pack"**. *Tests:* docs reference only real files/commands.

---

## 8. Parallelization & workflow guidance

**Within a phase**, milestones with no shared files run in parallel. Two good ways:

- **Lightweight:** spawn `Agent` subagents for independent milestones (e.g. in Phase 2: one builds B4
  reading/running clips, another B5 props, another B2 faces) — each returns code + a filmstrip path you
  Read to QA.
- **Dynamic Workflow (you pre-approved this):** best for Phase 2 content. Pattern —
  `pipeline(animations, build, visualQA)` where **build** writes the clip and **visualQA** is an
  adversarial critic agent that *reads the generated filmstrip and scores craft* (squash/stretch present?
  silhouette readable? expression legible at size? shadow pixels? on-palette?), looping until it passes.
  This is exactly the "comprehensive + adversarially verified" use the Workflow tool is for. Keep the
  shared engine files (`lib/anim/*`) as **serial** work (one writer) to avoid conflicts; fan out only the
  per-asset content.

**Always serialize:** anything touching `lib/anim/*.mjs`, `animayte.mjs`, `animayte.html`,
`make-assets.mjs` (single writer per file per phase). Content assets and per-clip work fan out freely.

---

## 9. Autonomous validation toolkit (THE priority)

Saar emphasized building **things provable without him**. Every milestone must lean on these:

1. **Logic unit tests** (`npm test`, extend `test/`): easing values, volume conservation, state-machine
   timelines, reaction selection + anti-repetition, palette-swap correctness, schema validation.
2. **Visual contact-sheets / filmstrips** — `tools/preview.mjs` renders any clip to a PNG grid; **I
   `Read` the image and judge craft directly.** This is the key unlock — *I can see pixel art.*
3. **Animated previews** — emit GIF/APNG per clip for motion review (plus a static filmstrip, which
   reads most reliably).
4. **Browser screenshots** — Preview MCP: start daemon, open `animayte.html`, drive states via
   `/set`,`/detect`,`/demo`, **screenshot + console/eval checks**.
5. **Event-stream simulations** — `tools/simulate.mjs` replays a realistic session's hook JSONs at speed
   → writes a state-timeline log I `Read` and assert against intent. Build a couple of canned sessions
   (happy path; bug-hunt-then-fix; long session → compact).
6. **Stress tests** — event floods, 6+ birds (cap at 5), fullness oscillation, relief mid-flood,
   malformed hook JSON → assert no crash / no stuck state / caps respected.
7. **Conformance golden tests** — `(state,t)→output` fixtures shared across renderers (drift guard).
8. **Parse/lint sanity** — validate inline HTML `<script>` via `node -e "new Function(src)"` (env trick);
   `node --check` modules.

**What still needs Saar (flag, don't block):** final taste on art cuteness, the *native* floating window
on his screen, sound cuteness, personality "vibes." Queue these in §11 "For Saar."

---

## 10. Progress checklist *(executing agent: keep this current)*

**Phase 0:** ☑ A1 ☑ A2 ☑ A6  ← Phase 0 COMPLETE
**Phase 1:** ☑ A3 ☑ A4 ☑ B1 ☑ C1  ← Phase 1 COMPLETE
**Phase 2:** ☑ A5 ☑ B2 ☑ B3 ☑ B4 ☑ B5  ← Phase 2 COMPLETE
**Phase 3:** ☑ B6 ☑ C6 ☑ C3 ☑ C4 ☑ C2  ← Phase 3 COMPLETE
**Phase 4:** ☑ C5 ☑ C7 ☑ C8  ← Phase 4 COMPLETE · **ALL 21 MILESTONES DONE**

`npm test` last status: **PASS — 715 checks** (279 engine + 112 conformance + 93 doc-lint + 188 detection/consistency + 43 e2e) · Branch: `feat/anim-engine`
Validated live via Preview MCP: thinking/excited/tired (indexed swap)/sleepy; tool gags reading(glasses)/asking(?+head-tilt)/running(dust) — all render correctly; SSE round-trip works; 0 console errors.

---

## 11. Decisions log & "For Saar" review queue *(fill during execution)*

**Decisions made (with rationale):**
- **Canvas2D over PixiJS/Rive** (G1) — zero-dep ethos; a ~150-line custom runtime covers
  layered compositing + procedural transforms + palette swap. PixiJS reconsidered only if
  confetti particle FX get heavy; Rive stays the v2 vector-morph differentiator.
- **`squash(k)` is AREA-conserving (`sx·sy≡1`)** — matches the plan's tested invariant and reads
  as a real mass-preserving body. Added `squashRound(k)` (`sx²·sy≡1`) for the round blob look so
  renderers can pick. (A2)
- **Manifest = thin superset of Aseprite JSON** (`format: "animayte-pet/1"`): layers, clips
  {frames+dur, transform tracks}, expressions, props, palettes (role→hex, shared roles so a mood
  swap is a clean re-index), reactions, idle. The slime manifest is GENERATED from
  `lib/expressions.mjs` via `buildSlimeManifest()` so the dictionary stays the source of truth. (A1)
- **§4.2 target palette lives in the manifest now** (calm/tired/error ramps) but the renderer/
  compiler don't consume it for color yet — that swap lands in A3/B2 to avoid regressing visuals
  mid-foundation. (A1)
- **Shared PNG/canvas module** `lib/anim/png.mjs` (encoder + RGBA canvas + header decoder + a tiny
  3×5 bitmap font + blitScaled). Extracted the encoder out of `make-assets.mjs` so the compiler,
  the offline preview, and the tests share ONE encoder (no drift). Verified the refactor keeps
  `slime.png`/`bird.png` BYTE-IDENTICAL. (A6)
- **`tools/make-assets.mjs` now also emits the manifest** and guards its build behind a
  `import.meta.url === argv[1]` main-check so `tools/preview.mjs` can import `drawSlime` without
  triggering file writes. (A6)
- **`tools/preview.mjs` is the validation backbone** — `contactSheet()` (all expr×frame, labelled),
  `clipFilmstrip()` (samples a clip's transform track → S&S reads left→right), `squashStrip()`
  (volume-conservation sweep). I Read these PNGs to QA craft autonomously. Output is gitignored
  (regenerable: `node tools/preview.mjs`). **QA'd:** contact-sheet (8 faces read distinctly),
  react filmstrip (anticipation→stretch→settle visible), squash sweep (volume conserved). (A6)
- **Compositor works on flat RGBA buffers** (same straight-alpha format as the Canvas), so the web
  runtime, preview, and conformance golden share one path. `swapPalette` is keyed by color, so roles
  that share a hex (eyeDark == outline) coalesce — intentional. Palette-swap tested on synthetic
  fixtures + the real calm→tired ramp (decoupled from the art-palette migration, which is B2). (A3)
- **B1 taxonomy doc** (`docs/animation-library.md`, 294 lines) formalizes §5 as manifest-shaped
  reaction tuples + a signal-coverage audit. Flagged honest-mirror concerns (cursor-glance, derived
  waiting/idle) — see For-Saar above. Tool sub-category poses depend on C6 classification. (B1)
- **State machine is deterministic by injection** (`tick(dt)` + `opts.rng`) so timelines replay
  exactly in tests. Reactions are TRANSIENT and always `return` to idle (recovery-never-punishment is
  structural, not just convention). Priority arbitration: a strictly-higher reaction interrupts; a
  lower one is dropped while a higher one plays. (A4)
- **Pet pack = a folder** (`pets/<name>/pet.json` [+ `sheet.png`]). The slime is now a self-contained
  pack (compiler writes `pets/slime/sheet.png`; `assets/slime.png` stays byte-identical for thin
  renderers). A hand-authored **`pets/bean/`** stub proves format reusability. `ANIMAYTE_PET` env
  selects the pack (daemon `state.pet`, threaded through `bin/animayte`). NOTE: I created `pets/` dirs
  by WRITING files into them (no `mv`), per Drive-safety. (C1)
- **Browser-safety call for A5:** the web runtime imports only `easing/transform/state-machine`
  (pure, no `node:` imports) over http; it must NOT import `compositor`/`png` (they pull `node:zlib`).
  Palette swap in-browser uses Canvas2D, not the Node compositor. (A5 — confirmed: importing
  `runtime.mjs` in Node works because `Image`/`fetch`/`rAF` are only touched inside `createRuntime`.)
- **A5 web runtime ships as `lib/anim/runtime.mjs`** (ES module, served over http) consumed by
  `animayte.html` via a **conditional dynamic `import()`** — so the standalone **file:// demo keeps
  working** via the preserved inline legacy renderer (which also holds the `STATES`/`moodState`
  consistency-test anchors). The runtime PLAYS the baked sheet (row=expression, col=clip frame) and
  layers procedural transform tracks + fullness swell + mood tint + birds + particles on top — it
  never redraws the body, so no drift. Mood tint is a stand-in until B2 re-palettizes the art to the
  §4.2 role colors, after which the indexed `swapPalette` replaces the tint. (A5)
- **Validation tooling:** added `.claude/launch.json` (daemon on :4366) so the Preview MCP can drive
  the live page for screenshots. This is how I autonomously QA the browser renderer (G4). (A5)
- **B2 art = §4.2 palette, sourced FROM the manifest.** The compiler draws the body in the exact
  `calm` role hexes (hue-shifted ramp: warm rim crown → highlight → base → cool shadowCool base, with
  an on-palette gel sheen + catchlight). First tried a directional left/right split → harsh blocky
  seams; reverted to a clean vertical ramp (kept a subtle top-left lift). Because the sheet is now in
  role colors, the runtime does a REAL indexed palette-swap: pre-bakes a recolored sheet per palette
  and cross-fades calm→tired by fullness (+ a brief error flash) — replacing the A5 stand-in tint.
  Validated live: 95% context renders the full cool-teal `tired` ramp. (B2)
- **Blink "split":** in the baked-sheet model, blink is column 3. True layer separation isn't in this
  model (deliberate — baked frames keep the 3 thin renderers drift-free per §3.4); B3 adds randomized
  blink via a runtime timer + per-frame `cell` column indices so breathing doesn't force a blink. (B2→B3)
- **B3 idle system** = state-machine logic (A4) + DATA: added secondary-idle clips `sway` (lean+rot),
  `stretch` (yawn-reach), `bounce` (hop) and a bored `doze` clip to the manifest; `idle.secondary`
  picks among them with anti-repetition; breathing uses `cell` cols [0,1,2,1] (never the blink col 3)
  so the runtime fires randomized blinks (3–6s) on its own timer. Added `rot` rendering to the runtime
  for sway. Validated: bounce filmstrip (anticipation→hop→settle), real-manifest sim (secondary variety
  + no back-to-back repeat + bored→doze). (B3)
- **Headless-preview gotcha (validation):** the Preview MCP tab throttles `requestAnimationFrame` to ~0
  when not painting, so eval+sleep "is it animating?" probes see a STALE canvas (rafFired:0). Use
  **screenshots** (they force a paint) for visual checks; use the sim tests + filmstrips for motion. (B3)
- **B5 prop library** lives in `tools/draw-props.mjs` (its own module so the set can grow): 14 props
  (glasses/magnifier/pencil/book/!/?/…/✨/💡/❤/✔/Z/steam/dust), ≤4 colors each, packed into a
  `props.png` strip by the compiler. Manifest `props{cell,anchor,pop}` + `propSheet`/`propCell`. Runtime
  overlays one at its body anchor with an `easeOutBack` 2-frame pop-in, scaling with the pet. (B5)
- **B4 tool gags** = manifest clips (reading/searching/writing/running/installing/asking/waiting/
  testing/committing) + a `reactions` map (event→clip+expression+prop+palette+priority+return). Tool
  clips LOOP until interrupted; the runtime's `reactByName()` plays them (wired to an SSE `react` cmd
  the daemon will emit in C6). Validated live: glasses+look-down (reading), `?`+head-tilt (asking, rot
  track), dust+run-in-place (running). Priority arbitration confirmed (Running dropped under Asking). (B4)
- **C6 daemon vocab** = `lib/anim/events.mjs#classifyTool` (shared with the simulator so it can't
  drift) maps `PreToolUse` tool_name → an event (Bash sub-classified by command: test/install/git/
  run). Daemon exposes `state.activeTool` (read/search/edit/run/test/install/git), broadcasts SSE
  `{cmd:'react',name}` for the rich runtime AND keeps `mood:'thinking'` for thin renderers; PostToolUse
  broadcasts `endReact` → runtime `toIdle()` (state-machine `release()`). Backwards-compatible. (C6)
- **B6 end-to-end** validated LIVE: real `Grep` hook POSTed to the daemon → classify → SSE → magnifier
  searching gag rendered. Plus `tools/simulate.mjs` (§9.5): replays canned sessions (happy / bug-hunt /
  sub-agents) through the shared classifier + state machine → a readable, asserted state timeline
  (read→glasses, edit→pencil, test→nervous, commit→check, stop→bounce; bug-hunt shows a sad beat then
  recovers; never stuck mid-reaction). Reaction selection is deterministic (event→reaction); personality
  re-weighting is C3. (B6)
- **C2 conformance golden** (`test/conformance.mjs` + `conformance.golden.json`, wired into `npm test`):
  pins, for canonical (clip,t) samples, the exact `{cell, transform}` AND a replayed session timeline.
  Any engine/art/easing change that drifts fails; regen with `--update`. `docs/renderer-runtime.md`
  (290 lines) documents the `(petState,t)→draw list` contract + an HONEST per-renderer subset table.
  **Key finding (from the doc sweep):** Swift derives its column from `Int(t*5)%FRAMES` (ignores
  `frame.cell`) and can hit the blink col — so the golden pins the WEB tier; Swift/Python are documented
  ◐/✗ partial tiers (mood row + birds; Swift also does its own fullness-swell + relief steam). (C2)
- **C3 personality** = `personalities/{adaptive,chipper,grumpy}.json` + `lib/anim/personality.mjs`
  (loader/resolver, Node-side). The state machine takes a RESOLVED personality object (kept browser-safe
  — no node: import) and uses it to scale idle interval + bored-timer and to WEIGHT secondary selection;
  the runtime scales reaction intensity by it. Daemon `state.personality` (env `ANIMAYTE_PERSONALITY`,
  threaded through `bin/animayte`); the page fetches the JSON. Tested: same idle stream under 3
  personalities → measurably different distributions (chipper bounces+fidgets more; grumpy leans+dozes
  sooner), anti-repetition preserved. Default = Adaptive. (C3)
- **C4 mood layer** = `lib/anim/mood.mjs` (`createMoodMeter`, pure): a slow drift in [−1 stressed … +1
  up] fed by emotional beats (sad/oops pull down, happy/excited push up; thinking/idle neutral),
  decaying back toward neutral over quiet time. Daemon feeds it on every `setMood` + a 15s decay tick
  (unref'd), exposes `state.moodLevel`/`moodLabel`, broadcasts `{cmd:'moodLevel'}` on label crossings;
  `SessionStart` resets it. Runtime nudges reaction size (up=bigger) + adds a cool "stressed" palette
  floor — coherence with NO new content. Tested pure (error-run→stressed, win-streak→up, decay,
  recency flip) + e2e (real streaks drive the label). (C4)
- **C5 sound infra (OFF by default)** = `lib/anim/sound.mjs` (pure synth `renderTone` + `encodeWav`
  + `SOUND_MAP`), `tools/make-sounds.mjs` → `assets/sfx/*.wav` (9 chiptune blips, `npm run sounds`).
  Runtime has a gated `createSound` that never touches AudioContext while disabled — zero autoplay
  surprises. Tested: WAV header valid, map coverage, samples in range, on-disk blips valid. Actual
  blip cuteness is a Saar taste call (§11). (C5)
- **C7 config** = `lib/anim/config.mjs` (load/save/sanitize) at `~/.config/animayte/config.json`
  (OUTSIDE Drive-synced ~/Documents; `$ANIMAYTE_CONFIG` override). Pet/personality/sound/volume/
  position; env still wins at runtime; corrupt/missing → safe defaults (never throws). Daemon loads
  it (env > config > default). Tested: round-trip, clamp, bad-position→null, corrupt→defaults. (C7)
- **C8 docs & packaging** = `docs/making-a-pet-pack.md` (authoring guide), README "animation engine"
  section + pet-pack/personality/sound story, CONTRIBUTING project-shape refresh, 4 new npm scripts
  (sounds/preview/simulate/conformance:update). NEW guard: `test/docs.test.mjs` doc-lint asserts every
  repo path + `npm run` command referenced in the docs actually exists (93 checks). Stale "211 checks"
  claims updated to the real total. (C8)

---
**🏁 ALL MILESTONES COMPLETE (2026-05-30).** G1 dynamic framework · G2 living-cartoon library · G3
future-ready infra (pet packs, conformance contract, personality, mood, sound, config, event vocab) ·
G4 autonomously validated (715 checks + readable contact-sheets/filmstrips + live Preview-MCP
screenshots + session sims). Per the PRIME DIRECTIVE the run does NOT stop here — rolling into the §12
backlog (next: a 2nd full pet pack to exercise the format; perf/stress hardening; reduced-motion).

**For Saar to review / decide (non-blocking — I proceeded with a default):**
- **Cursor-glance flair has NO real signal** (honest-mirror concern raised in `docs/animation-library.md`
  open-Q #4). It's the one taxonomy row not backed by a measured signal — scoped to web-renderer mouse
  flair only. Default: keep it (web-only, clearly "flair"), but happy to cut it to stay strictly
  honest-mirror. Your call.
- The Grep/Glob overlap between **Reading** and **Searching** poses is the fuzziest tool mapping
  (animation-library.md open-Q #2); I'll default Grep→searching, Glob→reading and tune in B6.
- Art taste on v2 expressions & the reading/running gags (contact-sheets in `tools/preview-out/`).
- Native window aesthetics on a real screen (`bin/animayte start`).
- Sound: cuteness + whether to ship enabled-by-default-off vs. fully omit for v1.
- Default personality vibe ("Adaptive") and the chipper/grumsy presets.
- PixiJS-accelerator vs stay-Canvas2D call; Rive as v2 differentiator.

---

## 12. Backlog / carry-on — the engine of continuous operation

Per the **prime directive**, the run never ends at "milestones complete." This backlog is the *seed*,
not the ceiling. Pick the next task by **best judgment** — prioritize by impact × what you can build
*and validate* without Saar, keep it lean, and log each pick + why in §11. When the list below is
exhausted, **generate new high-value work** in the same spirit (re-research → apply → build → validate)
and keep going. Roughly:
- **More research → apply it:** virtual-pet/sim/RPG interaction patterns (Nintendogs petting spots,
  Chao-garden trait grafting, Animal Crossing personality subtypes), more idle-secondary ideas, more
  celebrated 8-16-bit expression refs. Write findings into `docs/` and *act on them*.
- **More content:** additional secondary idles, seasonal/day-night palette nudges, more tool poses
  (e.g. WebFetch=telescope, TodoWrite=checklist), a 2nd full pet pack to prove reuse (e.g. a bean/cat),
  rare "special" animations (sneeze, hiccup, stretch-yawn).
- **Harden:** stress + fuzz the daemon, perf-profile the web runtime (target smooth at ≥30fps), reduce
  spritesheet size, accessibility (reduced-motion mode), multi-monitor notes.
- **Clean & document:** dead-code sweep, tighten the engine API, expand `CONTRIBUTING` for pet authors,
  diagram the architecture.
- **Simulations:** more canned sessions (parallel sub-agents, error-storm-then-recovery, marathon) as
  living regression fixtures + demo material.
- **Codex/Antigravity readiness:** sketch the adapter seam (the event-vocabulary mapping) without
  building it — note what each platform exposes.

---

## 13. THE EXECUTION PROMPT (paste this to run)

> Run via `/loop` (self-paced) for an unattended multi-hour build, or paste into a fresh session.
> For Phase 2, optionally drive content via a dynamic **Workflow** (see §8).

```
You are building animayte autonomously while Saar is away (he is a founder/creative director who
values lean "minimum REMARKABLE product" work, UX-first, borrow-don't-reinvent, and wants to make the
taste calls himself — but has explicitly authorized you to proceed without him now and be creative,
resourceful, and proactive; you are BOTH a talented video-game animator AND a brilliant engineer).

SOURCE OF TRUTH: /Users/za/Documents/animayte/plan_animayte.md. Read it fully first, then execute the
milestones in §7 in phase order. Within a phase you may parallelize per §8 (Agent subagents or a
dynamic Workflow for Phase-2 content with adversarial visual QA). Serialize edits to lib/anim/*,
animayte.mjs, animayte.html, tools/make-assets.mjs (one writer per file per phase).

WORKING RULES:
1. Start by running `npm test` to confirm the baseline is green; record the count. Create/checkout
   branch `feat/anim-engine`. Do NOT push and do NOT open a PR unless asked.
2. After EACH milestone: run the autonomous validation in §9 (unit tests + generate a filmstrip/contact
   sheet via tools/preview.mjs and READ it to judge the art + browser screenshot via the Preview MCP
   where relevant), keep `npm test` green, commit with a clear message ending:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`, then check the box in §10 and log any
   decision in §11.
3. VALIDATE, don't assume. You can SEE images — render every clip/expression to a filmstrip and Read it;
   fix craft (squash/stretch, readable silhouette, legible expression, shadow pixels, on-palette) before
   moving on. Drive the browser renderer and screenshot it.
4. EVOLVE, don't rewrite. Keep lib/expressions.mjs the source of truth; keep the native + browser pets
   working and the back-compat assets/slime.png emitting at every commit. Protect the just-fixed
   no-drift property with the conformance contract (C2).
5. GUARDRAILS (binding): zero runtime dependencies (vendor tiny permissive snippets only); recovery
   never punishment (no guilt/decay/death); ambient never Clippy (react, never initiate, never steal
   focus/block clicks); honest mirror (every animation ties to a real signal); secrets never shown.
6. FILESYSTEM SAFETY (Google Drive synced ~/Documents): create/edit files ONLY. NEVER move/rename/delete
   folders or .git; no bulk mv/rm/find -exec. New directories appear by writing a file into them, one at
   a time. (zsh aborts on empty globs and cancels sibling tool calls — avoid bare globs; end scripts with
   `|| true`/echo. `node` works on PATH though nvm default is broken.)
7. Make strong technical defaults and PRESENT them with rationale in §11; do NOT block on Saar. Queue
   genuine taste calls (art cuteness, native-window look, sound, personality vibe) in §11 "For Saar".
8. PRIME DIRECTIVE — DO NOT STOP until Saar explicitly says stop. Completing the milestones is NOT the
   end: roll straight into the §12 backlog, and when that's exhausted choose new high-value work by your
   own best judgment (re-research and apply it, more animations/pets, perf + stress hardening, cleanup,
   simulations, new features in the plan's spirit). Idle is not an option; never wait for Saar. If one
   task is blocked, pick another and proceed. Stay lean — quality and delight over volume. Log each
   next-task choice + rationale in §11 so Saar can follow your trail.

Deliver a living cartoon: a lean dynamic animation framework (G1), a reusable event-mapped animation
library (G2), future-ready infra (G3) — all autonomously validated (G4). Begin with Phase 0, then keep
going — milestones, backlog, and beyond — and DO NOT STOP until Saar says so.
```

---

*Plan authored by Claude (Opus 4.8) on 2026-05-30 after a full repo audit + a 3-track research sweep
(game animation systems · virtual-pet design · expressive 8-16-bit pixel art). Research lives implicitly
here and should be expanded into `docs/` during execution. No code was executed in producing this plan.*
