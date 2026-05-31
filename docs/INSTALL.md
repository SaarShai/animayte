# Installing & connecting animayte

animayte is a **Claude Code plugin** (not a native app you launch). It has two moving parts:

- a tiny **daemon** (`animayte.mjs`, zero-dependency Node) that holds the live session state and
  serves the pet, and
- a few **hooks + a statusline** that forward your Claude Code session to that daemon.

This doc covers getting from a clone to a reacting pet, taking it back out cleanly, and what to
do when the pet goes quiet.

---

## TL;DR — clone → reacting pet

```bash
git clone https://github.com/SaarShai/animayte
cd animayte
bin/animayte install     # wire the hooks + statusline into your GLOBAL Claude Code settings
bin/animayte start       # boot the daemon + float the pet on screen
# restart Claude Code (any project) once, so it loads the new hooks
```

That's it. From now on, every Claude Code session — in *any* project — drives the pet:
it perks up when you prompt, works while tools run, sweats as the context fills, sighs on
`/compact`, and reads the emotion in the agent's own words.

`bin/animayte stop` puts the pet away · `bin/animayte status` shows what's running ·
`bin/animayte doctor` diagnoses problems (see [Troubleshooting](#troubleshooting)).

---

## Two ways to install

### A. The plugin marketplace (recommended for most users)

```text
/plugin marketplace add SaarShai/animayte
/plugin install animayte@animayte
/animayte            # summon the pet; it now reacts to this session
```

When the plugin is enabled, Claude Code loads its hooks (`hooks/hooks.json`) and `/animayte`
command automatically — no settings editing required.

### B. `bin/animayte install` (clone / "everywhere" install)

`bin/animayte install` writes animayte's forwarding hooks **and** the statusline into your
**global** settings at `~/.claude/settings.json`, so the pet reacts to sessions in every
project — and you get the statusline (real context %, cost, effort) that the plugin alone
doesn't wire.

It is:

- **idempotent** — run it as many times as you like; it never duplicates hooks.
- **reversible** — `bin/animayte uninstall` removes exactly animayte's entries and nothing else.
- **backup-safe** — every change writes a timestamped `*.animayte-<time>.bak` next to your
  settings first.
- **non-destructive** — it merges alongside your own hooks, and it will **not** overwrite a
  statusline you've already set (it prints how to switch if you want animayte's).

> Already have the plugin enabled? `install` notices and adds **only the statusline** (the one
> thing the plugin doesn't wire), skipping the duplicate hooks so nothing fires twice. Force the
> full global hook install anyway with `bin/animayte install --with-hooks`.

The project-level `.claude/settings.json` in this repo only covers sessions launched **inside
the animayte folder** — `install` is what makes it work everywhere.

### Uninstall

```bash
bin/animayte uninstall   # removes animayte's hooks + statusline from ~/.claude/settings.json
```

Restart Claude Code afterward. Your own hooks, statusline, and everything else are left exactly
as they were. (A backup is written first, just in case.)

---

## How the connection works

```
Claude Code ──hooks (curl POST /event)──▶  animayte.mjs ──SSE /events──▶  the pet overlay
            ──statusline (POST /status)─▶   (daemon :4321)  ──HTTP /health──▶  native pets
```

- **Hooks** (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStop`,
  `Notification`, `Stop`, `PreCompact`, `SessionEnd`) `curl` each event to `/event`.
  They are **fire-and-forget**: a `0.4s` timeout and `|| true` mean a down or slow daemon can
  **never stall Claude Code** — the worst case is the pet briefly not reacting.
- The daemon tail-reads the session **transcript** for the real context % (from the `usage`
  object) and the agent's most recent text (for sentiment).
- The **statusline** streams the rich snapshot (model, cost, effort, rate limits) every turn.
- The overlay subscribes to **`/events`** (Server-Sent Events) and renders the result. The full
  signal catalog is in [`docs/session-signals.md`](session-signals.md).

### Port

Everything defaults to `http://127.0.0.1:4321`. To use another port, set `ANIMAYTE_PORT` for
**both** the install and the daemon so the hooks and the server agree:

```bash
ANIMAYTE_PORT=4322 bin/animayte install
ANIMAYTE_PORT=4322 bin/animayte start
```

`bin/animayte doctor` detects a port mismatch (hooks pointing at a different port than the
running daemon).

---

## On-screen presence

- `bin/animayte start` picks the best renderer automatically — native macOS window → Python/Tk
  → browser tab. The native pet floats over everything, is click-through in its empty space,
  and **remembers where you dragged it**.
- In the **browser** overlay, hit **🪟 Float on screen** for an always-on-top
  Picture-in-Picture window (Chrome/Edge). The browser decides where it opens, but animayte
  **remembers its size** between sessions.
- **Reconnect is automatic.** If the daemon restarts, the overlay shows `… reconnecting`, then
  re-attaches and **resyncs to the live session** on its own — no refresh, no stuck pet. (The
  daemon resends a full state snapshot to every client that connects.)

---

## Troubleshooting

Start here: **`bin/animayte doctor`**. It checks the daemon, the installed hooks, the
statusline, the port, and whether a live session is actually driving the pet, then prints a
fix for anything wrong.

| Symptom | Likely cause | Fix |
|---|---|---|
| Pet never reacts, `doctor` says **daemon not reachable** | the daemon isn't running | `bin/animayte start` (or `npm start`) |
| Pet reacts only inside the animayte repo | hooks are **project-only** | `bin/animayte install` (global), then restart Claude Code |
| Installed but still nothing | Claude Code hasn't reloaded the hooks | fully **restart Claude Code** in the project |
| `doctor` reports a **port mismatch** | hooks POST to one port, daemon on another | re-run install + start with the same `ANIMAYTE_PORT` |
| Context % stuck at 0 | **no transcript** / new session | it fills once the session has a `usage` object (after the first turn) |
| Pet reacts **twice** to everything | you forced `--with-hooks` while the plugin is on | re-run plain `bin/animayte install` (statusline-only), or disable the plugin |
| Overlay shows `… reconnecting` and stays there | daemon is down | `bin/animayte start`; it re-attaches automatically when the daemon returns |
| Statusline didn't appear | you already had a statusline | animayte won't overwrite it — `doctor` prints how to switch |

### Debug tools

The daemon serves a few connection/debug pages:

- **`/grid/detect-lab.html`** — paste agent text (one line per message) and see exactly which
  feeling each line triggers and what the pet shows. The "pet shows" column uses the same
  **recency-first** salience rule the live daemon uses (the newest line carrying a feeling wins).
- **`/grid/session-map.html`** — replay a recorded transcript through the detector to see the
  whole emotional timeline. Generate a map with
  `node grid/map-session.mjs <transcript.jsonl> --json grid/maps/<name>.json`.
- **`curl -s localhost:4321/demo`** — drives the live pet through its full range in ~50s
  (context swell → `/compact` relief, moods, birds). A quick "is the pipe alive?" check.
- **`curl -s 'localhost:4321/detect?text=fixed%20it!&push=1'`** — run the detector on arbitrary
  text and (with `push=1`) show it on the pet.

### Verifying the plumbing

The install round-trip and SSE reconnect behavior are covered by the test suite:

```bash
node test/install.test.mjs      # install/uninstall are idempotent, reversible, backup-safe
node test/reconnect.test.mjs    # the /events stream recovers after a daemon restart
npm test                        # the whole suite
```
