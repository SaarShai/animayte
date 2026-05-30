/*
 * animayte · easing — pure, zero-dependency easing curves (Node + browser).
 *
 * Vendored from Robert Penner's easing equations (BSD) as popularised by
 * easings.net (public-domain reference implementations). Normalised so every
 * curve maps t∈[0,1] → roughly [0,1]; the "Back"/"Elastic" curves intentionally
 * overshoot outside that range (that overshoot IS the bounce).
 *
 * Timing IS the easing at pixel scale (§4.4): hold the extremes, blow through the
 * middles. These curves drive the procedural squash/stretch in transform.mjs.
 */

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const linear = (t) => t;

export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => t * (2 - t);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const easeInCubic = (t) => t * t * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export const easeInSine = (t) => 1 - Math.cos((t * Math.PI) / 2);
export const easeOutSine = (t) => Math.sin((t * Math.PI) / 2);
export const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

// ── overshoot-and-settle: the workhorses for a bouncy slime ──────────────────
const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
export const easeInBack = (t) => C3 * t * t * t - C1 * t * t;
export const easeOutBack = (t) => 1 + C3 * Math.pow(t - 1, 3) + C1 * Math.pow(t - 1, 2);
export const easeInOutBack = (t) =>
  t < 0.5
    ? (Math.pow(2 * t, 2) * ((C2 + 1) * 2 * t - C2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2;

export const easeOutBounce = (t) => {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1; return n1 * t * t + 0.984375;
};
export const easeInBounce = (t) => 1 - easeOutBounce(1 - t);

const C4 = (2 * Math.PI) / 3;
const C5 = (2 * Math.PI) / 4.5;
export const easeOutElastic = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1;
export const easeInElastic = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * C4);
export const easeInOutElastic = (t) =>
  t === 0 ? 0 : t === 1 ? 1
    : t < 0.5
      ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2
      : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1;

/** Name → curve. The string a clip/track stores; resolved at sample time. */
export const EASINGS = {
  linear,
  easeInQuad, easeOutQuad, easeInOutQuad,
  easeInCubic, easeOutCubic, easeInOutCubic,
  easeInSine, easeOutSine, easeInOutSine,
  easeInBack, easeOutBack, easeInOutBack,
  easeInBounce, easeOutBounce,
  easeInElastic, easeOutElastic, easeInOutElastic,
};

/** ease(name, t) — resolve a named curve and apply it to a clamped t. Unknown → linear. */
export const ease = (name, t) => (EASINGS[name] || linear)(clamp01(t));

/** Is `name` a real easing curve we ship? (manifest validation uses this.) */
export const isEasing = (name) => Object.prototype.hasOwnProperty.call(EASINGS, name);
