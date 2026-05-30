#!/usr/bin/env node
/*
 * animayte · preview — render the pet to PNGs I can READ and judge (§9.2).
 *
 * This is the autonomous-validation backbone: I can see pixel art, so every
 * expression/clip gets rendered to a labelled contact-sheet or filmstrip that I
 * (and Saar) read to QA craft — squash/stretch present? silhouette readable?
 * expression legible at size? on-palette? — without anyone watching a live window.
 *
 *   node tools/preview.mjs                 → writes the default QA set to tools/preview-out/
 *   node tools/preview.mjs clip react 12   → one clip filmstrip (12 steps) to stdout path
 *
 * Importable: contactSheet(), clipFilmstrip(), squashStrip() return { png, w, h }.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Canvas, encodePNG, blitScaled, drawText, fillRect, textWidth, hexToRgba } from '../lib/anim/png.mjs';
import { drawSlime, CELL, FRAMES } from './make-assets.mjs';
import { PROPS, PROP_CELL, drawProp } from './draw-props.mjs';
import { EXPRESSIONS } from '../lib/expressions.mjs';
import { buildSlimeManifest } from '../lib/anim/manifest.mjs';
import { sampleTrack, squash } from '../lib/anim/transform.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tools', 'preview-out');

const BG = hexToRgba('#e8f0f8');     // soft neutral so the dark outline reads
const INK = hexToRgba('#33424f');
const GRID = hexToRgba('#cdddee'); // faint cell border

/** Render a single 64×64 slime cell (one expression, one baked frame). */
function slimeCell(expr, frame) {
  const C = Canvas(CELL, CELL);
  drawSlime(C, 0, 0, expr, frame);
  return C;
}

/**
 * contactSheet — every expression (row) × every baked frame (col), upscaled and
 * labelled. The first read I do to judge faces + the baked wobble/blink.
 */
export function contactSheet({ scale = 4 } = {}) {
  const cellPx = CELL * scale;
  const gap = 6;
  const labelW = 80;                       // left gutter for the expression id
  const headH = 22;
  const cols = FRAMES, rows = EXPRESSIONS.length;
  const w = labelW + cols * (cellPx + gap) + gap;
  const h = headH + rows * (cellPx + gap) + gap;
  const C = Canvas(w, h);
  fillRect(C, 0, 0, w, h, BG);
  drawText(C, gap, 8, 'animayte contact sheet  ' + cols + ' frames x ' + rows + ' expressions', INK, 2);

  EXPRESSIONS.forEach((expr, r) => {
    const y = headH + r * (cellPx + gap) + gap;
    drawText(C, gap, y + 6, expr.id, INK, 2);
    for (let f = 0; f < FRAMES; f++) {
      const x = labelW + f * (cellPx + gap) + gap;
      // cell border
      for (let i = 0; i < cellPx; i++) { C.px(x + i, y, GRID); C.px(x + i, y + cellPx - 1, GRID); C.px(x, y + i, GRID); C.px(x + cellPx - 1, y + i, GRID); }
      blitScaled(C, slimeCell(expr, f), 0, 0, CELL, CELL, x, y, scale);
    }
  });
  return { png: encodePNG(w, h, C.d), w, h, cols, rows };
}

/**
 * clipFilmstrip — sample a clip's body transform track at `steps` evenly-spaced
 * times and apply it to one expression's sprite, bottom-anchored, so squash &
 * stretch reads left→right. Width is EXACTLY steps × cell × scale (a clean grid).
 */
export function clipFilmstrip(clipName, { expression = 'happy', steps = 8, scale = 4 } = {}) {
  const manifest = buildSlimeManifest();
  const clip = manifest.clips[clipName];
  if (!clip) throw new Error(`unknown clip "${clipName}" (have: ${Object.keys(manifest.clips).join(', ')})`);
  const expr = EXPRESSIONS.find((e) => e.id === expression) || EXPRESSIONS[0];
  const track = (clip.tracks && clip.tracks.body) || [{ t: 0 }];

  const cellPx = CELL * scale;
  const labelBand = 14;
  const w = steps * cellPx;
  const h = labelBand + cellPx;
  const C = Canvas(w, h);
  fillRect(C, 0, 0, w, h, BG);
  drawText(C, 3, 3, clipName + ' / ' + expr.id, INK, 2);

  const sprite = slimeCell(expr, 0);
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const tf = sampleTrack(track, t);
    const cx0 = i * cellPx, cy0 = labelBand;
    // faint divider
    for (let yy = 0; yy < cellPx; yy++) C.px(cx0, cy0 + yy, GRID);
    const drawW = CELL * tf.sx, drawH = CELL * tf.sy;
    const dx = cx0 + (cellPx - drawW * scale) / 2 + tf.tx * scale;
    const dy = cy0 + cellPx - drawH * scale + tf.ty * scale;   // bottom-anchored
    blitScaled(C, sprite, 0, 0, CELL, CELL, Math.round(dx), Math.round(dy), tf.sx * scale, tf.sy * scale);
    drawText(C, cx0 + 2, cy0 + cellPx - 8, t.toFixed(2), INK, 1);
  }
  return { png: encodePNG(w, h, C.d), w, h, steps };
}

/**
 * squashStrip — sweep squash(k) across a range to SEE volume conservation
 * (shorter ⇒ wider, taller ⇒ narrower). A direct visual check of transform.mjs.
 */
export function squashStrip({ expression = 'neutral', from = -0.45, to = 0.6, steps = 9, scale = 4 } = {}) {
  const expr = EXPRESSIONS.find((e) => e.id === expression) || EXPRESSIONS[0];
  const cellPx = CELL * scale;
  const labelBand = 14;
  const w = steps * cellPx;
  const h = labelBand + cellPx;
  const C = Canvas(w, h);
  fillRect(C, 0, 0, w, h, BG);
  drawText(C, 3, 3, 'squash sweep (volume conserved)', INK, 2);
  const sprite = slimeCell(expr, 0);
  for (let i = 0; i < steps; i++) {
    const k = from + (to - from) * (i / (steps - 1));
    const s = squash(k);
    const cx0 = i * cellPx, cy0 = labelBand;
    for (let yy = 0; yy < cellPx; yy++) C.px(cx0, cy0 + yy, GRID);
    const dx = cx0 + (cellPx - CELL * s.sx * scale) / 2;
    const dy = cy0 + cellPx - CELL * s.sy * scale;
    blitScaled(C, sprite, 0, 0, CELL, CELL, Math.round(dx), Math.round(dy), s.sx * scale, s.sy * scale);
    drawText(C, cx0 + 2, cy0 + cellPx - 8, (k >= 0 ? '+' : '') + k.toFixed(2), INK, 1);
  }
  return { png: encodePNG(w, h, C.d), w, h, steps };
}

/**
 * propSheet — every §4.5 prop upscaled + labelled on a dark + light split background
 * (props must read on any wallpaper). The QA pass for the overlay library (B5).
 */
export function propSheet({ scale = 5 } = {}) {
  const cellPx = PROP_CELL * scale;
  const gap = 8, cols = 7;
  const rows = Math.ceil(PROPS.length / cols);
  const labelH = 12;
  const w = gap + cols * (cellPx + gap);
  const h = 24 + rows * (cellPx + labelH + gap);
  const C = Canvas(w, h);
  fillRect(C, 0, 0, w, h, BG);
  drawText(C, gap, 8, 'prop / emote library  (' + PROPS.length + ')', INK, 2);
  PROPS.forEach((name, i) => {
    const cxi = i % cols, ryi = Math.floor(i / cols);
    const x = gap + cxi * (cellPx + gap), y = 24 + ryi * (cellPx + labelH + gap);
    // half dark / half light cell so contrast reads on any background
    fillRect(C, x, y, cellPx / 2, cellPx, hexToRgba('#20303f'));
    fillRect(C, x + cellPx / 2, y, cellPx / 2, cellPx, hexToRgba('#eef4fb'));
    const tmp = Canvas(PROP_CELL, PROP_CELL); drawProp(tmp, 0, 0, name);
    blitScaled(C, tmp, 0, 0, PROP_CELL, PROP_CELL, x, y, scale);
    drawText(C, x, y + cellPx + 2, name, INK, 1);
  });
  return { png: encodePNG(w, h, C.d), w, h, count: PROPS.length };
}

// ---------- CLI ----------
function write(name, { png, w, h }) {
  mkdirSync(OUT, { recursive: true });
  const p = join(OUT, name);
  writeFileSync(p, png);
  console.log(`${name.padEnd(24)} ${w}x${h}  → ${p}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [mode, arg1, arg2] = process.argv.slice(2);
  if (mode === 'clip') {
    write(`clip-${arg1}.png`, clipFilmstrip(arg1, { steps: Number(arg2) || 8 }));
  } else if (mode === 'squash') {
    write('squash.png', squashStrip({}));
  } else {
    console.log('rows (top→bottom):', EXPRESSIONS.map((e) => e.id).join(', '));
    write('contact-sheet.png', contactSheet({ scale: 4 }));
    write('prop-sheet.png', propSheet({}));
    write('clip-idle.png', clipFilmstrip('idle', { steps: 8, expression: 'neutral' }));
    write('clip-react.png', clipFilmstrip('react', { steps: 8, expression: 'happy' }));
    write('squash.png', squashStrip({}));
    console.log('done → tools/preview-out/ (Read these to QA the art)');
  }
}
