/*
 * animayte · transform — procedural squash/stretch/scale/offset/rotate (pure).
 *
 * A Transform is a plain object { sx, sy, tx, ty, rot }:
 *   sx,sy  scale factors   (1 = unchanged)
 *   tx,ty  pixel offset    (0 = unchanged)
 *   rot    rotation (rad)  (0 = unchanged)
 * Renderers apply it around the pet's anchor; the math here is renderer-agnostic
 * so the web runtime, the offline preview, and the conformance golden all agree.
 *
 * Squash & stretch conserves volume (§4.2/§4.4): a slime that gets shorter gets
 * wider, never both — the single most important principle for "alive" pixel art.
 */
import { ease } from './easing.mjs';

export const identity = () => ({ sx: 1, sy: 1, tx: 0, ty: 0, rot: 0 });

const MIN_SCALE = 0.05; // never collapse to zero (keeps area math finite)

/**
 * squash(k) — volume-conserving squash & stretch, AREA form (sx·sy ≡ 1).
 *   k > 0 → stretch (taller + narrower)   k < 0 → squash (shorter + wider)
 * The defining invariant `sx * sy === 1` is what makes motion read as a real,
 * mass-preserving body rather than a balloon. Used by the anticipation/landing beats.
 */
export function squash(k) {
  const sy = Math.max(MIN_SCALE, 1 + k);
  return { sx: 1 / sy, sy, tx: 0, ty: 0, rot: 0 };
}

/**
 * squashRound(k) — volume-conserving for a ROUND body (sx²·sy ≡ 1), i.e. the
 * width change is shared across both horizontal dimensions of a 3D-ish blob.
 * Reads softer than the flat area form on the slime; renderers may prefer it.
 */
export function squashRound(k) {
  const sy = Math.max(MIN_SCALE, 1 + k);
  return { sx: 1 / Math.sqrt(sy), sy, tx: 0, ty: 0, rot: 0 };
}

export const scale = (sx, sy = sx) => ({ sx, sy, tx: 0, ty: 0, rot: 0 });
export const offset = (tx, ty = 0) => ({ sx: 1, sy: 1, tx, ty, rot: 0 });
export const rotate = (rot) => ({ sx: 1, sy: 1, tx: 0, ty: 0, rot });

/** Combine two transforms: scales multiply, offsets/rotations add. */
export function compose(a, b) {
  return {
    sx: a.sx * b.sx,
    sy: a.sy * b.sy,
    tx: a.tx + b.tx,
    ty: a.ty + b.ty,
    rot: a.rot + b.rot,
  };
}

/** Compose any number of transforms left→right onto the identity. */
export const composeAll = (...xs) => xs.reduce(compose, identity());

/** Linear blend between two transforms (field-wise). */
export function lerpTransform(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    sx: a.sx + (b.sx - a.sx) * k,
    sy: a.sy + (b.sy - a.sy) * k,
    tx: a.tx + (b.tx - a.tx) * k,
    ty: a.ty + (b.ty - a.ty) * k,
    rot: a.rot + (b.rot - a.rot) * k,
  };
}

/** Fill any missing Transform fields from identity (keyframes may be sparse). */
export const normalizeKey = (k) => ({ ...identity(), ...k });

/**
 * sampleTrack(track, t) — sample a keyframed transform track at normalised t∈[0,1].
 * A track is an ascending list of keyframes: { t, sx?, sy?, tx?, ty?, rot?, ease? }.
 * Between two keys we interpolate with the *destination* key's `ease` curve
 * (so each segment owns its timing). Outside the range we clamp to the ends.
 */
export function sampleTrack(track, t) {
  if (!Array.isArray(track) || track.length === 0) return identity();
  if (track.length === 1) return normalizeKey(track[0]);
  if (t <= track[0].t) return normalizeKey(track[0]);
  const last = track[track.length - 1];
  if (t >= last.t) return normalizeKey(last);
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i], b = track[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t || 1;
      const local = ease(b.ease || a.ease || 'linear', (t - a.t) / span);
      return lerpTransform(normalizeKey(a), normalizeKey(b), local);
    }
  }
  return normalizeKey(last);
}

/**
 * applyToBox(transform, box, anchor) — resolve a Transform into a drawn rectangle.
 * `box` = { x, y, w, h } in target pixels; `anchor` = [ax, ay] in 0..1 of the box
 * (default bottom-centre [0.5, 1] — the slime sits on its base). Scales around the
 * anchor, then offsets. Rotation is returned for the renderer to apply about the
 * anchor (Canvas2D / Swift handle the actual rotate). Pure + deterministic so the
 * conformance golden can assert exact geometry.
 */
export function applyToBox(transform, box, anchor = [0.5, 1]) {
  const { sx, sy, tx, ty, rot } = { ...identity(), ...transform };
  const ax = box.x + box.w * anchor[0];
  const ay = box.y + box.h * anchor[1];
  const w = box.w * sx;
  const h = box.h * sy;
  return {
    x: ax - w * anchor[0] + tx,
    y: ay - h * anchor[1] + ty,
    w,
    h,
    rot,
    pivot: [ax + tx, ay + ty],
  };
}
