/*
 * animayte · grid props — standalone overlays positioned around the creature.
 *
 * Props are session-driven flourishes (idea, tool-in-use) distinct from face accents.
 * Each is a char-map placed at a fixed grid anchor; colour from the palette at render.
 * Lightbulb floats in the headroom above the head; the hammer rests at Dijon's side.
 */

import { parseGrid } from './engine.mjs';
import { bodyCx } from './geom.mjs';

const G = (rows) => parseGrid(rows);

// name → { sprite, col, row }
export const PROPS = {
  // idea — a glowing bulb hovering above the head (S=glow, W=highlight, G=screw base)
  lightbulb: {
    sprite: G([
      '.WSSW.',
      'WSSSSW',
      'WSSSSW',
      'SSSSSS',
      '.SSSS.',
      '.GGGG.',
      '..GG..',
    ]),
    col: Math.round(bodyCx - 3),
    row: 0,
  },
  // working — an upright hammer at the right side (G=head, H=handle)
  hammer: {
    sprite: G([
      'GGGG',
      'GGGG',
      '.HH.',
      '.HH.',
      '.HH.',
      '.HH.',
      '.HH.',
    ]),
    col: Math.round(bodyCx + 8),
    row: 15,
  },
  // searching — a magnifying glass held at the side (G=rim, W=glint, H=handle)
  magnifier: {
    sprite: G([
      '.GG.',
      'GW.G',
      'G..G',
      '.GG.',
      '..HH',
      '...H',
    ]),
    col: Math.round(bodyCx + 8),
    row: 15,
  },
  // reading — an open book (W=pages, H=spine)
  book: {
    sprite: G([
      'WWHWW',
      'WWHWW',
      'WWHWW',
      'WWHWW',
    ]),
    col: Math.round(bodyCx + 7),
    row: 16,
  },
  // running / testing — a little terminal screen (G=frame, D=screen, W=prompt cursor)
  terminal: {
    sprite: G([
      'GGGGG',
      'GDDDG',
      'GWDDG',
      'GDDDG',
      'GGGGG',
    ]),
    col: Math.round(bodyCx + 7),
    row: 15,
  },
  // installing — a package/crate (S=lid tape, H=box)
  box: {
    sprite: G([
      'SSSS',
      'HHHH',
      'H..H',
      'HHHH',
    ]),
    col: Math.round(bodyCx + 8),
    row: 16,
  },
  // fetching — a globe (C=ocean, W=meridian highlight)
  globe: {
    sprite: G([
      '.CC.',
      'CCCC',
      'CWWC',
      'CCCC',
      '.CC.',
    ]),
    col: Math.round(bodyCx + 8),
    row: 15,
  },
  // asking permission — a question mark floating in the headroom (W=mark)
  question: {
    sprite: G([
      '.WW.',
      'W..W',
      '...W',
      '..W.',
      '..W.',
      '....',
      '..W.',
    ]),
    col: Math.round(bodyCx - 2),
    row: 0,
  },
};

/** propCells(name) → flat cells already placed in grid coordinates (or [] if unknown). */
export function propCells(name) {
  const p = PROPS[name];
  if (!p) return [];
  return p.sprite.cells.map((c) => ({ x: c.x + p.col, y: c.y + p.row, c: c.c }));
}
