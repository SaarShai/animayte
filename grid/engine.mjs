/*
 * animayte · grid engine — a minimal pixel-matrix renderer.
 *
 * The whole idea: a creature is a small grid of palette-indexed cells. Sprites are
 * authored as editable char-maps (rows of strings, one char = one palette key), and
 * the engine COMPOSES layers at runtime — body pose + face overlay + props — then
 * draws each cell as a crisp scaled rect on a Canvas2D context. Aliveness is mostly
 * PROCEDURAL: squash/stretch/bob/blink are computed per-frame, not hand-drawn.
 *
 * Zero-dep. No DOM access at import (so it loads in node for tests). The renderer is
 * the only part that touches a canvas context, and it's handed one explicitly.
 *
 * Coordinate model: a logical WxH grid. The "anchor" is the creature's footing
 * (bottom-centre by default) — all squash/stretch happens about it so the feet stay
 * planted and the body breathes upward, the way a real squashy thing does.
 */

const TRANSPARENT = new Set(['.', ' ', '']);

/** parseGrid(rows) → { w, h, cells:[{x,y,c}] }. `c` is the palette key for that cell. */
export function parseGrid(rows) {
  const cells = [];
  let w = 0;
  rows.forEach((row, y) => {
    if (row.length > w) w = row.length;
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (!TRANSPARENT.has(c)) cells.push({ x, y, c });
    }
  });
  return { w, h: rows.length, cells };
}

/**
 * triangle({ w, h, char, flatTop }) → rows[] — an isosceles triangle, apex up,
 * base flush to the bottom. `flatTop` (0..1) chops the spiky apex into a chunkier,
 * friendlier top (clawd-style chunk, not a sharp spike).
 */
export function triangle({ w, h, char = 'B', flatTop = 0.18 }) {
  const cx = (w - 1) / 2;
  const rows = [];
  for (let y = 0; y < h; y++) {
    // vertical progress, lifted by flatTop so row 0 already has some width
    const frac = flatTop + (1 - flatTop) * ((y + 1) / h);
    const half = (w / 2) * Math.min(1, frac);
    let row = '';
    for (let x = 0; x < w; x++) row += Math.abs(x - cx) <= half ? char : '.';
    rows.push(row);
  }
  return rows;
}

/**
 * stamp(base, overlay, col, row) — paint an overlay char-grid onto a copy of base's
 * cell list at (col,row), overlay cells WIN (so a face overrides body underneath).
 * Returns a flat cell list ready to render.
 */
export function stamp(baseCells, overlay, col, row) {
  const masked = new Set(overlay.cells.map((c) => `${c.x + col},${c.y + row}`));
  const out = baseCells.filter((c) => !masked.has(`${c.x},${c.y}`));
  for (const c of overlay.cells) out.push({ x: c.x + col, y: c.y + row, c: c.c });
  return out;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * idleTransform(nowMs, cfg) → { sx, sy, offY, blink } — the procedural "alive" pose.
 *  - a slow breathing squash (volume-preserving: as it flattens it widens),
 *  - a gentle vertical bob,
 *  - an occasional blink (deterministic from the clock; no RNG needed to look organic).
 */
export function idleTransform(nowMs, cfg = {}) {
  const breathePeriod = cfg.breathePeriod ?? 2600; // ms per breath
  const breatheAmp = cfg.breatheAmp ?? 0.05;        // ±5% height
  const bobAmp = cfg.bobAmp ?? 0.18;                // cells
  const blinkEvery = cfg.blinkEvery ?? 3400;        // ms between blinks
  const blinkDur = cfg.blinkDur ?? 120;             // ms eyes shut

  const ph = (nowMs % breathePeriod) / breathePeriod;
  const breath = Math.sin(ph * Math.PI * 2);        // -1..1
  const sy = 1 - breatheAmp * breath;               // flatter at the top of the breath
  const sx = 1 + (1 - sy) * 0.6;                    // widen to conserve volume
  const offY = -bobAmp * (0.5 + 0.5 * Math.sin(ph * Math.PI * 2 + Math.PI / 3));

  const sinceBlink = nowMs % blinkEvery;
  const blink = sinceBlink < blinkDur;

  return { sx, sy, offY, blink };
}

/**
 * render(ctx, cells, palette, opts) — draw a composed cell list.
 *
 * opts: { gridW, gridH, cell, anchorX, anchorY, transform }
 *   cell      — px per logical cell (the "scaled-up pixel" size)
 *   anchorX/Y — footing the squash pivots around (default bottom-centre)
 *   transform — { sx, sy, offY } from idleTransform (or any pose)
 *
 * Cells are drawn as solid rects (sharp — no image scaling blur). A tiny overlap
 * (EPS) kills hairline seams between adjacent cells when sx/sy aren't integers.
 */
export function render(ctx, cells, palette, opts = {}) {
  const cell = opts.cell ?? 12;
  const gridW = opts.gridW ?? 28;
  const gridH = opts.gridH ?? 28;
  const ax = opts.anchorX ?? (gridW - 1) / 2;
  const ay = opts.anchorY ?? gridH; // feet line
  const t = opts.transform ?? { sx: 1, sy: 1, offY: 0 };
  const EPS = opts.eps ?? 0.04;
  const offX = t.offX || 0, offY = t.offY || 0, rot = t.rot || 0;
  // optional hooks: colorFor(x,y,c)→hex|null (per-cell tint, e.g. a gradient);
  // warp(x,y,c)→{dx,dy,grow}|null (per-cell displacement + size bump, e.g. a local swell).
  const colorFor = opts.colorFor, warp = opts.warp;

  ctx.clearRect(0, 0, gridW * cell, gridH * cell);
  // rotation (sway / lean) pivots about the footing anchor
  if (rot) { ctx.save(); ctx.translate(ax * cell, ay * cell); ctx.rotate(rot); ctx.translate(-ax * cell, -ay * cell); }
  for (const { x, y, c } of cells) {
    const col = (colorFor && colorFor(x, y, c)) || palette[c];
    if (!col) continue;
    const w = warp ? warp(x, y, c) : null;
    const wx = (w && w.dx) || 0, wy = (w && w.dy) || 0, g = (w && w.grow) || 0;
    // squash/stretch about the anchor, then translate (+ per-cell warp)
    const dx = (x - ax) * t.sx + ax + offX + wx;
    const dy = (y - ay) * t.sy + ay + offY + wy;
    ctx.fillStyle = col;
    ctx.fillRect(dx * cell, dy * cell, (t.sx + EPS + g) * cell, (t.sy + EPS + g) * cell);
  }
  if (rot) ctx.restore();
}

/** sizeCanvas(canvas, gridW, gridH, cell) — retina-crisp setup. Returns the ctx. */
export function sizeCanvas(canvas, gridW, gridH, cell, dpr = 1) {
  const w = gridW * cell, h = gridH * cell;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

export const _internal = { clamp, TRANSPARENT };
