/*
 * animayte · VOCABULARY — the contract between the three routes.
 *
 *   Translation (lib/) emits a FeatureSpec  →  Plugin (daemon) transports it  →
 *   Art (grid/) renders it.
 *
 * This file is the single shared agreement: the expression families Translation may
 * pick, the appraisal AXES + their levels, and the ITEM (prop) names Art must be able
 * to draw. Translation must only emit values from here; Art must render every one.
 *
 * THE FEATURE SPEC (what `appraise()` returns and the renderer consumes):
 *   {
 *     expression:   <one of EXPRESSION_IDS>      // the base feeling family (legacy-compatible)
 *     valence:      number  -1..+1               // good ↔ bad
 *     arousal:      0 | 1 | 2                     // calm → active → intense
 *     cause:        'self' | 'external' | 'user' | 'none'
 *     expectedness: 'routine' | 'surprising'
 *     item?:        <one of ITEMS>                // a prop to show alongside (optional)
 *     reason:       string                        // why (for tests/debug)
 *   }
 */

import { EXPRESSIONS } from './expressions.mjs';

// the base feeling families Translation may pick (source of truth = the dictionary)
export const EXPRESSION_IDS = EXPRESSIONS.map((e) => e.id);

// appraisal axes ---------------------------------------------------------------
export const AROUSAL = { calm: 0, active: 1, intense: 2 };
export const CAUSE = ['self', 'external', 'user', 'none'];
export const EXPECTEDNESS = ['routine', 'surprising'];

// per-family default axes — Translation starts here, then the signal refines cause/etc.
export const FAMILY_AXES = {
  excited:     { valence: 1.0,  arousal: 2 },
  happy:       { valence: 0.6,  arousal: 1 },
  thinking:    { valence: 0.0,  arousal: 1 },
  neutral:     { valence: 0.0,  arousal: 0 },
  sleepy:      { valence: 0.0,  arousal: 0 },
  oops:        { valence: -0.5, arousal: 1, cause: 'self' },
  embarrassed: { valence: -1.0, arousal: 2, cause: 'self' },
  sad:         { valence: -0.8, arousal: 1, cause: 'external' },
};

// ITEMS (props) Art must be able to draw, and Translation may request -----------
// (Art owns the sprites in grid/props.mjs; this is the agreed name list.)
export const ITEMS = ['lightbulb', 'hammer', 'magnifier', 'book', 'terminal', 'box', 'globe', 'question'];

// the agent's own activity-emoji → the ITEM to show (abstract prop name, not a grid
// reaction). 🔧 puts the hammer in hand, 🔬 the magnifier, 🌐 the globe, 💡 the lightbulb.
export const EMOJI_ITEM = {
  '🔧': 'hammer', '🛠️': 'hammer', '🔨': 'hammer', '⚙️': 'terminal',
  '🔬': 'magnifier', '🔍': 'magnifier', '🔎': 'magnifier',
  '🌐': 'globe', '💡': 'lightbulb',
};
const stripVS = (e) => (e || '').replace(/[︀-️‍]/g, '');
export const emojiItem = (e) => EMOJI_ITEM[e] || EMOJI_ITEM[stripVS(e)] || null;

export const isExpression = (id) => EXPRESSION_IDS.includes(id);
export const isItem = (name) => ITEMS.includes(name);
