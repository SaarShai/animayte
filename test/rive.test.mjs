#!/usr/bin/env node
/*
 * animayte — RIVE CONTRACT tests (pure mapping, fast, no browser/WASM).
 *   node test/rive.test.mjs
 *
 * Verifies the daemon→Rive seam: the State-Machine input contract and the pure
 * commandToOps() / moodToIndex() / reactionToToolIndex() / nextBirds() mapping that
 * lib/rive/driver.mjs applies to live Rive inputs. The browser driver is thin glue
 * over this, so testing the mapping here covers the logic without a headless browser.
 */
import {
  commandToOps, moodToIndex, reactionToToolIndex, nextBirds,
  MOODS, TOOLS, INPUTS, INPUT_NAMES, MOOD_INDEX, TOOL_INDEX,
} from '../lib/rive/contract.mjs';
import { buildSpec, bodySvg, beanHalfWidth } from '../tools/rive-export.mjs';
import { buildSlimeManifest } from '../lib/anim/manifest.mjs';

let pass = 0, fail = 0; const fails = [];
function check(name, got, want) { if (got === want) pass++; else { fail++; fails.push(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); } }
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } }
const ops = (cmd, ctx) => commandToOps(cmd, ctx);
const has = (o, name, value) => o.some((x) => x.name === name && (value === undefined || x.value === value));
const fires = (o, name) => o.some((x) => x.name === name && x.kind === 'trigger');

console.log('\nRive contract — mood / tool indices');
check('neutral → 0', moodToIndex('neutral'), 0);
check('thinking → 1', moodToIndex('thinking'), 1);
check('sleepy → 7', moodToIndex('sleepy'), 7);
check('alias working → thinking index', moodToIndex('working'), MOOD_INDEX.thinking);
check('alias listening → thinking index', moodToIndex('listening'), MOOD_INDEX.thinking);
check('alias tired → sleepy index', moodToIndex('tired'), MOOD_INDEX.sleepy);
check('alias bashful → oops index', moodToIndex('bashful'), MOOD_INDEX.oops);
check('unknown mood → 0 (neutral)', moodToIndex('whatever'), 0);
ok('every expression maps to a distinct index', new Set(MOODS.map(moodToIndex)).size === MOODS.length);

check('Reading → read tool index', reactionToToolIndex('Reading'), TOOL_INDEX.read);
check('Searching → search', reactionToToolIndex('Searching'), TOOL_INDEX.search);
check('Writing → edit', reactionToToolIndex('Writing'), TOOL_INDEX.edit);
check('Running → run', reactionToToolIndex('Running'), TOOL_INDEX.run);
check('Committing → git', reactionToToolIndex('Committing'), TOOL_INDEX.git);
check('Fetching → fetch', reactionToToolIndex('Fetching'), TOOL_INDEX.fetch);
check('Planning → plan', reactionToToolIndex('Planning'), TOOL_INDEX.plan);
check('Asking → none (0)', reactionToToolIndex('Asking'), 0);
check('unknown reaction → 0', reactionToToolIndex('Nope'), 0);

console.log('Rive contract — commandToOps mapping');
{
  const o = ops({ cmd: 'mood', value: 'excited' });
  ok('excited sets mood=3', has(o, 'mood', 3));
  ok('excited fires win trigger', fires(o, 'win'));
}
{
  const o = ops({ cmd: 'mood', value: 'sad' });
  ok('sad sets mood=6', has(o, 'mood', 6));
  ok('sad fires error trigger', fires(o, 'error'));
}
{
  const o = ops({ cmd: 'mood', value: 'happy' });
  ok('happy fires react (generic bounce)', fires(o, 'react'));
}
{
  const o = ops({ cmd: 'mood', value: 'thinking' });
  ok('thinking sets mood=1 with NO trigger', has(o, 'mood', 1) && !o.some((x) => x.kind === 'trigger'));
}
check('working alias → mood number = thinking idx', ops({ cmd: 'mood', value: 'working' })[0].value, MOOD_INDEX.thinking);

check('fullness 0.6 → 60', ops({ cmd: 'fullness', value: 0.6 })[0].value, 60);
check('fullness clamps >1 → 100', ops({ cmd: 'fullness', value: 5 })[0].value, 100);
check('fullness clamps <0 → 0', ops({ cmd: 'fullness', value: -1 })[0].value, 0);

check('react Reading → tool=read idx', ops({ cmd: 'react', name: 'Reading' })[0].value, TOOL_INDEX.read);
check('react Committing → tool=git idx', ops({ cmd: 'react', name: 'Committing' })[0].value, TOOL_INDEX.git);
check('endReact → tool=0', ops({ cmd: 'endReact' })[0].value, 0);

ok('relief fires compact', fires(ops({ cmd: 'relief' }), 'compact'));
check('sleep sets sleeping=true', ops({ cmd: 'sleep' })[0].value, true);
ok('wake clears sleeping + fires wake', (() => { const w = ops({ cmd: 'wake' }); return has(w, 'sleeping', false) && fires(w, 'wake'); })());
ok('hatch behaves like wake', (() => { const w = ops({ cmd: 'hatch' }); return has(w, 'sleeping', false) && fires(w, 'wake'); })());

check('moodLevel 0.5 → 50', ops({ cmd: 'moodLevel', value: 0.5 })[0].value, 50);
check('moodLevel clamps -2 → -100', ops({ cmd: 'moodLevel', value: -2 })[0].value, -100);

check('addBird emits ctx.birds count', ops({ cmd: 'addBird' }, { birds: 3 })[0].value, 3);
check('clearBirds emits birds count', ops({ cmd: 'clearBirds' }, { birds: 0 })[0].value, 0);
ok('reset zeroes mood/fullness/tool/birds/moodLevel + sleeping false', (() => { const r = ops({ cmd: 'reset' }); return r.length >= 6 && has(r, 'mood', 0) && has(r, 'fullness', 0) && has(r, 'tool', 0) && has(r, 'birds', 0) && has(r, 'sleeping', false); })());
ok('say (caption) → no Rive ops', ops({ cmd: 'say', text: 'hi' }).length === 0);
ok('unknown command → no ops', ops({ cmd: 'mystery' }).length === 0);
ok('empty/garbage → no ops', ops(null).length === 0 && ops({}).length === 0);

console.log('Rive contract — bird counter + input definitions');
check('addBird 0 → 1', nextBirds(0, 'addBird'), 1);
check('addBird caps at 5', nextBirds(5, 'addBird'), 5);
check('removeBird 0 → 0 (never negative)', nextBirds(0, 'removeBird'), 0);
check('removeBird 3 → 2', nextBirds(3, 'removeBird'), 2);
check('clearBirds → 0', nextBirds(3, 'clearBirds'), 0);
check('reset → 0 birds', nextBirds(4, 'reset'), 0);

ok('12 contract inputs', INPUTS.length === 12 && INPUT_NAMES.length === 12);
ok('every input has a name + kind', INPUTS.every((i) => i.name && ['number', 'boolean', 'trigger'].includes(i.kind)));
ok('triggers carry no default value', INPUTS.filter((i) => i.kind === 'trigger').every((i) => i.default === undefined));
ok('number/boolean inputs carry a default', INPUTS.filter((i) => i.kind !== 'trigger').every((i) => i.default !== undefined));
ok('contract covers mood/fullness/tool/birds + the key triggers', ['mood', 'fullness', 'tool', 'birds', 'react', 'win', 'error', 'compact', 'wake'].every((n) => INPUT_NAMES.includes(n)));

console.log('Rive build-export — library → editor build package coverage');
{
  const spec = buildSpec();
  const m = buildSlimeManifest();
  ok('spec format tag', spec.format === 'animayte-rive-build/1');
  ok('spec covers all 8 expressions, keyed by mood index 0..7', Object.keys(spec.expressions).length === 8 && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => spec.expressions[i] && spec.expressions[i].eyes));
  ok('spec covers every manifest clip (timelines)', Object.keys(spec.clips).length === Object.keys(m.clips).length);
  ok('spec carries all 12 contract inputs', spec.inputs.length === 12);
  ok('spec carries the 3 palettes (calm/tired/error)', ['calm', 'tired', 'error'].every((p) => spec.palettes[p]));
  ok('spec carries the props', Object.keys(spec.props).length === Object.keys(m.props).length);
  ok('every reaction is annotated with a toolIndex', Object.keys(spec.reactions).length > 0 && Object.values(spec.reactions).every((r) => Number.isInteger(r.toolIndex)));
  ok('artboard/state-machine named per the contract', spec.artboard === 'Pet' && spec.stateMachine === 'animayte');
  ok('state-machine graph documents layers + data binds', spec.stateMachineGraph.layers.length >= 3 && spec.stateMachineGraph.dataBinds.length >= 4);

  const svg = bodySvg('slime', (t, RX) => RX * Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 4))), m.palettes.calm);
  ok('bodySvg emits a valid <svg> (path + gradient, no NaN)', svg.includes('<svg') && svg.includes('<path') && svg.includes('linearGradient') && !/NaN/.test(svg));
  ok('bodySvg uses the §4.2 ramp colors', svg.includes(m.palettes.calm.base) && svg.includes(m.palettes.calm.rim) && svg.includes(m.palettes.calm.outline));
  ok('beanHalfWidth is a rounded silhouette (0 at ends, max at middle)', beanHalfWidth(0, 40) === 0 && Math.abs(beanHalfWidth(0.5, 40) - 40) < 1e-9 && beanHalfWidth(1, 40) === 0);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} Rive-contract checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
