# What the pet can "see" — session signals → graphics

Every signal Claude Code exposes that we could reflect in the creature, captured
empirically on this machine (2026‑05‑30) + confirmed against the official docs
([statusline](https://code.claude.com/docs/en/statusline.md),
[hooks](https://code.claude.com/docs/en/hooks.md)). This is your palette, Saar —
pick what maps to what; I'll wire it.

**Legend:** ✅ wired now · 🟡 captured (in `/health`, not yet drawn) · 💡 idea (available, not captured)

---

## A. Two signal pipes

1. **Statusline** (`POST /status`) — fires **every turn**, even with no tool calls.
   Richest snapshot: context %, cost, rate limits, model, effort, thinking. *(Needs
   a Claude Code restart to start flowing — it's set in `.claude/settings.json`.)*
2. **Hooks** (`POST /event`) — fire on **discrete events** (prompt, tool, subagent,
   compact…). Already loaded; give us the live moments + `transcript_path` (from which
   we compute **real context %** without the statusline).

---

## B. Context window — the signature

| Signal | Source | Real value seen | Status | Current / possible mapping |
|---|---|---|---|---|
| **Context used %** | transcript `usage` (`input+cache_creation+cache_read` ÷ window) **and** statusline `context_window.used_percentage` | **28%** (276,746 / 1,000,000) | ✅ | **body swells + eyes droop** as it fills; the signature |
| Context window size | statusline `context_window_size` / model | 1,000,000 (opus‑4‑8) | ✅ | sets the 0–100% scale (1M vs 200k) |
| Exact token count | `context_window.total_input_tokens` | 276,746 | 🟡 | speech bubble / statusline number |
| **Compaction** | `PreCompact` hook | — | ✅ | **THE signature, shipped & loved:** above 60% the head swells one step per +5% with growing forehead sweat; on `/compact` the head **deflates to normal + steam puffs from the "ears"** + 😮‍💨. Daemon `triggerRelief()` bumps `reliefSeq` (pets play steam) and lerps fullness→30% over 1.8s. No competitor visualizes context at all. |

---

## C. Sub‑agents (parallel work)

| Signal | Source | Status | Mapping |
|---|---|---|---|
| Sub‑agent **spawned** | `PreToolUse` (tool=`Task`) + its `description`/`subagent_type` | ✅ | a labelled **bird** flies in & orbits (max 5) |
| Sub‑agent **finished** | `SubagentStop` (+ `status` success/failed) | ✅ | bird flies off; happy if last; *(could)* puff red on failure |
| Count | derived (no native count field — only start/stop) | ✅ | number of orbiting birds |

---

## D. Sentiment / activity (the face)

| Signal | Source | Status | Mapping |
|---|---|---|---|
| New request | `UserPromptSubmit` (+ `prompt` text) | ✅ | perks up → "listening" |
| Tool running | `PreToolUse` + `tool_name` | ✅ | "working" bob · 💡 *tool‑specific pose: Bash=run, Read=read, Grep=search* |
| Tool **success** | `PostToolUse` | ✅ | content "working" |
| Tool **error** | `PostToolUse` error / `PostToolUseFailure` | ✅ | "oops" + sweat, then **recovers** (no punishment) |
| **Agent's expressed emotion** | latest assistant text in transcript → `lib/sentiment.mjs` | ✅ | **face follows what the agent SAYS** — emoji-first (✅🎉😬💡), keyword-fallback (fixed/wrong/error/investigating). Pure-local, $0. Reads the model's *own* emotion (good news→happy, win→excited, "I was wrong"→bashful, error→oops). Scans last ~4 texts (newest is often neutral narration); negation-guarded ("zero errors"≠oops). Fires on `Stop` + non-error `PostToolUse`. |
| Idle / done | `Stop` | ✅ | settles to idle (or tired if context high) |
| Notifications | `Notification` + `message` | ✅ | 🔔 speech bubble *(filter secrets before showing)* |
| Session end | `SessionEnd` | ✅ | sleeps 💤 |

---

## E. Effort / cost / limits (captured, not yet drawn) 🟡

| Signal | Source | Real value seen | Idea |
|---|---|---|---|
| **Cost so far** | statusline `cost.total_cost_usd` | $1.83 | coins; or a "well‑fed" glow |
| Lines added / removed | `cost.total_lines_added` / `_removed` | +420 / −61 | growth spurt on big diffs |
| **Rate limit used** | `rate_limits.five_hour.used_percentage` | 34% | a stamina ring; yawns near 100% |
| **Effort level** | statusline `effort.level` | high | animation tempo (low=calm, high=zoomy) ← *your "Adaptive" lever* |
| **Thinking on** | statusline `thinking.enabled` | true | a thought bubble / focused brow |
| Model | statusline `model.display_name` | Opus | a tiny hat/badge per model |
| Duration | `cost.total_duration_ms` | — | "tired after a long session" |

---

## F. Identity / context (available, not captured) 💡

| Signal | Source | Idea |
|---|---|---|
| Git repo / branch / worktree | statusline `workspace.repo`, `git_worktree` | pet "remembers" each project (persistent identity) |
| Project dir | `cwd` / `workspace.project_dir` | per‑project pet variants |
| Vim mode, PR number/state, output style, permission mode | statusline `vim`/`pr`/`output_style`, hooks `permission_mode` | niche accessories / states |

---

## G. Guardrails (from the prior‑art research)

- **Recovery, never punishment** — errors → worried‑but‑hopeful, payoff is the recovery.
- **Secrets never shown** — run any `message`/tool text through a code/path/key filter before a speech bubble.
- **Honest mirror** — every expression ties to a *real measured* signal, not faked empathy.

---

### Suggested next mappings (my pick, your call)
1. **Effort → tempo** (cheap, makes "Adaptive" real: calm on low, lively on high).
2. **Rate‑limit ring + cost coins** (turns the pet into genuine ambient instrumentation).
3. **Tool‑specific poses** (Bash/Read/Grep) — makes "what is it doing?" legible at a glance.
