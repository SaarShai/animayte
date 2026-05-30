/*
 * animayte sentiment — thin wrapper over the EXPRESSION DICTIONARY (expressions.mjs).
 * Kept as a stable import for the daemon. All the real mapping lives in the dictionary.
 *
 * detectMood(text) -> { mood, emoji, reason } | null   (mood === expression id)
 */
import { detectExpression, appleFor, EXPRESSIONS } from './expressions.mjs';

export function detectMood(text) {
  const r = detectExpression(text);
  if (!r) return null;
  return { mood: r.id, emoji: r.emoji, priority: r.priority, reason: r.reason };
}

// default Apple-emoji face for an expression id (for events that carry no text)
export const MOOD_EMOJI = Object.fromEntries(EXPRESSIONS.map((e) => [e.id, e.apple]));

// legacy mood-name → expression id (so older renderers/aliases keep working)
export const MOOD_ALIAS = {
  idle: 'neutral', listening: 'thinking', working: 'thinking',
  bashful: 'oops', tired: 'sleepy', sleep: 'sleepy',
};
export const toExpression = (m) => (byIdSafe(m) ? m : (MOOD_ALIAS[m] || 'neutral'));
function byIdSafe(m) { return EXPRESSIONS.some((e) => e.id === m); }
export { appleFor };
