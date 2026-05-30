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
import { buildSlimeManifest, validateManifest } from '../lib/anim/manifest.mjs';
import { PROPS, PROP_CELL, drawProp } from './draw-props.mjs';

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
const inEll = (x, y, cx, cy, rx, ry) => { const dx = (x - cx) / rx, dy = (y - cy) / ry; return dx * dx + dy * dy <= 1; };
const fillEll = (C, cx, cy, rx, ry, col) => { for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) if (inEll(x, y, cx, cy, rx, ry)) C.px(x, y, col); };

export const FRAMES = 4;
export const CELL = 64;
export const STATES = EXPRESSIONS.map((e) => e.id);

// ---------- body silhouette (rounded narrow crown, wide flat base) ----------
function slimeHalfWidth(t, RX) { const s = Math.sin(0.30 + t * (Math.PI / 2 - 0.30)); return RX * Math.pow(s, 0.62); }

// ════════════════════════════════════════════════════════════════════════════
//  FACIAL FEATURE LIBRARY — each drawn in the spirit of the Apple emoji
// ════════════════════════════════════════════════════════════════════════════
function drawEyes(C, type, exL, exR, ey, blink) {
  if (blink && (type === 'dots' || type === 'open' || type === 'look_up')) type = 'closed';
  const eye = (ex) => {
    switch (type) {
      case 'dots':                                   // 🙂 simple calm eyes
        fillEll(C, ex, ey, 1.6, 2.4, P.pup); break;
      case 'open':                                   // 😟/😅 round open eyes
        fillEll(C, ex, ey, 2.4, 3.0, P.white);
        fillEll(C, ex, ey + 0.5, 1.7, 2.1, P.pup);
        C.px(ex + 1, ey - 1, P.white); break;
      case 'look_up':                                // 🤔 glancing up
        fillEll(C, ex, ey, 2.2, 2.8, P.white);
        fillEll(C, ex, ey - 1, 1.5, 1.7, P.pup); break;
      case 'wide':                                   // 😳 wide, startled/flushed eyes
        fillEll(C, ex, ey, 2.8, 3.3, P.white);
        fillEll(C, ex, ey, 1.4, 1.6, P.pup);
        C.px(ex + 1, ey - 1, P.white); break;
      case 'happy_arc':                              // 😄 smiling (∧) eyes
        for (let x = -3; x <= 3; x++) { const y = ey - Math.round((1 - Math.abs(x) / 3) * 2); C.px(ex + x, y, P.pup); C.px(ex + x, y + 1, P.pup); } break;
      case 'closed':                                 // 😴 / blink — gentle ‿ line
        for (let x = -3; x <= 3; x++) { const y = ey + Math.round((1 - (x / 3) ** 2) * 1.2); C.px(ex + x, y, P.pup); } break;
      case 'stars':                                  // 🤩 star-struck
        for (let i = -3; i <= 3; i++) { C.px(ex + i, ey, P.star); C.px(ex, ey + i, P.star); }
        C.px(ex - 1, ey - 1, P.star); C.px(ex + 1, ey - 1, P.star); C.px(ex - 1, ey + 1, P.star); C.px(ex + 1, ey + 1, P.star);
        C.px(ex, ey, P.white); break;
    }
  };
  eye(exL); eye(exR);
}

function drawBrows(C, type, exL, exR, ey) {
  if (!type) return;
  const brow = (ex, mirror) => {
    switch (type) {
      case 'one_raised':                             // 🤔 — only the right brow lifts
        if (mirror) { for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 6, P.pup); }
        else { for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 4, P.pup); }
        break;
      case 'worried':                                // 😅 — both lift, slightly arched
        for (let x = -2; x <= 2; x++) C.px(ex + x, ey - 5 - (x === 0 ? 1 : 0), P.pup); break;
      case 'sad': {                                  // 😟 — inner ends angle up  \   /
        for (let i = 0; i < 4; i++) { const x = mirror ? i : -i; const y = ey - 4 - (mirror ? -i : -i) + i; C.px(ex + x, ey - 5 + i, P.pup); }
        break;
      }
    }
  };
  brow(exL, false); brow(exR, true);
}

function drawMouth(C, type, cx, my) {
  switch (type) {
    case 'slight_smile':                             // 🙂 gentle upturn
      for (let x = -3; x <= 3; x++) C.px(cx + x, my + Math.round((1 - (x / 3) ** 2) * 1.4), P.mouth); break;
    case 'open_smile':                               // 😄 open happy mouth
      for (let y = 0; y <= 3; y++) for (let x = -4; x <= 4; x++) if ((x / 4) ** 2 + ((y - 1.4) / 2.4) ** 2 <= 1 && y >= 0) C.px(cx + x, my + y, y >= 2 ? P.tongue : P.mouth); break;
    case 'big_grin':                                 // 🤩 wide grin with teeth
      for (let y = -1; y <= 3; y++) for (let x = -5; x <= 5; x++) if ((x / 5) ** 2 + ((y - 1) / 2.6) ** 2 <= 1) C.px(cx + x, my + y, P.mouth);
      for (let x = -4; x <= 4; x++) C.px(cx + x, my - 1, P.white); break;
    case 'flat_skew':                                // 🤔 flat line pushed to one side
      for (let x = -1; x <= 4; x++) C.px(cx + x, my + 1, P.mouth); break;
    case 'awkward':                                  // 😅 small wavy open
      for (let x = -3; x <= 3; x++) C.px(cx + x, my + (x % 2 ? 1 : 0), P.mouth);
      C.px(cx - 1, my + 1, P.mouth); C.px(cx, my + 2, P.tongue); C.px(cx + 1, my + 1, P.mouth); break;
    case 'frown':                                    // 😟 downturned
      for (let x = -3; x <= 3; x++) C.px(cx + x, my + 2 - Math.round((1 - (x / 3) ** 2) * 1.6), P.mouth); break;
    case 'small':                                    // 😴 tiny mouth
      C.px(cx - 1, my, P.mouth); C.px(cx, my, P.mouth); C.px(cx + 1, my, P.mouth); C.px(cx, my + 1, P.mouth); break;
  }
}

function drawAccents(C, face, cx, cy, eyeY, RX) {
  if (face.blush) { for (let y = -2; y <= 1; y++) for (let x = -3; x <= 3; x++) if ((x / 3) ** 2 + (y / 1.6) ** 2 <= 1) { C.px(cx - 15 + x, eyeY + 4 + y, [...P.cheek, 235]); C.px(cx + 15 + x, eyeY + 4 + y, [...P.cheek, 235]); } }
  if (face.flush) {  // 😳 deep, large blush spanning the cheeks + warm tint — embarrassment
    for (let y = -3; y <= 2; y++) for (let x = -4; x <= 4; x++) if ((x / 4) ** 2 + (y / 2.4) ** 2 <= 1) { C.px(cx - 14 + x, eyeY + 4 + y, [...P.flush, 235]); C.px(cx + 14 + x, eyeY + 4 + y, [...P.flush, 235]); }
    // a few stray "heat" pixels under the eyes
    C.px(cx - 9, eyeY + 2, [...P.flush, 150]); C.px(cx + 9, eyeY + 2, [...P.flush, 150]);
  }
  if (face.sweat) { const sx = cx + 16, sy = eyeY - 6; C.px(sx, sy, P.sweat); C.px(sx, sy + 1, P.sweat); C.px(sx - 1, sy + 2, P.sweat); C.px(sx + 1, sy + 2, P.sweat); C.px(sx, sy + 3, P.sweat); C.px(sx, sy, [255, 255, 255, 200]); }
  if (face.zzz) { const zx = cx + 12, zy = eyeY - 9; C.px(zx, zy, P.pup); C.px(zx + 1, zy, P.pup); C.px(zx + 2, zy, P.pup); C.px(zx + 1, zy + 1, P.pup); C.px(zx, zy + 2, P.pup); C.px(zx + 1, zy + 2, P.pup); C.px(zx + 2, zy + 2, P.pup); C.px(zx + 4, zy - 3, P.pup); C.px(zx + 5, zy - 3, P.pup); C.px(zx + 5, zy - 2, P.pup); C.px(zx + 4, zy - 1, P.pup); C.px(zx + 5, zy - 1, P.pup); }
}

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

// ---------- prop / emote overlay strip (§4.5) ----------
function buildProps() {
  const W = PROP_CELL * PROPS.length, H = PROP_CELL;
  const C = Canvas(W, H);
  PROPS.forEach((name, i) => drawProp(C, i * PROP_CELL, 0, name));
  const png = encodePNG(W, H, C.d);
  writeFileSync(join(OUT, 'props.png'), png);
  const packDir = join(ROOT, 'pets', 'slime'); mkdirSync(packDir, { recursive: true });
  writeFileSync(join(packDir, 'props.png'), png);
  console.log(`props.png  ${W}x${H}  ${PROPS.length} props: ${PROPS.join(', ')}`);
}

// ---------- pet manifest (the data-driven pet-pack) ----------
// Generated from the SAME EXPRESSIONS source of truth, so the baked spritesheet and
// the manifest never disagree. Validated before writing — never emit a bad pack.
function buildManifest() {
  const m = buildSlimeManifest();
  const errs = validateManifest(m);
  if (errs.length) { console.error('✗ slime manifest invalid:\n  - ' + errs.join('\n  - ')); process.exit(1); }
  const dir = join(ROOT, 'pets', 'slime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(m, null, 2) + '\n');
  console.log(`pet.json   slime  ${Object.keys(m.expressions).length} expressions, ${Object.keys(m.clips).length} clips, ${Object.keys(m.palettes).length} palettes`);
}

// run the build only when executed directly — importing drawSlime/CELL/etc. (the
// preview tool does) must NOT write files as a side effect.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  buildSlime(); buildBird(); buildProps(); buildManifest();
  console.log('done →', OUT);
}
