#!/usr/bin/env node
/*
 * animayte · APPRAISE + COMPOSE test — the translation→composition seam.
 *   node test/appraise.test.mjs
 *
 * Locks the FeatureSpec contract: appraise(signal) derives the axes, composeExpression(spec)
 * turns them into face/FX/item. Proves the owner's point — the SAME bad valence fans out by
 * CAUSE (external error winces red; self-slip sweats, no flash) and INTENSITY.
 */
import { appraise, intensityDelta, attributeCause, expectednessOf } from '../lib/appraise.mjs';
import { composeExpression } from '../grid/compose.mjs';
import { ITEMS, EXPRESSION_IDS } from '../lib/vocabulary.mjs';

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } }
function eq(name, got, want) { ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want); }

console.log('\n· appraise — tool error');
{
  const s = appraise({ isError: true });
  eq('error → sad', s.expression, 'sad');
  eq('error cause = external', s.cause, 'external');
  ok('error valence < 0', s.valence < 0);
}

console.log('· appraise — user tone');
{
  const praise = appraise({ userText: 'this is amazing, you nailed it' });
  eq('praise → excited', praise.expression, 'excited');
  eq('praise cause = user', praise.cause, 'user');
  ok('praise valence > 0', praise.valence > 0);

  const scold = appraise({ userText: "no, that's wrong" });
  eq('scold → oops', scold.expression, 'oops');
  eq('scold cause = user', scold.cause, 'user');

  const neutral = appraise({ userText: 'add a feature to the parser' });
  eq('neutral request → thinking', neutral.expression, 'thinking');
  eq('neutral request cause = none', neutral.cause, 'none');
}

console.log('· appraise — agent text (recency-first) + item bridge');
{
  const s = appraise({ recentTexts: ['Let me check the other module.', 'Investigating the failing case.'] });
  eq('newest emotional line wins → thinking', s.expression, 'thinking');

  const fix = appraise({ recentTexts: ['fixing it 🔧'] });
  eq('🔧 → thinking', fix.expression, 'thinking');
  eq('🔧 bridges to the hammer item', fix.item, 'hammer');

  const win = appraise({ recentTexts: ['🚀 huge breakthrough'] });
  eq('🚀 → excited', win.expression, 'excited');
  ok('excited arousal = intense', win.arousal === 2);

  ok('no feeling → null', appraise({ recentTexts: ['the value is written to the buffer'] }) === null);
}

console.log('· appraise — expectedness (valence sign flip vs prev)');
{
  const surprising = appraise({ isError: true }, { valence: 1 });   // bad right after good
  eq('bad after good → surprising', surprising.expectedness, 'surprising');
  const routine = appraise({ isError: true }, { valence: -0.8 });   // bad after bad
  eq('bad after bad → routine', routine.expectedness, 'routine');
}

console.log('· compose — the SAME negative valence fans out by cause');
{
  const external = composeExpression(appraise({ isError: true }));
  ok('external error → red flash', external.fx.flash === true);
  ok('external error → shake', !!external.fx.shake);

  const self = composeExpression({ expression: 'oops', valence: -0.5, arousal: 1, cause: 'self', expectedness: 'routine' });
  ok('self slip → sweat', self.face.sweat === true);
  ok('self slip → NO red flash', !self.fx.flash);

  const user = composeExpression({ expression: 'happy', valence: 0.6, arousal: 1, cause: 'user', expectedness: 'routine' });
  ok('user praise → blush', user.face.blush === true);

  const win = composeExpression({ expression: 'excited', valence: 1, arousal: 2, cause: 'none', expectedness: 'routine' });
  ok('big win → confetti burst', win.fx.burst === true);

  const startled = composeExpression({ expression: 'sad', valence: -0.8, arousal: 1, cause: 'external', expectedness: 'surprising' });
  eq('surprising → wide-eyed startle', startled.face.eyes, 'wide');
}

console.log('· contract — appraise only emits known vocabulary');
for (const sig of [{ isError: true }, { userText: 'thanks!' }, { recentTexts: ['🚀 yes'] }]) {
  const s = appraise(sig);
  ok(`emits a real expression (${s.expression})`, EXPRESSION_IDS.includes(s.expression));
  ok(`item is null or a real item (${s.item})`, s.item === null || ITEMS.includes(s.item));
}

// ── the CALIBRATION lock — the axes are sensible, not guessed ──────────────────────────
console.log('\n· calibrate — INTENSITY spans the same family (minor → plain → severe)');
{
  const minor  = appraise({ recentTexts: ['a small lint issue, no big deal'] });
  const plain  = appraise({ recentTexts: ['the request returned an error'] });
  const severe = appraise({ recentTexts: ['everything is completely broken, fatal crash!!'] });
  eq('all three stay the sad family', [minor.expression, plain.expression, severe.expression].join(','), 'sad,sad,sad');
  eq('minor → calm',    minor.arousal, 0);
  eq('plain → active',  plain.arousal, 1);
  eq('severe → intense', severe.arousal, 2);
  ok('|valence| grows with intensity', Math.abs(minor.valence) < Math.abs(plain.valence) && Math.abs(plain.valence) < Math.abs(severe.valence));
  ok('intensityDelta: dampener calms', intensityDelta('a minor, harmless thing') < 0);
  ok('intensityDelta: hedge calms (investigating ≠ confronting)', intensityDelta('checking whether it failed') < 0);
  ok('intensityDelta: severe escalates', intensityDelta('the build completely crashed') > 0);
}

console.log('· calibrate — CAUSE: own-fault vs external (beyond keywords)');
{
  const self = appraise({ recentTexts: ['I broke the build with my edit'] });
  const ext  = appraise({ recentTexts: ['the build broke after the deploy'] });
  eq('"I broke it" → cause self', self.cause, 'self');
  eq('"the build broke" → cause external', ext.cause, 'external');
  eq('attributeCause keeps oops/embarrassed self', attributeCause('the build broke', 'self'), 'self');
  // and CAUSE fans out the SAME bad valence visually: external winces red, self only sweats
  const extFx = composeExpression(ext);
  const selfFx = composeExpression(self);
  ok('external setback → red flash', extFx.fx.flash === true);
  ok('self-caused setback → sweat, NO red flash', selfFx.face.sweat === true && !selfFx.fx.flash);
}

console.log('· calibrate — EXPECTEDNESS from real recent history (mood meter + prev)');
{
  const afterWin   = appraise({ isError: true }, { mood: 0.6 });   // setback after a winning streak
  const amidSlump  = appraise({ isError: true }, { mood: -0.6 });  // setback amid an ongoing slump
  eq('bad after a good run → surprising', afterWin.expectedness, 'surprising');
  eq('bad amid a slump → routine',        amidSlump.expectedness, 'routine');
  eq('mood meter overrides stale prev.valence', appraise({ isError: true }, { valence: -0.8, mood: 0.6 }).expectedness, 'surprising');
  eq('lexical surprise marker wins', appraise({ recentTexts: ['turns out it failed'] }, { mood: -0.6 }).expectedness, 'surprising');
  eq('expectednessOf is a pure, exported helper', expectednessOf({ valence: -0.6, mood: 0.5 }), 'surprising');
}

console.log('· calibrate — "thanks" reads CONTENT, "amazing!" reads GRIN');
{
  const thanks  = appraise({ userText: 'thanks, that works great' });
  const amazing = appraise({ userText: 'this is amazing, you nailed it!!' });
  eq('thanks → happy (not excited)', thanks.expression, 'happy');
  eq('thanks → calm (content, not a grin)', thanks.arousal, 0);
  eq('amazing → excited', amazing.expression, 'excited');
  eq('amazing → intense (a real grin)', amazing.arousal, 2);
  ok('amazing is more aroused than thanks', amazing.arousal > thanks.arousal);
}

console.log('· consolidate — tool ACTIVITY → item bridge lives in appraise (daemon just calls it)');
{
  const edit = appraise({ tool: 'Edit' });
  eq('Edit → thinking', edit.expression, 'thinking');
  eq('Edit → hammer item', edit.item, 'hammer');
  eq('Bash npm test → magnifier', appraise({ tool: 'Bash', toolInput: { command: 'npm test' } }).item, 'magnifier');
  eq('Bash git commit → box', appraise({ tool: 'Bash', toolInput: { command: 'git commit -m x' } }).item, 'box');
  eq('WebFetch → globe', appraise({ tool: 'WebFetch' }).item, 'globe');
  eq('pre-classified {event} works too', appraise({ event: 'Planning' }).item, 'lightbulb');
  ok('tool activity carries no feeling (valence 0)', edit.valence === 0 && edit.cause === 'none');
  for (const ev of ['Reading', 'Searching', 'Writing', 'Running', 'Testing', 'Installing', 'Committing', 'Fetching', 'Planning']) {
    const it = appraise({ event: ev }).item;
    ok(`event ${ev} → a real item (${it})`, ITEMS.includes(it));
  }
}

console.log('· consolidate — PostToolUse failure: severity from text, own-fault if the agent says so');
{
  const plain  = appraise({ isError: true });
  const severe = appraise({ isError: true, errorText: 'fatal: the process crashed, completely broken' });
  const owned  = appraise({ isError: true, errorText: 'my typo: I misspelled the flag' });
  eq('plain tool error → active', plain.arousal, 1);
  eq('severe tool error → intense', severe.arousal, 2);
  eq('tool error defaults to external', plain.cause, 'external');
  eq('agent-owned bad command → self', owned.cause, 'self');
}

// ── the FAN-OUT proof — the SAME sad family spreads across cause/arousal/expectedness ──────
// (Locked on neutral, domain-agnostic lines. The real-session re-maps live in grid/maps/
//  {codex,claude}.json + .appraise.json, regenerated by grid/map-session.mjs + map-appraise.)
console.log('\n· fan-out — one "sad" family, many faithful faces (was one flat 😟 for all)');
{
  const reassurance = appraise({ recentTexts: ['the scan is still going, which means it is working rather than failing'] });
  ok('reassurance ("rather than failing") is NOT a fresh sad', reassurance === null);

  const firstSetback = appraise({ recentTexts: ["The first attempt failed and didn't take, so I'm checking whether there's another way in."] }, { mood: 0.25 });
  eq('first setback after a winning run → surprising', firstSetback.expectedness, 'surprising');
  eq('  …but calm (a hedged probe, already pivoting)', firstSetback.arousal, 0);

  const namedProblem = appraise({ recentTexts: ['The page is failing to load: the asset is missing or unreachable.'] }, { mood: -0.3 });
  eq('a named, active problem → active concern', namedProblem.arousal, 1);
  eq('  …and routine once deep in the slump', namedProblem.expectedness, 'routine');

  const recovering = appraise({ recentTexts: ["The stuck job is done; now I'm restarting the worker."] }, { mood: -0.3 });
  eq('recovering reads calmer than the break', recovering.arousal, 0);

  const reliefMixed = appraise({ recentTexts: ['Good: the page renders now, though a couple of images are still missing.'] }, { mood: -0.2 });
  eq('a positive lead frames the residual as faint concern', reliefMixed.arousal, 0);

  const ownFault = appraise({ recentTexts: ['I broke the parser with my last edit.'] }, { mood: -0.1 });
  eq('an own-fault setback → cause self (sweats, no red flash)', ownFault.cause, 'self');

  const specs = [firstSetback, namedProblem, recovering, reliefMixed, ownFault];
  ok('all stay the sad family', specs.every((s) => s.expression === 'sad'));
  ok('but fan out into ≥3 distinct specs', new Set(specs.map((s) => `${s.cause}/${s.arousal}/${s.expectedness}`)).size >= 3);
}

console.log('· REAL Claude session — the two spurious "sad" rows are gone (it was all success)');
{
  const stateList = 'animayte already uses all 9 hatch-pet states (idle, running-right, running-left, running, waving, jumping, failed, waiting, review) plus its own emotional layer.';
  const sl = appraise({ recentTexts: [stateList] });   // a name in a list carries no fresh feeling → null (holds the prior), never a sad
  ok('enumerating a state list ("…, failed, …") is NOT sad', !sl || sl.expression !== 'sad');
  const wrapUp = appraise({ recentTexts: ['Done. Here’s what I learned and how it lands for animayte. The 9 states (idle, running, failed, waiting, review) all map cleanly.'] });
  eq('the successful wrap-up reads happy, not sad', wrapUp.expression, 'happy');
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} appraise+compose checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
