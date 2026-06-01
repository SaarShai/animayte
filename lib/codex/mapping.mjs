/*
 * animayte · codex/mapping — animayte's live session signals → Codex's 9 motion states.
 *
 * This is the "drive a Codex pet with our session" layer. animayte speaks in moods
 * (the daemon's sticky activity) and tool reaction events (Reading/Writing/…); a Codex
 * pet speaks in 9 fixed motion rows. We translate, honouring each Codex state's own
 * documented semantics (openai/skills hatch-pet SKILL.md):
 *
 *   running  — "active processing/thinking/focused effort, not literal foot-running"
 *   review   — "focused lean/blink/head tilt" (reading / reviewing)
 *   waiting  — "expectant pose showing need for approval or user input"
 *   waving   — greeting gesture        jumping — vertical celebration
 *   failed   — error state             idle    — calm micro-variation (also our rest/sleep)
 *   running-right / running-left       — directional drag movement (not session-driven; reserved)
 *
 * Pure + isomorphic (no node:) so the player and the tests share one mapping.
 */
import { isLoopState } from './format.mjs';

/**
 * MOOD_TO_STATE — the daemon's mood vocabulary (lib/anim/runtime.mjs MOOD_EXPRESSION
 * + animayte.mjs) mapped onto Codex states. Looping targets (idle/running/review)
 * become the pet's STICKY base while that mood holds; one-shot targets (waving/jumping/
 * failed) fire as a brief gesture and settle back. Codex has no sleep row → rest = idle.
 */
export const MOOD_TO_STATE = Object.freeze({
  neutral: 'idle', idle: 'idle',
  thinking: 'running', working: 'running',
  listening: 'review',
  happy: 'waving', excited: 'jumping',
  oops: 'failed', bashful: 'failed', embarrassed: 'failed', sad: 'failed',
  sleepy: 'idle', tired: 'idle',
});

/** stateForMood(mood) → a Codex state name (defaults to idle for anything unknown). */
export const stateForMood = (mood) => MOOD_TO_STATE[mood] || 'idle';

/** moodIsSticky(mood) → true when the mood maps to a continuous (looping) Codex state. */
export const moodIsSticky = (mood) => isLoopState(stateForMood(mood));

/**
 * EVENT_TO_STATE — tool reaction events (lib/anim/events.mjs classifyTool, plus the
 * pack-level Asking/Waiting/Idea) mapped onto Codex states. Reading-ish work → review
 * (the focused lean); active work → running (processing); a commit / idea → a jump;
 * an explicit ask → the expectant waiting pose (an exact semantic match).
 */
export const EVENT_TO_STATE = Object.freeze({
  Reading: 'review', Searching: 'review', Fetching: 'review', Planning: 'review',
  Writing: 'running', Running: 'running', Testing: 'running', Installing: 'running',
  Committing: 'jumping',
  Asking: 'waiting', Waiting: 'waiting',
  Idea: 'jumping',
});

// reaction priority mirrors the slime pack so interrupt arbitration feels identical:
// routine work (2) < a commit / an ask (3) < a spark of insight (4); a passive wait (1).
const EVENT_PRIORITY = Object.freeze({
  Reading: 2, Searching: 2, Fetching: 2, Planning: 2,
  Writing: 2, Running: 2, Testing: 2, Installing: 2,
  Committing: 3, Asking: 3, Idea: 4, Waiting: 1,
});

/**
 * buildCodexReactions() → { [event]: { clip, priority, return } }
 *
 * A reactions map shaped exactly like an animayte-pet `reactions` block, so the SHARED
 * state machine arbitrates Codex tool reactions the same way it does the slime's. `clip`
 * is the target Codex state; `return: 'idle'` sends the pet back to its CURRENT idle base
 * (which sticky moods may have set to running/review) once the transient reaction ends.
 */
export function buildCodexReactions() {
  const reactions = {};
  for (const [event, clip] of Object.entries(EVENT_TO_STATE)) {
    reactions[event] = { clip, priority: EVENT_PRIORITY[event] ?? 2, return: 'idle' };
  }
  return reactions;
}
