/*
 * animayte · grid geometry — shared layout constants (breaks the creature↔face import
 * cycle: both import from here, neither from each other for these constants).
 *
 * The creature sits in the LOWER part of the grid so there's headroom above the head
 * for floating props (lightbulb, Zzz) — mirroring the reference art where the idea-bulb
 * hovers well above the pet.
 */

export const GRID = { w: 30, h: 36 };

export const BODY_TOP = 8;            // first row the triangle occupies (rows 0..7 = headroom)
export const BODY_H = GRID.h - BODY_TOP; // 28 — the triangle's own height

export const bodyCx = (GRID.w - 1) / 2; // 14.5 — true horizontal centre

/** centerCol(featureWidth) → the left column that centres a feature on the body. */
export const centerCol = (fw) => Math.round(bodyCx - fw / 2);
