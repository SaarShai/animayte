/*
 * animayte · expression CORPUS — the editable spec for text → expression detection.
 *
 * This file IS the source of truth for "what should the pet feel when the agent says X".
 * To correct the mapping, edit the `expect` values here (or add cases); the simulation
 * test (test/detection-sim.test.mjs) enforces every SETTLED case and replays the SESSIONS,
 * so a wrong mapping fails loudly. DEBATABLE cases are printed (not asserted) for review.
 *
 * Detection lives in lib/expressions.mjs (emoji-first, then keywords, priority-ordered).
 * Priority high→low: embarrassed > oops > sad > excited > happy > thinking > sleepy ≈ neutral.
 */

// ── SETTLED: canonical emoji → expected feeling (unambiguous) ──────────────────
export const EMOJI_CASES = [
  ['🎉', 'excited'], ['🥳', 'excited'], ['🚀', 'excited'], ['🔥', 'excited'], ['✨', 'excited'], ['💯', 'excited'],
  ['😄', 'happy'], ['😊', 'happy'], ['✅', 'happy'], ['👍', 'happy'], ['👏', 'happy'],
  ['🤔', 'thinking'], ['🧐', 'thinking'], ['🔍', 'thinking'], ['👀', 'thinking'], ['💭', 'thinking'],
  ['😅', 'oops'], ['😬', 'oops'], ['🤭', 'oops'],
  ['😳', 'embarrassed'], ['🫣', 'embarrassed'], ['🙈', 'embarrassed'],
  ['😟', 'sad'], ['🙁', 'sad'], ['❌', 'sad'], ['😢', 'sad'], ['🐛', 'sad'],
  ['😴', 'sleepy'], ['💤', 'sleepy'], ['🥱', 'sleepy'],
  ['🙂', 'neutral'], ['😐', 'neutral'], ['😶', 'neutral'],
];

// ── KNOWN GAPS: real misfires the suite surfaced — printed for review, not asserted,
// until we decide the fix together. (Editing these to settled cases = "we fixed it".)
export const KNOWN_GAPS = [
  ['⚠️', 'sad', 'now: happy — emoji with a variation-selector (U+FE0F) drop to the "happy" default; any non-happy VS emoji (⚠️ ✔️ ❤️) misfires. 1-line fix in lib/expressions.mjs.'],
];

// ── SETTLED: keyword phrases (no emoji) → expected feeling ─────────────────────
export const KEYWORD_CASES = [
  ['Fixed it — all tests pass now.', 'happy'],
  ['That works, the build is green.', 'happy'],
  ['Done and verified, looks good.', 'happy'],
  ['This is amazing — we nailed it!', 'excited'],
  ['A huge win, absolutely brilliant.', 'excited'],
  ['Let me investigate the root cause.', 'thinking'],
  ['Hmm, I wonder why that happens.', 'thinking'],
  ['Reading through the main module.', 'thinking'],
  ['Oops, my mistake — let me fix that.', 'oops'],
  ['Sorry, my bad, I misread the signature.', 'oops'],
  ['How embarrassing, a rookie mistake.', 'embarrassed'],
  ['I feel foolish, I should have known.', 'embarrassed'],
  ['The build failed with an exception.', 'sad'],
  ['Unfortunately the request returned an error.', 'sad'],
  ['This is broken and the tests crash.', 'sad'],
  ['Context is almost full, compacting now.', 'sleepy'],
  ['Long session — getting tired.', 'sleepy'],
];

// ── SETTLED: adversarial — the cases that break naive detectors ────────────────
export const ADVERSARIAL = [
  ['runs clean, zero errors', 'happy', 'negation: "zero errors" must not read sad'],
  ['✅ done, and 🎉 a huge win!', 'excited', 'priority: excited beats a co-occurring ✅'],
  ['mostly works but it threw an error', 'sad', 'a negative is never hidden by a positive (order A)'],
  ['threw an error but it mostly works', 'sad', 'order B — same result'],
  ['fixed the test but the build failed', 'sad', 'mixed fix+fail → show the failure'],
  ['✔️ verified', 'happy', 'variation-selector emoji resolves'],
  ['great 👍🏽 work', 'happy', 'skin-tone modifier ignored'],
  ['Now let me restart the daemon', 'thinking', 'intent-to-work narration is a real "thinking" signal'],
];

// ── SETTLED: no emotion present → null (the pet should NOT react) ──────────────
export const NULL_CASES = [
  'the value is then written to the buffer',
  'calling the function with three arguments',
  '',
  '   \n  ',
];

// ── SESSIONS: realistic transcripts (chronological assistant utterances).
// The test replays each through the daemon's salience rule (most-salient over the last
// 4 texts; recency breaks ties) and checks the feeling timeline. `expect` is the feeling
// after each utterance; null means "no emotion → leave as-is". ⟂ = flagged for review.
export const SESSIONS = [
  {
    name: 'happy path (look → read → pass → celebrate)',
    turns: [
      ['Let me take a look at the code.', 'thinking'],
      ['Reading through the main module now.', 'thinking'],
      ['Got it working — all tests pass! ✅', 'happy'],
      ['🎉 That is a great result.', 'excited'],
    ],
  },
  {
    name: 'mistake → recovery (does the fix show, or does oops linger?)',
    turns: [
      ['Let me run the build.', 'thinking'],
      ['The build failed with an error. 😟', 'sad'],
      ['Ah, my mistake — I had a typo.', 'oops'],
      // ⟂ REVIEW: after the fix, does the pet brighten to happy, or does the
      // higher-priority "oops" still dominate the recent-text window?
      ['Fixed it, tests pass now. ✅', 'oops', '⟂ review: should this be happy (recovery) instead?'],
    ],
  },
  {
    name: 'deep work → big win (watch a stale "failing" poison the window)',
    turns: [
      ['Investigating the failing case.', 'sad', '⟂ "failing" reads sad, though this is neutral investigation'],
      ['Let me check the other module.', 'thinking', '⟂ stays sad — the prior "failing" still dominates the 4-text window'],
      ['Found it — this is the fix. 🚀', 'excited', '⟂ even 🚀 is suppressed: sad(5) outranks excited(4) while "failing" lingers in-window'],
    ],
  },
  {
    name: 'winding down',
    turns: [
      ['Wrapping up the last change.', null, '⟂ review: no feeling detected (expected?)'],
      ['Context is getting full.', 'sleepy'],
    ],
  },
];
