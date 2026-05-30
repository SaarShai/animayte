/*
 * animayte · compositor — layer compositing, indexed palette-swap, outline (pure).
 *
 * Operates on flat RGBA Uint8Array buffers (the same straight-alpha format the
 * png.mjs Canvas produces), so the web runtime, the offline preview, and the
 * conformance golden all share one compositing path:
 *
 *   composite(layers)  → stack the layer buffers bottom→top (alpha over)
 *   swapPalette(buf,m)  → re-index ramp colors for a mood (calm→tired→error)
 *   buildSwap(from,to)  → derive a swap map from two manifest palettes (role→hex)
 *   computeOutline(buf) → a 1px silhouette outline LAYER from the alpha mask
 *
 * Palette-swap is the cheap, instant mood mechanism (§4.2): same pixels, re-indexed
 * colors. Outline is precomputed from the mask so a pet reads on any wallpaper (§4.1).
 */
import { hexToRgba } from './png.mjs';

const OPAQUE = 8; // alpha above this counts as "solid" for masks/outline

/** Blend src [r,g,b,a] OVER the dst buffer at index i (straight alpha, matches Canvas.px). */
function blendOver(d, i, sr, sg, sb, sa) {
  const a = sa / 255; if (a <= 0) return;
  const da = d[i + 3] / 255, oa = a + da * (1 - a);
  if (oa <= 0) return;
  d[i] = (sr * a + d[i] * da * (1 - a)) / oa;
  d[i + 1] = (sg * a + d[i + 1] * da * (1 - a)) / oa;
  d[i + 2] = (sb * a + d[i + 2] * da * (1 - a)) / oa;
  d[i + 3] = oa * 255;
}

/**
 * composite(layers, W, H) — stack RGBA buffers bottom→top, alpha-over, into a new
 * buffer. `layers` is an array of Uint8Array (each W·H·4), order = draw order.
 */
export function composite(layers, W, H) {
  const out = new Uint8Array(W * H * 4);
  for (const layer of layers) {
    if (!layer) continue;
    for (let i = 0; i < out.length; i += 4) {
      const sa = layer[i + 3];
      if (sa > 0) blendOver(out, i, layer[i], layer[i + 1], layer[i + 2], sa);
    }
  }
  return out;
}

const packRGB = (r, g, b) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);

/**
 * swapPalette(buf, swap) — in-place re-index. `swap` is a Map<packedRGB, [r,g,b]>.
 * Replaces the RGB of every exactly-matching opaque-ish pixel, KEEPING its alpha
 * (so soft edges survive). Returns the same buffer for chaining.
 */
export function swapPalette(buf, swap) {
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] === 0) continue;
    const to = swap.get(packRGB(buf[i], buf[i + 1], buf[i + 2]));
    if (to) { buf[i] = to[0]; buf[i + 1] = to[1]; buf[i + 2] = to[2]; }
  }
  return buf;
}

/**
 * buildSwap(fromPalette, toPalette) — a Map<packedRGB(from role), [r,g,b](to role)>
 * for every role present in BOTH manifest palettes. Roles are matched by name, so a
 * mood swap is "same roles, different hexes" (the manifest enforces shared roles).
 */
export function buildSwap(fromPalette, toPalette) {
  const swap = new Map();
  for (const role of Object.keys(fromPalette)) {
    if (!(role in toPalette)) continue;
    const f = hexToRgba(fromPalette[role]);
    const t = hexToRgba(toPalette[role]);
    swap.set(packRGB(f[0], f[1], f[2]), [t[0], t[1], t[2]]);
  }
  return swap;
}

/** alphaMask(buf, W, H) → Uint8Array(W·H) of 0/1 (1 = solid). */
export function alphaMask(buf, W, H) {
  const m = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) m[p] = buf[p * 4 + 3] > OPAQUE ? 1 : 0;
  return m;
}

/**
 * computeOutline(buf, W, H, color, { diagonal }) — return a NEW RGBA buffer holding
 * only the 1px outline: every transparent pixel that touches a solid pixel, painted
 * in `color` (hex or [r,g,b,a]). Composite it UNDER the body for a clean silhouette
 * that reads on any wallpaper. `diagonal` includes the 8-neighbourhood (rounder).
 */
export function computeOutline(buf, W, H, color = '#16352B', { diagonal = false } = {}) {
  const [r, g, b, a] = Array.isArray(color) ? color : hexToRgba(color);
  const mask = alphaMask(buf, W, H);
  const out = new Uint8Array(W * H * 4);
  const N = diagonal
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
    : [[0, -1], [-1, 0], [1, 0], [0, 1]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (mask[p]) continue;                 // solid pixels are not outline
    let touch = false;
    for (const [dx, dy] of N) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (mask[ny * W + nx]) { touch = true; break; }
    }
    if (touch) { const i = p * 4; out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a; }
  }
  return out;
}
