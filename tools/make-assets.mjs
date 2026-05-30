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
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPRESSIONS } from '../lib/expressions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets');
mkdirSync(OUT, { recursive: true });

// ---------- minimal PNG encoder (RGBA, 8-bit) ----------
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, dataBuf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, dataBuf])), 0);
  return Buffer.concat([len, typeBuf, dataBuf, crcBuf]);
}
function encodePNG(W, H, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]; }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- pixel canvas with alpha compositing ----------
function Canvas(W, H) {
  const d = new Uint8Array(W * H * 4);
  const px = (x, y, c) => {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = (c[3] === undefined ? 255 : c[3]) / 255; if (a <= 0) return;
    const i = (y * W + x) * 4, da = d[i + 3] / 255, oa = a + da * (1 - a);
    d[i] = (c[0] * a + d[i] * da * (1 - a)) / oa;
    d[i + 1] = (c[1] * a + d[i + 1] * da * (1 - a)) / oa;
    d[i + 2] = (c[2] * a + d[i + 2] * da * (1 - a)) / oa;
    d[i + 3] = oa * 255;
  };
  return { W, H, d, px };
}

// ---------- palette ----------
const P = {
  lite: [186, 246, 212], base: [111, 224, 173], mid: [76, 197, 146], dark: [47, 158, 114], out: [27, 104, 76],
  white: [255, 255, 255], pup: [44, 54, 66], cheek: [255, 150, 178], mouth: [70, 44, 56], tongue: [232, 120, 145],
  sweat: [125, 198, 255], star: [255, 224, 86], shadow: [38, 96, 74, 70], flush: [255, 120, 150],
  birdB: [126, 170, 255], birdD: [92, 140, 250], beak: [255, 179, 71], birdEye: [30, 46, 74],
};
const inEll = (x, y, cx, cy, rx, ry) => { const dx = (x - cx) / rx, dy = (y - cy) / ry; return dx * dx + dy * dy <= 1; };
const fillEll = (C, cx, cy, rx, ry, col) => { for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) if (inEll(x, y, cx, cy, rx, ry)) C.px(x, y, col); };

const FRAMES = 4;
const CELL = 64;
const STATES = EXPRESSIONS.map((e) => e.id);

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
function drawSlime(C, ox, oy, expr, frame) {
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
      const ny = (y - topY) / BH;
      C.px(x, y, ny < 0.18 ? P.lite : ny < 0.45 ? P.base : ny < 0.76 ? P.mid : P.dark);
    }
  }
  const cy = topY + BH * 0.54;
  for (let y = -8; y <= 4; y++) for (let x = -5; x <= 4; x++) if ((x / 5) ** 2 + (y / 8) ** 2 <= 1) C.px(cx - 8 + x, topY + 13 + y, [255, 255, 255, 60]);
  C.px(cx - 10, topY + 8, [255, 255, 255, 230]); C.px(cx - 9, topY + 8, [255, 255, 255, 150]);

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
  writeFileSync(join(OUT, 'slime.png'), encodePNG(W, H, C.d));
  writeFileSync(join(OUT, 'slime.json'), JSON.stringify({ cell: CELL, frames: FRAMES, states: STATES, apple: Object.fromEntries(EXPRESSIONS.map((e) => [e.id, e.apple])) }, null, 2));
  console.log(`slime.png  ${W}x${H}  rows: ${STATES.join(', ')}`);
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

buildSlime(); buildBird();
console.log('done →', OUT);
