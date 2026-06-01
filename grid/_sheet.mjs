/*
 * dev-only PNG contact-sheet renderer (NOT shipped). Rasterizes faceSpecs to a single
 * PNG so faces can be shown inline without a browser. Reuses the same compose() +
 * PALETTE the real renderer uses, so what you see here IS the on-screen pixels.
 *
 *   node grid/_sheet.mjs '<json faces>' <outfile>
 *   faces = [{ name, face, props? }]   (name unused in pixels; order = left→right)
 *
 * Each column shows the face at BIG (review) size on top and at ~30px (real) below.
 */
import { writeFileSync } from 'node:fs';
import { encodePNG } from '../lib/anim/png.mjs';
import { GRID, PALETTE, compose } from './creature.mjs';

const BG = [10, 14, 26, 255];          // #0a0e1a — lab background
const GUTTER = 10;                      // px between columns
const PAD = 14;
const BIG = 5;                          // px per cell, review size (GRID.w*5 = 150px)
const SMALL = 1;                        // px per cell, ≈ real 30px footprint
const LABEL_H = 4;                      // a thin accent bar under each column (hero/self tint)

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

function tile(face, props, cell) {
  const w = GRID.w * cell, h = GRID.h * cell;
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }
  const cells = compose(face, { props: props || [] });
  for (const { x, y, c } of cells) {
    const col = PALETTE[c]; if (!col) continue;
    const [r, g, b] = hex(col);
    for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
      const px = x * cell + dx, py = y * cell + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const o = (py * w + px) * 4; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return { buf, w, h };
}

const faces = JSON.parse(process.argv[2] || '[]');
const out = process.argv[3] || '/tmp/sheet.png';

const bigW = GRID.w * BIG, bigH = GRID.h * BIG;
const smW = GRID.w * SMALL, smH = GRID.h * SMALL;
const colW = bigW;
const colH = bigH + 8 + smH + LABEL_H;
const W = PAD * 2 + faces.length * colW + (faces.length - 1) * GUTTER;
const H = PAD * 2 + colH;
const sheet = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i * 4] = BG[0]; sheet[i * 4 + 1] = BG[1]; sheet[i * 4 + 2] = BG[2]; sheet[i * 4 + 3] = 255; }

function blit(src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const so = (y * sw + x) * 4, px = dx + x, py = dy + y;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const o = (py * W + px) * 4;
    sheet[o] = src[so]; sheet[o + 1] = src[so + 1]; sheet[o + 2] = src[so + 2]; sheet[o + 3] = 255;
  }
}

faces.forEach((f, i) => {
  const x0 = PAD + i * (colW + GUTTER);
  const big = tile(f.face, f.props, BIG);
  blit(big.buf, big.w, big.h, x0, PAD);
  const sm = tile(f.face, f.props, SMALL);
  blit(sm.buf, sm.w, sm.h, x0 + Math.round((colW - smW) / 2), PAD + bigH + 8);
  // accent bar: self=rose, hero=mustard, ref=grey
  const bar = f.self ? [236, 138, 126] : f.ref ? [90, 98, 122] : [230, 168, 23];
  const by = PAD + bigH + 8 + smH + 2;
  for (let y = 0; y < LABEL_H; y++) for (let x = 0; x < colW; x++) {
    const o = ((by + y) * W + (x0 + x)) * 4; sheet[o] = bar[0]; sheet[o + 1] = bar[1]; sheet[o + 2] = bar[2]; sheet[o + 3] = 255;
  }
});

writeFileSync(out, encodePNG(W, H, sheet));
process.stdout.write(`wrote ${out} (${W}x${H}, ${faces.length} faces)\n`);
