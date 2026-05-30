/*
 * animayte · personality — a tiny DATA layer that re-weights idle/reaction selection
 * (C3). A personality is a small object (personalities/<name>.json); it never adds
 * new content, only biases which existing behaviours fire and how big. The state
 * machine reads it; the runtime scales reaction intensity by it.
 *
 *   resolvePersonality(obj|name) → a complete personality (defaults filled)
 *   loadPersonality(name)        → read personalities/<name>.json (Node only)
 *
 * Default = "Adaptive" (calm working / lively at milestones). Browsers fetch the JSON
 * over http and pass the object to createStateMachine({ personality }).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const DEFAULT_PERSONALITY = {
  name: 'adaptive',
  label: 'Adaptive',
  blurb: 'Calm while working, lively at milestones. The balanced default.',
  secondaryEveryMsScale: 1.0,
  boredAfterMsScale: 1.0,
  secondaryWeights: {},        // missing clip → weight 1
  reactionIntensity: 1.0,
};

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

/** Fill any missing fields from the default; coerce bad values to safe defaults. */
export function resolvePersonality(p) {
  if (!p || typeof p !== 'object') return { ...DEFAULT_PERSONALITY };
  return {
    ...DEFAULT_PERSONALITY,
    ...p,
    secondaryEveryMsScale: num(p.secondaryEveryMsScale, 1.0),
    boredAfterMsScale: num(p.boredAfterMsScale, 1.0),
    reactionIntensity: num(p.reactionIntensity, 1.0),
    secondaryWeights: (p.secondaryWeights && typeof p.secondaryWeights === 'object') ? p.secondaryWeights : {},
  };
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'personalities');

/** Read a personality JSON by name (Node). Unknown/missing → the Adaptive default. */
export function loadPersonality(name = 'adaptive') {
  const fp = join(DIR, `${String(name).replace(/[^a-z0-9_-]/gi, '')}.json`);
  if (!existsSync(fp)) return { ...DEFAULT_PERSONALITY };
  try { return resolvePersonality(JSON.parse(readFileSync(fp, 'utf8'))); } catch { return { ...DEFAULT_PERSONALITY }; }
}

/** weight for a clip under a personality (default 1; clamped ≥0). */
export const weightFor = (personality, clip) => {
  const w = personality && personality.secondaryWeights ? personality.secondaryWeights[clip] : undefined;
  return typeof w === 'number' && w >= 0 ? w : 1;
};
