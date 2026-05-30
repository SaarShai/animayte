<div align="center">

# 🫧 animayte

**A tiny desktop pet that _is_ your AI coding session.**

Its body swells and sweats as the context window fills — then sighs with relief and
deflates when you `/compact`. Sub-agents become little birds orbiting its head. Its
face shows how the session _feels_ — reading the emotion the agent expresses in its
own words.

_Chat & agent interfaces are powerful but faceless. animayte gives a session a visible
body and personality._

</div>

---

## Why animayte is different

Other coding pets (vscode-pets, Codex Pets, Petdex) are **decorative** or react only to
coarse states (running / waiting / done). animayte visualizes the session's **inner
physiology** — the stuff nobody else shows:

| Signal | What the pet does | Anyone else? |
|---|---|---|
| **Context window %** | head **swells + sweats** past 60%; **deflates with steam** on `/compact` | ❌ no one does this graphically |
| **Sentiment** | face reflects the emotion in the agent's own words (8 expressions) | ❌ others react to states, not feeling |
| **Sub-agents** | each spawned task becomes an orbiting bird (max 5) | ➖ rarely, and not as "its own thoughts" |

That triad — **context-as-body, emotion-as-face, subagents-as-thoughts** — is the idea.

## Quick start

Requires **Node 18+**. On macOS you also get a native floating pet (needs `swiftc`,
which ships with Xcode Command Line Tools); otherwise it falls back to Python/Tk, or a
browser tab.

```bash
git clone https://github.com/SaarShai/animayte
cd animayte
bin/animayte start      # launches the daemon + floating pet
```

A cute slime appears, floating over everything. **Drag it anywhere** (it remembers where);
clicks pass _through_ its empty space to the app underneath; **right-click to dismiss**.

`bin/animayte stop` puts it away · `bin/animayte status` shows what's running.

### See the whole personality in 50 seconds

```bash
curl -s localhost:4321/demo      # plays the full arc incl. the context-swell → /compact relief
```

### Try it without installing anything

Open **`animayte.html`** in any browser → hit **▶ Play demo**. Fully self-contained.

## Use it with Claude Code (live mode)

animayte ships as a Claude Code **plugin** — its hooks forward your real session events
to the pet, so it reacts as you work.

```text
/plugin marketplace add SaarShai/animayte
/plugin install animayte@animayte
/animayte            # summon the pet; it now reacts to this session
```

(Until you restart Claude Code in the folder, run `bin/animayte start` directly.)

## How a session maps to the pet

| Session signal | Source | Pet reaction |
|---|---|---|
| Context window filling | transcript `usage` (real tokens) | body inflates + forehead sweat past 60% |
| `/compact` | `PreCompact` hook | **deflates + steam from the "ears"** 😮‍💨 |
| New request | `UserPromptSubmit` | perks up, "thinking" 👀 |
| Tool running | `PreToolUse`/`PostToolUse` | calm "working" |
| Sub-agent spawned/finished | `PreToolUse` (Task) / `SubagentStop` | a bird flies in / flies off |
| The agent's words | transcript text | face reads the emotion (😄 🤩 😅 😳 😟 …) |
| Tool error | `PostToolUse` | 😟 worried — then **recovers** (no punishment) |
| Idle / end | `Stop` / `SessionEnd` | settles / sleeps 💤 |

Full signal catalog: [`docs/session-signals.md`](docs/session-signals.md).

## Architecture

```
Claude Code hooks ─curl POST─▶ animayte.mjs ─SSE / HTTP /health─▶ pet renderer
 (.claude/settings.json)       (zero-dep daemon,                  ├─ native Swift/AppKit (macOS) ★
 + statusline                   real context %,                   ├─ Python/Tk (cross-platform)
                                emotion engine)                    └─ browser (animayte.html)
```

- **One emotion dictionary** — [`lib/expressions.mjs`](lib/expressions.mjs) — is the single
  source of truth. Edit it + run `npm run assets` to change the pet's feelings.
- **Pixel art is generated** by [`tools/make-assets.mjs`](tools/make-assets.mjs) (zero deps —
  hand-plots pixels, encodes PNG via Node's `zlib`). 100% original, no licensing strings.

## Customize the emotions

```bash
# edit lib/expressions.mjs (add emoji / keywords / a new face), then:
npm run assets        # regenerate the spritesheet + manifest
npm test              # 700+ checks: engine, conformance golden, detection, doc-lint, end-to-end
```

Try the interactive **expression tester** at `http://localhost:4321/tester.html` — type
any agent phrasing and see exactly which face it triggers and why.

## The animation engine (a living cartoon)

Under the hood, animayte is a small **data-driven animation engine** (`lib/anim/`, zero
runtime deps): a pet is **data** (`pets/<name>/pet.json`) describing layers, clips with
procedural **squash/stretch transform tracks**, expressions, props, mood **palettes**, and
event→reaction mappings. ~80% of the "aliveness" is procedural (easing + volume-conserving
squash), not hand-drawn frames — so the library re-skins onto any pet design.

- **Tool gags** — the daemon classifies tool calls (`lib/anim/events.mjs`) so the pet puts on
  **👓 glasses to read**, peers with a **🔍 magnifier to search**, sprouts **legs + 💨 dust to
  run a command**, **✏️ scribbles** to edit, and **stamps ✔ to commit**.
- **Idle life** — breathing + randomized blink + a secondary-idle pool (sway / stretch / hop,
  anti-repetition) + dozing when bored.
- **Personalities** — `personalities/*.json` re-weight behavior (Adaptive / Chipper / Grumpy).
- **Mood drift** — a run of errors reads as "stressed" (cooler), a streak of wins as "up".
- **Sound** — optional chiptune SFX infra, **off by default** (`npm run sounds` bakes the blips).

Build a pet of your own: **[docs/making-a-pet-pack.md](docs/making-a-pet-pack.md)**. The
renderer-conformance contract that keeps the 3 renderers in sync:
**[docs/renderer-runtime.md](docs/renderer-runtime.md)**. The full event→animation taxonomy:
**[docs/animation-library.md](docs/animation-library.md)**.

```bash
npm run preview       # contact-sheets + clip filmstrips → tools/preview-out/ (QA the art)
npm run simulate      # replay canned sessions → the pet's state timeline
ANIMAYTE_PET=bean ANIMAYTE_PERSONALITY=chipper bin/animayte start
```

## Design guardrails

- **Recovery, never punishment** — no guilt-trips, no neglect "death". Errors → worried-but-hopeful.
- **Ambient, never Clippy** — it reflects; it never interrupts or steals focus.
- **Zero telemetry, fully local** — state never leaves your machine.

## Status

Working MVP. The context-as-body signature, emotion-as-face engine, sub-agent birds,
native floating window (click-through + remembered position), live Claude Code plugin,
and a 211-check test suite are all in. Roadmap: custom-pet support, Codex & Antigravity
adapters, persistent per-project identity.

## License

[MIT](LICENSE) © 2026 Saar Shai. Built with [Claude Code](https://claude.com/claude-code).
