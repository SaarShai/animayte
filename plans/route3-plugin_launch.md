# animayte · Route 3 — Plugin ("the plumbing") · parallel session launch

**One-liner:** Make the **plugin** (not a native app) rock-solid — how it loads, how it connects to a live Claude Code session to read its text, where the pet sits on screen, how it reconnects, and how you troubleshoot when the pet goes quiet.

**Branch:** from `feat/anim-engine`, work on `feat/plugin`. **Keep going until the Goal is met.** You may ask Saar questions any time.

---

## The seam is already cut (read this first)
The daemon is now thin transport. The translation logic moved out:
- `animayte.mjs` — **your main file.** It builds a SIGNAL from each hook event, calls `appraise()` (Route 1, treat as a black box — **do not edit `lib/appraise.mjs`**), and broadcasts the result: legacy `mood`/`react` (for current renderers) **plus a new additive `express` cmd carrying the full FeatureSpec**.
- The contract you transport: `POST /event` + `POST /status` (verbatim Claude Code hook/statusline JSON) in; SSE `/events` out; `GET /health`.
- `pet.html` — the on-screen overlay host (window, sizing, SSE connect, speech bubble). The rendering pipeline (`grid/runtime.mjs`, `grid/compose.mjs`) is **Art's**; you only wire the SSE cmd to it — e.g. add `case 'express': pet.applySpec(m.spec)` once Art exposes `pet.applySpec`.

## Goal (done =)
1. **One-command install/connect that's idempotent + reversible.** `bin/animayte install`/`uninstall` wire (and cleanly remove) the hooks + statusline in the user's Claude Code settings, backup-safe, round-trip tested (`test/install.test.mjs`). (Today hooks are pre-wired only in the project `.claude/settings.json`; there's no global install and no uninstall.)
2. **Reliable session connection.** The pet reflects a *real* live session: hooks deliver events fire-and-forget to a maybe-down daemon without stalling Claude Code; the daemon reads the transcript for context% + recent text; statusline feeds cost/effort/etc. Verify against an actual session.
3. **On-screen presence as a plugin.** The overlay loads, sizes, and positions predictably (where on screen, remembers it), and **reconnects** when the daemon restarts (SSE retry) without a stuck pet.
4. **Troubleshooting story.** A `bin/animayte status`/doctor that diagnoses the common failures (daemon down, hooks not firing, wrong port, no transcript) and a `docs/INSTALL.md` + troubleshooting section. Repurpose `grid/detect-lab.html` / `grid/session-map.html` as connection/debug tools (note: `detect-lab.html` still runs an OLD salience rule — fix it to match, it's a pure debug-tool fix in your lane).
5. **Switch transport to specs + retire the bridge.** Once Art's renderer consumes `express`, prefer broadcasting the FeatureSpec and retire the transitional `REACTION_FOR_ITEM` bridge in `animayte.mjs`.

## Why this is safe in parallel
- **You OWN:** `animayte.mjs` (server/SSE/transcript-IO/transport — NOT the translation logic), `hooks/`, `bin/**`, `.claude/settings.json`, `commands/**`, `.claude-plugin/**`, `pet.html` (host/positioning/connection), `docs/**`, `test/install.test.mjs`, and the debug tools `grid/detect-lab.html` + `grid/session-map.html` (as connection diagnostics).
- **READ-ONLY CONTRACT:** `appraise()` (call it; don't reinvent translation) and `pet.applySpec()` (Art provides it). The hook/statusline JSON is Claude Code's — pass it verbatim.
- **DO NOT EDIT:** `lib/**` (Translation — if you think the daemon needs a translation change, it belongs in `lib/appraise.mjs`; ask Route 1), `grid/{face,props,creature,engine,geom,motion,manifest,runtime,compose}.mjs` and `grid/{sheet,facelab}.html` (Art), `desktop/**` (the native app is explicitly out of scope — this is the *plugin*).

## Verification gate
Round-trip the installer on a throwaway settings file (`test/install.test.mjs` green); boot the daemon and confirm a live session drives the pet (it already smoke-tests: praise→happy, tool error→sad); kill+restart the daemon and confirm the overlay reconnects. Definition of done: clone→reacting-pet in one step, clean uninstall, reliable reconnect, and a troubleshooting doc that actually resolves the common failures.
