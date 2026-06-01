/*
 * dev-only EXHAUSTIVE audit (NOT shipped) — proves the Art library is internally
 * consistent end-to-end, with NO browser. Checks:
 *   1. every face-feature key the families/dictionary reference actually exists in
 *      grid/face.mjs (no silent 'dots'/'neutral' fallback hiding a typo)
 *   2. every vocabulary.ITEMS name has a non-empty sprite in grid/props.mjs
 *   3. composeExpression over the FULL axis grid: never throws, every resolved face
 *      uses only real keys, FX invariants hold (flash ⇒ external+negative, etc.)
 *   4. familyOf is total + matches the documented ladder
 *   5. the dashboard's hardcoded FAM_SPEC really resolves to the family it labels
 *      and carries the FX badge it advertises
 *   6. composed cells never collide off-grid; face cells stay in-bounds
 *   node grid/_audit.mjs
 */
import { writeFileSync } from 'node:fs';
import { EYES, BROWS, MOUTH, composeFace } from './face.mjs';
import { PROPS, propCells } from './props.mjs';
import { FAMILY, familyOf, composeExpression } from './compose.mjs';
import { compose, GRID } from './creature.mjs';
import { EXPRESSIONS, byId } from '../lib/expressions.mjs';
import { ITEMS, AROUSAL, CAUSE, EXPECTEDNESS } from '../lib/vocabulary.mjs';

let pass = 0, fail = 0;
const fails = [];
const ok = (cond, msg) => { if (cond) pass++; else { fail++; fails.push(msg); } };
const section = (s) => process.stdout.write(`\n── ${s} ──\n`);

// face-feature key sets that actually exist
const EYE_KEYS = new Set(Object.keys(EYES));
const BROW_KEYS = new Set(Object.keys(BROWS));
const MOUTH_KEYS = new Set(Object.keys(MOUTH));
const ACCENTS = ['blush', 'flush', 'sweat', 'zzz'];

function checkFaceKeys(label, face) {
  if (face.eyes !== undefined) ok(EYE_KEYS.has(face.eyes), `${label}: eyes '${face.eyes}' missing from EYES`);
  if (face.brows !== undefined) ok(BROW_KEYS.has(face.brows), `${label}: brows '${face.brows}' missing from BROWS`);
  if (face.mouth !== undefined) ok(MOUTH_KEYS.has(face.mouth), `${label}: mouth '${face.mouth}' missing from MOUTH`);
}

// ── 1. dictionary + family faces use only real keys ───────────────────────────────
section('1. feature keys resolve (no silent fallback)');
for (const ex of EXPRESSIONS) checkFaceKeys(`dict:${ex.id}`, ex.face);
for (const [fam, face] of Object.entries(FAMILY)) checkFaceKeys(`family:${fam}`, face);
process.stdout.write(`  dict=${EXPRESSIONS.length} families=${Object.keys(FAMILY).length} eyes=${EYE_KEYS.size} brows=${BROW_KEYS.size} mouths=${MOUTH_KEYS.size}\n`);

// ── 2. every ITEM has a real sprite ───────────────────────────────────────────────
section('2. every vocabulary.ITEMS prop draws');
for (const it of ITEMS) {
  ok(!!PROPS[it], `item '${it}' has no entry in PROPS`);
  const cells = propCells(it);
  ok(Array.isArray(cells) && cells.length > 0, `item '${it}' renders 0 cells`);
}
// nothing in PROPS that vocabulary doesn't know about (drift the other way)
for (const name of Object.keys(PROPS)) ok(ITEMS.includes(name), `PROPS has '${name}' not in vocabulary.ITEMS (drift)`);
process.stdout.write(`  items=${ITEMS.length} props=${Object.keys(PROPS).length}\n`);

// ── 3. composeExpression over the FULL axis grid ──────────────────────────────────
section('3. composeExpression — full axis sweep');
const VALENCES = [-1, -0.6, -0.3, -0.1, 0, 0.1, 0.3, 0.6, 1];
const AROUSALS = Object.values(AROUSAL);            // 0,1,2
let combos = 0, threw = 0;
for (const ex of EXPRESSIONS) {
  for (const valence of VALENCES) {
    for (const arousal of AROUSALS) {
      for (const cause of CAUSE) {                   // self, external, user, none
        for (const expectedness of EXPECTEDNESS) {   // routine, surprising
          for (const item of [null, 'hammer']) {
            combos++;
            const spec = { expression: ex.id, valence, arousal, cause, expectedness, item };
            let out;
            try { out = composeExpression(spec); }
            catch (e) { threw++; fails.push(`THREW ${JSON.stringify(spec)} → ${e.message}`); fail++; continue; }
            // a) shape
            ok(out && out.face && out.fx !== undefined, `no shape for ${JSON.stringify(spec)}`);
            // b) face keys all real
            checkFaceKeys(`combo`, out.face);
            // c) FX invariants
            if (out.fx.flash) ok(valence < 0 && cause === 'external', `flash fired wrongly @ ${JSON.stringify(spec)}`);
            if (out.fx.burst) ok(valence > 0 && arousal >= 2, `burst fired wrongly @ ${JSON.stringify(spec)}`);
            if (out.fx.shake !== undefined) ok(out.fx.shake > 0 && out.fx.shake <= 1, `shake out of range @ ${JSON.stringify(spec)}`);
            // d) self-caused NEVER gets the red flash (the core "not the world's fault" rule)
            if (cause === 'self' || cause === 'user') ok(!out.fx.flash, `self/user got flash @ ${JSON.stringify(spec)}`);
            // e) surprising ⇒ eyes go wide (documented stomp)
            if (expectedness === 'surprising') ok(out.face.eyes === 'wide', `surprising didn't widen eyes @ ${JSON.stringify(spec)}`);
            // f) item passes through
            ok(out.item === item, `item not passed through @ ${JSON.stringify(spec)}`);
            // g) cells render in-bounds
            const cells = compose(out.face, { props: item ? [item] : [] });
            for (const c of cells) if (c.x < 0 || c.x >= GRID.w || c.y < 0 || c.y >= GRID.h) { ok(false, `cell off-grid (${c.x},${c.y}) @ ${JSON.stringify(spec)}`); break; }
          }
        }
      }
    }
  }
}
process.stdout.write(`  swept ${combos} specs · threw ${threw}\n`);

// ── 4. familyOf is total + matches the ladder ─────────────────────────────────────
section('4. familyOf ladder');
ok(familyOf({ expression: 'happy', valence: 0.3, arousal: 0 }) === 'content', 'happy/low → content');
ok(familyOf({ expression: 'happy', valence: 0.6, arousal: 1 }) === 'pleased', 'happy/mid → pleased');
ok(familyOf({ expression: 'excited', valence: 1, arousal: 2 }) === 'thrilled', 'excited/high → thrilled');
ok(familyOf({ expression: 'sad', valence: -0.6, arousal: 1, cause: 'external' }) === 'concerned', 'sad/external → concerned');
ok(familyOf({ expression: 'sad', valence: -0.5, arousal: 1, cause: 'self' }) === 'determined', 'sad/self → determined');
ok(familyOf({ expression: 'oops', valence: -0.4, arousal: 1, cause: 'self' }) === 'sheepish', 'oops/self → sheepish');
ok(familyOf({ expression: 'neutral', valence: 0, arousal: 0 }) === null, 'neutral → null (base face)');
ok(familyOf({ expression: 'thinking', valence: 0, arousal: 1 }) === null, 'thinking → null');
ok(familyOf({ expression: 'sleepy', valence: 0, arousal: 0 }) === null, 'sleepy → null');

// ── 5. dashboard FAM_SPEC honesty (mirror the table in dashboard.html) ─────────────
section('5. dashboard FAM_SPEC resolves to its label + advertised FX');
const FAM_SPEC = {
  content:    { expression: 'happy',   valence: 0.35, arousal: 0, cause: 'none' },
  pleased:    { expression: 'happy',   valence: 0.6,  arousal: 1, cause: 'none' },
  thrilled:   { expression: 'excited', valence: 1.0,  arousal: 2, cause: 'none' },
  determined: { expression: 'sad',     valence: -0.5, arousal: 1, cause: 'self' },
  concerned:  { expression: 'sad',     valence: -0.6, arousal: 1, cause: 'external' },
  sheepish:   { expression: 'oops',    valence: -0.4, arousal: 1, cause: 'self' },
};
// the FX badges the dashboard prints for each (must match what compose actually yields)
const ADVERTISED = {
  content: ['blush'], pleased: ['blush'], thrilled: ['burst', 'blush'],
  determined: ['shake', 'sweat'], concerned: ['flash', 'shake'], sheepish: ['shake', 'sweat', 'blush'],
};
for (const [fam, spec] of Object.entries(FAM_SPEC)) {
  ok(familyOf(spec) === fam, `FAM_SPEC[${fam}] resolves to '${familyOf(spec)}' not '${fam}'`);
  const { face, fx } = composeExpression(spec);
  const got = [];
  if (fx.flash) got.push('flash'); if (fx.burst) got.push('burst'); if (fx.shake) got.push('shake');
  if (face.sweat) got.push('sweat'); if (face.flush) got.push('flush'); else if (face.blush) got.push('blush');
  if (face.zzz) got.push('zzz');
  const want = ADVERTISED[fam];
  const same = got.length === want.length && want.every((w) => got.includes(w));
  ok(same, `FAM_SPEC[${fam}] FX got [${got}] but dashboard advertises [${want}]`);
}

// ── 6. accent flags only ever true/undefined ──────────────────────────────────────
section('6. accent flags are booleans');
for (const [fam, face] of Object.entries(FAMILY)) for (const a of ACCENTS)
  if (face[a] !== undefined) ok(face[a] === true, `family:${fam} accent ${a} not boolean true`);

// dedupe + structured dump (text channel garbles; JSON is reliable)
const uniq = [...new Set(fails)];
writeFileSync('/tmp/audit_fails.json', JSON.stringify({ pass, fail, uniqueFails: uniq }, null, 2));

// ── report ────────────────────────────────────────────────────────────────────────
process.stdout.write(`\n${'='.repeat(50)}\n`);
if (fail === 0) process.stdout.write(`✅  AUDIT GREEN — ${pass} checks passed\n`);
else {
  process.stdout.write(`❌  ${fail} FAILED / ${pass} passed\n`);
  for (const f of fails.slice(0, 40)) process.stdout.write(`   · ${f}\n`);
  if (fails.length > 40) process.stdout.write(`   … +${fails.length - 40} more\n`);
}
process.exit(fail === 0 ? 0 : 1);
