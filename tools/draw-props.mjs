/*
 * animayte · prop art — the §4.5 iconographic overlay library (zero-dep pixel plots).
 *
 * Each prop is a tiny icon drawn into a CELL×CELL cell (default 24): 1–2px dark outline,
 * ≤4 colors, readable at a glance. The compiler (make-assets) packs them into a strip;
 * the runtime overlays one at a prop's body anchor with a 2-frame scale pop-in (§4.4).
 * Kept in its own module so the prop set can grow without touching the slime drawing.
 */
export const PROP_CELL = 24;

// the ordered prop set → also the column order in the generated sheet
export const PROPS = [
  'glasses', 'magnifier', 'pencil', 'book', 'exclaim', 'question',
  'ellipsis', 'sparkle', 'idea', 'heart', 'check', 'zzz', 'steam', 'dust',
];

// shared prop palette (accent-driven; mood-independent per §4.5)
const INK = [22, 53, 43];            // dark outline (matches the pet outline family)
const NEU = [58, 68, 102];           // neutral blue-grey (glasses/?/book)
const WARM = [254, 231, 97];         // warm yellow (!/✨/💡)
const ALERT = [228, 59, 68];         // alert red (error/heart)
const WHITE = [242, 251, 233];
const GLASS = [180, 222, 255, 150];  // translucent lens
const WOOD = [232, 168, 78];         // pencil body
const PINK = [246, 117, 122];        // eraser / heart hi
const GREEN = [91, 198, 97];         // check
const STEAM = [220, 234, 242];       // puff

const rect = (C, x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) C.px(xx, yy, c); };
const dot = (C, x, y, c) => C.px(x, y, c);
const ring = (C, cx, cy, r, c) => { for (let a = 0; a < 360; a += 12) { C.px(Math.round(cx + Math.cos(a * Math.PI / 180) * r), Math.round(cy + Math.sin(a * Math.PI / 180) * r), c); } };
const disc = (C, cx, cy, r, c) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) C.px(cx + x, cy + y, c); };

// each prop draws centered in its cell at (ox+12, oy+12)
const DRAW = {
  glasses(C, ox, oy) {
    const y = oy + 12;
    for (const lx of [ox + 7, ox + 17]) { // two lenses
      ring(C, lx, y, 3, INK); disc(C, lx, y, 2, GLASS);
    }
    rect(C, ox + 10, y - 1, 4, 2, INK);   // bridge
    rect(C, ox + 3, y - 2, 2, 1, INK); rect(C, ox + 19, y - 2, 2, 1, INK); // temples
  },
  magnifier(C, ox, oy) {
    ring(C, ox + 10, oy + 9, 4, INK); disc(C, ox + 10, oy + 9, 3, GLASS);
    dot(C, ox + 8, oy + 7, WHITE);
    for (let i = 0; i < 5; i++) { C.px(ox + 13 + i, oy + 12 + i, INK); C.px(ox + 14 + i, oy + 12 + i, INK); } // handle
  },
  pencil(C, ox, oy) {
    for (let i = 0; i < 11; i++) { const x = ox + 5 + i, y = oy + 16 - i; rect(C, x, y, 2, 2, i < 2 ? PINK : i > 8 ? INK : WOOD); }
    dot(C, ox + 16, oy + 5, INK); // tip
  },
  book(C, ox, oy) {
    rect(C, ox + 5, oy + 7, 14, 10, NEU);
    rect(C, ox + 6, oy + 8, 5, 8, WHITE); rect(C, ox + 13, oy + 8, 5, 8, WHITE);
    rect(C, ox + 11, oy + 7, 2, 10, INK); // spine
  },
  exclaim(C, ox, oy) { rect(C, ox + 10, oy + 4, 3, 9, ALERT); rect(C, ox + 10, oy + 15, 3, 3, ALERT); rect(C, ox + 9, oy + 4, 1, 12, [...INK, 120]); },
  question(C, ox, oy) {
    rect(C, ox + 8, oy + 5, 7, 2, NEU); rect(C, ox + 14, oy + 6, 2, 4, NEU); rect(C, ox + 11, oy + 9, 4, 2, NEU); rect(C, ox + 11, oy + 11, 2, 3, NEU); rect(C, ox + 11, oy + 16, 2, 2, NEU);
  },
  ellipsis(C, ox, oy) { for (const x of [ox + 6, ox + 11, ox + 16]) rect(C, x, oy + 11, 2, 2, NEU); },
  sparkle(C, ox, oy) {
    const cx = ox + 12, cy = oy + 11;
    for (let i = -4; i <= 4; i++) { C.px(cx + i, cy, WARM); C.px(cx, cy + i, WARM); }
    dot(C, cx - 1, cy - 1, WHITE); dot(C, cx + 1, cy + 1, WARM);
    dot(C, ox + 18, oy + 5, WARM); dot(C, ox + 5, oy + 17, WARM);
  },
  idea(C, ox, oy) {
    disc(C, ox + 12, oy + 9, 4, WARM); ring(C, ox + 12, oy + 9, 4, INK);
    rect(C, ox + 10, oy + 13, 4, 2, NEU); rect(C, ox + 10, oy + 15, 4, 1, INK);
    for (let i = 0; i < 3; i++) C.px(ox + 12, oy + 4 - i, WARM); // shine
  },
  heart(C, ox, oy) {
    const c = ALERT;
    rect(C, ox + 7, oy + 7, 4, 3, c); rect(C, ox + 13, oy + 7, 4, 3, c);
    rect(C, ox + 6, oy + 9, 12, 3, c); rect(C, ox + 8, oy + 12, 8, 2, c); rect(C, ox + 10, oy + 14, 4, 2, c);
    dot(C, ox + 9, oy + 8, PINK);
  },
  check(C, ox, oy) {
    for (let i = 0; i < 4; i++) C.px(ox + 7 + i, oy + 11 + i, GREEN);
    for (let i = 0; i < 7; i++) C.px(ox + 11 + i, oy + 14 - i, GREEN);
    for (let i = 0; i < 4; i++) C.px(ox + 7 + i, oy + 12 + i, [...GREEN, 120]);
  },
  zzz(C, ox, oy) {
    const z = (bx, by, s) => { for (let i = 0; i < s; i++) C.px(bx + i, by, NEU); for (let i = 0; i < s; i++) C.px(bx + s - 1 - i, by + i, NEU); for (let i = 0; i < s; i++) C.px(bx + i, by + s - 1, NEU); };
    z(ox + 5, oy + 12, 4); z(ox + 11, oy + 7, 5); z(ox + 17, oy + 3, 3);
  },
  steam(C, ox, oy) { disc(C, ox + 8, oy + 12, 3, STEAM); disc(C, ox + 13, oy + 10, 4, STEAM); disc(C, ox + 17, oy + 13, 3, STEAM); disc(C, ox + 12, oy + 14, 3, STEAM); },
  dust(C, ox, oy) { disc(C, ox + 6, oy + 15, 3, STEAM); disc(C, ox + 12, oy + 16, 2, STEAM); disc(C, ox + 17, oy + 15, 3, STEAM); ring(C, ox + 6, oy + 15, 3, [...NEU, 90]); ring(C, ox + 17, oy + 15, 3, [...NEU, 90]); },
};

export function drawProp(C, ox, oy, name) {
  const fn = DRAW[name];
  if (fn) fn(C, ox, oy);
  return !!fn;
}
