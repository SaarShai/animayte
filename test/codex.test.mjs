#!/usr/bin/env node
/*
 * animayte — CODEX FORMAT tests (pure mapping + spec + loader; fast, no browser).
 *   node test/codex.test.mjs
 *
 * Verifies that animayte can host a Codex / Petdex pet: the 8×9 / 192×208 atlas spec
 * (transcribed from openai/skills hatch-pet), the session-signal → motion-state mapping,
 * the shared state machine's setIdleClip extension that lets a sticky mood swap the idle
 * loop, and the Node loader against the generated fixture pet (pets/codex-demo). The
 * browser player (lib/codex/runtime.mjs) is thin glue over exactly this logic.
 */
import {
  ATLAS, ROW_SPECS, CODEX_STATES, rowOf, isLoopState, buildCodexClips,
  isCodexManifest, validateCodexManifest, validateAtlasDims,
} from '../lib/codex/format.mjs';
import {
  MOOD_TO_STATE, stateForMood, moodIsSticky, EVENT_TO_STATE, buildCodexReactions,
} from '../lib/codex/mapping.mjs';
import { loadCodexPack, isCodexPack } from '../lib/codex/loader.mjs';
import { createStateMachine } from '../lib/anim/state-machine.mjs';
import { classifyTool, TOOL_EVENTS } from '../lib/anim/events.mjs';

let pass = 0, fail = 0; const fails = [];
function check(name, got, want) { if (JSON.stringify(got) === JSON.stringify(want)) pass++; else { fail++; fails.push(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); } }
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } }
function throws(name, fn) { try { fn(); fail++; fails.push('  ✗ ' + name + ' (expected a throw)'); } catch { pass++; } }

console.log('\nCodex format — atlas geometry (compose_atlas.py / validate_atlas.py)');
check('atlas is 1536×1872', [ATLAS.width, ATLAS.height], [1536, 1872]);
check('grid is 8×9', [ATLAS.cols, ATLAS.rows], [8, 9]);
check('cell is 192×208', [ATLAS.cellW, ATLAS.cellH], [192, 208]);
ok('cols·cellW === width', ATLAS.cols * ATLAS.cellW === ATLAS.width);
ok('rows·cellH === height', ATLAS.rows * ATLAS.cellH === ATLAS.height);

console.log('Codex format — the 9 ordered states + frame counts + timings (animation-rows.md)');
check('9 states in row order', CODEX_STATES, ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review']);
ok('row index === array index', ROW_SPECS.every((s, i) => s.row === i && rowOf(s.state) === i));
ok('rowOf(unknown) === -1', rowOf('nope') === -1);
check('frame counts per row', ROW_SPECS.map((s) => s.frames), [6, 8, 8, 4, 5, 8, 6, 6, 6]);
ok('every row has ≤ 8 frames (fits the 8 columns)', ROW_SPECS.every((s) => s.frames >= 1 && s.frames <= ATLAS.cols));
ok('durations length === frame count', ROW_SPECS.every((s) => s.durations.length === s.frames));
ok('all durations are positive ms', ROW_SPECS.every((s) => s.durations.every((d) => d > 0)));
check('idle timings verbatim', ROW_SPECS[0].durations, [280, 110, 110, 140, 140, 320]);
check('running-right = 7×120 + 220', ROW_SPECS[1].durations, [120, 120, 120, 120, 120, 120, 120, 220]);
check('waving = 3×140 + 280', ROW_SPECS[3].durations, [140, 140, 140, 280]);
check('jumping = 4×140 + 280', ROW_SPECS[4].durations, [140, 140, 140, 140, 280]);
check('failed = 7×140 + 240', ROW_SPECS[5].durations, [140, 140, 140, 140, 140, 140, 140, 240]);
check('running = 5×120 + 220', ROW_SPECS[7].durations, [120, 120, 120, 120, 120, 220]);
check('review = 5×150 + 280', ROW_SPECS[8].durations, [150, 150, 150, 150, 150, 280]);

console.log('Codex format — loop vs transient classification');
check('continuous states loop', CODEX_STATES.filter(isLoopState), ['idle', 'running-right', 'running-left', 'waiting', 'running', 'review']);
check('transient gestures do not loop', CODEX_STATES.filter((s) => !isLoopState(s)), ['waving', 'jumping', 'failed']);

console.log('Codex format — buildCodexClips() (synthetic clips for the shared state machine)');
{
  const clips = buildCodexClips();
  ok('one clip per state', Object.keys(clips).length === CODEX_STATES.length && CODEX_STATES.every((s) => clips[s]));
  ok('clip.loop matches the spec', CODEX_STATES.every((s) => clips[s].loop === isLoopState(s)));
  ok('frames carry { dur, cell } with cell === column index', CODEX_STATES.every((s) => clips[s].frames.every((f, i) => f.cell === i && f.dur > 0)));
  check('idle clip frame durations match', clips.idle.frames.map((f) => f.dur), [280, 110, 110, 140, 140, 320]);
}

console.log('Codex format — pet.json detection + validation');
const goodManifest = { id: 'pixel-coder', displayName: 'Pixel Coder', description: 'a pet', spritesheetPath: 'spritesheet.webp' };
ok('isCodexManifest(real codex pet) === true', isCodexManifest(goodManifest));
ok('isCodexManifest(animayte-pet/1) === false', isCodexManifest({ format: 'animayte-pet/1', name: 'slime', spritesheetPath: 'x.png' }) === false);
ok('isCodexManifest(null/garbage) === false', !isCodexManifest(null) && !isCodexManifest('x') && !isCodexManifest({}) );
check('valid manifest → no errors', validateCodexManifest(goodManifest), []);
ok('missing fields → errors', validateCodexManifest({ id: 'x' }).length === 3);
ok('non-png/webp spritesheet → error', validateCodexManifest({ ...goodManifest, spritesheetPath: 'sheet.gif' }).some((e) => /png or .?webp/i.test(e)));
check('conformant atlas dims → no errors', validateAtlasDims(1536, 1872), []);
ok('wrong atlas dims → error', validateAtlasDims(1024, 1024).length === 1);

console.log('Codex mapping — moods → motion states (honouring Codex semantics)');
check('neutral/idle → idle', [stateForMood('neutral'), stateForMood('idle')], ['idle', 'idle']);
check('thinking/working → running (processing)', [stateForMood('thinking'), stateForMood('working')], ['running', 'running']);
check('listening → review (focused lean)', stateForMood('listening'), 'review');
check('happy → waving', stateForMood('happy'), 'waving');
check('excited → jumping', stateForMood('excited'), 'jumping');
check('oops/sad/bashful/embarrassed → failed', ['oops', 'sad', 'bashful', 'embarrassed'].map(stateForMood), ['failed', 'failed', 'failed', 'failed']);
check('sleepy/tired → idle (no sleep row)', [stateForMood('sleepy'), stateForMood('tired')], ['idle', 'idle']);
check('unknown mood → idle', stateForMood('zzz'), 'idle');
ok('every mood maps to a real Codex state', Object.values(MOOD_TO_STATE).every((s) => rowOf(s) >= 0));
ok('working is sticky (loop), happy/excited are transient', moodIsSticky('working') && !moodIsSticky('happy') && !moodIsSticky('excited'));

console.log('Codex mapping — tool events → motion states + reactions');
check('Reading/Searching/Fetching/Planning → review', ['Reading', 'Searching', 'Fetching', 'Planning'].map((e) => EVENT_TO_STATE[e]), ['review', 'review', 'review', 'review']);
check('Writing/Running/Testing/Installing → running', ['Writing', 'Running', 'Testing', 'Installing'].map((e) => EVENT_TO_STATE[e]), ['running', 'running', 'running', 'running']);
check('Committing/Idea → jumping', [EVENT_TO_STATE.Committing, EVENT_TO_STATE.Idea], ['jumping', 'jumping']);
check('Asking/Waiting → waiting (needs input)', [EVENT_TO_STATE.Asking, EVENT_TO_STATE.Waiting], ['waiting', 'waiting']);
ok('every classifyTool event maps to a real Codex state', TOOL_EVENTS.every((e) => rowOf(EVENT_TO_STATE[e]) >= 0));
{
  const reactions = buildCodexReactions();
  ok('every reaction targets a real state, has an integer priority, returns to idle', Object.values(reactions).every((r) => rowOf(r.clip) >= 0 && Number.isInteger(r.priority) && r.return === 'idle'));
  // the real classifier (events.mjs) emits names the Codex reactions map understands
  ok('classifyTool(Read) → Reading → a Codex reaction', !!reactions[classifyTool('Read').event]);
  ok('classifyTool(git commit) → Committing → jumping', reactions[classifyTool('Bash', { command: 'git commit -m x' }).event].clip === 'jumping');
}

console.log('Codex brain — state machine plays Codex clips + the setIdleClip extension');
{
  const sm = createStateMachine({ clips: buildCodexClips(), reactions: buildCodexReactions(), idle: { base: 'idle', secondary: [], boredAfterMs: Infinity } }, { defaultExpression: 'neutral' });
  ok('boots into the idle loop', sm.current().clip === 'idle');
  ok('setIdleClip(running) swaps the resting loop (sticky mood)', sm.setIdleClip('running') === true && (sm.tick(10), sm.current().clip === 'running'));
  ok('setIdleClip(unknown) is a no-op', sm.setIdleClip('nope') === false && sm.current().clip === 'running');
  ok('setIdleClip(current) is a no-op', sm.setIdleClip('running') === false);
  // a tool reaction interrupts, then RETURNS to the new sticky base (not back to plain idle)
  sm.react('Reading'); sm.tick(10);
  ok('Reading reaction → review row', sm.current().clip === 'review');
  sm.tick(2000);  // let the (looping) reaction be released
  sm.release();
  ok('after release, returns to the sticky running base', sm.current().clip === 'running');
  // a one-shot gesture completes back to idle on its own
  sm.setIdleClip('idle'); sm.react({ clip: 'jumping', priority: 6, return: 'idle' }); sm.tick(5);
  ok('jumping gesture is active', sm.current().clip === 'jumping');
  sm.tick(5000);
  ok('jumping completes back to idle', sm.current().clip === 'idle');
}

console.log('Codex loader — the generated fixture pet (pets/codex-demo)');
ok('isCodexPack(codex-demo) === true', isCodexPack('codex-demo'));
ok('isCodexPack(slime) === false (it is animayte-pet/1)', isCodexPack('slime') === false);
{
  const pack = loadCodexPack('codex-demo');
  check('loads the fixture id', pack.id, 'codex-demo');
  ok('manifest validates + sheetPath resolved', validateCodexManifest(pack.manifest).length === 0 && /spritesheet\.png$/.test(pack.sheetPath));
}
throws('loadCodexPack(missing) throws a clear error', () => loadCodexPack('no-such-pet'));

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} Codex checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
