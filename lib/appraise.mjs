/*
 * animayte · APPRAISE — the translation layer (Route 1 / "the brain").
 *
 * appraise(signal, prev) turns a normalized session SIGNAL into a FeatureSpec (see
 * lib/vocabulary.mjs). It is the single home for "what should the pet express, given X" —
 * extracted out of the daemon so the daemon (Route 3) is thin transport and the renderer
 * (Route 2) just draws the spec. PURE + deterministic: no daemon state, no I/O.
 *
 * It reuses the existing detectors (detectExpression via detectMood, detectUserTone) and
 * the tool-event classifier (classifyTool) and ENRICHES the picked feeling with the four
 * appraisal AXES, all derived FROM THE TEXT — so the SAME base feeling fans out instead of
 * collapsing. "error" is no longer a flat sad: a probe that timed out is calm + routine; a
 * stacked "failing… missing… crash" is active concern; a slip the agent owns ("my mistake")
 * sweats with cause=self; a setback right after a win reads surprising.
 *
 *   signal — one of:
 *     { recentTexts: string[] }          assistant text, newest-first → recency-first feeling
 *     { userText: string }               the user's prompt → how they spoke to the pet (tone)
 *     { isError: true, errorText?, ... }  a real tool failure (PostToolUse) → external bad news
 *     { tool, toolInput } | { event }    a live tool activity → what it's DOING (item, no feeling)
 *   prev — recent history for expectedness. Optional:
 *     { valence }   the previous spec's valence (immediate prior beat)
 *     { mood }      the slow mood-meter level (−1..+1, lib/anim/mood.mjs) — preferred when present
 */

import { detectMood, detectUserTone } from './sentiment.mjs';
import { classifyTool } from './anim/events.mjs';
import { FAMILY_AXES, emojiItem, itemForEvent } from './vocabulary.mjs';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const clampA = (n) => (n < 0 ? 0 : n > 2 ? 2 : n);
// live transcripts use smart quotes ("I’m restarting", "didn’t expect"); our lexicons are
// written with straight apostrophes, so normalize or the cues silently miss on real text.
const norm = (s) => (s || '').replace(/[’‘]/g, "'");
// truncate toward zero → the pet is CONSERVATIVE about escalating to 'intense' (a lone
// +0.5 amplifier won't; only a strong cue (SEVERE, +1) or two stacked +0.5s do) but QUICK
// to calm down (any −1 dampener/hedge/recovery lands in full). Overblown negatives are the
// failure mode we're avoiding, so the asymmetry is deliberate.
const roundDelta = (d) => Math.trunc(d);

// |valence| by arousal level, per sign: calmer feelings sit closer to neutral, intense
// ones near the rail. Keeps valence coherent with arousal (a louder feeling is a stronger
// one) without a separate magnitude axis. happy@active ≈ 0.65, excited@intense = 1.0.
const VALENCE_BY_AROUSAL = { neg: [-0.35, -0.65, -0.95], pos: [0.4, 0.65, 1.0] };
const valenceFor = (familyValence, arousal) => {
  const s = sign(familyValence);
  return s === 0 ? 0 : VALENCE_BY_AROUSAL[s < 0 ? 'neg' : 'pos'][arousal];
};

// ── INTENSITY lexicon — how HARD the feeling lands (shifts arousal up/down a notch) ──────
const SEVERE = /\b(crash(ed|es|ing)?|fatal|critical|catastroph\w*|completely|totally|utterly|severe(ly)?|blocking|blocker|data ?loss|corrupt\w*|emergency|hit a wall|won'?t (even )?(start|run|build|compile)|nothing works|everything (is )?broken|wiped out|destroyed)\b/i;
const AMPLIFY = /\b(very|extremely|really|massively|hugely|terribly|incredibly|seriously|insanely|absurdly)\b/i;
const EMPHATIC = /!{2,}|‼|⁉/;
const DAMPEN = /\b(minor|tiny|small|slight(ly)?|a bit|a little|somewhat|just a|harmless|cosmetic|trivial|no big deal|not a big deal|edge case|nitpick|negligible|expected|as expected)\b/i;
// investigating a maybe-bad thing is calmer than confronting a definitely-bad one
const HEDGED = /\b(whether|see if|to check|checking (whether|if)|might (be|have)|may be|could be|possibly|seems to|appears to|usually means|not sure (if|whether)|wonder(ing)? (if|whether))\b/i;
// already turning the corner — recovering reads calmer than the moment it broke. (No trailing
// \b: "restart" must be free to match inside "restarting".)
const RECOVERY = /\b(now (i'?m|i am|im) (restart|re-?run|retry|trying|fixing)|lower-?friction fix|the fix is|workaround|i'?ll (retry|try again)|moving on|back on track|let me fix)/i;
// a positive lead frames a trailing negative as residual, not the headline ("Good: … missing")
const POSITIVE_LEAD = /^[^.!?]{0,28}\b(good|great|nice|success|progress|better|finally|resolved|fixed|clear(ed)?)\b/i;

// distinct negative ROOTS present — three or more separate gripes in one breath escalates
const NEG_TOKENS = /\b(fail\w*|error|bug|crash\w*|broke|broken|stuck|missing|denied|timeout|timed out|exception|wrong|blocked|unable|undefined|problem|issue)\b/gi;
function stackedNegatives(text) {
  const m = (text || '').match(NEG_TOKENS);
  if (!m) return 0;
  return new Set(m.map((s) => s.toLowerCase().replace(/(ed|ing|ure|s)$/, ''))).size;
}

/** intensityDelta(text) → a small signed shift to apply to a family's base arousal. */
export function intensityDelta(rawText) {
  if (!rawText) return 0;
  const text = norm(rawText);
  let d = 0;
  if (SEVERE.test(text)) d += 1;
  if (AMPLIFY.test(text)) d += 0.5;
  if (EMPHATIC.test(text)) d += 0.5;
  if (stackedNegatives(text) >= 3) d += 0.5;
  if (DAMPEN.test(text)) d -= 1;
  if (HEDGED.test(text)) d -= 1;
  if (RECOVERY.test(text)) d -= 1;
  if (POSITIVE_LEAD.test(text)) d -= 1;
  return Math.max(-2, Math.min(2, d));
}

// ── CAUSE — own-fault vs external, beyond the family default ─────────────────────────────
// the agent attributes the problem to ITSELF ("my mistake", "I broke", "I forgot to")
const SELF_ATTRIB = /\bmy (mistake|bad|fault|error|oversight|typo|bug|regression|change|edit)\b|\b(i|we) (broke|messed up|screwed up|introduced|caused|botched|forgot|missed|overlooked|misread|goofed|slipped)\b|\bi (was wrong|should(n'?t)? have|shouldn'?t have)\b/i;

/** attributeCause(text, familyDefault) → refine a negative's cause from how it's phrased. */
export function attributeCause(text, familyDefault) {
  if (familyDefault === 'self') return 'self';                       // oops/embarrassed: by definition
  if (familyDefault === 'external' && SELF_ATTRIB.test(norm(text))) return 'self';  // "I broke it"
  return familyDefault;
}

// ── EXPECTEDNESS — surprising vs routine, from the words AND the recent history ──────────
const SURPRISE = /\b(surprisingly|unexpectedly|to my surprise|didn'?t expect|wasn'?t expecting|turns out|out of nowhere|oddly|strangely|weird(ly)?|huh[,\s]|wait[,\s])/i;

/** expectednessOf({valence, prevValence, mood, text}) → 'surprising' | 'routine'. */
export function expectednessOf({ valence = 0, prevValence = 0, mood, text } = {}) {
  if (text && SURPRISE.test(norm(text))) return 'surprising';      // the agent says it was a turn
  if (valence === 0) return 'routine';
  // baseline = the established direction: the slow mood meter if we have it, else the last beat.
  const baseline = typeof mood === 'number' && mood !== 0 ? mood : prevValence;
  if (typeof baseline === 'number' && baseline !== 0 && sign(valence) !== sign(baseline)) return 'surprising';
  return 'routine';                                                // bad-amid-bad / good-amid-good is expected
}

// how strongly the user spoke → arousal shift from the tone family's base. Warm thanks is
// CONTENT (calm), not a grin; "amazing!!" keeps excited's intense base; a hard scold mortifies.
const TONE_AROUSAL_DELTA = { excited: 0, happy: -1, oops: 0, embarrassed: 0 };

function makeSpec({ base, cause, emoji, arousalDelta = 0, prev = {}, reason, text }) {
  const ax = FAMILY_AXES[base] || { valence: 0, arousal: 1 };
  const resolvedCause = cause || ax.cause || (ax.valence < 0 ? 'external' : 'none');
  const arousal = clampA(ax.arousal + arousalDelta);
  const valence = valenceFor(ax.valence, arousal);
  const expectedness = expectednessOf({
    valence,
    prevValence: typeof prev.valence === 'number' ? prev.valence : 0,
    mood: typeof prev.mood === 'number' ? prev.mood : undefined,
    text,
  });
  return {
    expression: base,
    valence,
    arousal,
    cause: resolvedCause,
    expectedness,
    item: (emoji && emojiItem(emoji)) || null,
    reason: reason || base,
    _text: text || null, // for the daemon's de-dupe; not part of the public contract
  };
}

export function appraise(signal = {}, prev = {}) {
  // 1) a real tool error (PostToolUse failure) — external bad news; intensity from its text,
  //    cause stays external unless the agent owns the broken command ("my typo in the script").
  if (signal.isError) {
    const text = signal.errorText || signal.text || '';
    const cause = SELF_ATTRIB.test(text) ? 'self' : 'external';
    return makeSpec({ base: 'sad', cause, arousalDelta: roundDelta(intensityDelta(text)), prev, reason: 'toolError', text: text || null });
  }

  // 2) a live tool ACTIVITY — what it's DOING, not how it feels → thinking + the matching item.
  //    Accepts a raw tool ({tool,toolInput}) or a pre-classified {event}; the daemon's
  //    classifyTool→item bridge now lives here so the daemon only ever calls appraise().
  if (signal.tool || signal.event) {
    const ev = signal.event || (classifyTool(signal.tool, signal.toolInput || signal.input) || {}).event;
    if (ev) {
      return { expression: 'thinking', valence: 0, arousal: 1, cause: 'none', expectedness: 'routine', item: itemForEvent(ev), reason: 'tool:' + ev, _text: null };
    }
  }

  // 3) the USER spoke to the pet — praise → proud, correction → sheepish (cause = user)
  if (signal.userText != null && signal.userText !== '') {
    const tone = detectUserTone(signal.userText);
    if (tone) {
      return makeSpec({ base: tone.mood, cause: 'user', arousalDelta: TONE_AROUSAL_DELTA[tone.mood] ?? 0, prev, reason: 'userTone:' + tone.tone, text: signal.userText });
    }
    // a normal request with no praise/scold → attentive, neutral
    return { expression: 'thinking', valence: 0, arousal: 1, cause: 'none', expectedness: 'routine', item: null, reason: 'userNeutral', _text: null };
  }

  // 4) the agent's own words — RECENCY-FIRST (newest text carrying a feeling wins), enriched
  //    per-line by intensity (how hard) + cause (own-fault vs external) + expectedness.
  if (signal.recentTexts != null) {
    const texts = (Array.isArray(signal.recentTexts) ? signal.recentTexts : [signal.recentTexts]).filter(Boolean);
    for (const t of texts) {
      const s = detectMood(t);
      if (!s) continue;
      const ax = FAMILY_AXES[s.mood] || { valence: 0 };
      const familyCause = ax.cause || (ax.valence < 0 ? 'external' : 'none');
      return makeSpec({
        base: s.mood,
        cause: attributeCause(t, familyCause),
        emoji: s.emoji,
        arousalDelta: roundDelta(intensityDelta(t)),
        prev,
        reason: 'text:' + s.mood,
        text: t,
      });
    }
  }

  return null; // nothing to express
}
