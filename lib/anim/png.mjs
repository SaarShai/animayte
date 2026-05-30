/*
 * animayte · png — shared zero-dep RGBA canvas + PNG encode/header-decode.
 *
 * Extracted from tools/make-assets.mjs so the compiler, the offline preview, and
 * the tests all share ONE encoder (no drift). Node built-ins only (node:zlib).
 * Also ships a tiny 3×5 bitmap font so contact-sheets/filmstrips can label
 * themselves — the whole point is that they're readable when QA'd.
 */
import { deflateSync } from 'node:zlib';

// ---------- minimal PNG encoder (RGBA, 8-bit) ----------
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, dataBuf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dataBuf.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, dataBuf])), 0);
  return Buffer.concat([len, typeBuf, dataBuf, crcBuf]);
}
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
export function encodePNG(W, H, rgba) {
  const sig = Buffer.from(PNG_SIG);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]; }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** readPngHeader(buf) → { sig, width, height, bitDepth, colorType } (no full decode). */
export function readPngHeader(buf) {
  const sig = PNG_SIG.every((b, i) => buf[i] === b);
  if (!sig) return { sig: false };
  // IHDR data starts at byte 16 (8 sig + 4 len + 4 "IHDR")
  return {
    sig: true,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

// ---------- pixel canvas with alpha compositing ----------
export function Canvas(W, H) {
  const d = new Uint8Array(W * H * 4);
  const px = (x, y, c) => {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return;
    const a = (c[3] === undefined ? 255 : c[3]) / 255; if (a <= 0) return;
    const i = (y * W + x) * 4, da = d[i + 3] / 255, oa = a + da * (1 - a);
    d[i] = (c[0] * a + d[i] * da * (1 - a)) / oa;
    d[i + 1] = (c[1] * a + d[i + 1] * da * (1 - a)) / oa;
    d[i + 2] = (c[2] * a + d[i + 2] * da * (1 - a)) / oa;
    d[i + 3] = oa * 255;
  };
  return { W, H, d, px };
}

/** Sample a canvas pixel as [r,g,b,a] (out-of-bounds → transparent). */
export function sample(C, x, y) {
  x |= 0; y |= 0; if (x < 0 || y < 0 || x >= C.W || y >= C.H) return [0, 0, 0, 0];
  const i = (y * C.W + x) * 4; return [C.d[i], C.d[i + 1], C.d[i + 2], C.d[i + 3]];
}

/**
 * blitScaled — copy a source region of `src` into `dst` at integer/float scale,
 * nearest-neighbour, with optional per-axis scale. Used to upscale 64px cells into
 * a readable contact-sheet. `sx,sy,sw,sh` = source rect; `dx,dy` = dest top-left;
 * `kx,ky` = scale factors.
 */
export function blitScaled(dst, src, sx, sy, sw, sh, dx, dy, kx, ky = kx) {
  const ow = Math.round(sw * kx), oh = Math.round(sh * ky);
  for (let oyi = 0; oyi < oh; oyi++) {
    const syi = sy + Math.floor(oyi / ky);
    for (let oxi = 0; oxi < ow; oxi++) {
      const sxi = sx + Math.floor(oxi / kx);
      dst.px(dx + oxi, dy + oyi, sample(src, sxi, syi));
    }
  }
}

export function fillRect(C, x, y, w, h, col) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) C.px(xx, yy, col);
}

/** Parse #rrggbb or #rrggbbaa → [r,g,b,a]. */
export function hexToRgba(hex) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return [r, g, b, a];
}

// ---------- tiny 3×5 bitmap font (uppercase + digits + a few symbols) ----------
// each glyph = 5 rows of 3 bits (bit2=left). Labels read clearly at scale ≥2.
const FONT = {
  A: [0b111, 0b101, 0b111, 0b101, 0b101], B: [0b110, 0b101, 0b110, 0b101, 0b110],
  C: [0b011, 0b100, 0b100, 0b100, 0b011], D: [0b110, 0b101, 0b101, 0b101, 0b110],
  E: [0b111, 0b100, 0b110, 0b100, 0b111], F: [0b111, 0b100, 0b110, 0b100, 0b100],
  G: [0b011, 0b100, 0b101, 0b101, 0b011], H: [0b101, 0b101, 0b111, 0b101, 0b101],
  I: [0b111, 0b010, 0b010, 0b010, 0b111], J: [0b001, 0b001, 0b001, 0b101, 0b010],
  K: [0b101, 0b101, 0b110, 0b101, 0b101], L: [0b100, 0b100, 0b100, 0b100, 0b111],
  M: [0b101, 0b111, 0b111, 0b101, 0b101], N: [0b101, 0b111, 0b111, 0b111, 0b101],
  O: [0b010, 0b101, 0b101, 0b101, 0b010], P: [0b111, 0b101, 0b111, 0b100, 0b100],
  Q: [0b010, 0b101, 0b101, 0b110, 0b011], R: [0b110, 0b101, 0b110, 0b101, 0b101],
  S: [0b011, 0b100, 0b010, 0b001, 0b110], T: [0b111, 0b010, 0b010, 0b010, 0b010],
  U: [0b101, 0b101, 0b101, 0b101, 0b111], V: [0b101, 0b101, 0b101, 0b101, 0b010],
  W: [0b101, 0b101, 0b111, 0b111, 0b101], X: [0b101, 0b101, 0b010, 0b101, 0b101],
  Y: [0b101, 0b101, 0b010, 0b010, 0b010], Z: [0b111, 0b001, 0b010, 0b100, 0b111],
  0: [0b111, 0b101, 0b101, 0b101, 0b111], 1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111], 3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001], 5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111], 7: [0b111, 0b001, 0b010, 0b010, 0b010],
  8: [0b111, 0b101, 0b111, 0b101, 0b111], 9: [0b111, 0b101, 0b111, 0b001, 0b111],
  ' ': [0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0b010], '-': [0, 0, 0b111, 0, 0],
  '/': [0b001, 0b001, 0b010, 0b100, 0b100], ':': [0, 0b010, 0, 0b010, 0],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101], '=': [0, 0b111, 0, 0b111, 0],
};

/** drawText(C, x, y, str, col, scale=1) — render a label with the 3×5 font. */
export function drawText(C, x, y, str, col, scale = 1) {
  let cx = x;
  for (const ch of String(str).toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let row = 0; row < 5; row++) for (let bit = 0; bit < 3; bit++) {
      if (g[row] & (1 << (2 - bit))) fillRect(C, cx + bit * scale, y + row * scale, scale, scale, col);
    }
    cx += 4 * scale; // 3px glyph + 1px space
  }
  return cx - x; // advance width
}

/** Measured width of a label at scale (for centering). */
export const textWidth = (str, scale = 1) => String(str).length * 4 * scale;
