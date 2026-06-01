/*
 * dev-only END-TO-END verification sheet (NOT shipped): feeds real FeatureSpecs through
 * composeExpression() — the SAME path applySpec() uses — and rasterizes the composed
 * faces to one PNG. Proves the spec→pixels seam yields the approved families.
 *   node grid/_verify.mjs <outfile>
 */
import { writeFileSync } from 'node:fs';
import { encodePNG } from '../lib/anim/png.mjs';
import { GRID, PALETTE, compose } from './creature.mjs';
import { composeExpression } from './compose.mjs';
import { appraise } from '../lib/appraise.mjs';

const BG = [10, 14, 26, 255], PAD = 14, GUT = 10, BIG = 5, SMALL = 1, BAR = 4;
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// each column = a real spec; we render what composeExpression() produces for it
const COLS = [
  { label: 'neutral',    ref: true,  spec: { expression: 'neutral', valence: 0, arousal: 0, cause: 'none' } },
  { label: 'content',    spec: { expression: 'happy', valence: 0.4, arousal: 0, cause: 'user' } },
  { label: 'pleased',    spec: { expression: 'happy', valence: 0.6, arousal: 1, cause: 'user' } },
  { label: 'thrilled',   spec: { expression: 'excited', valence: 1, arousal: 2, cause: 'none' } },
  { label: 'determined', self: true, spec: appraise({ recentTexts: ['I broke the build with my edit'] }) },
  { label: 'concerned',  self: true, spec: appraise({ isError: true }) },
  { label: 'sheepish',   self: true, spec: { expression: 'oops', valence: -0.5, arousal: 1, cause: 'self' } },
];

function tile(face, item, cell) {
  const w = GRID.w * cell, h = GRID.h * cell, buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }
  const cells = compose(face, { props: item ? [item] : [] });
  for (const { x, y, c } of cells) {
    const col = PALETTE[c]; if (!col) continue; const [r, g, b] = hex(col);
    for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
      const px = x * cell + dx, py = y * cell + dy; if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const o = (py * w + px) * 4; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return { buf, w, h };
}

const bigW = GRID.w * BIG, bigH = GRID.h * BIG, smW = GRID.w * SMALL, smH = GRID.h * SMALL;
const colW = bigW, colH = bigH + 8 + smH + BAR;
const W = PAD * 2 + COLS.length * colW + (COLS.length - 1) * GUT, H = PAD * 2 + colH;
const sheet = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i * 4] = BG[0]; sheet[i * 4 + 1] = BG[1]; sheet[i * 4 + 2] = BG[2]; sheet[i * 4 + 3] = 255; }
function blit(src, sw, sh, dx, dy) { for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const so = (y * sw + x) * 4, px = dx + x, py = dy + y; if (px < 0 || py < 0 || px >= W || py >= H) continue; const o = (py * W + px) * 4; sheet[o] = src[so]; sheet[o + 1] = src[so + 1]; sheet[o + 2] = src[so + 2]; sheet[o + 3] = 255; } }

COLS.forEach((col, i) => {
  const { face, item, fx } = composeExpression(col.spec);
  const x0 = PAD + i * (colW + GUT);
  const big = tile(face, item, BIG); blit(big.buf, big.w, big.h, x0, PAD);
  const sm = tile(face, item, SMALL); blit(sm.buf, sm.w, sm.h, x0 + Math.round((colW - smW) / 2), PAD + bigH + 8);
  const bar = col.self ? [236, 138, 126] : col.ref ? [90, 98, 122] : [230, 168, 23];
  const by = PAD + bigH + 8 + smH + 2;
  for (let y = 0; y < BAR; y++) for (let x = 0; x < colW; x++) { const o = ((by + y) * W + (x0 + x)) * 4; sheet[o] = bar[0]; sheet[o + 1] = bar[1]; sheet[o + 2] = bar[2]; sheet[o + 3] = 255; }
  process.stdout.write(`${col.label.padEnd(11)} fx=${JSON.stringify(fx)} item=${item || '-'}\n`);
});

writeFileSync(process.argv[2] || '/tmp/verify.png', encodePNG(W, H, sheet));
process.stdout.write(`wrote ${process.argv[2]} (${W}x${H})\n`);
