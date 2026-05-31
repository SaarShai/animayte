/*
 * dev-only OLD-vs-NEW prop comparison sheet (NOT shipped). Self-contained: OLD + NEW
 * sprite strings are inlined here so the sheet is honest about the before/after. After
 * sign-off, the NEW strings get copied into grid/props.mjs.
 *   node grid/_props_ab.mjs <outfile>
 */
import { writeFileSync } from 'node:fs';
import { encodePNG } from '../lib/anim/png.mjs';
import { PALETTE } from './creature.mjs';

const BG = [10, 14, 26, 255];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const TRANSPARENT = new Set(['.', ' ', '']);
const parse = (rows) => { const cells = []; let w = 0; rows.forEach((r, y) => { if (r.length > w) w = r.length; for (let x = 0; x < r.length; x++) if (!TRANSPARENT.has(r[x])) cells.push({ x, y, c: r[x] }); }); return { w, h: rows.length, cells }; };

// ── OLD (current grid/props.mjs) ────────────────────────────────────────────────
const OLD = {
  book:   ['WWHWW', 'WWHWW', 'WWHWW', 'WWHWW'],
  hammer: ['GGGG', 'GGGG', '.HH.', '.HH.', '.HH.', '.HH.', '.HH.'],
  globe:  ['.CC.', 'CCCC', 'CWWC', 'CCCC', '.CC.'],
};
// ── NEW candidates ──────────────────────────────────────────────────────────────
const NEW = {
  // open book v2: clean — white pages, a brown center spine, NO text dashes. The two
  // page-blocks tent slightly up at the spine so it reads as an open book, not a slab.
  book: [
    '.WHW.',
    'WWHWW',
    'WWHWW',
    'WWHWW',
    'WWHWW',
  ],
  // claw hammer: a chunky metal head (with a glint) on a clearly thinner brown handle
  hammer: [
    '.GGGGG',
    'GGGGGG',
    'GWGGGG',
    '..HH..',
    '..HH..',
    '..HH..',
    '..HH..',
  ],
  // globe: ocean sphere with a bright vertical meridian + horizontal equator (a clear ✚)
  globe: [
    '.CCCC.',
    'CCWCC C'.replace(' ', ''),
    'WWWWWW',
    'CCWCCC',
    '.CCWC.'.replace('C.', 'C.'),
  ],
};
// fix globe rows to clean 6-wide
NEW.globe = [
  '.CCCC.',
  'CCWWCC',
  'WWWWWW',
  'CCWWCC',
  '.CCCC.',
];

function tile(sprite, scale) {
  const w = sprite.w * scale, h = sprite.h * scale;
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = BG[0]; buf[i * 4 + 1] = BG[1]; buf[i * 4 + 2] = BG[2]; buf[i * 4 + 3] = 255; }
  for (const { x, y, c } of sprite.cells) {
    const col = PALETTE[c]; if (!col) continue; const [r, g, b] = hex(col);
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const o = ((y * scale + dy) * w + (x * scale + dx)) * 4; buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return { buf, w, h };
}

const BIG = 16, TINY = 3, PAD = 16, GUT = 22, ROWGUT = 18;
const names = ['book', 'hammer', 'globe'];
const cellMax = 7; // max sprite dims for layout box
const boxBig = cellMax * BIG, boxTiny = cellMax * TINY;
const colW = boxBig;
const rowH = boxBig + 6 + boxTiny;
// columns: OLD-big | NEW-big | NEW-tiny
const W = PAD * 2 + 3 * colW + 2 * GUT;
const H = PAD * 2 + 3 * rowH + 2 * ROWGUT + 24;
const sheet = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) { sheet[i * 4] = BG[0]; sheet[i * 4 + 1] = BG[1]; sheet[i * 4 + 2] = BG[2]; sheet[i * 4 + 3] = 255; }

function blit(src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const so = (y * sw + x) * 4, px = dx + x, py = dy + y;
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const o = (py * W + px) * 4; sheet[o] = src[so]; sheet[o + 1] = src[so + 1]; sheet[o + 2] = src[so + 2]; sheet[o + 3] = 255;
  }
}
function center(t, colX, rowY, boxW, boxH) { blit(t.buf, t.w, t.h, colX + ((boxW - t.w) >> 1), rowY + ((boxH - t.h) >> 1)); }

names.forEach((nm, r) => {
  const rowY = PAD + r * (rowH + ROWGUT);
  const old = parse(OLD[nm]), neu = parse(NEW[nm]);
  // col 0: OLD big
  center(tile(old, BIG), PAD, rowY, colW, boxBig);
  // col 1: NEW big
  center(tile(neu, BIG), PAD + colW + GUT, rowY, colW, boxBig);
  // col 2: NEW big again with tiny beneath for size check
  center(tile(neu, BIG), PAD + 2 * (colW + GUT), rowY, colW, boxBig);
  center(tile(neu, TINY), PAD + 2 * (colW + GUT), rowY + boxBig + 6, colW, boxTiny);
});

writeFileSync(process.argv[2] || '/tmp/props_ab.png', encodePNG(W, H, sheet));
process.stdout.write(`wrote ${process.argv[2]} (${W}x${H}) — rows: book/hammer/globe · cols: OLD | NEW | NEW+tiny\n`);
