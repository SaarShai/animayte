/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  animayte EXPRESSION DICTIONARY — the single source of truth for feelings  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * CONCEPT:  an emoji IS a feeling. The agent already speaks in emoji, so we:
 *    1. find the feeling the agent expressed  (its emoji → or keywords → emoji)
 *    2. map that feeling to one of the character's EXPRESSIONS
 *    3. draw that expression on the slime, modeled on the matching APPLE emoji
 *
 * FOUNDATION:  the `emojis` + `keywords` below are grounded in the vocabulary that
 * standard emoji dictionaries (Unicode CLDR annotations / emojilib) attach to each
 * face in the "Smileys & Emotion" group — e.g. 😳 flushed → "embarrassed, dazed,
 * flushed, shy". We curate that vocabulary (drop non-emotional noise like "cat")
 * rather than importing every emoji wholesale. A full dataset import can drop in
 * later if we want exhaustive coverage.
 *
 * TO EDIT THE PET'S EMOTIONS:  add / change entries below, then `npm run assets`.
 *   id       — expression name (also the sprite-sheet row name)
 *   apple    — the Apple emoji we model the face on  (visual north-star)
 *   meaning  — when this feeling happens
 *   emojis   — every emoji that should trigger this feeling
 *   keywords — words/phrases in the agent's text that imply it (no emoji present)
 *   events   — session events that trigger it directly
 *   priority — higher wins when several feelings match the same text.
 *              Order (high→low): embarrassed > oops > sad > excited > happy >
 *              thinking > sleepy > neutral.  Rationale: self-critical & negative
 *              feelings outrank positive ones, so a smile NEVER hides an error.
 *   face     — how to DRAW it, from the feature library in make-assets.mjs
 *              eyes:  dots | open | wide | happy_arc | stars | look_up | closed
 *              brows: one_raised | worried | sad
 *              mouth: slight_smile | open_smile | big_grin | flat_skew | awkward | frown | small
 *              blush | flush | sweat | zzz : true
 */

export const EXPRESSIONS = [
  {
    id: 'neutral',
    apple: '🙂',
    meaning: 'idle, waiting, calm — nothing notable happening',
    emojis: ['🙂', '😐', '😶', '🫥', '😑', '🤷', '🤞'],
    keywords: [],
    events: ['idle', 'SessionStart'],
    priority: 1,
    face: { eyes: 'dots', mouth: 'slight_smile' },
  },
  {
    id: 'thinking',
    apple: '🤔',
    meaning: 'working, investigating, considering, reading',
    emojis: ['🤔', '🧐', '💭', '🔍', '🔎', '👀', '📝', '✍️', '⏳', '⌛', '🕵️', '🤨', '🔧', '🛠️', '⚙️', '🔨', '🔬', '📊', '✏️', '📄', '💡', '🤓', '🌐'],
    keywords: ['let me', "let's see", 'investigating', 'investigate', 'analyz', 'analys', 'considering', 'figuring out', 'figure out', 'working on', 'digging', 'searching', 'exploring', 'checking', 'looking into', 'look into', 'hmm', 'reading', 'i wonder', 'wondering', 'curious', 'pondering', 'examining', 'reviewing', 'inspecting', 'debug', 'tracing', 'trying to understand', 'let me think'],
    events: ['working', 'listening', 'PreToolUse', 'UserPromptSubmit'],
    priority: 2,
    face: { eyes: 'look_up', brows: 'one_raised', mouth: 'flat_skew' },
  },
  {
    id: 'happy',
    apple: '😄',
    meaning: 'success — it works, tests pass, a good result',
    emojis: ['😄', '😃', '😀', '😁', '😆', '😊', '☺️', '🥰', '😺', '😸', '👍', '👌', '✅', '✔️', '☑️', '🆗', '💚', '👏', '🙆', '😌', '🫡', '🙏', '🤝', '👋', '😎'],
    keywords: ['fixed', 'works', 'working now', 'verified', 'passed', 'passing', 'success', 'clean', 'green', 'done', 'solved', 'confirmed', 'ready', 'looks good', 'landed', 'shipped', 'great', 'nice', 'glad', 'pleased', 'good news', 'all set', 'complete', 'works now', 'that did it', 'got it working', 'no problems', 'smoothly', 'resolved', 'sorted', 'up and running'],
    events: [],
    priority: 3,
    face: { eyes: 'happy_arc', mouth: 'open_smile', blush: true },
  },
  {
    id: 'excited',
    apple: '🤩',
    meaning: 'a big win, breakthrough, or amazing result',
    emojis: ['🤩', '🥳', '🎉', '🎊', '🎈', '🚀', '🔥', '✨', '🌟', '💫', '⭐', '💯', '🏆', '🥇', '😍', '🤯', '🙌', '🎆', '🎇', '🎯', '💪'],
    keywords: ['amazing', 'beautiful', 'incredible', 'brilliant', 'fantastic', 'huge win', 'nailed it', 'love it', 'wow', 'perfect', 'excellent', 'gold', 'awesome', 'thrilled', "can't believe", 'exceeded', 'breakthrough', 'spectacular', 'phenomenal', 'outstanding', 'woohoo', "let's go", 'crushed it', 'knocked it out', 'so good', 'stellar'],
    events: [],
    priority: 4,
    face: { eyes: 'stars', mouth: 'big_grin', blush: true },
  },
  {
    id: 'oops',
    apple: '😅',
    meaning: 'a small slip / my mistake — sheepish but recoverable',
    emojis: ['😅', '😬', '🤭', '🫠', '🙊'],
    keywords: ['oops', 'whoops', 'my mistake', 'my bad', 'my fault', 'my error', 'i was wrong', 'i messed up', 'i goofed', 'slipped', 'typo', 'that was silly', 'let me correct', 'let me fix that', 'my apolog', 'i apologi', 'i missed', 'overlooked', 'forgot to', 'should have caught', 'my oversight', 'silly me'],
    events: [],
    priority: 6,
    face: { eyes: 'open', brows: 'worried', mouth: 'awkward', sweat: true },
  },
  {
    id: 'embarrassed',
    apple: '😳',
    meaning: 'shame / embarrassment — flushed, mortified, deeper than a slip',
    emojis: ['😳', '🫣', '🙈', '😖', '🥴'],
    keywords: ['embarrass', 'ashamed', 'shame', 'shameful', 'mortif', 'flushed', 'blush', 'shy', 'how embarrassing', 'i should have known', 'rookie mistake', 'facepalm', 'cringe', 'awkward', 'self-conscious', 'red-faced', 'i feel silly', 'i feel foolish', 'foolish', 'i really should have', "that's on me", 'sheepish', 'humbling', 'humbled'],
    events: [],
    priority: 7,
    face: { eyes: 'wide', mouth: 'small', flush: true },
  },
  {
    id: 'sad',
    apple: '😟',
    meaning: 'bad news, a negative finding, or an error (not the pet\'s own fault)',
    emojis: ['😟', '🙁', '☹️', '😞', '😔', '😕', '😢', '😭', '😿', '💔', '❌', '🔴', '⚠️', '🐛', '😩', '😫', '📉', '🐞', '🆘', '‼️', '❗', '🚨', '😤', '🤬', '😠', '😡'],
    keywords: ['error', 'failed', 'failure', 'fails', 'failing', 'broken', 'broke', 'bug', 'crash', 'exception', 'traceback', "doesn't work", 'not working', "won't", 'stuck', 'blocked', 'denied', "can't find", 'undefined', 'unfortunately', 'bad news', 'problem', 'issue', "couldn't", 'unable', 'no luck', 'regression', 'timeout', 'rejected', 'missing', 'went wrong', 'disappointing', 'sadly', 'ugh', 'frustrating', 'hit a wall', 'not great', 'concerning'],
    events: [],
    priority: 5,
    face: { eyes: 'open', brows: 'sad', mouth: 'frown' },
  },
  {
    id: 'sleepy',
    apple: '😴',
    meaning: 'context window full, a long session, or resting',
    emojis: ['😴', '😪', '💤', '🥱', '😮‍💨'],
    keywords: ['compact', 'context full', 'context is full', 'tired', 'exhausted', 'drained', 'long session', 'running low', 'almost full', 'winding down', 'getting full', 'low on context', 'need a break'],
    events: ['tired', 'PreCompact', 'SessionEnd'],
    priority: 1,
    face: { eyes: 'closed', mouth: 'small', zzz: true },
  },
];

// ---- derived lookups -------------------------------------------------------
// real assistant/user text uses smart quotes ("I’m", "doesn’t", "that’s wrong"); our
// keyword/tone phrases are written with straight apostrophes, so normalize before matching
// or every apostrophe'd phrase silently misses on a live transcript.
const normApostrophes = (s) => s.replace(/[’‘]/g, "'");
const stripVariation = (e) => e.replace(/[︀-️‍]/g, ''); // strip VS selectors / ZWJ before matching
const BY_PRIORITY = [...EXPRESSIONS].sort((a, b) => b.priority - a.priority);
// VS/ZWJ-stripped emoji per expression: the matcher's regex captures a bare codepoint
// (it drops the U+FE0F selector), so we must compare against dictionary entries that are
// likewise stripped — otherwise ⚠️ ✔️ ❤️ (stored WITH the selector) silently miss.
const STRIPPED_EMOJIS = new Map(EXPRESSIONS.map((ex) => [ex, ex.emojis.map(stripVariation)]));

// emoji → a grid tool-reaction (a prop pose), so the agent's OWN activity-emoji puts the
// matching ITEM in Dijon's hands: 🔧 grabs the hammer, 🔬 the magnifier, 🌐 the globe, 💡
// the lightbulb, ⚙️ the terminal. Reuses the existing reactions (no new sprites) — the
// "what's it doing" prop driven by what the agent SAYS, not only by the tools it runs.
export const EMOJI_REACTION = {
  '🔧': 'Writing', '🛠️': 'Writing', '🔨': 'Writing', '⚙️': 'Running',
  '🔬': 'Searching', '🔍': 'Searching', '🔎': 'Searching',
  '🌐': 'Fetching', '💡': 'Planning',
};
export const emojiReaction = (emoji) => EMOJI_REACTION[emoji] || EMOJI_REACTION[stripVariation(emoji)] || null;
export const byId = (id) => EXPRESSIONS.find((e) => e.id === id) || null;
export const appleFor = (id) => (byId(id)?.apple) || '🙂';

// a negative WORD inside a non-negative frame: classic negation ("zero errors") and
// reassurance ("traversing the db rather than failing", "live progress instead of the
// crash") — the bad word is present but the agent is saying the bad thing did NOT happen.
const NEGATED = /\b(no|zero|without|never|free of|rather than|instead of)\s+\w*\s*(error|bug|issue|fail(ed|ing|ure)?|problem|crash|broke|broken|stuck|missing|wrong)/i;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/*
 * A keyword can be a FEELING ("the build failed") or just an IDENTIFIER in a list — e.g.
 * "the 9 states (idle, running, failed, waiting, review)". The latter is not an emotion.
 * inEnumeration() spots a keyword that sits as a standalone item inside a long comma/paren
 * list of bare names (≥3 commas nearby, delimiter on both sides) and tells the matcher to
 * skip it — so enumerating animation states no longer reads as a string of sad faces.
 */
function inEnumeration(text, index, kwLen) {
  const pre = text.slice(0, index).replace(/[`'"\s]+$/, '');
  const post = text.slice(index + kwLen).replace(/^[`'"\s]+/, '');
  const beforeCh = pre.charAt(pre.length - 1);
  const afterCh = post.charAt(0);
  if (!((beforeCh === ',' || beforeCh === '(') && (afterCh === ',' || afterCh === ')'))) return false;
  const win = text.slice(Math.max(0, index - 70), index + kwLen + 70);
  return (win.match(/,/g) || []).length >= 3;
}

/*
 * detectExpression(text) -> { id, emoji, apple, priority, reason } | null
 * Finds the feeling the agent expressed. Emoji first (its own words), then keywords.
 * On ties / multiple matches, the highest-priority feeling wins (negatives outrank
 * positives — a face never hides an error).
 */
export function detectExpression(text) {
  if (!text || typeof text !== 'string') return null;
  const t = normApostrophes(text.slice(0, 4000));

  // 1) the agent's OWN emoji — the most authentic signal
  const found = [...t.matchAll(EMOJI_RE)].map((m) => m[0]);
  if (found.length) {
    for (const ex of BY_PRIORITY) {                         // salience order
      const hit = found.find((e) => ex.emojis.includes(e) || STRIPPED_EMOJIS.get(ex).includes(stripVariation(e)));
      if (hit) return { id: ex.id, emoji: hit, apple: ex.apple, priority: ex.priority, reason: 'emoji ' + hit };
    }
    // an emoji we don't classify yet → stay expressive but neutral-positive
    return { id: 'happy', emoji: found[0], apple: appleFor('happy'), priority: byId('happy').priority, reason: 'emoji:other ' + found[0] };
  }

  // 2) keyword fallback → the feeling's representative Apple emoji
  const negated = NEGATED.test(t);
  for (const ex of BY_PRIORITY) {
    if (!ex.keywords.length) continue;
    if ((ex.id === 'sad' || ex.id === 'oops') && negated) continue;  // "zero errors" isn't sad/oops
    for (const kw of ex.keywords) {
      const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const m = re.exec(t);
      if (!m) continue;
      if (inEnumeration(t, m.index, m[0].length)) continue;  // a name in a list, not a feeling
      return { id: ex.id, emoji: ex.apple, apple: ex.apple, priority: ex.priority, reason: 'kw:' + kw };
    }
  }
  return null;
}

/*
 * detectUserTone(text) -> { tone, mood, emoji, reason } | null
 * How the USER is speaking TO the pet — distinct from the agent's own sentiment. Praise
 * makes Dijon proud (happy/excited); a correction makes it apologetic (oops/embarrassed).
 * Deliberately CONSERVATIVE: criticism must be AGENT-DIRECTED ("you broke it", "that's
 * wrong", "no,"), never a mere task that mentions a problem ("fix the failing test") — so
 * a normal request stays neutral (returns null) and the pet just gets to work.
 */
const USER_TONES = [
  // strongest first so "amazing!" beams (excited) and "that's terrible" mortifies (embarrassed)
  { tone: 'praise', mood: 'excited', phrases: ['amazing', 'incredible', 'genius', 'brilliant', 'phenomenal', 'spectacular', 'outstanding', 'blown away', 'you nailed it', 'nailed it', 'love it', 'love this', 'absolutely perfect', 'so good'] },
  { tone: 'scold', mood: 'embarrassed', phrases: ['completely wrong', 'totally wrong', 'terrible', 'awful', 'horrible', 'what are you doing', 'what were you thinking', 'unacceptable', 'are you kidding', 'this is bad', 'a mess'] },
  { tone: 'scold', mood: 'oops', phrases: ["that's wrong", 'that is wrong', "you're wrong", "that's not right", "that's not what", 'not what i asked', 'not what i wanted', 'no, that', 'no that', 'nope', 'you broke', "you didn't", 'you forgot', 'you missed', 'why did you', 'undo that', 'revert that', 'stop doing', 'still broken', 'still failing', 'still not working', "didn't work", "doesn't work", 'this is wrong', 'messed up', "that's bad", 'frustrat', 'ugh,', 'come on,'] },
  { tone: 'praise', mood: 'happy', phrases: ['thank you', 'thanks', 'nice work', 'nice job', 'great job', 'good job', 'well done', 'great work', 'good work', 'nicely done', 'perfect', 'awesome', 'beautiful', 'excellent', 'looks good', 'lgtm', 'works great', 'that worked', 'works now', 'wonderful', 'fantastic', 'impressive', 'you got it', '👍', '🙏', '🎉', '❤️'] },
];
export function detectUserTone(text) {
  if (!text || typeof text !== 'string') return null;
  const t = normApostrophes(text.slice(0, 4000));
  for (const grp of USER_TONES) {
    for (const ph of grp.phrases) {
      const re = new RegExp('\\b' + ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(t) || t.includes(ph)) return { tone: grp.tone, mood: grp.mood, emoji: appleFor(grp.mood), reason: grp.tone + ':' + ph };
    }
  }
  return null;
}
