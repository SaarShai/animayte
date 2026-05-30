#!/usr/bin/env node
/*
 * animayte asset generator — zero dependencies (Node built-ins only).
 *
 * Draws the slime body + a FACE PER EXPRESSION, where the expressions and their
 * facial features come from the dictionary in  lib/expressions.mjs  (single source
 * of truth). Each face is modeled on the matching APPLE emoji. Edit the dictionary
 * to change the pet's emotions, then re-run:  node tools/make-assets.mjs
 *
 * Output: assets/slime.png (one row per expression), assets/slime.json, assets/bird.png
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPRESSIONS } from '../lib/expressions.mjs';
import { Canvas, encodePNG } from '../lib/anim/png.mjs';
import { buildSlimeManifest, buildBeanManifest, validateManifest } from '../lib/anim/manifest.mjs';
import { PROPS, PROP_CELL, drawProp } from './draw-props.mjs';
import { makeFaceLib } from './draw-faces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
mkdirSync(OUT, { recursive: true });

// ---------- palette (§4.2 hue-shifted role ramp) ----------
// Sourced from the manifest's `calm` palette so the BAKED sheet is drawn in the exact
// role colors the runtime's indexed palette-swap expects — sheet + mood-swap stay locked.
// cool shadows → saturated mid → warm near-yellow rim highlight (reads as real light).
const hx = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), h.length >= 9 ? parseInt(h.slice(7, 9), 16) : 255];
const _M = buildSlimeManifest();
const CAL = _M.palettes.calm, AC = _M.accentColors;
const P = {
  rim: hx(CAL.rim), lite: hx(CAL.highlight), base: hx(CAL.base), mid: hx(CAL.shadow), dark: hx(CAL.shadowCool), out: hx(CAL.outline),
  white: hx(CAL.catchlight), pup: hx(CAL.eyeDark), cheek: hx(CAL.blush), flush: hx(CAL.blush),
  mouth: hx(CAL.outline), tongue: [232, 120, 145],
  sweat: hx(AC.sweat), star: hx(AC.warm), shadow: hx(CAL.dropShadow),
  birdB: [126, 170, 255], birdD: [92, 140, 250], beak: [255, 179, 71], birdEye: [30, 46, 74],
};
// the shared face library, drawn in THIS pet's palette (same craft, re-skinned)
const { drawEyes, drawBrows, drawMouth, drawAccents } = makeFaceLib(P);

// ---------- bean pet (amber) — proves the library re-skins onto a different body ----------
const BCAL = buildBeanManifest().palettes.calm;
const BP = {
  rim: hx(BCAL.rim), lite: hx(BCAL.highlight), base: hx(BCAL.base), mid: hx(BCAL.shadow), dark: hx(BCAL.shadowCool), out: hx(BCAL.outline),
  white: hx(BCAL.catchlight), pup: hx(BCAL.eyeDark), cheek: hx(BCAL.blush), flush: hx(BCAL.blush),
  mouth: hx(BCAL.outline), tongue: [232, 120, 145], sweat: hx(AC.sweat), star: hx(AC.warm), shadow: hx(BCAL.dropShadow),
};
const beanFaces = makeFaceLib(BP);

export const FRAMES = 4;
export const CELL = 64;
export const STATES = EXPRESSIONS.map((e) => e.id);

// ---------- body silhouette (rounded narrow crown, wide flat base) ----------
function slimeHalfWidth(t, RX) { const s = Math.sin(0.30 + t * (Math.PI / 2 - 0.30)); return RX * Math.pow(s, 0.62); }
// bean: an upright rounded egg — wide rounded middle, tapering to soft rounded ends
function beanHalfWidth(t, RX) { return RX * Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 4))); }

// ---------- one slime cell ----------
export function drawSlime(C, ox, oy, expr, frame) {
  const p = frame / FRAMES;
  const wob = Math.sin(p * Math.PI * 2);
  const hop = Math.max(0, Math.sin(p * Math.PI)) * 2;
  const cx = ox + 32;
  const baseY = oy + 58 - hop;
  const RX = 26 * (1 + 0.05 * wob);
  const BH = 42 * (1 - 0.045 * wob);
  const topY = baseY - BH;

  // shadow
  for (let x = -25; x <= 25; x++) { const w = Math.round(Math.sqrt(Math.max(0, 1 - (x / 25) ** 2)) * 3.4); const fade = 1 - hop / 4; for (let y = -w; y <= w; y++) C.px(cx + x, oy + 61 + y, [P.shadow[0], P.shadow[1], P.shadow[2], P.shadow[3] * fade]); }

  // body
  const hwAt = (y) => slimeHalfWidth(Math.max(0, Math.min(1, (y - topY) / BH)), RX);
  for (let y = Math.floor(topY); y <= baseY; y++) {
    const drip = (y > topY + BH * 0.6) ? Math.sin((y - topY) * 0.9 + frame) * 0.8 : 0;
    const hw = hwAt(y) + drip; if (hw < 1) continue;
    const xl = Math.round(cx - hw), xr = Math.round(cx + hw);
    for (let x = xl; x <= xr; x++) {
      const edgeX = x === xl || x === xr;
      const edgeYtop = (hwAt(y - 1) + ((y - 1 > topY + BH * 0.6) ? Math.sin((y - 1 - topY) * 0.9 + frame) * 0.8 : 0)) < Math.abs(x - cx);
      const edge = edgeX || edgeYtop || y === baseY || y === Math.floor(topY);
      if (edge) { C.px(x, y, P.out); continue; }
      const ny = (y - topY) / BH;                       // 0 top → 1 bottom
      const nx = (x - cx) / Math.max(1, hw);            // -1 left → +1 right
      // hue-shifted ramp (§4.2): warm rim crown → highlight → base → cool shadow at the base.
      // Mostly vertical (light from above) with a gentle top-left lift — no hard seams.
      let col;
      if (ny < 0.10) col = P.rim;                       // bright gel crown
      else if (ny < 0.30) col = P.lite;
      else if (ny < 0.58) col = (nx < -0.35 && ny < 0.42) ? P.lite : P.base;  // subtle left lift
      else if (ny < 0.82) col = P.mid;
      else col = P.dark;                                // cool core shadow at the base
      C.px(x, y, col);
    }
  }
  const cy = topY + BH * 0.54;
  // small soft gel sheen + a 1px catchlight, upper-left (on-palette → survives a mood swap)
  for (let y = -5; y <= 3; y++) for (let x = -4; x <= 3; x++) if ((x / 4) ** 2 + (y / 5) ** 2 <= 1) C.px(cx - 9 + x, topY + 11 + y, [...P.rim, 55]);
  C.px(cx - 10, topY + 8, P.white); C.px(cx - 9, topY + 8, [...P.white, 150]);

  // ---- face (from the dictionary spec) ----
  const f = expr.face;
  const eyeY = Math.round(cy - 1);
  const exL = cx - 8, exR = cx + 8;
  const my = eyeY + 8;
  const blink = frame === 3;                          // a quick blink on the last frame
  drawBrows(C, f.brows, exL, exR, eyeY);
  drawEyes(C, f.eyes, exL, exR, eyeY, blink);
  drawMouth(C, f.mouth, cx, my);
  drawAccents(C, f, cx, cy, eyeY, RX);
}

function buildSlime() {
  const W = CELL * FRAMES, H = CELL * STATES.length;
  const C = Canvas(W, H);
  EXPRESSIONS.forEach((expr, r) => { for (let fr = 0; fr < FRAMES; fr++) drawSlime(C, fr * CELL, r * CELL, expr, fr); });
  const png = encodePNG(W, H, C.d);
  writeFileSync(join(OUT, 'slime.png'), png);                 // back-compat path for thin renderers
  writeFileSync(join(OUT, 'slime.json'), JSON.stringify({ cell: CELL, frames: FRAMES, states: STATES, apple: Object.fromEntries(EXPRESSIONS.map((e) => [e.id, e.apple])) }, null, 2));
  // self-contained pet pack: pets/slime/sheet.png (referenced by the manifest's `sheet`)
  const packDir = join(ROOT, 'pets', 'slime'); mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'sheet.png'), png);
  console.log(`slime.png  ${W}x${H}  rows: ${STATES.join(', ')}  (+ pets/slime/sheet.png)`);
}

// ---------- one bean cell (different body, SAME shared face lib) ----------
function drawBean(C, ox, oy, expr, frame) {
  const p = frame / FRAMES;
  const wob = Math.sin(p * Math.PI * 2);
  const hop = Math.max(0, Math.sin(p * Math.PI)) * 2;
  const cx = ox + 32;
  const baseY = oy + 60 - hop;
  const RX = 21 * (1 + 0.045 * wob);
  const BH = 48 * (1 - 0.04 * wob);
  const topY = baseY - BH;
  // shadow (narrower than the slime)
  for (let x = -20; x <= 20; x++) { const w = Math.round(Math.sqrt(Math.max(0, 1 - (x / 20) ** 2)) * 3.0); const fade = 1 - hop / 4; for (let y = -w; y <= w; y++) C.px(cx + x, oy + 61 + y, [BP.shadow[0], BP.shadow[1], BP.shadow[2], BP.shadow[3] * fade]); }
  // body — rounded egg; the bottom rounds off naturally as the half-width → 0
  const hwAt = (y) => beanHalfWidth(Math.max(0, Math.min(1, (y - topY) / BH)), RX);
  for (let y = Math.floor(topY); y <= baseY; y++) {
    const hw = hwAt(y); if (hw < 1) continue;
    const xl = Math.round(cx - hw), xr = Math.round(cx + hw);
    for (let x = xl; x <= xr; x++) {
      const edge = x === xl || x === xr || hwAt(y - 1) < Math.abs(x - cx) || hwAt(y + 1) < Math.abs(x - cx);
      if (edge) { C.px(x, y, BP.out); continue; }
      const ny = (y - topY) / BH, nx = (x - cx) / Math.max(1, hw);
      let col;
      if (ny < 0.10) col = BP.rim;
      else if (ny < 0.30) col = BP.lite;
      else if (ny < 0.58) col = (nx < -0.35 && ny < 0.42) ? BP.lite : BP.base;
      else if (ny < 0.82) col = BP.mid;
      else col = BP.dark;
      C.px(x, y, col);
    }
  }
  const cy = topY + BH * 0.52;
  for (let y = -5; y <= 3; y++) for (let x = -4; x <= 3; x++) if ((x / 4) ** 2 + (y / 5) ** 2 <= 1) C.px(cx - 8 + x, topY + 12 + y, [...BP.rim, 55]);
  C.px(cx - 9, topY + 9, BP.white); C.px(cx - 8, topY + 9, [...BP.white, 150]);
  // face — the SAME library, in the bean's palette
  const f = expr.face;
  const eyeY = Math.round(cy - 1);
  const exL = cx - 8, exR = cx + 8;
  const my = eyeY + 8;
  const blink = frame === 3;
  beanFaces.drawBrows(C, f.brows, exL, exR, eyeY);
  beanFaces.drawEyes(C, f.eyes, exL, exR, eyeY, blink);
  beanFaces.drawMouth(C, f.mouth, cx, my);
  beanFaces.drawAccents(C, f, cx, cy, eyeY, RX);
}

function buildBean() {
  const W = CELL * FRAMES, H = CELL * STATES.length;
  const C = Canvas(W, H);
  EXPRESSIONS.forEach((expr, r) => { for (let fr = 0; fr < FRAMES; fr++) drawBean(C, fr * CELL, r * CELL, expr, fr); });
  const dir = join(ROOT, 'pets', 'bean'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sheet.png'), encodePNG(W, H, C.d));
  writeFileSync(join(dir, 'props.png'), renderPropStrip());   // props are pet-agnostic
  console.log(`bean       ${W}x${H}  → pets/bean/ (reuses the shared face lib + full animation library)`);
}

// ---------- bird (sub-agent) ----------
function drawBird(C, ox, oy, up) {
  const cx = ox + 12, cy = oy + 12;
  for (let y = -5; y <= 5; y++) for (let x = -6; x <= 6; x++) if ((x / 6) ** 2 + (y / 5) ** 2 <= 1) C.px(cx + x, cy + y, (x / 6) ** 2 + (y / 5) ** 2 > 0.7 ? P.birdD : P.birdB);
  C.px(cx + 4, cy - 2, P.birdEye); C.px(cx + 4, cy - 1, P.birdEye);
  C.px(cx + 7, cy, P.beak); C.px(cx + 8, cy, P.beak); C.px(cx + 7, cy + 1, [220, 150, 50]);
  const wy = up ? -5 : 4;
  for (let x = -3; x <= 1; x++) { C.px(cx + x - 4, cy + wy, P.birdD); C.px(cx + x - 4, cy + wy + (up ? 1 : -1), P.birdB); }
}
function buildBird() { const C = Canvas(48, 24); drawBird(C, 0, 0, true); drawBird(C, 24, 0, false); writeFileSync(join(OUT, 'bird.png'), encodePNG(48, 24, C.d)); console.log('bird.png   48x24'); }

// ---------- prop / emote overlay strip (§4.5) — pet-agnostic ----------
function renderPropStrip() {
  const W = PROP_CELL * PROPS.length, H = PROP_CELL;
  const C = Canvas(W, H);
  PROPS.forEach((name, i) => drawProp(C, i * PROP_CELL, 0, name));
  return encodePNG(W, H, C.d);
}
function buildProps() {
  const png = renderPropStrip();
  writeFileSync(join(OUT, 'props.png'), png);
  const packDir = join(ROOT, 'pets', 'slime'); mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'props.png'), png);
  console.log(`props.png  ${PROP_CELL * PROPS.length}x${PROP_CELL}  ${PROPS.length} props: ${PROPS.join(', ')}`);
}

// ---------- pet manifest (the data-driven pet-pack) ----------
// Generated from the SAME EXPRESSIONS source of truth, so the baked spritesheet and
// the manifest never disagree. Validated before writing — never emit a bad pack.
function emitManifest(name, m) {
  const errs = validateManifest(m);
  if (errs.length) { console.error(`✗ ${name} manifest invalid:\n  - ` + errs.join('\n  - ')); process.exit(1); }
  const dir = join(ROOT, 'pets', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(m, null, 2) + '\n');
  console.log(`pet.json   ${name}  ${Object.keys(m.expressions).length} expressions, ${Object.keys(m.clips).length} clips, ${Object.keys(m.palettes).length} palettes`);
}

// run the build only when executed directly — importing drawSlime/CELL/etc. (the
// preview tool does) must NOT write files as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  buildSlime(); buildBird(); buildProps(); buildBean();
  emitManifest('slime', buildSlimeManifest());
  emitManifest('bean', buildBeanManifest());
  console.log('done →', OUT);
}
