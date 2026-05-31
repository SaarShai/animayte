# animayte · Path 3 — one-command install & integration (parallel session launch)

**One-liner:** Make animayte trivial to adopt and remove — a robust, idempotent **install / uninstall** that wires the hooks + statusline into a user's Claude Code, a clean daemon lifecycle (incl. optional auto-start), and the docs to match.

**Branch:** from `feat/anim-engine`, create and work on `feat/install-integration`. Push when each phase is verified.

**You are one of three parallel sessions.** Stay strictly in your lane (below). You may ask the user (Saar) questions any time. **Keep going until the Goal is met.**

---

## Goal (done =)
1. `bin/animayte install` **idempotently** merges animayte's hooks + statusline into the user's `~/.claude/settings.json` (global) — backing up first, never clobbering existing unrelated hooks, safe to run twice. A `--project` mode targets the project `.claude/settings.json` instead.
2. `bin/animayte uninstall` cleanly **removes only animayte's** hook/statusline entries and stops the daemon, leaving the rest of `settings.json` intact.
3. Both are **tested round-trip** against a throwaway settings file (install → assert entries present + valid JSON → uninstall → assert back to original). Add `test/install.test.mjs` (or extend the suite) so it can't silently break.
4. `docs/INSTALL.md` documents global vs project install, the plugin path, daemon lifecycle, and uninstall; `README.md` links to it.
5. (Optional, if Saar wants) a `launchd` plist that auto-starts the **daemon** at login, wired via `bin/animayte install --autostart` / removed on uninstall. **This (the daemon-as-service) is YOUR lane** — the desktop session owns only the app window's own launch-at-login.

## Why this is safe in parallel (disjointness — verified)
- **You OWN:** `bin/**` (`animayte` launcher, `animayte-statusline.mjs`, NEW `animayte-install`/`uninstall` logic — as subcommands of `bin/animayte` or sibling scripts), the **hooks template** (`hooks/hooks.json`) + `.claude/settings.json`, `commands/**`, `.claude-plugin/**`, `docs/INSTALL.md`, the README setup section, an optional `launchd` plist, and `test/install.test.mjs`.
- **READ-ONLY CONTRACT (never edit):** the daemon endpoints `POST /event` and `POST /status` — hooks forward **Claude Code's native hook JSON verbatim**; the daemon (`animayte.mjs`) is the receiver and belongs to the engine session. You do **not** need to change what the daemon understands; you only ensure events get delivered.
- **DO NOT EDIT (other people's lanes):** `animayte.mjs` internals, `lib/**`, `grid/**` (incl. `grid/facelab.html`, `grid/maps/**`), `desktop/**` (the desktop session owns the app + its menubar; if you need the daemon started, call the existing `bin/animayte start`), `lib/codex/**`, `pets/**`. If you believe a daemon-side change is required, **ask Saar** — it's another session's file.

## Current state (grounded)
- **Hooks already wired in the project** `.claude/settings.json`: every event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse` matcher `*`, `SubagentStop`, `Notification`, `Stop`, `PreCompact`, `SessionEnd`) fires a fire-and-forget `curl -m 0.4 ... || true` to `http://127.0.0.1:4321/event`. Statusline → `node bin/animayte-statusline.mjs` → `POST /status`.
- **Launcher exists:** `bin/animayte {start|stop|restart|status}` — `nohup node animayte.mjs &`, `pkill -f animayte.mjs`, `/health` checks. Port 4321 (env `ANIMAYTE_PORT`), single-daemon-per-machine (EADDRINUSE → exits cleanly).
- **Plugin path exists:** `.claude-plugin/plugin.json` + `marketplace.json`; `/animayte` & `/animayte-stop` commands run the launcher.
- **Gaps:** no global `~/.claude/settings.json` auto-wiring, **no uninstall**, no idempotent/backup-safe merge, no install test, no `docs/INSTALL.md`, no daemon auto-start at login. `hooks/hooks.json` exists as a reference copy (not loaded) — a good source-of-truth template for the merge.

## Build it (phases, each with a verification gate)
1. **Idempotent install** — `bin/animayte install [--project] [--autostart]`: read-or-create the target `settings.json`, back it up (`settings.json.animayte.bak`), deep-merge animayte's hooks + statusline (tagged so they're identifiable), preserve all other keys, write valid JSON. Re-running makes no further changes. *Gate:* run twice on a fixture → identical, valid result; unrelated hooks preserved.
2. **Uninstall** — remove only the tagged animayte entries + `bin/animayte stop`. *Gate:* install→uninstall on a fixture returns it byte-for-byte (or semantically) to the original.
3. **Tests** — `test/install.test.mjs` runs the round-trip on a temp file (never the user's real settings). *Gate:* green; wire into the suite runner.
4. **Docs** — `docs/INSTALL.md` (global vs project vs plugin, daemon lifecycle, troubleshooting "pet not reacting", uninstall) + README link. *Gate:* a clean-machine walkthrough in the doc actually works.
5. **(Optional) daemon auto-start** — `launchd` plist + `--autostart` flag (install loads it, uninstall unloads it). *Gate:* after login (or Saar confirms), the daemon is up and a session reacts. Coordinate with the desktop session so only ONE thing starts the daemon.

## Open decisions — ask Saar
- Default install target: **global** `~/.claude/settings.json`, or project-only? (Recommend global with a `--project` opt.)
- Is daemon auto-start-at-login wanted in v1, or keep it manual via `/animayte`?
- How to TAG animayte's hook entries for safe removal (a comment marker / a wrapper field / a known command signature)? Pick a scheme that survives JSON round-trips.

## Definition of done
`bin/animayte install`/`uninstall` are idempotent, backup-safe, and round-trip-tested (`test/install.test.mjs` green); `docs/INSTALL.md` + README updated; optional autostart works without racing the desktop app. All on `feat/install-integration`.
