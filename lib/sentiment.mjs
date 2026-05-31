/*
 * animayte sentiment — thin wrapper over the EXPRESSION DICTIONARY (expressions.mjs).
 * The daemon imports detectMood from here; all the real mapping lives in the dictionary.
 *
 * detectMood(text) -> { mood, emoji, priority, reason } | null   (mood === expression id)
 */
import { detectExpression, detectUserTone } from './expressions.mjs';

export function detectMood(text) {
  const r = detectExpression(text);
  if (!r) return null;
  return { mood: r.id, emoji: r.emoji, priority: r.priority, reason: r.reason };
}

// how the USER is speaking to the pet (praise → proud, correction → apologetic)
export { detectUserTone };
