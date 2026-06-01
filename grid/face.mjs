/*
 * animayte · grid face — the feature library + compositor for Dijon's expressions.
 *
 * Every key here matches the vocabulary in lib/expressions.mjs (eyes / brows / mouth /
 * accents), so the existing feeling dictionary drives the face with NO translation
 * layer. The "mouth" features are MUSTACHE shapes — Dijon emotes through his 'stache.
 *
 * Each feature is a char-map (parseGrid). Pure geometry: colour comes from the palette
 * at render time. composeFace() returns face cells already placed in grid coordinates.
 */

import { parseGrid } from './engine.mjs';
import { BODY_TOP, bodyCx, centerCol } from './geom.mjs';

const G = (rows) => parseGrid(rows);

// ── eyes ──────────────────────────────────────────────────────────────────────
export const EYES = {
  dots:      G(['DD..DD', 'DD..DD']),                       // calm, neutral
  open:      G(['DD..DD', 'DD..DD', 'DD..DD']),             // taller, attentive
  wide:      G(['DDD..DDD', 'DWD..DWD', 'DDD..DDD']),       // startled (white glint)
  happy_arc: G(['.DD..DD.', 'D..DD..D']),                   // ^_^ upcurved
  stars:     G(['.D...D.', 'DDD.DDD', '.D...D.']),          // ✦✦ sparkle
  look_up:   G(['DD..DD', '......']),                        // pupils raised (thinking)
  closed:    G(['DDD..DDD']),                                // ___ resting
  focused:   G(['DDDD..DDDD']),                              // narrowed, intense (legacy determined — reads as a glare)
  lock:      G(['DDD..DDD', 'DWD..DWD']),                    // open but level-narrowed, white spark — locked-in (resolve)
  steady:    G(['DD..DD', 'DD..DD', '.D..D.']),              // open, calm, gaze settled forward (resolve)
  calm:      G(['D....D', '.DDDD.']),                        // soft ︶︶ relaxed lids — serene/content
  avert:     G(['......', 'DD..DD']),                        // pupils dropped low — looking away/down (sheepish/self-conscious)
};
const BLINK = G(['DDD..DDD']); // transient over any expression

// ── brows (sit just above the eyes) ─────────────────────────────────────────────
export const BROWS = {
  one_raised: G(['......DD', 'DD......']),                  // skeptical asymmetry
  worried:    G(['..DD..DD..', 'DD......DD']),              // inner-up
  sad:        G(['..DDDD..', '.D....D.', 'D......D']),      // strong inner-up angle
  determined: G(['DD......DD', '..DD..DD..']),              // LEGACY: outer-up / inner-down furrow — reads as anger/menace
  // resolve brows: LOW + LEVEL (no inner-down spike = no anger). Knit = a gentle centre
  // draw-together for concentration; flat = a clean lowered bar for calm steel.
  firm:      G(['..............', 'DDDDDD..DDDDDD']),        // low, level, heavy bar — steely focus (drops close to the eyes)
  knit:      G(['..............', '..DDDD..DDDD..', '....DDDDDD....']), // low brows knitting into a centre furrow — concentration
};

// ── mouth = MUSTACHE, morphed to the feeling ────────────────────────────────────
// A curly HANDLEBAR silhouette: outer tips curl UP into hooks, body hangs in the
// centre under the nose. Same emoting language as before — tips up = happy, tips
// droop = sad — but the shape always reads as a waxed 'stache, not a mouth.
export const MOUTH = {
  neutral: G([
    'DD..........DD',
    'D.DD......DD.D',
    '..DDD....DDD..',
    '..DDDDDDDDDD..',
    '...DDDDDDDD...',
  ]),
  slight_smile: G([
    'DD..........DD',
    'D.DD......DD.D',
    '..DDD....DDD..',
    '...DDDDDDDD...',
    '....DDDDDD....',
  ]),
  open_smile: G([
    'DDD........DDD',
    'D.DDD....DDD.D',
    '..DDDD..DDDD..',
    '...DDD..DDD...',
    '....DDDDDD....',
  ]),
  big_grin: G([
    'DDD........DDD',
    'D.DDD....DDD.D',
    '..DDDD..DDDD..',
    '..DDDDDDDDDD..',
    '...DDDDDDDD...',
    '....DDDDDD....',
  ]),
  flat_skew: G([
    'DD............',
    'D.DD.......DD.',
    '..DDDDDDDDDD.D',
    '...DDDDDDDDD..',
    '....DDDDDD....',
  ]),
  awkward: G([
    'DD..........DD',
    'D.DD..DD..DD.D',
    '..DDDD..DDDD..',
    '...DD.DD.DD...',
    '....D.DD.D....',
  ]),
  small: G([
    '.DD......DD.',
    '..DDD..DDD..',
    '...DDDDDD...',
  ]),
  frown: G([
    '...DDDDDDDD...',
    '..DDDDDDDDDD..',
    '..DDD....DDD..',
    'D.DD......DD.D',
    'DD..........DD',
  ]),
  set: G([                          // firm, resolute bar — neither up nor down (determined)
    'DD..........DD',
    'D.DD......DD.D',
    '..DDDDDDDDDD..',
    '..DDDDDDDDDD..',
  ]),
};

// ── face anchors (absolute grid rows; columns auto-centred per feature width) ────
const ROW = {
  brows: BODY_TOP + 8,   // 16
  eyes: BODY_TOP + 11,   // 19
  mouth: BODY_TOP + 16,  // 24 — a row of breathing space below the eyes
  cheeks: BODY_TOP + 13, // 21
  sweat: BODY_TOP + 2,   // 10
};

const place = (out, sprite, col, row) => {
  for (const c of sprite.cells) out.push({ x: c.x + col, y: c.y + row, c: c.c });
  return out;
};

/**
 * composeFace(faceSpec, { blink }) → face cells in grid coords.
 * faceSpec is an entry's `face` object from lib/expressions.mjs.
 */
export function composeFace(faceSpec = {}, { blink = false } = {}) {
  let cells = [];

  // brows — recolor to dark-mustard (R) so they don't read as a second pair of eyes
  if (faceSpec.brows && BROWS[faceSpec.brows]) {
    const b = BROWS[faceSpec.brows];
    const browCells = { w: b.w, cells: b.cells.map((c) => ({ x: c.x, y: c.y, c: c.c === 'D' ? 'R' : c.c })) };
    place(cells, browCells, centerCol(b.w), ROW.brows);
  }

  // eyes (blink overrides to a shut line)
  const eyesKey = faceSpec.eyes && EYES[faceSpec.eyes] ? faceSpec.eyes : 'dots';
  const eyeSprite = blink ? BLINK : EYES[eyesKey];
  place(cells, eyeSprite, centerCol(eyeSprite.w), ROW.eyes);

  // mouth = mustache
  const mKey = faceSpec.mouth && MOUTH[faceSpec.mouth] ? faceSpec.mouth : 'neutral';
  const m = MOUTH[mKey];
  place(cells, m, centerCol(m.w), ROW.mouth);

  // accents
  if (faceSpec.blush) { // two rosy cheeks
    place(cells, G(['PP', 'PP']), Math.round(bodyCx - 8), ROW.cheeks);
    place(cells, G(['PP', 'PP']), Math.round(bodyCx + 4), ROW.cheeks);
  }
  if (faceSpec.flush) { // bigger, deeper flush
    place(cells, G(['PPP', 'PPP']), Math.round(bodyCx - 9), ROW.cheeks);
    place(cells, G(['PPP', 'PPP']), Math.round(bodyCx + 4), ROW.cheeks);
  }
  if (faceSpec.sweat) { // a single cool drop at the upper-right temple
    place(cells, G(['.C', 'CC', 'CC']), Math.round(bodyCx + 4), ROW.sweat);
  }
  if (faceSpec.zzz) { // floating Zzz in the headroom, ascending to the right
    place(cells, G(['WWW', '.W.', 'WWW']), Math.round(bodyCx + 1), 4);
    place(cells, G(['WW', 'W.', 'WW']), Math.round(bodyCx + 5), 1);
  }

  return cells;
}
