/*
 * animayte · grid manifest — Dijon's behaviour spec for the (reused) state machine.
 *
 * lib/anim/state-machine.mjs is the tested behaviour brain; it wants a manifest with
 * `clips` (named motions with durations + loop), `reactions` (event → clip/expression/
 * prop/priority), an `idle` block, and `palettes`. Our clips carry NO sprite frames —
 * a clip is just a name + duration; grid/motion.mjs turns the name into PROCEDURAL
 * squash/stretch. So `frames:[{dur}]` here exists only to give the machine timing.
 *
 * MOOD_EXPRESSION mirrors lib/anim/runtime.mjs exactly, so the daemon's sticky "moods"
 * land on the same faces the legacy renderer used.
 */

const clip = (dur, loop = false) => ({ loop, frames: [{ dur }] });

export const MANIFEST = {
  format: 'animayte-grid/1',
  name: 'dijon',
  defaultPalette: 'calm',
  palettes: {
    calm: { B: '#E6A817' },
    tired: { B: '#C9A24B' },  // cooler, drained mustard (context full)
    error: { B: '#D8643C' },  // a warm red flash (failure)
  },
  clips: {
    idle: clip(2600, true),   // breathe
    sway: clip(1100),         // lean side to side (secondary fidget)
    hop: clip(650),           // a little bounce
    glance: clip(1000),       // shift + look around
    bored: clip(3200, true),  // slow sag/sigh
    react: clip(620),         // squash-stretch pop on a mood change
    sleep: clip(2400, true),  // slow deep breathing
  },
  idle: {
    base: 'idle',
    secondary: ['sway', 'hop', 'glance'],
    boredClip: 'bored',
    boredAfterMs: 30000,
  },
  // tool poses (event names match lib/anim/events.mjs classifyTool) — each read as
  // "thinking" but carrying a DISTINCT prop so "what's it doing?" is legible at a glance.
  reactions: {
    Reading:    { clip: 'react', expression: 'thinking', prop: 'book', priority: 2 },
    Searching:  { clip: 'react', expression: 'thinking', prop: 'magnifier', priority: 2 },
    Writing:    { clip: 'react', expression: 'thinking', prop: 'hammer', priority: 2 },
    Running:    { clip: 'react', expression: 'thinking', prop: 'terminal', priority: 2 },
    Testing:    { clip: 'react', expression: 'thinking', prop: 'terminal', priority: 2 },
    Installing: { clip: 'react', expression: 'thinking', prop: 'box', priority: 2 },
    Committing: { clip: 'react', expression: 'happy', priority: 2 },
    Fetching:   { clip: 'react', expression: 'thinking', prop: 'globe', priority: 2 },
    Planning:   { clip: 'react', expression: 'thinking', prop: 'lightbulb', priority: 2 },
    // session-signal poses (NOT tool gags): looking around for the user, and asking to proceed.
    // They reuse existing faces + the 'glance' look-around so no 9th feeling is introduced.
    Waiting:    { clip: 'glance', expression: 'neutral', priority: 1 },
    Asking:     { clip: 'glance', expression: 'thinking', prop: 'question', priority: 3 },
  },
};

// daemon "mood" (sticky activity) → one of the 8 expression ids. Mirrors runtime.mjs.
export const MOOD_EXPRESSION = {
  neutral: 'neutral', idle: 'neutral',
  thinking: 'thinking', working: 'thinking', listening: 'thinking',
  happy: 'happy', excited: 'excited',
  oops: 'oops', bashful: 'oops', embarrassed: 'embarrassed',
  sad: 'sad', sleepy: 'sleepy', tired: 'sleepy',
};
