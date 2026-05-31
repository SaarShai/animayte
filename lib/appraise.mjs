/*
 * animayte · APPRAISE — the translation layer (Route 1 / "the brain").
 *
 * appraise(signal, prev) turns a normalized session SIGNAL into a FeatureSpec (see
 * lib/vocabulary.mjs). It is the single home for "what should the pet express, given X" —
 * extracted out of the daemon so the daemon (Route 3) is thin transport and the renderer
 * (Route 2) just draws the spec. PURE + deterministic: no daemon state, no I/O.
 *
 * It reuses the existing detectors (detectExpression via detectMood, detectUserTone,
 * emojiReaction) and ENRICHES the picked feeling with the appraisal axes — so an "error"
 * is no longer a flat `sad`: its cause/intensity/expectedness compose a nuanced face.
 *
 *   signal — one of:
 *     { recentTexts: string[] }   assistant text, newest-first → recency-first sentiment
 *     { userText: string }        the user's prompt → how they spoke to the pet (tone)
 *     { isError: true }           a real tool error (PostToolUse) → external bad news
 *   prev — { valence } from the previous appraisal (for expectedness). Optional.
 */

import { detectMood, detectUserTone } from './sentiment.mjs';
import { FAMILY_AXES, emojiItem } from './vocabulary.mjs';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function specFor(base, { cause, emoji, prevValence, reason, text } = {}) {
  const ax = FAMILY_AXES[base] || { valence: 0, arousal: 1 };
  const valence = ax.valence;
  const resolvedCause = cause || ax.cause || (valence < 0 ? 'external' : 'none');
  const expectedness =
    valence !== 0 && typeof prevValence === 'number' && prevValence !== 0 && sign(valence) !== sign(prevValence)
      ? 'surprising'
      : 'routine';
  const item = emoji ? emojiItem(emoji) : null;
  return {
    expression: base,
    valence,
    arousal: ax.arousal,
    cause: resolvedCause,
    expectedness,
    item: item || null,
    reason: reason || base,
    _text: text || null, // for the daemon's de-dupe; not part of the public contract
  };
}

export function appraise(signal = {}, prev = {}) {
  const prevValence = prev && typeof prev.valence === 'number' ? prev.valence : 0;

  // 1) a real tool error — external bad news (not the agent's own fault)
  if (signal.isError) {
    return specFor('sad', { cause: 'external', prevValence, reason: 'toolError' });
  }

  // 2) the USER spoke to the pet — praise → proud, correction → sheepish
  if (signal.userText != null && signal.userText !== '') {
    const tone = detectUserTone(signal.userText);
    if (tone) return specFor(tone.mood, { cause: 'user', prevValence, reason: 'userTone:' + tone.tone });
    // a normal request with no praise/scold → attentive, neutral
    return { expression: 'thinking', valence: 0, arousal: 1, cause: 'none', expectedness: 'routine', item: null, reason: 'userNeutral', _text: null };
  }

  // 3) the agent's own words — RECENCY-FIRST (newest text carrying a feeling wins)
  if (signal.recentTexts != null) {
    const texts = (Array.isArray(signal.recentTexts) ? signal.recentTexts : [signal.recentTexts]).filter(Boolean);
    for (const t of texts) {
      const s = detectMood(t);
      if (s) return specFor(s.mood, { emoji: s.emoji, prevValence, reason: 'text:' + s.mood, text: t });
    }
  }

  return null; // nothing to express
}
