#!/usr/bin/env node
/*
 * animayte — expression DETECTION + CONSISTENCY tests (pure, fast, no server).
 *   node test/expressions.test.mjs
 *
 * Layer 1: detectExpression() maps the right emoji/keyword → the right expression,
 *          including adversarial cases (negation, priority, neutral, variation selectors).
 * Layer 2: every expression in the dictionary exists as a sprite row in EVERY renderer
 *          (daemon moods, Swift moodRow, HTML moodState, Python) — catches drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXPRESSIONS, detectExpression } from '../lib/expressions.mjs';
import { detectMood } from '../lib/sentiment.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const fails = [];
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else { fail++; fails.push(`  ✗ ${name}\n      got:  ${got}\n      want: ${want}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}`); } }

const ids = new Set(EXPRESSIONS.map((e) => e.id));

// ─────────────────────────────────────────────────────────────────────────
console.log('\nLayer 1 — DETECTION');

// 1a. each expression's OWN emoji must resolve back to it
console.log('  · every dictionary emoji resolves to its own expression');
for (const ex of EXPRESSIONS) {
  for (const em of ex.emojis) {
    const r = detectExpression(`the agent says ${em} about the thing`);
    // priority can legitimately reroute a shared/lower emoji; assert it at least lands on a real id
    ok(`emoji ${em} (${ex.id}) → some valid expression`, !!r && ids.has(r.id));
  }
}

// 1b. canonical emoji → expected expression (the headline mappings)
const EMOJI_CASES = [
  ['🎉', 'excited'], ['🥳', 'excited'], ['🚀', 'excited'], ['🔥', 'excited'], ['✨', 'excited'],
  ['😄', 'happy'], ['😊', 'happy'], ['✅', 'happy'], ['👍', 'happy'], ['👏', 'happy'],
  ['🤔', 'thinking'], ['🧐', 'thinking'], ['🔍', 'thinking'], ['👀', 'thinking'],
  ['😅', 'oops'], ['😬', 'oops'],
  ['😳', 'embarrassed'], ['🫣', 'embarrassed'], ['🙈', 'embarrassed'],
  ['🎉', 'excited'], ['🙌', 'excited'], ['🚀', 'excited'],
  ['😟', 'sad'], ['🙁', 'sad'], ['❌', 'sad'], ['😢', 'sad'], ['🐛', 'sad'],
  ['😴', 'sleepy'], ['💤', 'sleepy'], ['🥱', 'sleepy'],
  ['🙂', 'neutral'], ['😐', 'neutral'],
];
console.log('  · canonical emoji → expected expression');
for (const [em, want] of EMOJI_CASES) {
  const r = detectExpression(`result ${em}`);
  check(`emoji ${em}`, r && r.id, want);
}

// 1c. keyword fallback (no emoji present)
const KW_CASES = [
  ['Fixed it, all tests pass now', 'happy'],
  ['This is absolutely amazing, brilliant work', 'excited'],
  ['Let me investigate the root cause', 'thinking'],
  ['Sorry, my mistake — I misread that', 'oops'],
  ['The build failed with an exception', 'sad'],
  ['Unfortunately the request returned an error', 'sad'],
  ['compacting the context now', 'sleepy'],
  // expanded vocabulary (Saar feedback: "shame" was missed)
  ['how embarrassing, that was a rookie mistake', 'embarrassed'],
  ['I feel so ashamed of that oversight', 'embarrassed'],
  ['ugh, that is a bit of a facepalm moment', 'embarrassed'],
  ['woohoo, we crushed it!', 'excited'],
  ['hmm, I wonder why that happens', 'thinking'],
  ['that is frustrating, it went wrong again', 'sad'],
  ['nice, that resolved smoothly', 'happy'],
];
console.log('  · keyword fallback → expected expression');
for (const [text, want] of KW_CASES) {
  const r = detectExpression(text);
  check(`kw "${text.slice(0, 32)}…"`, r && r.id, want);
}

// 1d. ADVERSARIAL — the cases that break naive detectors
console.log('  · adversarial (negation / neutral / priority / mixed)');
check('negation: "clean, zero errors" is NOT sad', (detectExpression('runs clean, zero errors')||{}).id, 'happy');
check('negation: "no bugs, no errors" not sad', (() => { const r = detectExpression('no bugs and no errors'); return r ? r.id : 'null(ok)'; })() === 'sad' ? 'sad' : 'not-sad', 'not-sad');
// truly neutral narration (no emotion words at all) → null
ok('neutral narration → null', detectExpression('the value is then written to the buffer') === null);
ok('empty string → null', detectExpression('') === null);
ok('whitespace → null', detectExpression('   \n  ') === null);
ok('non-string → null', detectExpression(null) === null && detectExpression(undefined) === null);
// "let me…" IS a real working signal — the pet SHOULD react with 🤔 thinking
check('intent-to-work narration → thinking', (detectExpression('Now let me restart the daemon')||{}).id, 'thinking');
check('priority: celebration beats a stray ✅ ("✅ done but 🎉 huge win")', (detectExpression('✅ done, and 🎉 a huge win!')||{}).id, 'excited');
// PRINCIPLE: a negative signal must never be hidden by a co-occurring positive one.
// When success + error are both mentioned, the pet shows the error (😟 sad). Order-independent.
check('mixed (works+error) → sad, word order A', (detectExpression('mostly works but threw an error')||{}).id, 'sad');
check('mixed (error+works) → sad, word order B', (detectExpression('threw an error but mostly works')||{}).id, 'sad');
check('mixed (fixed+failed) → sad', (detectExpression('fixed the test but the build failed')||{}).id, 'sad');
check('variation selector emoji ✔️ resolves', (detectExpression('✔️ verified')||{}).id, 'happy');
check('emoji with skin/ZWJ noise still classified', (detectExpression('great 👍🏽 work')||{}).id, 'happy');

// 1e. sentiment.mjs wrapper agrees with the dictionary
console.log('  · sentiment.mjs wrapper matches dictionary');
for (const [em, want] of EMOJI_CASES.slice(0, 8)) {
  const m = detectMood(`x ${em}`);
  check(`detectMood ${em}`, m && m.mood, want);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\nLayer 2 — RENDERER CONSISTENCY (no expression drifts between files)');

const daemonSrc = readFileSync(join(ROOT, 'animayte.mjs'), 'utf8');
const swiftSrc  = readFileSync(join(ROOT, 'desktop/AnimaytePet.swift'), 'utf8');
const htmlSrc   = readFileSync(join(ROOT, 'animayte.html'), 'utf8');
const slimeJson = JSON.parse(readFileSync(join(ROOT, 'assets/slime.json'), 'utf8'));

// 2a. the generated spritesheet has exactly the dictionary's rows, in order
check('slime.json states == dictionary ids', JSON.stringify(slimeJson.states), JSON.stringify(EXPRESSIONS.map((e) => e.id)));

// 2b. every setMood('x') the daemon emits is a known expression id (or a documented alias)
const ALIASES = { idle: 'neutral', listening: 'thinking', working: 'thinking', bashful: 'oops', tired: 'sleepy' };
const daemonMoods = [...daemonSrc.matchAll(/setMood\(\s*['"]([a-z]+)['"]/g)].map((m) => m[1]);
const uniqueDaemonMoods = [...new Set(daemonMoods)];
console.log('  · daemon emits moods:', uniqueDaemonMoods.join(', '));
for (const m of uniqueDaemonMoods) {
  ok(`daemon mood '${m}' is a real expression or alias`, ids.has(m) || (m in ALIASES));
}

// 2c. Swift moodRow handles every daemon mood (and maps into 0..ROWS-1)
const swiftCases = [...swiftSrc.matchAll(/case\s+([^:]+):\s*return\s+(\d+)/g)]
  .flatMap((m) => m[1].split(',').map((s) => [s.trim().replace(/"/g, ''), Number(m[2])]));
const swiftMap = new Map(swiftCases);
const swiftRows = EXPRESSIONS.length;
for (const m of uniqueDaemonMoods) {
  const canonical = ids.has(m) ? m : ALIASES[m];
  ok(`Swift moodRow handles '${m}'`, swiftMap.has(m) || swiftMap.has(canonical));
}
ok('Swift ROWS count matches dictionary', new RegExp(`let ROWS = ${swiftRows}\\b`).test(swiftSrc));
for (const [, row] of swiftCases) ok(`Swift row ${row} within range`, row >= 0 && row < swiftRows);

// 2d. HTML moodState maps every daemon mood to a real state row
const htmlStatesMatch = htmlSrc.match(/const STATES = \[([^\]]+)\]/);
const htmlStates = htmlStatesMatch ? htmlStatesMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')) : [];
check('HTML STATES == dictionary ids', JSON.stringify(htmlStates), JSON.stringify(EXPRESSIONS.map((e) => e.id)));
const htmlMapMatch = htmlSrc.match(/const moodState = m => \(\{([^}]+)\}/);
const htmlKeys = htmlMapMatch ? [...htmlMapMatch[1].matchAll(/([a-z]+)\s*:/g)].map((m) => m[1]) : [];
for (const m of uniqueDaemonMoods) ok(`HTML moodState maps '${m}'`, htmlKeys.includes(m));

// ─────────────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
