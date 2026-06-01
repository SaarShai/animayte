---
name: animayte-new-pet
description: Scaffold a NEW animayte pet pack (a re-skin of the pet) against the real art contract. Use when the user asks to "make / create a new animayte pet (pack)", "scaffold a pet", "skin / re-skin animayte", "start a new pet", "add a custom pet", or "how do I draw my own animayte pet". Generates a folder with a pre-filled, schema-valid pet.json (a stub for every reaction + face the daemon can emit), a README checklist of the exact art to draw, and an assets/ layout — then validates it and prints a coverage report. Walks the artist scaffold → fill assets → validate → preview.
effort: low
tools: [Bash, Read]
---

# animayte-new-pet

Scaffold a **new pet pack** — a community/art-team re-skin of the animayte pet — against a clean
contract, **without touching the plumbing**. This skill drives `${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs`, which
writes a pet folder pre-filled to the real `animayte-pet/1` schema, validates it, and tells the
artist exactly which pictures to draw.

## The one thing to get right first: which pet path?

animayte has **two** renderer paths. Pick the right one before scaffolding:

- **The LIVE on-screen pet ("Dijon")** is a **procedural** grid renderer. Its art is code
  (`grid/*.mjs`, manifest `animayte-grid/1`) and lives in **art-team territory**. It is **NOT** a
  sprite pack — this scaffolder does **not** target it.
- **The SPRITE pet-pack path** (`pets/<name>/pet.json` + `sheet.png`, schema `animayte-pet/1`,
  validated by `lib/anim/manifest.mjs`) **is** what this skill scaffolds. It's the extensibility
  surface: drop a valid folder in `pets/`, set `ANIMAYTE_PET=<name>`, and the loader wears it.

If the user wants to change how the *currently floating* pet looks, that's the grid renderer
(point them at `grid/` + `docs/ARCHITECTURE.md` §6) — say so, and confirm they instead want a new
**sprite pack** before running this. (Read `docs/ARCHITECTURE.md` and `docs/making-a-pet-pack.md`
if you need the full picture.)

## When to use

Trigger on any of:
- "make / create a new animayte pet" · "new pet pack" · "scaffold a pet"
- "skin / re-skin animayte" · "custom pet" · "my own pet"
- "start a new pet" · "how do I draw a pet for animayte"

## The workflow — scaffold → fill → validate → preview

### 1. Scaffold

Ask the user for a **name** (lowercase letters/digits/`-`/`_`). Optionally ask whether they want to
start from a **copy of an existing animation library** (`--from slime` or `--from bean`,
*recommended* — real, complete motion they re-skin) or a **minimal stub** (default — they author
the motion themselves).

```bash
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" <name>                 # → pets/<name>/  (stub library)
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" <name> --from slime     # → copy the slime's full library to start
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" <name> --dir <path>     # scaffold somewhere else
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" <name> --force          # overwrite a non-empty dir
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" --help                  # full usage
```

This creates `<dir>/pet.json` (pre-filled: palettes, the idle clip, and a stub clip + the right
face for **every** reaction the daemon emits + the standard moods), a `README.md` checklist of the
assets to draw, and an `assets/` placeholder layout (`body/`, `faces/`, `props/`). It **validates
the scaffold against the real schema before writing** and prints a coverage report. It refuses to
overwrite a non-empty dir without `--force`.

**Why it can't drift:** the required reactions + faces are derived from the real source at scaffold
time (`lib/anim/events.mjs#TOOL_EVENTS`, the `react` literals + `REACTION_FOR_ITEM` in
`animayte.mjs`, and `grid/manifest.mjs#MOOD_EXPRESSION`) — the same sources
`test/contract.test.mjs` locks. When the daemon learns a new reaction, the scaffolder asks for its
art too.

### 2. Fill the assets

Open the generated `pets/<name>/README.md` and follow it — it lists, in exact order, every
spritesheet **row** (one per expression) and every prop **column** to draw, plus the cell sizes.
Then:
- draw `sheet.png` (rows = expressions in the README's order, cols = frames; **column 3 is the
  blink frame**, eyes closed),
- draw `props.png` (one column per prop), and
- recolor the `palettes` in `pet.json` (every palette must keep the **same role names** for a clean
  mood-swap — the validator enforces this).

The coverage checklist's unchecked boxes are the artist's to-do list. A reaction or face counts as
"covered" once it has a clip/row; replacing the placeholder pixels is the real work.

### 3. Validate

After every edit, re-validate. Prefer the **`animayte-lint`** skill if available (nicer report,
checks the art contract end-to-end). Otherwise validate directly with the real schema:

```bash
# direct schema check — every error names its exact JSON path:
node -e "import('./lib/anim/manifest.mjs').then(m=>{const fs=require('fs');const e=m.validateManifest(JSON.parse(fs.readFileSync('pets/<name>/pet.json','utf8')));console.log(e.length?e.join('\n'):'valid ✓')})"
```

(`${CLAUDE_PLUGIN_ROOT}/tools/animayte-lint.mjs` may also exist — same checks, friendlier output.) The loader validates
too and refuses to load a malformed pack.

### 4. Preview

Wear the pack and watch it react. The **`animayte-gallery`** skill / `${CLAUDE_PLUGIN_ROOT}/tools/animayte-gallery.mjs`
drives every reaction on demand so the artist can sign off without waiting for a real session:

```bash
ANIMAYTE_PET=<name> node animayte.mjs     # daemon on http://127.0.0.1:4321
# then run /animayte to summon the window, and:
node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-gallery.mjs"           # play every mood, tool gag, relief, birds, fullness…
```

## Guardrails (state these to the user)

- The scaffolder **only writes under the target dir** and never touches the daemon, port 4321, git,
  or `~/.claude`. It defaults to `pets/<name>` but refuses to clobber an existing non-empty pet
  without `--force` — if in doubt, scaffold to a throwaway `--dir` first and review.
- Pet design follows animayte's guardrails: **recovery never punishment** (no guilt/decay/death),
  **ambient never Clippy** (react, never initiate), **honest mirror** (every animation ties to a
  real measured signal), **zero runtime deps**.

## Self-check

`node "${CLAUDE_PLUGIN_ROOT}/tools/animayte-new-pet.mjs" --selftest` scaffolds into a temp dir, asserts the `pet.json`
parses + validates + the README lists the required reactions, then breaks it and asserts validation
fails with a clear message. Run it if the tool's behavior is ever in question.
