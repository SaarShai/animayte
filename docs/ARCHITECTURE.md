# animayte — Architecture & Module Manifest

> The single source of truth for how animayte is built: every module, the data flow, the
> contracts between the parts, and where to change things. Two audiences:
> **graphics/art** (jump to [The command vocabulary](#5-the-command-vocabulary--arts-input-contract)
> and [The reaction manifest](#6-the-reaction-manifest--arts-clip-contract) — that is your whole
> contract) and **developers** (read top to bottom).

---

## 1. What it is

animayte is a **Claude Code plugin** that turns a live coding session into a floating desktop pet.
A tiny zero-dependency Node daemon listens to Claude Code's lifecycle **hooks** and **statusline**,
translates each session signal into a *reaction*, and pushes it over **Server-Sent Events (SSE)** to
a pet rendered in a small always-on-top window (a WKWebView on macOS; a browser tab anywhere).

One-sentence mental model:

```
the pet's BODY = your context window · its FACE = sentiment of the latest text · its BIRDS = sub-agents
```

Three layers, three owners (keep the seams clean):

| Layer | What | Owner | Touch? |
|---|---|---|---|
| **Plumbing** | daemon, hooks, statusline, install, transport, SSE, dispatch | Route 3 (this doc) | yes |
| **Translator** | text/event → emotion (`lib/appraise.mjs`, `lib/anim/events.mjs`) | translation dept | black box |
| **Graphics** | the actual pixels: clips, faces, props, palettes (`grid/*.mjs`, art) | art dept | black box (except the host HTML + `grid/dispatch.mjs`) |

---

## 2. Data flow

```
┌─ Claude Code ───────────────┐
│  9 lifecycle hooks (node)   │  POST /event   ┌──────────────────────────────┐
│  statusline (every render)  │  POST /status  │        animayte.mjs          │
└─────────────────────────────┘ ─────────────▶ │  (the daemon, port 4321)     │
                                                │                              │
   transcript_path ───reads tail──────────────▶│  handleEvent / handleStatus  │
   (assistant text + token usage)              │     │  appraise()  classify()  │
                                                │     ▼                        │
                                                │  state {phase,mood,fullness, │
                                                │         birds,ctx,…}         │
                                                │     │ broadcast(cmd)          │
                                                └─────┼────────────────────────┘
                                                      │  SSE  /events  (data: {cmd,…})
                                                      ▼
                          ┌───────────────────────────────────────────────┐
                          │  overlay host  (grid/pet.html · animayte.html) │
                          │   grid/sse.mjs   ── reconnect supervisor       │
                          │   grid/dispatch.mjs ── cmd → pet.method()      │
                          │   grid/runtime.mjs  ── draws Dijon (canvas)    │
                          └───────────────────────────────────────────────┘
```

Key property: **events are fire-and-forget.** Hooks `curl -m 0.4 … || true`, so if the daemon is
down nothing blocks Claude. The daemon owns exactly **one** session (see [§4 ownership](#ownership)).

---

## 3. Repository map

Only the parts that matter for the running product. `■` = Route-3 plumbing (this doc owns it),
`□` = translator/graphics black box (read, don't edit), `·` = supporting/dev.

```
animayte.mjs            ■ the daemon: HTTP + SSE + state + the hook→reaction logic
animayte.html           ■ browser/multi-engine overlay host (legacy + dev)
grid/
  pet.html              ■ the LIVE Dijon overlay host (loaded by the WKWebView window)
  dispatch.mjs          ■ SSE cmd → pet.method()  — the shared command vocabulary (unit-tested)
  sse.mjs               ■ EventSource reconnect supervisor (dependency-injected, unit-tested)
  serve.mjs             · standalone static server for grid dev
  runtime.mjs           □ draws the creature from the public control API (the renderer)
  manifest.mjs          □ THE ART CONTRACT: clips, reactions, palettes, idle (see §6)
  creature/engine/geom/face/props/motion/compose.mjs  □ rendering internals
bin/
  animayte              ■ bash launcher: start/stop/restart/status, install/uninstall/doctor
  animayte-install.mjs  ■ idempotent install/uninstall of hooks+statusline; `doctor`
  animayte-statusline.mjs ■ reads CC statusline JSON, injects session_id, forwards to /status
hooks/hooks.json        ■ the 9 hooks (each runs bin/animayte-post.mjs → POST /event)
bin/animayte-post.mjs   ■ the hook forwarder: stdin event JSON → POST /event (cross-platform; replaces curl)
commands/               ■ /animayte and /animayte-stop slash commands
skills/                 ■ shipped skills: selftest · lint · gallery · new-pet (auto-discovered by CC)
tools/                  ■ dev/QA CLIs: selftest · gallery · replay · fixtures · lint · new-pet · preflight · post (the hook forwarder)
.claude-plugin/         ■ plugin.json + marketplace.json (plugin manifest)
lib/
  appraise.mjs          □ translator: session signal → FeatureSpec (emotion). black box.
  anim/events.mjs       □ classifyTool(): tool name+input → a tool-gag reaction name. black box.
  anim/runtime.mjs      □ the reference renderer the grid runtime mirrors
  expressions.mjs sentiment.mjs vocabulary.mjs  □ translator support
desktop/
  dijon-pet.swift       (desktop dept) WKWebView NSPanel hosting grid/pet.html — the macOS window
docs/
  ARCHITECTURE.md       ← you are here   ·   INSTALL.md · session-signals.md · renderer-runtime.md
test/                   ■ see §11 — the suite map
```

---

## 4. The daemon — `animayte.mjs`

Zero dependencies, one file, ~530 lines. Boots an `http.createServer` on `ANIMAYTE_PORT` (default
**4321**), bound to **127.0.0.1**.

### Endpoints

| Method · path | Purpose |
|---|---|
| `POST /event` | a Claude Code hook payload → `handleEvent` (ownership-filtered, de-duped, serialized) |
| `POST /status` | the statusline JSON → `handleStatus` (context %, cost, model, …) |
| `GET /events` | the SSE stream. On connect: a full authoritative snapshot + `retry: 1500` + a `ping` every 20s |
| `GET /health` | `{ok, owner, clients, rss, state}` — also what `doctor` probes |
| `POST /claim` | bind the pet to one session (`{session_id}`); `freshStart`s the pet |
| `GET /set` | direct control for demos/commands (`?mood=&fullness=&birds=&say=`) |
| `GET /detect` | run the real detector on arbitrary text (debug) |
| `GET /demo` | scripted tour of the full reaction range |
| `GET /…` | static files (the overlay HTML/JS), guarded to the daemon's own dir |

### State (`state = {…}`)

`phase` (`alive`/`sleeping`) · `mood` · `fullness` (0–1, the body) · `birds[]` (sub-agents) ·
`activeTool` · rich statusline fields (`model, ctxPct, ctxTokens, ctxWindow, costUsd, linesAdded,
linesRemoved, rateLimitPct, effort, thinking`) · `moodLevel/moodLabel` (slow mood drift) ·
`reliefSeq` (compact steam trigger) · `lastEventAt` (doctor's "is a session driving?" signal).

### Ownership

The daemon serves **one** session so concurrent sessions in the same repo don't blend. It is born
owned via `ANIMAYTE_SESSION` (the launcher passes `CLAUDE_CODE_SESSION_ID`) or claimed via
`POST /claim`. `ownsEvent(sid)` drops events from any other session. The statusline has **no**
`session_id`, so `bin/animayte-statusline.mjs` injects it before forwarding (else an owned pet's
cost/context feed would go dark).

### Key functions

- `handleEvent(ev)` — the hook → reaction switch (the behavioral spec, §8). Serialized through a
  queue (`enqueueEvent`) so a slow transcript read can't let a stale update land after a fresh one.
- `handleStatus(j)` — statusline → rich state; `used_percentage` is the authoritative context %.
- `readTranscriptTail(path)` — tail-reads the transcript for the newest assistant text (sentiment)
  and token usage (context %). **Stops at the `compact_boundary`** so a read right after `/compact`
  never re-inflates the body with the pre-compact usage.
- `applyContextFullness(v)` — guarded fullness: drops a big upward jump within the post-`/compact`
  window (a stale reading can't snap the body back to full).
- `broadcast(cmd)` — write a cmd to every SSE client; drops dead sockets **and** slow consumers
  (writableLength > 1 MB → destroy) so a stalled window can't grow RSS unboundedly.
- `snapshotTo(res)` — the idempotent full-state sync sent on every (re)connect, incl. the last
  `express` FeatureSpec so a reconnecting rich renderer keeps its face.

### Environment variables

`ANIMAYTE_PORT` (4321) · `ANIMAYTE_SESSION` (owner) · `ANIMAYTE_PET` (pack) ·
`ANIMAYTE_PERSONALITY` · `ANIMAYTE_ASSETS` · `ANIMAYTE_SETTINGS` (config path) ·
`ANIMAYTE_SLOW_BUFFER` (slow-client cap, test knob).

---

## 5. The command vocabulary — ART'S INPUT CONTRACT

Every signal the daemon can send over SSE. **A renderer must handle each one (or deliberately
ignore it).** `test/contract.test.mjs` fails the build if the daemon and a renderer ever drift.

| cmd | payload | meaning |
|---|---|---|
| `wake` / `hatch` | — | come alive |
| `sleep` | — | session ended → sleep |
| `reset` / `resetEgg` | — | fresh start (new session) |
| `mood` | `value` | set the face mood (`idle/happy/excited/thinking/sad/sleepy/neutral/…`) |
| `fullness` | `value` 0–1 | body fill = context window usage |
| `addBird` | `label` | a sub-agent spawned (max 5) |
| `removeBird` | — | a sub-agent finished |
| `clearBirds` | — | drop all birds (snapshot/reset) |
| `react` | `name` | play a named tool-gag clip (see §6 — `Reading`, `Running`, …, `Asking`, `Waiting`) |
| `endReact` | — | tool finished → return to idle |
| `relief` | — | `/compact` happened → steam-from-ears + deflate |
| `say` | `text`, `ms` | speech bubble (host concern, not a pet method) |
| `express` | `spec` | the full FeatureSpec rich face (see §10) |
| `moodLevel` | `value`, `label` | slow mood drift — *intentionally ignored by the grid runtime* |
| `ping` | — | keepalive (resets the client watchdog; renderers ignore) |

---

## 6. The reaction manifest — ART'S CLIP CONTRACT  (`grid/manifest.mjs`)

`MANIFEST` is where the art lives. Top-level keys: `format, name, defaultPalette, palettes, clips,
idle, reactions`. The plumbing only touches **`reactions`**: a `react` cmd calls
`pet.reactByName(name)`, which looks up `MANIFEST.reactions[name]`. If the name is missing, the pet
**silently doesn't react** — so the daemon's react names are locked to this map by
`test/contract.test.mjs`.

A reaction entry:

```js
Running: { clip: 'react', expression: 'thinking', prop: 'terminal', priority: 2 }
//        ^ animation     ^ face               ^ held item     ^ arbitration weight
```

The 11 reaction names (the full tool-gag set): `Reading, Searching, Writing, Running, Testing,
Installing, Committing, Fetching, Planning` (from `classifyTool`) + `Asking, Waiting` (notifications).

**To add a new tool reaction:** add the name to `MANIFEST.reactions` *and* make
`lib/anim/events.mjs:classifyTool` emit it. Run `test/contract.test.mjs` — it proves the two agree.

---

## 7. Parameter → reaction map (the behavioral spec)

What each session parameter does. This is the contract `test/reactivity.test.mjs` asserts on the wire.

| session parameter | source | reaction |
|---|---|---|
| **user text** | `UserPromptSubmit.prompt` | `appraise()` → praise = proud face, correction = sheepish (`express`+`mood`+`say`) |
| **output text** | assistant text in transcript (on `Stop`/`PostToolUse`) | sentiment → `mood`/`express` |
| **context window** | statusline `used_percentage` + transcript usage | `fullness` (body fill) |
| **/compact** | `PreCompact` | `relief` (steam + deflate), guarded against re-inflation |
| **tool call** | `PreToolUse` | `react` tool-gag + `mood thinking`; `PostToolUse` → `endReact` |
| **tool error** | `PostToolUse` structured `is_error` | negative `express` + "hit a snag" |
| **sub-agent** | `PreToolUse` Task → `addBird`; `SubagentStop` → `removeBird` | orbiting birds |
| **notification** | `Notification` permission/waiting | `react Asking` / `react Waiting` |
| **lifecycle** | `SessionStart` → `reset`+greet; `SessionEnd` → `sleep` | — |

---

## 8. The renderer contract — how art plugs in

The overlay host (`grid/pet.html`) does three things, all Route-3 plumbing:

1. `createGridRuntime(canvas)` → a `pet` with the **public control API**:
   `setMood, setFullness, addBird, removeBird, clearBirds, relief, sleep, wake, reset, reactByName,
   toIdle, applySpec, resize`, plus `state` and `stop`.
2. `createSseSupervisor(...)` (`grid/sse.mjs`) keeps the EventSource alive.
3. `applyCommand(pet, msg, {say})` (`grid/dispatch.mjs`) routes each SSE cmd to a method above.

**The art dept owns `grid/runtime.mjs` and the render internals.** To make the pet *look* different
you only change the renderer + `manifest.mjs`; the command vocabulary and dispatch stay fixed. The
plumbing guarantees the right method is called with the right args at the right time —
`test/dispatch.test.mjs` proves every cmd lands on the right method.

**To add a brand-new reaction type** (a parameter not yet rendered): the daemon can already
broadcast a placeholder `react`/`mood`/`express`; add the matching `MANIFEST.reactions` entry (even
a stub clip) and the contract test goes green. Art fills the stub with real frames later.

---

## 9. The rich path — `express` / FeatureSpec  (`lib/appraise.mjs`)

`appraise(signal, ctx)` returns a **FeatureSpec** — compositional emotion, not a flat bucket:

```js
{ expression, valence, arousal, cause, expectedness, item, reason }
//  face       -1..1    0..2     who    routine|…       prop   (debug)
```

The daemon broadcasts it as `express`, and `pet.applySpec(spec)` renders the full face. For
backward-compatibility it *also* sends the legacy `mood` (+ a `react` for `spec.item` via the
`REACTION_FOR_ITEM` bridge), so mood-only renderers still react. **Retirement plan:** once every
renderer consumes `express`, delete `REACTION_FOR_ITEM` and the extra `react` broadcast.

---

## 10. Hooks, statusline, install

- **`hooks/hooks.json`** — 9 hooks, each `node "${CLAUDE_PLUGIN_ROOT}/bin/animayte-post.mjs" event` — a tiny forwarder that reads the event JSON on stdin and POSTs it to `/event`, fire-and-forget (≤0.4s, always exits 0). Uses `node` (not `curl`) so hooks fire on **every** OS — on Windows PowerShell `curl` is an `Invoke-WebRequest` alias that rejects `--data-binary`, so the old curl hooks failed silently there.
- **statusline** — `bin/animayte-statusline.mjs` reads CC's statusline JSON on stdin, injects
  `session_id` from the env, forwards to `/status`, and prints a compact text status.
- **install** — `bin/animayte-install.mjs`: idempotent, backup-safe, atomic writes; plugin-aware
  (statusline-only when the plugin is enabled). `doctor` probes `/health`, ownership, port mismatch,
  double-fire. Round-tripped by `test/install.test.mjs`.

---

## 11. Running, testing, extending

```bash
bin/animayte            # start (daemon + native window); also: stop | restart | status
bin/animayte doctor     # diagnose a live install
node test/run.mjs       # run the whole suite
```

### Test-suite map (what each suite LOCKS)

| suite | locks |
|---|---|
| `contract.test.mjs` | daemon cmds ⊆ renderer dispatch ⊆ runtime methods; react names ⊆ manifest |
| `dispatch.test.mjs` | every cmd routes to the right `pet.method()` (renderer half of "does it react") |
| `sse.test.mjs` | reconnect-on-any-error, heartbeat watchdog, jump-safe, no leaked streams (fake clock) |
| `reactivity.test.mjs` | every session-parameter class produces a reaction **on the wire** + a property fuzzer |
| `transport.test.mjs` | SSE header contract, path-traversal, backpressure, EADDRINUSE, **security** (Host/CORS/cross-site/client-cap) |
| `compact.test.mjs` | `/compact` body deflate (real transcript fixtures, boundary-aware) |
| `sidechain.test.mjs` | a sub-agent (isSidechain) turn must not drive the MAIN pet's face/body |
| `daemon-safety.test.mjs` | malformed-request survival, `/claim` relief-cancel + rich-state reset, stray SubagentStop |
| `adopt.test.mjs` | adopt-on-silence: follow a changed session id, never bleed two concurrent ones |
| `integration.test.mjs` | end-to-end hook → state |
| `e2e.test.mjs` | full pipe: real hook commands + statusline + daemon + headless pet (real dispatch/sse) |
| `reconnect.test.mjs` | server-side snapshot/resync/restart recovery |
| `install.test.mjs` · `install-messy.test.mjs` | install/uninstall round-trip + messy-config P0s (array/scalar settings, disabled plugin) |
| `gallery.test.mjs` · `replay.test.mjs` | the QA tools (drive every reaction · replay a real transcript) self-test |
| `plugin.test.mjs` | ownership, dedup, doctor, statusline forwarding |
| `stress.test.mjs` | SSE fan-out, no-leak, flood, dedup/ownership under load |

> The full set run by `test/run.mjs` also includes the translator/renderer/asset suites (anim,
> conformance, docs, rive, codex, expressions, detection-sim, appraise) owned by their depts.

**Testing discipline (learned the hard way):** prefer real captured payloads/transcripts over
synthetic ones; for every fix, prove the test goes **red** without it; lock *contracts* (the silent
no-op class of bug stays green in behavioral tests).

---

## 12. Cross-platform notes

- **Daemon / hooks / statusline / transport** are cross-platform: Node + `curl` (Win10+ ships
  `curl.exe`), bound to `127.0.0.1` (not `localhost`, which isn't always 127.0.0.1).
- **The native window is macOS** (Swift WKWebView). `bin/animayte` gates Swift on `uname=Darwin`,
  falls back to python3/Tk, then prints a **browser** fallback (`open http://127.0.0.1:4321`). The
  pet runs anywhere a browser can point at the daemon.
- **Windows manual check** (no CI): `SIGTERM` semantics differ (the daemon's EADDRINUSE retry is the
  safety net for `restart`); path separators (`\`) — the static guard resolves within the daemon dir.
- The daemon itself runs **headless** (no display) — that's how the whole test suite drives it.

---

## 13. Ownership boundaries (don't cross without coordinating)

- **Route 3 / plumbing (this doc):** `animayte.mjs`, `grid/pet.html`, `animayte.html`,
  `grid/dispatch.mjs`, `grid/sse.mjs`, `bin/**`, `hooks/**`, `commands/**`, `.claude-plugin/**`,
  `docs/**`, the listed `test/**`.
- **Translator (black box):** `lib/appraise.mjs`, `lib/anim/events.mjs`, `lib/sentiment.mjs`,
  `lib/expressions.mjs`, `lib/vocabulary.mjs`.
- **Graphics (black box):** `grid/{runtime,creature,engine,geom,face,props,motion,compose,manifest}.mjs`
  and `desktop/**`.
