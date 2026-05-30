# 🎬 animayte — Event → Animation Library (design reference)

> **Milestone B1.** This is the design reference the content milestones build against:
> **B2** (expressions v2), **B3** (idle system), **B4** (tool-call animations), **B5** (prop library),
> **B6** (reaction wiring). It formalizes §5 of `plan_animayte.md` into a taxonomy that maps cleanly onto
> the pet-pack manifest (`pets/slime/pet.json`, validated by `lib/anim/manifest.mjs`). **Design only — no code.**

Every animation below is a tuple the engine already understands:
**`{ clip, expression, prop, palette, priority, return }`** (see `validateManifest()`'s `reactions` shape).
The job of B2–B6 is to fill `clips`, `props`, and `reactions` in the manifest so each row here becomes real.

**Status legend** — borrowed from `docs/session-signals.md`:
- ✅ **buildable now** — backed by a signal the daemon already emits (`docs/session-signals.md` = ground truth)
- 🔧 **needs C6 daemon classification** — the signal exists, but the daemon must classify it first (e.g. tool sub-categories)
- 🎨 **art TBD** — frames/props not drawn yet (a B2–B5 deliverable)

---

## 1. Purpose & guardrails

The pet is a **living cartoon** — 80% of its aliveness comes from *procedural* squash/stretch/easing/props,
not hand-drawn frames. This document is the contract between **what the agent is really doing** and
**what the creature shows**. It is a design reference (what + why + which signal), never an implementation.

Four guardrails are binding (inherited from §2 of the plan and `docs/session-signals.md`):

| Guardrail | What it means for this library |
|---|---|
| **Recovery, never punishment** | Errors → worried-but-hopeful; the *payoff* is the bounce-back. No guilt, decay, or death. Every "bad" reaction must `return` to idle (or a hopeful perk), and the `error` palette **flashes then snaps back** to `calm` — it never *stays* red. |
| **Ambient, never Clippy** | The pet only ever *reacts* to a measured signal. It never initiates during silence, never steals focus, never blocks clicks. The only "self-started" behavior is idle (breathing/blink/secondary/bored) — and that *is* silence, drawn. |
| **Honest mirror** | Every animation ties to a **real measured signal**. If a row can't cite a signal from `docs/session-signals.md` (or an honestly-derived one), it doesn't ship. The coverage audit (§5) enforces this. |
| **Zero runtime deps** | The library is data (clips, props, palettes) + the shared engine (`lib/anim/*`). No new runtime dependency, ever. Props are tiny indexed sprites, not icon fonts or SVG libs. |

---

## 2. Visual-language summary (distilled from §4)

The full animator's brief is §4 of `plan_animayte.md`; this is the working summary every B-milestone needs.

### 2.1 Layer stack (bottom → top)
`shadow → outline → body → eyes → mouth → brows → prop`
(matches `LAYERS` in `lib/anim/manifest.mjs`). The **body** carries squash/stretch — the slime *is*
squash & stretch. Eyes/mouth/brows are independent layers, so **any expression composes onto any pose**;
a blink is one frame of the eye filled with body color. **Props** are separate overlays that pop in/out.
The **drop shadow** squashes/widens *in sync* with the body (wider when flat, smaller when airborne).

### 2.2 Palette roles (mood = palette swap)
Three named palettes already live in the manifest, each exposing the **same roles** so a mood swap is a
clean re-index (the validator enforces shared roles):

| Palette | Role | When |
|---|---|---|
| `calm` | default working green | the resting state for almost everything |
| `tired` | cooler blue-green | as context `fullness` rises (the signature swell) |
| `error` | brief red | a single flash on a bad result, then **snap back to `calm`** |

Roles: `shadowCool · shadow · base · highlight · rim · outline · halo · dropShadow · eyeDark · catchlight · blush`.
Mood-independent prop accents: `warm #FEE761 · alert #E43B44 · neutral #3A4466 · sweat #7DC6FF · white`.

### 2.3 Expression craft (few pixels, big feeling)
Eyes + mouth carry ~90% of emotion. Lock eye↔eye and eye↔mouth spacing across all poses (the "Kirby rule")
so identity survives squash. Big pupils / little white = cuter; 2px horizontal eyes = sleepy/bored. Brows
(1–2 overlay px) are the cheapest expressiveness. **Exaggerate** — push every pose 1–2px past "correct."

### 2.4 Timing budgets (the 12 principles, on a pixel budget)
- **Idle:** 2–4 frames at ~6fps (400–500ms holds), with a randomized blink.
- **Reactions:** 3–5 frames following **anticipation → extreme → settle** (one opposite frame first;
  hold the extreme; let it jiggle-settle a beat late). The baseline `react` clip already does this:
  squash `sy 0.88` → stretch `sy 1.16 easeOutBack` → settle `easeOutBounce`.
- **Runs:** 3–6 frames; **props pop in over 2 frames** (scale pop).
- **Squash & stretch conserves volume** (wider when short, taller when narrow — never both).
- **Vary frame durations — never constant timing.** Favor `easeOutBack / easeOutBounce / easeOutElastic`
  for the bounce (all present in `lib/anim/easing.mjs`).

---

## 3. The taxonomy (every row of §5, formalized)

Each row is the manifest reaction tuple plus its **real trigger**. `priority` follows the same spirit as
`lib/expressions.mjs` (self-critical/negative feelings outrank positive ones so a smile never hides an
error) — the integers below are a *proposed* scale for B6 to wire, not yet baked. `return` is `idle` unless
noted. Face ids in **bold** are the 8 existing expression ids (kept stable — `neutral · thinking · happy ·
excited · oops · embarrassed · sad · sleepy`); a non-bold face is a *new* expression a B2 milestone must add.

**Priority scale (proposed):** idle/ambient `0` · waiting/fidget `1` · activity poses (read/run/search/…) `2` ·
success/win `3` · own-slip `4` · sad/error `5` · embarrassed `6` · compact relief `7` (the signature interrupt).
Higher interrupts lower; equal priority lets the newer event take over.

| State / event | Real trigger (signal) | Body clip | Face | Prop / emote | Mood / palette | Prio | Returns to | Status |
|---|---|---|---|---|---|---|---|---|
| **Greet** | `SessionStart` hook (✅ `neutral.events`) | pop-in bounce + wave | **neutral**→**happy** | ✨ | `calm` | 1 | idle | ✅ 🎨 |
| **Listening** | `UserPromptSubmit` hook (✅ Section D) | perk up, lean toward user | **thinking** (attentive) | `!` → `…` | `calm` | 2 | idle | ✅ 🎨 |
| **Thinking** | reasoning between turns / `Stop` with thinking on (✅ statusline `thinking.enabled`; ✅ `Stop`) | look up, brow furrow, slow sway | **thinking** | `?` / 💭 | `calm` | 2 | idle | ✅ 🎨 |
| **Reading** | `PreToolUse` tool_name ∈ {Read, Grep, Glob} (🔧 needs C6 classification) | put on glasses, look down, eyes scan L↔R | **thinking** (focused) | 👓 + 📖 | `calm` | 2 | idle | 🔧 🎨 |
| **Searching** | `PreToolUse` tool_name ∈ {Grep, Glob, WebSearch} (🔧 C6) | peer around with magnifier | **thinking** (focused) | 🔍 | `calm` | 2 | idle | 🔧 🎨 |
| **Writing / editing** | `PreToolUse` tool_name ∈ {Edit, Write, NotebookEdit} (🔧 C6) | tiny pencil, scribble bob | **thinking** (determined) | ✏️ + paper | `calm` | 2 | idle | 🔧 🎨 |
| **Running a command** | `PreToolUse` tool_name = Bash (✅ tool_name today; 🔧 C6 for the *category*) | sprout little legs, run-in-place, dust puffs | **thinking** (determined) | 🦵 + 💨 | `calm` (lively tempo) | 2 | idle | 🔧 🎨 |
| **Testing** | `PostToolUse` after `Bash(test…)` + result ok/err (🔧 C6 sub-classify Bash; ✅ Post ok/err) | bite nails / crossed fingers → cheer or wince | nervous → **happy** / **sad** | 💧 → ✨ | `calm` → flash `error` on fail | 2→3/5 | idle | 🔧 🎨 |
| **Installing** | `Bash(npm/pip/brew …)` then watch for Post (🔧 C6) | watch, tap foot | **neutral** (waiting) | `…` / 📦 | `calm` | 1 | idle | 🔧 🎨 |
| **Committing / git** | `Bash(git …)` (🔧 C6) | stamp / seal, proud nod | **happy** | ✔ / 🚩 | `calm` (lively) | 3 | idle | 🔧 🎨 |
| **Asking the user** | `Notification` hook + `message` (✅ Section D; filter secrets) | turn to user, head-tilt, raise "hand" | **thinking** (curious) | `?` | `calm` (gentle bob) | 2 | waiting | ✅ 🎨 |
| **Waiting** (model latency) | gap between a `PreToolUse` and its `PostToolUse` (✅ derived from the Pre/Post pair) | idle fidget, glance around | **neutral** | `…` | `calm` | 1 | idle | ✅ 🎨 |
| **Sub-agent spawned** | `PreToolUse` tool_name = Task (+ `description`/`subagent_type`) (✅ Section C) | bird hatches from a thought, orbits (cap 5) | **happy** (proud) | 🐦 | `calm` (lively) | 2 | idle | ✅ 🎨 |
| **Sub-agent done** | `SubagentStop` hook (+ `status`) (✅ Section C) | bird flies off | **happy** | — | `calm` | 2 | idle | ✅ 🎨 |
| **Success** | sentiment `happy` (✅ `lib/sentiment.mjs`) / non-error `PostToolUse` (✅) | stretch-up bounce | **happy** | ✨ / ♪ | `calm` (warm) | 3 | idle | ✅ 🎨 |
| **Big win** | sentiment `excited` (✅ `lib/sentiment.mjs`) | jump + confetti, star eyes; **rare special dance** | **excited** | 🎉 / ⭐ | `calm` (warm) | 3 | idle | ✅ 🎨 |
| **Own slip** | sentiment `oops` (✅ `lib/sentiment.mjs`) | flinch, sheepish scratch | **oops** | 💧 | `calm` (slight) | 4 | idle | ✅ 🎨 |
| **Embarrassed** | sentiment `embarrassed` (✅ `lib/sentiment.mjs`) | hide face, peek | **embarrassed** | flush (warm-red cheeks) | `calm` | 6 | idle | ✅ 🎨 |
| **Error / bad news** | `PostToolUse` error / `PostToolUseFailure` (✅) **or** sentiment `sad` (✅) | flinch-squash → **perk back (recovery)** | **sad** → hopeful | `!` → resolve | brief `error` → back to `calm` | 5 | idle | ✅ 🎨 |
| **Context filling** | rising `fullness` from transcript `usage` ÷ window (✅ Section B, "the signature") | body swells, eyes droop, sweat | **sleepy**-ish (tired) | 💧 | shift toward `tired` | 1 | idle | ✅ 🎨 |
| **Compact relief** ★ | `PreCompact` hook (✅ Section B; `triggerRelief()` already wired) | big inhale (stretch) → long exhale squash, steam from ears, satisfied sigh | **sleepy** → blissful | 💨 + 😮‍💨 | snap back from `tired` → `calm` | 7 | idle | ✅ 🎨 |
| **Idle** | quiet N s (no events) (✅ derived; `Stop` settles here) | breathing + blink + weight-shift | **neutral** | — | `calm` | 0 | — (base) | ✅ |
| **Bored** | quiet ~30s+ inactivity (✅ derived; `idle.boredAfterMs` exists) | yawn, look around, tap, doze | **sleepy**-ish | faint `Z` | `calm` | 0 | idle | ✅ 🎨 |
| **Sleep / end** | `SessionEnd` hook (✅ `sleepy.events`) | curl down, Z's | **sleepy** | 💤 | `calm` (dim) | 1 | idle (wake) | ✅ 🎨 |
| **Wake** | any event after sleep (✅ derived — next hook after `SessionEnd`/long idle) | stretch, blink awake | **sleepy** → **neutral**/**happy** | — | brighten to `calm` | 1 | idle | ✅ 🎨 |
| **Cursor glance** (flair) | mouse near pet (🎨 web renderer only; no daemon signal) | pupils track cursor | (eyes only) | — | unchanged | 0 | (overlay) | 🎨 |

**Notes on a few rows:**
- **Reading/Searching overlap on Grep & Glob** by design: a daemon classifier (C6) picks `read` vs `search`
  by context (Grep with a file path = read; Grep across the tree / WebSearch = search). Until C6, both
  collapse to the generic "thinking" pose the daemon emits today.
- **Testing** is a two-beat reaction: a nervous *anticipation* loop while the `Bash(test…)` runs, then a
  branch on the `PostToolUse` result (cheer on ok, wince on error). It reuses `happy`/`sad` faces.
- **Cursor glance** is the one row with **no daemon signal** — it's pure web-renderer flair (mouse position),
  so it's flagged 🎨 and lives only in `animayte.html`. It never blocks clicks (ambient guardrail).

---

## 4. Idle system spec (where a desktop pet actually lives)

Idle is not "do nothing" — it is the pet *being alive in silence*. The manifest already carries the hooks
(`idle.base`, `idle.blink {minMs,maxMs}`, `idle.secondary[]`, `idle.boredAfterMs`); B3 fills the pool.

| Layer | Spec | Backed by |
|---|---|---|
| **Base breathing loop** | ~4–6s continuous; the `idle` clip's volume-conserving sway (today: `sy 1.03 / ty -1` at the midpoint, `easeInOutSine`) | `idle.base` |
| **Randomized blink** | every **3–6s**, jittered (never on a fixed beat); one eye-fill frame | `idle.blink {minMs:3000, maxMs:6000}` |
| **Secondary-idle pool** | on a **randomized timer**, play one of: *look-around · wobble · yawn · scratch* | `idle.secondary[]` (B3 to populate) |
| **Bored idle** | after **~30s** of no session activity: yawn → look around → tap → doze, faint `Z` | `idle.boredAfterMs: 30000` |

**Anti-repetition rule (load-bearing for "alive, not looped"):**
- **Never play the same secondary twice in a row.** (Enforced by the state machine, A4.)
- **Weight selection by personality** (C3) — a `chipper` pet wobbles more; a `grumpy` pet yawns more; the
  default "Adaptive" is calm while working, livelier near milestones.
- Secondary-idle frequency should also bend with **effort** (statusline `effort.level`, ✅ captured): calm
  tempo on `low`, zoomier on `high` — the "Adaptive" lever.

This is the single highest-leverage investment in perceived life — §5 of the plan calls it out explicitly:
*"this is where a desktop pet actually lives — invest here."*

---

## 5. Coverage audit (cross-check against `session-signals.md`)

This section is the **honest-mirror enforcement**: (a) every real signal is consumed by something, and
(b) no animation needs a signal that doesn't exist.

### 5a. Every real signal → which animation(s) consume it

| Signal (from `docs/session-signals.md`) | Status there | Consumed by |
|---|---|---|
| `SessionStart` | ✅ | Greet |
| `UserPromptSubmit` (+ prompt) | ✅ | Listening |
| `PreToolUse` + `tool_name` | ✅ (generic) | Reading / Searching / Writing / Running / Sub-agent spawned (the *category* split needs C6) |
| `PreToolUse` tool_name = Task (+ desc/type) | ✅ | Sub-agent spawned (bird) |
| `PostToolUse` (ok) | ✅ | Success; resolves Testing/Waiting |
| `PostToolUse` error / `PostToolUseFailure` | ✅ | Error / bad news; Testing (wince branch) |
| `SubagentStop` (+ status) | ✅ | Sub-agent done (bird flies off) |
| `Stop` | ✅ | settle to Idle (or Thinking if thinking-on; or Context-filling if high) |
| `Notification` (+ message) | ✅ | Asking the user |
| `SessionEnd` | ✅ | Sleep / end |
| `PreCompact` | ✅ | **Compact relief** (the signature; `triggerRelief()` wired) |
| Context used % (`fullness`) | ✅ ("the signature") | Context filling (swell + droop + sweat → `tired` palette) |
| Context window size | ✅ | sets the 0–100% scale for Context filling |
| Sub-agent count (derived from start/stop) | ✅ | number of orbiting birds (cap 5) |
| Sentiment `happy/excited/oops/embarrassed/sad` (`lib/sentiment.mjs`) | ✅ | Success / Big win / Own slip / Embarrassed / Error |
| `thinking.enabled` (statusline) | ✅ captured | Thinking (focused brow) |
| `effort.level` (statusline) | ✅ captured | idle/reaction **tempo** (Adaptive) |

**Derived (not a single hook, but honestly computable from real signals):**
- **Waiting** = the gap between a `PreToolUse` and its matching `PostToolUse`.
- **Idle / Bored** = elapsed wall-clock with no events (timer; `idle.boredAfterMs`).
- **Wake** = the first event after `SessionEnd`/a long idle.

### 5b. Captured-but-not-yet-drawn signals (🟡 — available for future content, not required by any row)
These exist in `/health` today but **no taxonomy row depends on them**, so nothing breaks if they're unused:
cost (`cost.total_cost_usd`), lines ±, rate-limit %, model name, session duration. Listed in the §12 backlog
as future flair (coins, stamina ring, model hat) — **not** in scope for B2–B6.

### 5c. Animations that need a signal we DON'T have
**One, and it's intentional:** **Cursor glance** has no daemon signal — it's web-renderer mouse flair only,
flagged 🎨 and scoped to `animayte.html`. **No other row requires a signal absent from `session-signals.md`.**

### 5d. Best-effort / derived vs. directly-available-now
| Bucket | Rows |
|---|---|
| ✅ **Directly available now** | Greet, Listening, Thinking, Asking, Waiting, Sub-agent spawned/done, Success, Big win, Own slip, Embarrassed, Error, Context filling, **Compact relief**, Idle, Bored, Sleep, Wake |
| 🔧 **Needs C6 daemon classification** | Reading, Searching, Writing, Running, Testing, Installing, Committing (all depend on classifying `PreToolUse` `tool_name` → category, and sub-classifying `Bash` by argv → test/install/git) |
| 🎨 **Web-only flair** | Cursor glance |

> The daemon today maps `PreToolUse` → a generic "thinking" pose (only `Task` is special). So **all 🔧 rows
> render as generic "thinking" until C6 lands** — the art (🎨) can be built first (B4) and wired (B6) once C6
> emits `activeTool` category in `/health`+SSE. This is the explicit B4↔C6 dependency.

---

## 6. Prop / emote library (§4.5)

Iconographic shorthand — the cheapest way to add legibility. **Convention for every prop:** 1–2px outline,
≤4 colors (drawn from the `accentColors` roles: `warm/alert/neutral/sweat/white`), and a **2-frame scale
pop-in** (and pop-out). Props are a separate `prop` layer (top of the stack), anchored relative to the body
(`prop.anchor [ax,ay]`, `prop.pop` = pop-in frame count in the manifest). They compose onto *any* pose/expression.

| Prop | Meaning | Used by | Accent |
|---|---|---|---|
| `!` | alert | Listening, Error | `alert` |
| `?` | confused / asking | Thinking, Asking the user | `neutral` |
| `…` | waiting / unsure | Listening, Waiting, Installing | `neutral` |
| 💧 sweat | stress | Own slip, Context filling, Testing (nerves) | `sweat` |
| `Z` sleep | drowsy / asleep | Bored (faint), Sleep/end | `neutral` |
| ✨ / ♪ | success | Greet, Success | `warm` |
| 💡 idea | insight | (flair — a breakthrough beat) | `warm` |
| ❤ | affection | (flair — petting / favorite, future) | `alert` |
| 👓 glasses | reading | Reading | `neutral` |
| ✏️ pencil | writing | Writing / editing | `neutral` |
| 🔍 magnifier | searching | Searching | `neutral` |
| 📖 book | reading | Reading | `neutral` |
| 🦵 tiny legs | running | Running a command | (body color) |
| 💨 steam | compact relief / exertion | Compact relief, Running (dust) | `white` |
| 🐦 bird | sub-agent | Sub-agent spawned (orbits, cap 5) | (own sprite — `bird.png` exists) |
| 🎉 confetti | big win | Big win | `warm` + `alert` |
| hat | flavor / model badge | (flair — per-model, future) | `neutral` |

The 🐦 bird is the one "prop" that's already a real asset (`bird.png`, orbits live in the daemon + renderers);
the rest are B5 deliverables.

---

## 7. Tool-call animation sub-categories (the C6 contract)

This is the explicit map B4 builds the art for and **C6 wires the classification for**. The daemon's job in
C6: read `PreToolUse` `tool_name` (and `Bash` argv), emit an `activeTool` **category** on `/health`+SSE; the
renderer then picks the matching pose. Until then, every tool call shows the generic "thinking" pose.

| `tool_name` (PreToolUse) | → category | → animation (clip + prop) |
|---|---|---|
| `Read`, `Grep`, `Glob` | **reading** | glasses on, look down, eyes scan L↔R · 👓 + 📖 |
| `Grep`, `Glob`, `WebSearch` | **searching** | peer around with magnifier · 🔍 |
| `Edit`, `Write`, `NotebookEdit` | **writing** | tiny pencil, scribble bob · ✏️ + paper |
| `Bash` | **running** | sprout legs, run-in-place, dust puffs · 🦵 + 💨 |
| `Bash` argv ~ `test / jest / pytest / vitest / npm test …` | **testing** | nail-bite/crossed-fingers → cheer or wince · 💧 → ✨ |
| `Bash` argv ~ `npm / pnpm / yarn / pip / brew / cargo install …` | **installing** | watch, tap foot · `…` / 📦 |
| `Bash` argv ~ `git …` | **committing** | stamp/seal, proud nod · ✔ / 🚩 |
| `Task` | **sub-agent** | bird hatches & orbits (cap 5) · 🐦 |

> **Grep/Glob appear in two categories** (reading *and* searching) — C6 disambiguates by context (a scoped
> path → reading; a broad/tree-wide or web query → searching). When uncertain, default to **searching**
> (the magnifier reads as "looking for something," which is true either way).
> **`Bash` is hierarchical:** classify the argv first (test/install/git); fall back to generic **running**.

---

## 8. How this threads into the milestones

| Milestone | What it pulls from this doc |
|---|---|
| **A3** (compositor + palette) | §2.2 palette roles; the `calm/tired/error` swap |
| **A4** (state machine) | §3 priorities + `return`; §4 anti-repetition + bored trigger |
| **A5** (web runtime) | renders every §3 row; §3 Cursor glance lives here |
| **B2** (expressions v2) | §2.3 craft on the 8 stable ids; adds the non-bold faces (attentive/curious/nervous/blissful as face *variants*, ids unchanged) |
| **B3** (idle system) | §4 in full |
| **B4** (tool-call anims) | §7 art (reading/running/searching/writing/testing/installing/committing) |
| **B5** (prop library) | §6 props as anchored pop-in sprites |
| **B6** (reaction wiring) | turns every §3 row into a manifest `reactions` entry; needs **C6** for the 🔧 rows |
| **C6** (daemon vocab) | §7 classification → `activeTool` on `/health`+SSE |

---

## 9. Open questions for Saar (taste calls)

These are genuine taste decisions, not blockers — B-milestones will proceed with the noted default and
queue these in §11 "For Saar":

1. **"Rare special dance" frequency.** Big-win (`excited`) can trigger a rare full dance. How rare —
   1-in-N wins? once per session? Default proposal: ~1-in-8 excited reactions, never twice in a session.
2. **Reading vs. Searching default** when Grep/Glob are ambiguous (§7). Default: **searching** (magnifier).
   Acceptable, or prefer reading (glasses) as the safer "it's just looking at a file" read?
3. **Testing nerves intensity.** How anxious should the pre-result "bite nails" beat be? It must still obey
   recovery-never-punishment (a wince, never distress). Default: mild — a single sweat drop, quick recover.
4. **Cursor glance** — keep it as web-only flair, or cut it for v1 to stay strictly honest-mirror
   (it's the only row not backed by a session signal)? Default: keep, clearly scoped to the web renderer.
5. **New face *variants*** (attentive/curious/nervous/blissful): implement as lightweight overlays on the
   existing 8 ids (keeps detection stable), or promote any to a first-class expression id? Default: variants
   only — the 8 ids and their priorities stay frozen.
