---
name: animayte-gallery
description: Drive the LIVE animayte pet through its ENTIRE reaction range on demand so the art team can watch the floating pet and sign off on the art. Use when the user says "show me every animayte reaction", "animayte gallery", "preview the pet", "validate the pet art", "run the pet through all its reactions / expressions / moods", or "let me see all the pet's faces". Plays every mood, every tool gag, the rich express faces, birds 0→5, relief, sleep/wake, and the fullness sweep — each with a readable pause and a printed label.
effort: low
tools: [Bash]
---

# animayte-gallery

A **showcase driver** for the animayte pet. It makes the LIVE floating pet perform its
*entire* reaction range — one reaction at a time, with a readable pause and a printed label of
what's on screen — so the **art team can watch and sign off on the art** without running (and
waiting through) a real coding session and hoping each rare signal happens to fire.

It is the art dept's counterpart to the renderer contract in `docs/ARCHITECTURE.md` (§5 command
vocabulary, §6 reaction manifest): that doc says what the pet *should* do; this skill makes the
pet *actually do all of it*, on demand, in front of you.

## When to use

Trigger on any of:
- "show me every animayte reaction" / "all the pet's reactions / faces / expressions / moods"
- "animayte gallery" / "preview the pet" / "pet gallery"
- "validate the pet art" / "sign off on the pet" / "review the pet animations"
- "run the pet through its full range"

## Before you run: the pet must be floating

The gallery drives the pet that is ALREADY on screen over the real event endpoints — it
**never** starts or kills a daemon. So first make sure the pet is summoned:

- If the pet isn't up yet, run the **/animayte** skill/command (or `bin/animayte start`) and
  tell the user to keep the floating window visible.
- Confirm it's alive (optional): `curl -s http://127.0.0.1:4321/health` should return `ok:true`.

## How to run

Run the tour against the live daemon and tell the user to watch the floating pet:

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/tools/animayte-gallery.mjs"
```

Each step prints a label like `[18/43] ▶ tool gag · Running (PreToolUse Bash)` as the pet
performs it, so the user always knows what they're looking at.

### Useful flags

- `--list` — print the full catalog of reactions (no pet needed) so the user can pick.
- `--only <name>` — show just one reaction, e.g. `--only Running`, `--only relief`,
  `--only mood:excited`. Names come from `--list`; a bare `--only mood` shows every mood.
- `--pace <ms>` — pause between steps (default `1800`). Slow it down (`--pace 3000`) if the
  user wants longer to inspect each frame.
- `--port <n>` — daemon port (default `4321`, or set `ANIMAYTE_PORT`).

```bash
# print the catalog
node "${CLAUDE_PLUGIN_ROOT:-.}/tools/animayte-gallery.mjs" --list

# show one reaction, slowly
node "${CLAUDE_PLUGIN_ROOT:-.}/tools/animayte-gallery.mjs" --only excited --pace 3000
```

## What it covers (derived from the real source, so it can't drift)

The catalog is built FROM the live contract — `TOOL_EVENTS`/`classifyTool`
(`lib/anim/events.mjs`), `MOOD_EXPRESSION` and `MANIFEST.reactions` (`grid/manifest.mjs`) — so
when the art/translation contract grows, the gallery grows with it automatically:

- **Every mood** — each face bucket the daemon can park on (neutral, thinking, happy, excited,
  oops, embarrassed, sad, sleepy, …).
- **Every tool gag** — one real `PreToolUse` per `classifyTool` category (Reading, Searching,
  Writing, Running, Testing, Installing, Committing, Fetching, Planning) plus the notification
  poses (Asking, Waiting). Each shows the held prop.
- **The rich `express` faces** — praise → proud, gentle praise → content, correction →
  sheepish, scolding → mortified, and a tool error → the red wince.
- **Birds 0 → 5 and back** — sub-agents spawning (and the 5-bird cap) then finishing.
- **Relief** — the `/compact` steam-from-ears + body deflate.
- **Sleep / wake** — session end → sleep, then wake again.
- **The fullness sweep** — the body fill from 0 → 100% and back, the way the context window
  drives it.

Everything is driven through the pet's **real** event path (the same `POST /event` /
`POST /status` a live Claude Code session uses), so what the art team watches is exactly what a
real session produces — not a special preview mode.

## After it runs

Relay that the tour is complete and ask the art team for their sign-off (or which specific
reaction they want to see again, via `--only`). The tool leaves the pet idle-happy at the end.
