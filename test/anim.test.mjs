#!/usr/bin/env node
/*
 * animayte — ANIMATION ENGINE unit tests (pure logic, fast, no server).
 *   node test/anim.test.mjs
 *
 * Covers lib/anim/*: easing curves, volume-conserving transforms + track sampling,
 * the pet manifest schema/validator, the compositor + palette swap, and the
 * idle/reaction state machine. Grows as the engine grows (Tracks A/C).
 */
import {
  EASINGS, ease, easeOutBack, easeOutBounce, easeOutElastic, isEasing, clamp01,
} from '../lib/anim/easing.mjs';
import {
  identity, squash, squashRound, compose, composeAll, lerpTransform, sampleTrack, applyToBox,
} from '../lib/anim/transform.mjs';
import { validateManifest, assertManifest, buildSlimeManifest, FORMAT } from '../lib/anim/manifest.mjs';
import { EXPRESSIONS } from '../lib/expressions.mjs';

let pass = 0, fail = 0; const fails = [];
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}`); } }
function near(name, got, want, eps = 1e-6) {
  if (approx(got, want, eps)) pass++;
  else { fail++; fails.push(`  ✗ ${name}\n      got:  ${got}\n      want: ${want} (±${eps})`); }
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEngine — EASING');

// every curve pins the endpoints (overshoot curves still land exactly on 0 and 1)
console.log('  · all curves map 0→0 and 1→1');
for (const [name, fn] of Object.entries(EASINGS)) {
  near(`${name}(0) === 0`, fn(0), 0, 1e-6);
  near(`${name}(1) === 1`, fn(1), 1, 1e-6);
}

// midpoints / known reference values
console.log('  · known reference points');
near('linear(0.5) = 0.5', ease('linear', 0.5), 0.5);
near('easeInQuad(0.5) = 0.25', ease('easeInQuad', 0.5), 0.25);
near('easeOutQuad(0.5) = 0.75', ease('easeOutQuad', 0.5), 0.75);
near('easeInOutSine(0.5) = 0.5', ease('easeInOutSine', 0.5), 0.5, 1e-9);
ok('easeOutBack overshoots above 1 before settling', easeOutBack(0.7) > 1);
ok('easeOutElastic oscillates above 1', easeOutElastic(0.4) > 1);
ok('easeOutBounce stays within [0,1]', (() => { for (let i = 0; i <= 20; i++) { const v = easeOutBounce(i / 20); if (v < -1e-9 || v > 1 + 1e-9) return false; } return true; })());

console.log('  · ease() helper');
ok('unknown easing falls back to linear', ease('nope', 0.42) === 0.42);
ok('ease() clamps t into [0,1]', ease('linear', 2) === 1 && ease('linear', -1) === 0);
ok('isEasing knows real + rejects fake', isEasing('easeOutBack') && !isEasing('wobble'));
ok('clamp01 clamps', clamp01(-3) === 0 && clamp01(3) === 1 && clamp01(0.3) === 0.3);

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEngine — TRANSFORM');

console.log('  · squash conserves volume (sx·sy ≡ 1)');
for (const k of [-0.5, -0.2, 0, 0.3, 0.8, 1.5]) {
  const s = squash(k);
  near(`squash(${k}): width×height ≈ 1`, s.sx * s.sy, 1, 1e-9);
  ok(`squash(${k}): k>0 ⇒ taller, k<0 ⇒ shorter`, k > 0 ? s.sy > 1 && s.sx < 1 : k < 0 ? s.sy < 1 && s.sx > 1 : s.sy === 1);
}
ok('squash never collapses to non-positive scale', squash(-5).sy > 0 && squash(-5).sx > 0);

console.log('  · squashRound conserves round volume (sx²·sy ≡ 1)');
for (const k of [-0.3, 0, 0.5, 1.0]) {
  const s = squashRound(k);
  near(`squashRound(${k}): sx²·sy ≈ 1`, s.sx * s.sx * s.sy, 1, 1e-9);
}

console.log('  · compose / lerp');
const c = compose(squash(0.5), { sx: 2, sy: 2, tx: 3, ty: -4, rot: 0.1 });
near('compose multiplies sx', c.sx, (1 / 1.5) * 2);
near('compose multiplies sy', c.sy, 1.5 * 2);
near('compose adds tx', c.tx, 3);
near('compose adds rot', c.rot, 0.1);
ok('composeAll(identity) is identity', JSON.stringify(composeAll(identity())) === JSON.stringify(identity()));
const lt = lerpTransform(identity(), { sx: 3, sy: 3, tx: 10, ty: 10, rot: 1 }, 0.5);
near('lerpTransform midpoint sx', lt.sx, 2);
near('lerpTransform midpoint tx', lt.tx, 5);
ok('lerpTransform clamps t', lerpTransform(identity(), scaleT(), 5).sx === 4);
function scaleT() { return { sx: 4, sy: 4, tx: 0, ty: 0, rot: 0 }; }

console.log('  · sampleTrack keyframe interpolation');
const track = [
  { t: 0, sy: 1 },
  { t: 0.5, sy: 1.4, ease: 'linear' },
  { t: 1, sy: 1, ease: 'linear' },
];
near('track @0 = first key', sampleTrack(track, 0).sy, 1);
near('track @0.5 = middle key', sampleTrack(track, 0.5).sy, 1.4);
near('track @0.25 lerps halfway (linear)', sampleTrack(track, 0.25).sy, 1.2);
near('track @1 = last key', sampleTrack(track, 1).sy, 1);
near('track clamps below 0', sampleTrack(track, -1).sy, 1);
near('track clamps above 1', sampleTrack(track, 2).sy, 1);
ok('empty track → identity', JSON.stringify(sampleTrack([], 0.5)) === JSON.stringify(identity()));
ok('single-key track → that key (filled)', sampleTrack([{ t: 0, sx: 2 }], 0.9).sx === 2);

console.log('  · applyToBox geometry');
const box = { x: 0, y: 0, w: 64, h: 64 };
const r0 = applyToBox(identity(), box);
ok('identity transform leaves box unchanged', r0.x === 0 && r0.y === 0 && r0.w === 64 && r0.h === 64);
const rs = applyToBox(squash(-0.5), box);          // shorter + wider, anchored bottom-centre
ok('squash widens around bottom-centre', rs.w > 64 && rs.h < 64);
near('bottom edge stays planted after squash', rs.y + rs.h, 64, 1e-6);

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEngine — MANIFEST (pet-pack schema)');

const slime = buildSlimeManifest();

console.log('  · the generated slime manifest is valid');
ok('buildSlimeManifest validates clean', validateManifest(slime).length === 0);
ok('assertManifest returns the manifest when valid', assertManifest(slime) === slime);
ok('format tag is the expected version', slime.format === FORMAT);

console.log('  · round-trips all 8 dictionary expressions');
for (const ex of EXPRESSIONS) {
  const m = slime.expressions[ex.id];
  ok(`expression "${ex.id}" present`, !!m);
  ok(`expression "${ex.id}" keeps eyes`, m && m.eyes === ex.face.eyes);
  ok(`expression "${ex.id}" keeps mouth`, m && m.mouth === ex.face.mouth);
  if (ex.face.brows) ok(`expression "${ex.id}" keeps brows`, m && m.brows === ex.face.brows);
  for (const a of ['blush', 'flush', 'sweat', 'zzz']) {
    if (ex.face[a]) ok(`expression "${ex.id}" keeps accent ${a}`, m && Array.isArray(m.accents) && m.accents.includes(a));
  }
}
ok('expression count matches the dictionary', Object.keys(slime.expressions).length === EXPRESSIONS.length);

console.log('  · each invalid field is rejected with a path-specific message');
// helper: clone valid manifest, apply a mutation, assert ≥1 error mentions `pathHint`
const clone = (o) => JSON.parse(JSON.stringify(o));
function rejects(label, mutate, pathHint) {
  const m = clone(slime);
  mutate(m);
  const errs = validateManifest(m);
  const hit = errs.some((e) => e.includes(pathHint));
  if (hit) pass++;
  else { fail++; fails.push(`  ✗ ${label}\n      expected an error mentioning "${pathHint}"\n      got: ${JSON.stringify(errs)}`); }
}
rejects('bad format', (m) => { m.format = 'nope'; }, 'format');
rejects('missing name', (m) => { delete m.name; }, 'name');
rejects('non-integer cell', (m) => { m.cell = 1.5; }, 'cell');
rejects('unknown layer', (m) => { m.layers.push('tail'); }, 'layers[');
rejects('empty palettes', (m) => { m.palettes = {}; }, 'palettes');
rejects('bad hex color', (m) => { m.palettes.calm.base = 'green'; }, 'palettes.calm.base');
rejects('defaultPalette not defined', (m) => { m.defaultPalette = 'ghost'; }, 'defaultPalette');
rejects('palettes must share roles', (m) => { delete m.palettes.tired.rim; }, 'palettes.tired');
rejects('expression missing eyes', (m) => { delete m.expressions.neutral.eyes; }, 'expressions.neutral.eyes');
rejects('expression unknown accent', (m) => { m.expressions.happy.accents = ['glitter']; }, 'accents[0]');
rejects('clip with no frames', (m) => { m.clips.idle.frames = []; }, 'clips.idle.frames');
rejects('clip frame with bad dur', (m) => { m.clips.idle.frames[0].dur = -5; }, 'clips.idle.frames[0].dur');
rejects('track keyframe t out of range', (m) => { m.clips.idle.tracks.body[0].t = 5; }, '.t');
rejects('track keyframe unknown easing', (m) => { m.clips.idle.tracks.body[1].ease = 'boing'; }, '.ease');
rejects('reaction references unknown clip', (m) => { m.reactions = { Boom: { clip: 'kaboom' } }; }, 'reactions.Boom.clip');
rejects('idle.base references unknown clip', (m) => { m.idle.base = 'nope'; }, 'idle.base');
ok('non-object manifest → single clear error', validateManifest(42).length === 1);
ok('assertManifest throws on invalid', (() => { try { assertManifest({ format: 'x' }); return false; } catch { return true; } })());

// ───────────────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${total} engine checks — ${pass} passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
