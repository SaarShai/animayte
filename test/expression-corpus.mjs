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
  ['😟', 'sad'], ['🙁', 'sad'], ['❌', 'sad'], ['😢', 'sad'], ['🐛', 'sad'], ['⚠️', 'sad'],
  ['😴', 'sleepy'], ['💤', 'sleepy'], ['🥱', 'sleepy'],
  ['🙂', 'neutral'], ['😐', 'neutral'], ['😶', 'neutral'],
  // formerly fell through to the "happy default" — now classified faithfully:
  ['🔧', 'thinking'], ['🛠️', 'thinking'], ['⚙️', 'thinking'], ['🔬', 'thinking'], ['💡', 'thinking'], ['🌐', 'thinking'],
  ['🐞', 'sad'], ['🆘', 'sad'], ['‼️', 'sad'], ['❗', 'sad'], ['😤', 'sad'], ['🤬', 'sad'], ['😡', 'sad'], ['🚨', 'sad'],
  ['🎯', 'excited'], ['💪', 'excited'],
  ['🤷', 'neutral'],
  ['🫡', 'happy'], ['🙏', 'happy'], ['🤝', 'happy'],
];

// ── KNOWN GAPS: real misfires the suite surfaced — printed for review, not asserted,
// until we decide the fix together. (Editing these to settled cases = "we fixed it".)
// FIXED 2026-05-31: the VS-emoji misfire (⚠️ ✔️ ❤️ → happy default) is resolved — the
// matcher now compares VS/ZWJ-stripped on both sides; ⚠️ → sad is a settled emoji case.
export const KNOWN_GAPS = [];

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

// ── SETTLED: USER tone → how the pet reacts to being SPOKEN TO (detectUserTone).
// [text, tone|null, mood|null]. The null cases are false-positive guards: a task that
// merely MENTIONS a problem ("fix the failing test") must stay neutral, not apologetic.
export const USER_TONE_CASES = [
  ['thanks, that works great', 'praise', 'happy'],
  ['nice job!', 'praise', 'happy'],
  ['this is amazing, you nailed it', 'praise', 'excited'],
  ['brilliant 🎉', 'praise', 'excited'],
  ["no, that's wrong", 'scold', 'oops'],
  ['you broke the tests', 'scold', 'oops'],
  ['ugh, still not working', 'scold', 'oops'],
  ['this is completely wrong', 'scold', 'embarrassed'],
  // false-positive guards — normal tasks that name a problem must NOT scold the pet:
  ['fix the failing test', null, null],
  ['the build is broken, can you look', null, null],
  ['add a feature to the parser', null, null],
  ['why is this slow', null, null],
];

// ── SESSIONS: realistic transcripts (chronological assistant utterances).
// The test replays each through the daemon's salience rule (RECENCY-FIRST: the newest
// text carrying a feeling wins; priority arbitrates only within one text) and checks the
// feeling timeline. `expect` is the feeling after each utterance; null means "no emotion →
// leave as-is". ⟂ = flagged for review (none currently — the agenda is cleared).
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
      // RECENCY-FIRST: the recovery line carries its own happy (✅ + "tests pass"), and it's
      // the newest, so the pet brightens immediately instead of the stale "oops" lingering.
      ['Fixed it, tests pass now. ✅', 'happy'],
    ],
  },
  {
    name: 'deep work → big win (recency-first lets the win land)',
    turns: [
      // "the failing case" is a real negative (it IS broken), so sad is correct — not neutral.
      ['Investigating the failing case.', 'sad'],
      // recency-first: this newest line is its own "thinking", so the prior "failing" no longer lingers.
      ['Let me check the other module.', 'thinking'],
      // and the 🚀 win now shows immediately instead of being suppressed by a stale sad.
      ['Found it — this is the fix. 🚀', 'excited'],
    ],
  },
  {
    name: 'winding down',
    turns: [
      // calm narration with no feeling word → stay as-is; the explicit "context full" line below carries it.
      ['Wrapping up the last change.', null],
      ['Context is getting full.', 'sleepy'],
    ],
  },
];
