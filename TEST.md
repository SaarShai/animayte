# Testing animayte inside Claude Code (60 seconds)

## The slash-command test (what you asked for)

Project slash-commands load when Claude Code **starts a session**. Since this
session was already running when the command was created, do one of:

- **Restart Claude Code in this folder**, then type **`/animayte`** → press Enter.
- (or just run the launcher directly to see it now — see below.)

`/animayte` → a cute pixel slime floats in the top-right of your screen.
**Drag it anywhere. Esc or right-click dismisses it.** `/animayte-stop` puts it away.

It reacts to *this* session: face shows the mood, body swells as context fills.

## Run it right now without restarting

```bash
bin/animayte start     # summon the floating pet
bin/animayte status    # what's running
bin/animayte stop      # dismiss it
```

If `python3` is missing, the browser pet is the fallback: `node animayte.mjs`
then open http://127.0.0.1:4321

## What "works" means here
- **No agent (Claude Code / Codex / VS Code) lets a plugin draw a free-floating
  window from inside it.** Every floating pet — including the official Codex pet
  and the community codex-pets app — is a **separate native OS window process**.
  So the plugin is the *integration* (hooks + `/animayte`); it **launches** the
  window. This is the same model codex-pets uses (and we're better integrated:
  they're a standalone app with no plugin at all).
- **Renderer, auto-selected by `bin/animayte`:**
  1. **Native Swift / AppKit `NSPanel`** (macOS) — transparent, always-on-top,
     **follows across all Spaces**, no dock icon, never steals focus. Compiles
     once on first run (~seconds). This is the codex-pets-grade overlay.
  2. **Python / Tk** — cross-platform fallback, zero install.
  3. **Browser** — `node animayte.mjs` → http://127.0.0.1:4321
- Same launcher is the universal entrypoint we'll point Codex & Antigravity at
  next — they just need a way to call it.

## Requirements
- macOS with `swiftc` (best) — ✅ confirmed (Swift 6.3). Or `python3` (Tk) — ✅.
- `node` for the live-reaction daemon (optional; pet idles happily without it).
