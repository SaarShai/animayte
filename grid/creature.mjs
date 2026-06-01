/*
 * animayte · grid creature — "Dijon": a mustard-yellow triangle with a mustache.
 *
 * Body = a procedural triangle, seated in the lower grid (headroom above for props).
 * Face = composable overlays from ./face.mjs (eyes / brows / a MORPHING mustache that
 * plays the role of the mouth / accents), driven by the same face spec the expression
 * dictionary (lib/expressions.mjs) already speaks. Props = ./props.mjs.
 *
 * compose(faceSpec, opts) is the one entry the renderer calls each frame.
 */

import { parseGrid, triangle } from './engine.mjs';
import { GRID, BODY_TOP, BODY_H } from './geom.mjs';
import { composeFace } from './face.mjs';
import { propCells } from './props.mjs';

export { GRID };

// mustard theme + the few extra keys faces/props need (still a tight palette)
export const PALETTE = {
  B: '#F2B01C', // body — mustard (brighter)
  S: '#FBD468', // sheen / bulb glow — lighter mustard (brighter)
  D: '#3A2A12', // dark — eyes, mustache
  R: '#8F6410', // brow — dark mustard (distinct from near-black eyes, darker than body)
  W: '#FFF7E6', // glint / Zzz / bulb highlight
  P: '#EC8A7E', // blush / flush — warm rose
  C: '#CFEAF7', // sweat — cool drop
  G: '#C2C7CF', // metal grey — bulb base, hammer head
  H: '#7A4A1E', // handle brown — hammer
};

// ── body: triangle seated at BODY_TOP, with one small sheen patch for a hint of form
function buildBody() {
  const tri = triangle({ w: GRID.w, h: BODY_H, char: 'B', flatTop: 0.2 }).map((r) => r.split(''));
  const cx = Math.round((GRID.w - 1) / 2);
  for (let y = 5; y <= 6; y++)
    for (let x = cx - 4; x <= cx - 2; x++)
      if (tri[y] && tri[y][x] === 'B') tri[y][x] = 'S';
  // pad headroom on top so triangle row 0 lands at grid row BODY_TOP
  const rows = Array.from({ length: BODY_TOP }, () => '').concat(tri.map((r) => r.join('')));
  return parseGrid(rows);
}
export const BODY = buildBody();

/**
 * compose(faceSpec, { blink, props }) → flat cell list (body + face + props), ready
 * for engine.render(). Face cells OVERRIDE body cells beneath them (so dark eyes read
 * on the mustard); props draw on top (and may sit in the headroom above the head).
 */
export function compose(faceSpec = {}, { blink = false, props = [] } = {}) {
  const face = composeFace(faceSpec, { blink });
  const taken = new Set(face.map((c) => `${c.x},${c.y}`));
  let cells = BODY.cells.filter((c) => !taken.has(`${c.x},${c.y}`)).concat(face);
  for (const name of props) cells = cells.concat(propCells(name));
  return cells;
}

/** composeIdle — the neutral resting face (kept for Phase-1 callers). */
export function composeIdle({ blink = false } = {}) {
  return compose({ eyes: 'dots', mouth: 'slight_smile' }, { blink });
}
