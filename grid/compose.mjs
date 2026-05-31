/*
 * animayte · COMPOSE — the appraisal compositor (Route 2 / "the body").
 *
 * composeExpression(spec) is THE axes→pixels mapping: it turns a FeatureSpec
 * (lib/vocabulary.mjs) into renderable outputs —
 *   { face: {eyes,brows,mouth,blush?,flush?,sweat?}, fx: {flash?,burst?,shake?}, item }
 * — a face-feature object (the same shape grid/face.mjs consumes), a set of intensity
 * FX flags, and an optional prop.
 *
 * The whole point: the SAME base feeling fans out across the axes into DISTINCT faces,
 * so one flat 😟 no longer stands in for every setback. Which axis drives which channel:
 *
 *   valence  → which side of the ladder (positive families vs negative families)
 *   arousal  → the RUNG on a ladder (content→pleased→thrilled; calm→active→intense FX)
 *   cause    → WHO owns it: external → concerned (+red wince); self → resolve/sheepish
 *              (sweat, never the red flash — it's not the world's fault); user → bashful
 *   expect.  → a transient wide-eyed startle on a surprising onset
 *
 * The four authored families (Saar-approved in grid/facelab.html, reading at ~30px):
 *   content / pleased / thrilled   — the positive intensity ladder
 *   determined                     — resolve ("an error isn't sad; I'm on it"), NOT menace
 *   concerned / sheepish           — the external-vs-self split
 *
 * Art owns + refines this mapping. The FeatureSpec + vocabulary are a read-only contract.
 */

import { byId } from '../lib/expressions.mjs';

// ── the authored family faces (feature keys live in grid/face.mjs) ────────────────
const FAMILY = {
  // positive intensity ladder (rising arousal)
  content:    { eyes: 'closed',    mouth: 'slight_smile', blush: true },
  pleased:    { eyes: 'happy_arc', mouth: 'open_smile',   blush: true },
  thrilled:   { eyes: 'stars',     mouth: 'big_grin',     blush: true },
  // resolve — low LEVEL brow + spark eyes + firm 'stache (zero anger angle)
  determined: { eyes: 'lock',      brows: 'firm',         mouth: 'set' },
  // the external-vs-self split
  concerned:  { eyes: 'open',      brows: 'worried',      mouth: 'frown' }, // looks OUT at the problem
  sheepish:   { eyes: 'look_up',   brows: 'worried',      mouth: 'small', blush: true }, // glances away, own slip
};

const POSITIVE = new Set(['happy', 'excited']);
const NEGATIVE = new Set(['sad', 'oops', 'embarrassed']);

/**
 * familyOf(spec) → one of the authored family names, or null to keep the base
 * dictionary face (neutral / thinking / sleepy carry no axis fan-out).
 */
export function familyOf({ expression, valence = 0, arousal = 0, cause = 'none' } = {}) {
  const positive = valence > 0 || POSITIVE.has(expression);
  const negative = valence < 0 || NEGATIVE.has(expression);

  if (positive && !negative) {
    if (arousal >= 2 || expression === 'excited') return 'thrilled';
    if (arousal >= 1) return 'pleased';
    return 'content';
  }
  if (negative) {
    // self/user-owned: it's about ME. A real setback I caused → resolve; a lighter
    // slip or a user scold → sheepish. External → concerned (the world's problem).
    if (cause === 'self' || cause === 'user') {
      return expression === 'sad' ? 'determined' : 'sheepish';
    }
    return 'concerned';
  }
  return null; // neutral / thinking / sleepy → base face unchanged
}

export function composeExpression(spec = {}) {
  const { valence = 0, arousal = 0, cause = 'none', expectedness = 'routine' } = spec;
  const base = (spec.expression && byId(spec.expression) && byId(spec.expression).face) || {};

  const fam = familyOf(spec);
  const face = fam ? { ...FAMILY[fam] } : { ...base };
  const fx = {};

  // CAUSE → self-conscious accents + whether the red error-flash is earned.
  if (cause === 'self') {
    face.sweat = true;                 // a nervous/effort bead for one's own slip
    if (arousal >= 2) face.flush = true;
  } else if (cause === 'user' && valence > 0) {
    face.blush = true;                 // bashful pride when the user praises
  }
  // the red wince fires ONLY for a real EXTERNAL setback — never for self/user-caused.
  if (valence < 0 && cause === 'external') fx.flash = true;

  // AROUSAL → intensity of the reaction.
  if (valence > 0 && arousal >= 2) fx.burst = true;                  // confetti on a big win
  if (valence < 0 && arousal >= 1) fx.shake = Math.min(1, 0.4 + 0.25 * arousal);

  // EXPECTEDNESS → a transient wide-eyed startle on a surprising onset (stomps eyes last).
  if (expectedness === 'surprising') face.eyes = 'wide';

  return { face, fx, item: spec.item || null };
}
