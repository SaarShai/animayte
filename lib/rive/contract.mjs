/*
 * animayte · rive/contract — the interface between OUR daemon and a Rive `.riv`.
 *
 * Adopting Rive (see docs/engine-research.md) splits cleanly: the daemon keeps ALL the
 * intelligence it already has (real context %, sentiment→mood, tool classification,
 * sub-agent birds, mood drift) and the `.riv` (authored in the Rive editor) is the
 * renderer + visual state machine. This module is the seam: the set of State-Machine
 * INPUTS an `animayte.riv` must expose, plus the PURE mapping from our SSE commands →
 * Rive input operations. Pure + dependency-free → fully unit-testable in Node (the
 * browser driver in driver.mjs just applies these ops to live Rive inputs).
 *
 * Why State-Machine inputs (not only Data Binding): inputs (number/boolean/trigger) are
 * supported by every Rive runtime version and are the most portable contract. Data
 * Binding / View Models (newer) can additionally drive color/scale directly — documented
 * as an enhancement in docs/rive-contract.md — but the inputs below are the floor.
 */

export const ARTBOARD = 'Pet';            // default artboard the runtime instances
export const STATE_MACHINE = 'animayte';   // default state machine the runtime plays

// the 8 expressions (index = the `mood` number input value) — mirrors lib/expressions.mjs order
export const MOODS = ['neutral', 'thinking', 'happy', 'excited', 'oops', 'embarrassed', 'sad', 'sleepy'];
export const MOOD_INDEX = Object.fromEntries(MOODS.map((m, i) => [m, i]));

// daemon mood aliases → canonical expression (mirror of MOOD_EXPRESSION in the Canvas2D runtime)
export const MOOD_ALIAS = { idle: 'neutral', working: 'thinking', listening: 'thinking', bashful: 'oops', tired: 'sleepy' };
export const moodToIndex = (mood) => { const m = MOOD_ALIAS[mood] || mood; return MOOD_INDEX[m] != null ? MOOD_INDEX[m] : 0; };

// tool categories (index = the `tool` number input value); 0 = none. Mirrors lib/anim/events.mjs.
export const TOOLS = ['none', 'read', 'search', 'edit', 'run', 'test', 'install', 'git', 'fetch', 'plan'];
export const TOOL_INDEX = Object.fromEntries(TOOLS.map((t, i) => [t, i]));
// manifest reaction name → tool category
export const REACTION_TOOL = { Reading: 'read', Searching: 'search', Writing: 'edit', Running: 'run', Testing: 'test', Installing: 'install', Committing: 'git', Fetching: 'fetch', Planning: 'plan', Asking: 'none', Waiting: 'none', Idea: 'none' };
export const reactionToToolIndex = (name) => TOOL_INDEX[REACTION_TOOL[name] || 'none'] || 0;

// The inputs an animayte.riv MUST expose on its state machine. The driver grabs these by
// name (missing ones are skipped, so partial/sample .riv files still load); the human
// doc (docs/rive-contract.md) is generated from this list.
export const INPUTS = [
  { name: 'mood', kind: 'number', default: 0, doc: 'expression index 0..7 (see MOODS) — the sticky feeling' },
  { name: 'fullness', kind: 'number', default: 0, doc: 'context window 0..100 → body swell + cool "tired" tint' },
  { name: 'tool', kind: 'number', default: 0, doc: 'active tool category 0..9 (see TOOLS); 0 = none → tool gag pose' },
  { name: 'birds', kind: 'number', default: 0, doc: 'orbiting sub-agents 0..5' },
  { name: 'moodLevel', kind: 'number', default: 0, doc: 'slow mood drift -100..100 (stressed..up)' },
  { name: 'sleeping', kind: 'boolean', default: false, doc: 'session ended → curl down, Z\'s' },
  { name: 'reduceMotion', kind: 'boolean', default: false, doc: 'prefers-reduced-motion → dampen movement' },
  { name: 'react', kind: 'trigger', doc: 'generic emphasis bounce (happy / oops)' },
  { name: 'win', kind: 'trigger', doc: 'big celebration (excited) — confetti, star eyes' },
  { name: 'error', kind: 'trigger', doc: 'flinch then recover (sad / tool error)' },
  { name: 'compact', kind: 'trigger', doc: '/compact relief: big inhale → exhale, steam from ears' },
  { name: 'wake', kind: 'trigger', doc: 'wake from sleep — stretch, blink awake' },
];
export const INPUT_NAMES = INPUTS.map((i) => i.name);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** nextBirds(prev, cmd) — pure bird-counter for add/remove/clear (driver tracks the count). */
export function nextBirds(prev, cmdName) {
  const n = prev || 0;
  if (cmdName === 'addBird') return Math.min(5, n + 1);
  if (cmdName === 'removeBird') return Math.max(0, n - 1);
  if (cmdName === 'clearBirds' || cmdName === 'reset') return 0;
  return n;
}

/**
 * commandToOps(cmd, ctx) — PURE map from a daemon SSE/dispatch command → Rive input ops.
 * Returns [{ name, kind:'number'|'boolean', value }] to set, or { name, kind:'trigger' } to fire.
 * `ctx.birds` = the already-updated bird count (the driver owns the counter via nextBirds).
 * Commands with no visual-input effect (say/addBird-label/etc.) return [].
 */
export function commandToOps(cmd, ctx = {}) {
  if (!cmd || !cmd.cmd) return [];
  switch (cmd.cmd) {
    case 'mood': {
      const ops = [{ name: 'mood', kind: 'number', value: moodToIndex(cmd.value) }];
      const m = MOOD_ALIAS[cmd.value] || cmd.value;
      if (m === 'excited') ops.push({ name: 'win', kind: 'trigger' });
      else if (m === 'happy' || m === 'oops') ops.push({ name: 'react', kind: 'trigger' });
      else if (m === 'sad') ops.push({ name: 'error', kind: 'trigger' });
      return ops;
    }
    case 'fullness': return [{ name: 'fullness', kind: 'number', value: Math.round(clamp01(cmd.value) * 100) }];
    case 'react': return [{ name: 'tool', kind: 'number', value: reactionToToolIndex(cmd.name) }];
    case 'endReact': return [{ name: 'tool', kind: 'number', value: 0 }];
    case 'relief': return [{ name: 'compact', kind: 'trigger' }];
    case 'sleep': return [{ name: 'sleeping', kind: 'boolean', value: true }];
    case 'wake': case 'hatch': return [{ name: 'sleeping', kind: 'boolean', value: false }, { name: 'wake', kind: 'trigger' }];
    case 'moodLevel': return [{ name: 'moodLevel', kind: 'number', value: Math.round(clamp(cmd.value, -1, 1) * 100) }];
    case 'addBird': case 'removeBird': case 'clearBirds':
      return [{ name: 'birds', kind: 'number', value: clamp(ctx.birds || 0, 0, 5) }];
    case 'reset':
      return [
        { name: 'mood', kind: 'number', value: 0 }, { name: 'fullness', kind: 'number', value: 0 },
        { name: 'tool', kind: 'number', value: 0 }, { name: 'birds', kind: 'number', value: 0 },
        { name: 'moodLevel', kind: 'number', value: 0 }, { name: 'sleeping', kind: 'boolean', value: false },
      ];
    default: return [];
  }
}
