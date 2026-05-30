/*
 * animayte · mood — one slow-moving global "mood" derived from recent emotional events
 * (C4). It's NOT the per-message expression (that's the face right now) and NOT the
 * personality (that's a fixed bias) — it's the drift of the last little while:
 *   a run of errors → "stressed";  a streak of wins → "up".
 * The daemon feeds it; the renderer nudges reaction intensity + a cool palette floor by
 * it, so the whole session feels coherent without any new content. Pure + testable.
 *
 *   const meter = createMoodMeter();
 *   meter.feel('sad'); meter.feel('sad'); meter.label // → 'stressed'
 *   meter.decayStep();  // pulls back toward neutral over time
 */

// per-expression nudge to the mood level (−1 stressed … +1 up)
const DELTAS = { excited: 0.34, happy: 0.16, neutral: 0, thinking: 0, sleepy: -0.04, oops: -0.18, sad: -0.30, embarrassed: -0.20 };
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

export function createMoodMeter({ decay = 0.9, upAt = 0.25, downAt = -0.25 } = {}) {
  let level = 0;
  const labelOf = (v) => (v > upAt ? 'up' : v < downAt ? 'stressed' : 'level');
  return {
    /** register an emotional beat (an expression id); returns the new level. */
    feel(moodId) { level = clamp1(level + (DELTAS[moodId] || 0)); return level; },
    /** time passing with no strong feeling pulls the mood back toward neutral. */
    decayStep() { level = clamp1(level * decay); return level; },
    get level() { return level; },
    get label() { return labelOf(level); },
    reset() { level = 0; },
  };
}

export { DELTAS as MOOD_DELTAS };
