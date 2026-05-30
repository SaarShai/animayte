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
import { readPngHeader, hexToRgba } from '../lib/anim/png.mjs';
import { composite, swapPalette, buildSwap, computeOutline, alphaMask } from '../lib/anim/compositor.mjs';
import { contactSheet, clipFilmstrip, squashStrip } from '../tools/preview.mjs';
import { EXPRESSIONS } from '../lib/expressions.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
console.log('\nEngine — COMPILER + PREVIEW (A6: the "I can SEE it" loop)');

console.log('  · baked assets are valid PNGs (back-compat for thin renderers)');
const slimePng = readPngHeader(readFileSync(join(ROOT, 'assets/slime.png')));
ok('slime.png has a valid PNG signature', slimePng.sig === true);
ok('slime.png is 256×512 (4 frames × 8 expressions @64px)', slimePng.width === 256 && slimePng.height === 512);
ok('slime.png is 8-bit RGBA (colorType 6)', slimePng.bitDepth === 8 && slimePng.colorType === 6);
const birdPng = readPngHeader(readFileSync(join(ROOT, 'assets/bird.png')));
ok('bird.png is a valid 48×24 PNG', birdPng.sig && birdPng.width === 48 && birdPng.height === 24);

console.log('  · the emitted manifest on disk validates');
const onDisk = JSON.parse(readFileSync(join(ROOT, 'pets/slime/pet.json'), 'utf8'));
ok('pets/slime/pet.json validates', validateManifest(onDisk).length === 0);
ok('on-disk manifest matches buildSlimeManifest()', JSON.stringify(onDisk) === JSON.stringify(buildSlimeManifest()));

console.log('  · preview renders readable PNGs with correct dimensions');
const cs = contactSheet({ scale: 2 });
const csH = readPngHeader(cs.png);
ok('contact-sheet PNG header matches returned dims', csH.sig && csH.width === cs.w && csH.height === cs.h);
ok('contact-sheet has a row per expression', cs.rows === EXPRESSIONS.length && cs.cols === 4);

const f6 = clipFilmstrip('react', { steps: 6, scale: 3 });
ok('filmstrip width === steps × cell × scale (6×64×3)', f6.w === 6 * 64 * 3);
const f6H = readPngHeader(f6.png);
ok('filmstrip PNG header matches returned dims', f6H.sig && f6H.width === f6.w && f6H.height === f6.h);
const f10 = clipFilmstrip('react', { steps: 10, scale: 3 });
ok('filmstrip width scales with frame count', f10.w === 10 * 64 * 3 && f10.w > f6.w);
ok('unknown clip throws a clear error', (() => { try { clipFilmstrip('nope'); return false; } catch (e) { return /unknown clip/.test(e.message); } })());
ok('squashStrip renders a valid PNG', readPngHeader(squashStrip({ steps: 5 }).png).sig === true);

// ───────────────────────────────────────────────────────────────────────────
console.log('\nEngine — COMPOSITOR + PALETTE SWAP (A3)');

// tiny RGBA buffer helpers
const buf = (W, H) => new Uint8Array(W * H * 4);
const setPx = (b, W, x, y, c) => { const i = (y * W + x) * 4; b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = c[3] ?? 255; };
const getPx = (b, W, x, y) => { const i = (y * W + x) * 4; return [b[i], b[i + 1], b[i + 2], b[i + 3]]; };
const eqPx = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

console.log('  · composite stacks layers bottom→top (exact pixels)');
{
  const W = 2, H = 1;
  const A = buf(W, H); setPx(A, W, 0, 0, [255, 0, 0, 255]); setPx(A, W, 1, 0, [255, 0, 0, 255]); // red base
  const B = buf(W, H); setPx(B, W, 0, 0, [0, 0, 255, 255]); setPx(B, W, 1, 0, [0, 255, 0, 128]); // blue opaque + half green
  const out = composite([A, B], W, H);
  ok('opaque top layer fully covers', eqPx(getPx(out, W, 0, 0), [0, 0, 255, 255]));
  // α=128/255 → R=255·(127/255)=127, G=255·(128/255)=128, over an opaque red base
  ok('half-alpha green over red = exact blend [127,128,0,255]', eqPx(getPx(out, W, 1, 0), [127, 128, 0, 255]));
}
{
  const W = 1, H = 1;
  const A = buf(W, H); setPx(A, W, 0, 0, [10, 20, 30, 255]);
  const out = composite([A, buf(W, H)], W, H); // empty top layer changes nothing
  ok('empty/transparent layer is a no-op', eqPx(getPx(out, W, 0, 0), [10, 20, 30, 255]));
}

console.log('  · indexed palette-swap re-indexes ramp colors, keeps alpha');
{
  const W = 3, H = 1;
  const from = { base: '#5BC661', shadow: '#2E7D4F' };
  const to = { base: '#E04A4A', shadow: '#8E2C30' };
  const swap = buildSwap(from, to);
  ok('buildSwap covers every shared role', swap.size === 2);
  const b = buf(W, H);
  setPx(b, W, 0, 0, hexToRgba('#5BC661'));      // base
  setPx(b, W, 1, 0, [...hexToRgba('#2E7D4F').slice(0, 3), 128]); // shadow @ half alpha
  setPx(b, W, 2, 0, [10, 10, 10, 255]);         // unmapped color
  swapPalette(b, swap);
  ok('base re-indexed', eqPx(getPx(b, W, 0, 0), hexToRgba('#E04A4A')));
  ok('shadow re-indexed, alpha preserved', eqPx(getPx(b, W, 1, 0), [...hexToRgba('#8E2C30').slice(0, 3), 128]));
  ok('unmapped color untouched', eqPx(getPx(b, W, 2, 0), [10, 10, 10, 255]));
}
{
  // every ramp color of the real calm palette maps under a calm→tired swap
  const m = buildSlimeManifest();
  const swap = buildSwap(m.palettes.calm, m.palettes.tired);
  const calmRoles = Object.keys(m.palettes.calm);
  // some roles legitimately share a color (eyeDark == outline == the dark ink), and a
  // swap is keyed by color → assert every DISTINCT calm color is mapped.
  const distinct = new Set(calmRoles.map((r) => { const c = hexToRgba(m.palettes.calm[r]); return (c[0] << 16) | (c[1] << 8) | c[2]; }));
  ok('calm→tired swap maps every distinct calm ramp color', swap.size === distinct.size);
  const probe = buf(1, 1); setPx(probe, 1, 0, 0, hexToRgba(m.palettes.calm.base));
  swapPalette(probe, swap);
  ok('a calm-base pixel becomes the tired-base color', eqPx(getPx(probe, 1, 0, 0), hexToRgba(m.palettes.tired.base)));
}

console.log('  · computeOutline produces a 1px silhouette ring');
{
  const W = 5, H = 5;
  const b = buf(W, H); setPx(b, W, 2, 2, [100, 200, 100, 255]); // single solid pixel
  const out = computeOutline(b, W, H, '#16352B');
  const ink = hexToRgba('#16352B');
  ok('4-neighbour above is outline', eqPx(getPx(out, W, 2, 1), ink));
  ok('4-neighbour left is outline', eqPx(getPx(out, W, 1, 2), ink));
  ok('the solid pixel itself is NOT outline', getPx(out, W, 2, 2)[3] === 0);
  ok('a diagonal-only neighbour is NOT outline (4-conn)', getPx(out, W, 1, 1)[3] === 0);
  ok('a far pixel is NOT outline', getPx(out, W, 0, 0)[3] === 0);
  const outD = computeOutline(b, W, H, '#16352B', { diagonal: true });
  ok('diagonal mode fills the corner', eqPx(getPx(outD, W, 1, 1), ink));
}
ok('alphaMask flags solids', (() => { const W = 2, H = 1; const b = buf(W, H); setPx(b, W, 0, 0, [1, 2, 3, 255]); const m = alphaMask(b, W, H); return m[0] === 1 && m[1] === 0; })());

// ───────────────────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${total} engine checks — ${pass} passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
