/*
 * animayte · COMPOSE — the appraisal compositor (Route 2 / "the body").
 *
 * composeExpression(spec) turns a FeatureSpec (lib/vocabulary.mjs) into renderable
 * outputs: a face-feature object (eyes/brows/mouth/accents — same shape grid/face.mjs
 * consumes), a set of intensity FX flags, and an optional item/prop.
 *
 * This is where the AXES drive distinct visual channels, so the SAME base feeling fans
 * out: an "error" with cause=external lands the red wince + a frown; the same valence
 * with cause=self instead sweats and looks away (no red flash — it's not the world's
 * fault). Art owns + refines this mapping; v1 modulates the existing dictionary face.
 *
 *   → { face: {eyes,brows,mouth,blush?,flush?,sweat?,...}, fx: {flash?,burst?,shake?}, item }
 */

import { byId } from '../lib/expressions.mjs';

export function composeExpression(spec = {}) {
  const base = (spec.expression && byId(spec.expression) && byId(spec.expression).face) || {};
  const face = { ...base };
  const fx = {};
  const { valence = 0, arousal = 0, cause = 'none', expectedness = 'routine' } = spec;

  // CAUSE → self-conscious accents + whether the red error-flash is earned
  if (cause === 'self') {
    face.sweat = true;            // a nervous bead for one's own slip
    if (arousal >= 2) face.flush = true;
  } else if (cause === 'user' && valence > 0) {
    face.blush = true;            // bashful pride when the user praises
  }
  // the red wince fires ONLY for a real external setback — not for self/user-caused
  if (valence < 0 && cause === 'external') fx.flash = true;

  // AROUSAL → intensity of the reaction
  if (valence > 0 && arousal >= 2) fx.burst = true;                 // confetti on a big win
  if (valence < 0 && arousal >= 1) fx.shake = Math.min(1, 0.4 + 0.25 * arousal);

  // EXPECTEDNESS → a transient startle on the onset
  if (expectedness === 'surprising') face.eyes = 'wide';

  return { face, fx, item: spec.item || null };
}
