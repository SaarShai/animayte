---
name: animayte-selftest
description: Diagnose whether the animayte desktop pet is actually connected to THIS Claude Code session and reacting. Use when the user asks "is my animayte pet working / connected", "why isn't the pet reacting", "the pet is frozen / dead / not responding", or "animayte diagnose". Runs a live round-trip probe over SSE (the real reaction path doctor can't test) and reports PASS/FAIL with the exact one-line remedy.
effort: low
tools: [Bash]
---

# animayte-selftest

A **live round-trip connection probe** for the animayte pet. It answers the #1 recurring question — *"is the pet actually connected to THIS session and reacting?"* — by sending a real synthetic event through the running daemon and confirming the reaction comes back out the SSE stream the pet renders from.

This is the real-environment check a simulation or a static config audit can't make: `bin/animayte doctor` reads `/health` (config + ownership), but only this tool proves an event makes the full trip **hook → daemon → state → SSE → client**.

## When to use

Trigger on any of:
- "is my animayte pet working / connected?"
- "why isn't the pet reacting / responding?"
- "the pet is frozen / dead / stuck / not updating"
- "animayte diagnose" / "diagnose the pet" / "check the pet"

## How to run

Run the probe as the **current session** (so it can compare the live session id against the pet's owner):

```bash
node "${CLAUDE_PLUGIN_ROOT:-.}/tools/animayte-selftest.mjs"
```

Flags (rarely needed):
- `--port <n>` — daemon port (default `4321`; or set `ANIMAYTE_PORT`).
- `--timeout <ms>` — how long to wait for the reaction (default `4000`).
- `--json` — machine-readable output (findings + remedies) if you want to parse it.

It is **read-only and safe**: it never starts or kills a process and never edits config — it only reads `/health` and posts one harmless synthetic notification (the kind the pet would surface anyway). Exit code `0` = PASS, non-zero = FAIL.

## Interpreting the result

The tool already prints the exact remedy. Relay it plainly. The failure modes it distinguishes:

| What it reports | Meaning | Remedy to relay |
|---|---|---|
| **daemon not reachable** | no daemon on the port | run `/animayte` (or `bin/animayte start`) |
| **owned by a DIFFERENT session** | the silent-death bug — every hook from this session is dropped | run `/animayte` to claim the pet for THIS session |
| **no pet window connected (clients=0)** | daemon works but nothing is rendering | run `/animayte` (native window) or open `http://127.0.0.1:4321` |
| **could not open the SSE stream** | the event stream is broken | `bin/animayte restart` |
| **no reaction came back** | the event was accepted but never round-tripped (or it's blocked by ownership) | claim with `/animayte`, else retry with a longer `--timeout`, then `bin/animayte restart` |
| **PASS** | the pet is connected and reacting to this session | nothing — confirm it's healthy |

If the result is PASS but the user still "sees nothing", the cause is almost always **clients=0** (no window open) — the tool flags this as a note even on PASS. Tell them to run `/animayte` to open the window.

After running, summarize: the one-line verdict (PASS/FAIL), the specific cause if it failed, and the single command that fixes it. Don't dump raw output unless asked.
