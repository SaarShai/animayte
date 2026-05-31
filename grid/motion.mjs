/*
 * animayte · grid motion — clip name → a procedural transform, per frame.
 *
 * The state machine says WHICH clip is playing (idle / sway / hop / react / …) and how
 * far through it we are (t in 0..1, plus the wall clock). This module turns that into a
 * { sx, sy, offX, offY, rot, blink } pose. All "aliveness" is computed here — there are
 * no baked frames. A subtle breathing baseline underlies every clip so Dijon is never
 * dead-still.
 */

const TAU = Math.PI * 2;
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const bump = (t) => Math.sin(Math.max(0, Math.min(1, t)) * Math.PI); // 0→1→0

/** the resting breath: a slow volume-preserving squash + gentle bob + clock-driven blink. */
function breathe(now, amp = 0.045) {
  const ph = (now % 2600) / 2600;
  const b = Math.sin(ph * TAU);
  const sy = 1 - amp * b;
  const sx = 1 + (1 - sy) * 0.6;
  const offY = -0.18 * (0.5 + 0.5 * Math.sin(ph * TAU + Math.PI / 3));
  const blink = (now % 3400) < 120;
  return { sx, sy, offX: 0, offY, rot: 0, blink };
}

/**
 * motionFor(clip, t, now) → transform. `t` is clip progress 0..1; `now` is ms.
 * Secondary fidgets and reactions layer their flourish ON TOP of the breath so motion
 * is continuous, never a hard cut.
 */
export function motionFor(clip, t, now) {
  const base = breathe(now);
  switch (clip) {
    case 'sleep': return breathe(now, 0.085); // slower, deeper — blink stays (eyes are drawn shut by expression)
    case 'bored': { const sag = 0.04 * (0.5 + 0.5 * Math.sin((now % 3200) / 3200 * TAU)); return { ...breathe(now, 0.03), sy: 1 - 0.05 - sag, offY: 0.3 }; }
    case 'sway': { const e = Math.sin(t * TAU); return { ...base, rot: 0.10 * e, blink: false }; }
    case 'hop': { const e = bump(t); return { ...base, offY: base.offY - 1.6 * e, sy: base.sy + 0.06 * e, sx: base.sx - 0.04 * e, blink: false }; }
    case 'glance': { const e = Math.sin(t * TAU); return { ...base, offX: 0.9 * e, rot: 0.03 * e, blink: false }; }
    case 'react': { // a snappy squash→stretch pop, then settle
      const p = bump(Math.min(1, t * 1.25));
      const k = easeOutBack(Math.min(1, t)) * 0; // (reserved) — pop drives it
      return { sx: 1 - 0.10 * p + k, sy: 1 + 0.16 * p, offX: 0, offY: -0.5 * p, rot: 0, blink: false };
    }
    case 'idle':
    default:
      return base;
  }
}
