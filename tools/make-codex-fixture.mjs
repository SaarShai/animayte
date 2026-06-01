#!/usr/bin/env node
/*
 * animayte · make-codex-fixture — generate a SPEC-EXACT synthetic Codex pet (license-clean).
 *
 *   node tools/make-codex-fixture.mjs   →   pets/codex-demo/{pet.json, spritesheet.png}
 *
 * Produces a conformant Codex atlas (1536×1872, 8×9, 192×208 cells, transparent, frames
 * centered) so the loader/runtime/tests have an in-repo Codex pet with NO third-party art.
 * The creature is a friendly blob; each state is a distinct HUE and carries a small label
 * + a frame-pip strip (the lit pip advances per frame) so a screenshot proves the player
 * selected the right ROW (state) and COLUMN (frame). Drives entirely off lib/codex/format
 * (ROW_SPECS) so it can never drift from the spec it's meant to exercise.
 */
import { Canvas, encodePNG, fillRect, drawText, textWidth, hexToRgba } from '../lib/anim/png.mjs';
import { ATLAS, ROW_SPECS } from '../lib/codex/format.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'pets', 'codex-demo');
const { cellW, cellH, width: W, height: H } = ATLAS;

// per-state hue → the playing row is unmistakable at a glance; label → unambiguous in QA.
const STATE = {
  idle:           { col: '#5BC661', label: 'IDLE' },
  'running-right':{ col: '#5B8CFF', label: 'RUN>' },
  'running-left': { col: '#5B8CFF', label: '<RUN' },
  waving:         { col: '#FEC84B', label: 'WAVE' },
  jumping:        { col: '#FF8FB1', label: 'JUMP' },
  failed:         { col: '#E04A4A', label: 'FAIL' },
  waiting:        { col: '#B07BFF', label: 'WAIT' },
  running:        { col: '#33C7C7', label: 'PROC' },
  review:         { col: '#F59E42', label: 'REVW' },
};
const darken = (hex, k = 0.55) => { const [r, g, b] = hexToRgba(hex); return [Math.round(r * k), Math.round(g * k), Math.round(b * k), 255]; };

function ellipse(C, cx, cy, rx, ry, col) {
  if (rx <= 0 || ry <= 0) return;
  for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
    if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1) C.px(Math.round(cx + x), Math.round(cy + y), col);
  }
}
const TAU = Math.PI * 2;

/** Draw the creature for (state, frame) centered in the cell whose top-left is (ox, oy). */
function drawCreature(C, ox, oy, state, frame, frames) {
  const meta = STATE[state];
  const body = hexToRgba(meta.col), edge = darken(meta.col), white = [255, 255, 255, 255], dark = [30, 40, 55, 255];
  const cx = ox + cellW / 2;
  const baseCy = oy + cellH * 0.56;                 // a touch below center → headroom for the jump lift
  const f = frames > 1 ? frame / (frames - 1) : 0;   // 0..1 across the row
  const ph = (frame / frames) * TAU;                 // looping phase

  let dx = 0, dy = 0, sx = 1, sy = 1;
  let arm = 0, tear = false, glyph = null;
  switch (state) {
    case 'idle':           sy = 1 + 0.05 * Math.sin(ph); sx = 1 - 0.04 * Math.sin(ph); break;
    case 'running-right':  dx = 7 * Math.sin(ph); dy = -4 * Math.abs(Math.sin(ph)); glyph = '>'; break;
    case 'running-left':   dx = -7 * Math.sin(ph); dy = -4 * Math.abs(Math.sin(ph)); glyph = '<'; break;
    case 'waving':         arm = Math.sin(frame * 1.6); break;
    case 'jumping':        dy = -Math.sin(f * Math.PI) * 56; sy = 1 + 0.12 * Math.cos(f * Math.PI); sx = 2 - sy; break;
    case 'failed':         dy = 8; sy = 0.9; dx = 4 * (frame % 2 ? 1 : -1); tear = true; glyph = 'x'; break;
    case 'waiting':        dy = -3 * Math.sin(ph); glyph = '?'; break;
    case 'running':        sy = 1 + 0.06 * Math.sin(ph * 2); break;        // "processing" pulse + spinner dots below
    case 'review':         dx = 5 * Math.sin(ph); break;                   // a focused lean
    default: break;
  }

  const rx = Math.round(46 * sx), ry = Math.round(42 * sy);
  const bcx = Math.round(cx + dx), bcy = Math.round(baseCy + dy);
  // a tiny ground shadow (anchors the read) — skipped while airborne in the jump
  if (state !== 'jumping' || dy > -6) ellipse(C, cx, oy + cellH * 0.86, 38, 9, [20, 30, 40, 60]);
  // body + a darker rim
  ellipse(C, bcx, bcy, rx + 2, ry + 2, edge);
  ellipse(C, bcx, bcy, rx, ry, body);
  // a soft highlight
  ellipse(C, bcx - rx * 0.35, bcy - ry * 0.42, Math.round(rx * 0.3), Math.round(ry * 0.28), [255, 255, 255, 90]);

  // eyes (blink: a thin line on a chosen frame per state) + cheeks
  const blink = (state === 'idle' && frame === 4) || (state === 'review' && frame === 3);
  const eyeY = bcy - 6, eoff = 15;
  for (const s of [-1, 1]) {
    const ex = bcx + s * eoff + (state === 'review' ? s * 2 : 0);
    if (blink) fillRect(C, ex - 4, eyeY, 8, 2, dark);
    else { ellipse(C, ex, eyeY, 5, 6, white); ellipse(C, ex + (state.startsWith('running') ? 1 : 0), eyeY + 1, 3, 3, dark); }
  }
  // mouth — a small smile (or a frown when failed)
  if (state === 'failed') for (let x = -8; x <= 8; x++) C.px(bcx + x, bcy + 16 + Math.round((x * x) / 22), dark);
  else for (let x = -7; x <= 7; x++) C.px(bcx + x, bcy + 14 - Math.round((x * x) / 26), dark);
  if (tear) ellipse(C, bcx + eoff, eyeY + 10 + frame, 2, 3, [120, 190, 255, 220]);

  // waving arm
  if (state === 'waving') { const ax = bcx + rx - 4, ay = bcy - 8; fillRect(C, ax, ay - Math.round(arm * 6), 6, 18, edge); ellipse(C, ax + 3, ay - 12 - Math.round(arm * 8), 6, 6, body); }
  // "processing" spinner: three dots orbiting above the head
  if (state === 'running') for (let i = 0; i < 3; i++) { const a = ph + (i / 3) * TAU; ellipse(C, bcx + Math.cos(a) * 14, bcy - ry - 16 + Math.sin(a) * 6, 3, 3, edge); }
  // a meaning glyph above the head (?, x, ‹, ›)
  if (glyph) drawText(C, bcx - 3, bcy - ry - 24, glyph === '<' ? '-' : glyph === '>' ? '-' : glyph, edge, 3);

  // ── QA aids: a small state label (top-left) + a frame-pip strip (lit pip = current frame) ──
  drawText(C, ox + 7, oy + 7, meta.label, [40, 50, 65, 200], 3);
  const pip = 9, gap = 4, totalW = frames * pip + (frames - 1) * gap, px0 = Math.round(cx - totalW / 2), py = oy + cellH - 20;
  for (let i = 0; i < frames; i++) fillRect(C, px0 + i * (pip + gap), py, pip, pip, i === frame ? edge : [120, 130, 140, 90]);
}

// ── compose the atlas ──
const C = Canvas(W, H);
for (const spec of ROW_SPECS) {
  const oy = spec.row * cellH;
  for (let col = 0; col < spec.frames; col++) drawCreature(C, col * cellW, oy, spec.state, col, spec.frames);
  // columns ≥ frames are left fully transparent, per the contract
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'spritesheet.png'), encodePNG(W, H, C.d));
const manifest = {
  id: 'codex-demo',
  displayName: 'Codex Demo Blob',
  description: 'A license-clean synthetic Codex pet that animayte generates to exercise the 8×9 atlas player.',
  spritesheetPath: 'spritesheet.png',
};
writeFileSync(join(OUT, 'pet.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✅ wrote ${OUT}/spritesheet.png (${W}×${H}) + pet.json — ${ROW_SPECS.length} states, ${ROW_SPECS.reduce((n, s) => n + s.frames, 0)} frames`);
