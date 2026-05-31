#!/usr/bin/env node
/*
 * animayte · APPRAISE + COMPOSE test — the translation→composition seam.
 *   node test/appraise.test.mjs
 *
 * Locks the FeatureSpec contract: appraise(signal) derives the axes, composeExpression(spec)
 * turns them into face/FX/item. Proves the owner's point — the SAME bad valence fans out by
 * CAUSE (external error winces red; self-slip sweats, no flash) and INTENSITY.
 */
import { appraise } from '../lib/appraise.mjs';
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

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} appraise+compose checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
