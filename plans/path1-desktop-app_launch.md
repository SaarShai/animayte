# animayte · Path 1 — the native macOS desktop app (parallel session launch)

**One-liner:** Turn the working-but-raw Swift pet into a distributable, controllable macOS **app** — a menubar control, a real `.app` bundle, launch-at-login for the *window*, and multi-monitor-safe positioning.

**Branch:** from `feat/anim-engine`, create and work on `feat/desktop-app`. Commit only files under `desktop/` (see "Owns"). Push when a phase is green.

**You are one of three parallel sessions.** Stay strictly in your lane (below). You may ask the user (Saar) questions any time — especially for visual/taste calls and signing identity. **Keep going until the Goal is met.**

---

## Goal (done =)
A new user can run one build command and get a polished floating pet they can control:
1. `desktop/build.sh` produces `desktop/.build/Animayte.app` (a proper bundle with `Info.plist`, icon, `LSUIElement`/accessory policy).
2. A **menubar status-item** (NSStatusBar) summons / dismisses / quits the pet and shows whether the daemon is connected — so the pet can be re-opened after dismissal without the terminal (today's #1 UX gap).
3. **Position persistence is multi-monitor-safe** (store screen identity, restore correctly after a display is unplugged/replugged).
4. An **opt-in "launch at login"** for the *app/window* (a toggle in the menubar). NOTE: auto-starting the **daemon** at login is Path 3's job — do not duplicate it; your app should just connect to (or invoke `bin/animayte start` as a black box) a daemon that may already be running.
5. Saar confirms on his Mac that it looks and behaves right (drag, click-through on empty pixels, menubar control, survives display changes).

Document the unsigned-distribution path (Gatekeeper bypass instructions) and, if Saar provides a Developer ID, wire codesigning + notarization into `build.sh`.

## Why this is safe in parallel (disjointness — verified)
- **You OWN:** everything under `desktop/` — `AnimaytePet.swift` (native pixel renderer, ~251 lines, production-ready), `dijon-pet.swift` (WKWebView overlay → `grid/pet.html`, ~95 lines), `animayte_pet.py` (cross-platform fallback), `desktop/rive/` (Rive host), plus NEW files you add: `desktop/build.sh`, `Info.plist`, a menubar `AppDelegate`, an `.icns`, an optional app-level launch-at-login helper.
- **READ-ONLY CONTRACT (never edit):** `grid/pet.html`, the daemon HTTP/SSE API — `GET /health` → `{ ok, state:{ fullness, birds[], mood, phase } }`, `GET /events` (SSE: `mood`/`fullness`/`addBird`/`removeBird`/`clearBirds`/`relief`/`react`/`endReact`/`sleep`/`say`/`hatch`/`wake`), port via `ANIMAYTE_PORT` (default 4321), env `ANIMAYTE_CLICKTHROUGH=1`.
- **DO NOT EDIT (other people's lanes):** `animayte.mjs`, `lib/**`, `grid/**` (engine/face/runtime/manifest/props/etc.), `bin/**`, `.claude/**`, `commands/**`, `pets/**`, `lib/codex/**`. If you think you need a daemon or contract change, **ask Saar** rather than editing — it belongs to another session.

## Current state (grounded)
- Two Swift apps already **compile and run**: `AnimaytePet` (native sprite; transparent borderless `NSPanel`, always-on-top, all-Spaces, hit-test click-through, drag-to-move, right-click dismiss, position persisted to `~/.animayte/petpos.json`, context-swell + sweat + birds + relief steam) and `dijon-pet` (loads `http://localhost:PORT/grid/pet.html` in a transparent WKWebView, position persisted to `~/.animayte/dijonpos.json`).
- Build today: `swiftc -O desktop/AnimaytePet.swift -o desktop/.build/AnimaytePet` and likewise for `dijon-pet`; Rive host builds via SPM (`cd desktop/rive && swift build -c release`, pinned rive-ios 6.20.5).
- **Gaps to "shippable app":** no menubar/tray control (can't re-open after dismiss), no `.app` bundle, no codesigning/notarization, no build script, multi-monitor restore uses `NSScreen.main` only, no dark-mode palette adaptation, no global hotkey.

## Build it (phases, each with a verification gate)
1. **Menubar control** — add an `NSStatusBar` item (AppDelegate) with: Show/Hide pet, Restart, Quit, and a daemon-connection indicator (poll `/health`). *Gate:* Saar can dismiss and re-summon the pet from the menubar, screenshot confirms.
2. **App bundle + build script** — `desktop/build.sh` assembles `Animayte.app` (Info.plist with `LSUIElement=true`, bundle id, icon). *Gate:* double-clicking the `.app` launches the connected pet; `build.sh` is reproducible from clean.
3. **Multi-monitor positioning** — persist screen identity alongside origin; clamp to a visible screen on restore. *Gate:* Saar moves the pet to a second display, quits, relaunches → it returns to the right screen (and degrades gracefully if that display is gone).
4. **Launch-at-login (app)** — menubar toggle using `SMAppService`/login-item for the *app*. *Gate:* toggling on, logging out/in (or Saar confirms), the pet reappears. (Daemon auto-start = Path 3.)
5. **Distribution polish** — Gatekeeper/unsigned instructions in a short `desktop/README.md`; if Saar supplies a Developer ID, add codesign + notarize steps to `build.sh`. *Gate:* a fresh-download install works following the doc.

## Open decisions — ask Saar
- Which renderer is the flagship app: the **native pixel `AnimaytePet`** or the **WKWebView `dijon-pet`** (Dijon)? (Default assumption: ship the one Saar's currently iterating — confirm.)
- App name / bundle id / icon. Codesigning: does Saar have a Developer ID + want notarization, or ship unsigned with instructions?
- Is "launch at login" wanted in v1, or defer?

## Definition of done
`build.sh` → `Animayte.app`; menubar summon/dismiss/quit works; position survives a monitor change; Saar signs off visually on his Mac; docs cover install. All commits under `desktop/` on `feat/desktop-app`.
