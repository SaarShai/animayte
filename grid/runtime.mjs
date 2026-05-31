/*
 * animayte · grid runtime — drives Dijon from live session signals.
 *
 * Mirrors the public control API of lib/anim/runtime.mjs (setMood / setFullness /
 * addBird / relief / sleep / reactByName / …) so the daemon + animayte.html can drive
 * this renderer unchanged in Phase 4. Internally it's all grid: the (reused) state
 * machine arbitrates idle ↔ fidget ↔ bored ↔ reaction; grid/motion.mjs makes the pose;
 * the face comes from lib/expressions.mjs; context-fullness swells the body; sub-agents
 * orbit as little triangles; particles + palette tint carry the rest.
 */

import { render, sizeCanvas } from './engine.mjs';
import { GRID, PALETTE, compose } from './creature.mjs';
import { BODY_TOP } from './geom.mjs';
import { MANIFEST, MOOD_EXPRESSION } from './manifest.mjs';
import { motionFor } from './motion.mjs';
import { createStateMachine } from '../lib/anim/state-machine.mjs';
import { byId } from '../lib/expressions.mjs';
import { composeExpression } from './compose.mjs';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const to2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const rgbHex = (rgb) => '#' + rgb.map(to2).join('');
// context-fullness heat: a vertical yellow→orange→red gradient, hottest at the TOP and
// scaling with fullness; the base stays yellow. Sampled per cell → pixelated by design.
const YELLOW = [230, 168, 23], ORANGE = [233, 126, 42], RED = [212, 52, 40];
function heatColor(p, fullness) {
  const f = clamp((fullness - 0.2) / 0.8, 0, 1);      // stay pure yellow until 20% full
  const heat = clamp(f * 1.2 * (1 - p), 0, 1);         // p: 0 top … 1 bottom
  return heat < 0.5 ? mix(YELLOW, ORANGE, heat / 0.5) : mix(ORANGE, RED, (heat - 0.5) / 0.5);
}

export function createGridRuntime(canvas, opts = {}) {
  const dpr = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  let cell = opts.cell || 10;
  let ctx = sizeCanvas(canvas, GRID.w, GRID.h, cell, dpr);
  const cxCells = (GRID.w - 1) / 2, yTop = BODY_TOP, yBot = GRID.h;
  let CX = cxCells * cell;
  // forehead sweat beads (1×2-pixel droplets) — slide down + fade when context is high
  const BEADS = [{ dx: -3, t: 0.15, speed: 0.0004 }, { dx: 2.5, t: 0.66, speed: 0.00033 }];

  const sm = createStateMachine(MANIFEST, { defaultExpression: 'neutral', secondaryEveryMs: 7000 });
  const S = { mood: 'idle', fullness: 0, phase: 'alive', birds: [], fx: [], shake: 0, errFlash: 0, lastT: 0, lastZ: 0, now: 0, exprFace: null, exprItem: null };
  let birdSeq = 1;
  // /compact relief — an 8s eased deflation with smoke hissing out the sides
  const REL = { active: false, t0: 0, from: 0, to: 0.3, lastPuff: 0, dur: 8000 };

  // ── particles ───────────────────────────────────────────────────────────────
  const CONFETTI = ['#E6A817', '#F4C95D', '#EC8A7E', '#CFEAF7', '#FFF7E6'];
  function burst() {
    for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; S.fx.push({ x: CX, y: (BODY_TOP + 6) * cell, vx: Math.cos(a) * (1.4 + Math.random()) * cell * 0.2, vy: (Math.sin(a) * 1.2 - 0.8) * cell * 0.2, life: 34 + Math.random() * 16, col: CONFETTI[i % CONFETTI.length], sz: Math.max(2, cell * 0.28) }); }
  }
  // one soft smoke puff drifting outward (+up) from a head side — subtle, fades out
  function puff(x, y, dir) {
    S.fx.push({ x, y, vx: dir * (0.12 + Math.random() * 0.14) * cell * 0.2, vy: -(0.18 + Math.random() * 0.28) * cell * 0.2, life: 46 + Math.random() * 26, col: '#D8DEE6', sz: Math.max(2, Math.round(cell * 0.34)), steam: true, cap: 0.5 });
  }
  // smoke from both sides of the head; emit points pull inward as the dome deflates
  function sideSmoke() {
    const yC = (BODY_TOP + 3) * cell;
    const halfX = (5 + 4 * S.fullness) * cell;
    puff(CX - halfX, yC, -1);
    puff(CX + halfX, yC, 1);
  }
  function poof(x, y) { for (let i = 0; i < 7; i++) S.fx.push({ x, y, vx: (Math.random() - 0.5) * cell * 0.3, vy: (Math.random() - 0.5) * cell * 0.3, life: 18, col: '#CFE0FF', sz: Math.max(2, cell * 0.25) }); }

  // ── controls (mirror lib/anim/runtime.mjs) ───────────────────────────────────
  const REACT_PRIORITY = { happy: 4, excited: 6, oops: 4, bashful: 4, sad: 5, embarrassed: 5 };
  function setMood(mood) {
    S.phase = 'alive'; S.mood = mood || 'idle';
    S.exprFace = null; S.exprItem = null;   // a sticky mood reclaims the face from any spec override
    const expr = MOOD_EXPRESSION[S.mood] || 'neutral';
    sm.setIdleExpression(expr);
    if (S.mood in REACT_PRIORITY) sm.react({ clip: 'react', expression: expr, priority: REACT_PRIORITY[S.mood], return: 'idle' });
    if (S.mood === 'excited') burst();
    if (S.mood === 'oops' || S.mood === 'bashful') S.shake = 1;
    if (S.mood === 'sad') { S.errFlash = 1; S.shake = 0.7; }  // bad news lands as a quick wince/flinch
  }
  function setFullness(v) { if (REL.active) return; S.fullness = clamp(v, 0, 1); } // relief owns fullness while deflating
  function addBird(label) { if (S.birds.length >= 5) return; S.birds.push({ id: birdSeq++, label: label || 'task', born: S.lastT }); }
  function removeBird() { const b = S.birds.shift(); if (b) poof(b._x || CX, b._y || (BODY_TOP * cell)); }
  function clearBirds() { S.birds = []; }
  function relief() {
    REL.active = true; REL.t0 = S.now; REL.from = S.fullness; REL.to = Math.min(S.fullness, 0.3); REL.lastPuff = 0;
    sm.setIdleExpression('happy'); // a relieved face for the whole exhale
    sideSmoke();                    // an immediate first release
  }
  function sleep() { S.phase = 'sleeping'; sm.setIdleExpression('sleepy'); sm.setIdleClip('sleep'); }
  function wake() { if (S.phase === 'sleeping') { S.phase = 'alive'; sm.setIdleClip('idle'); setMood('happy'); } }
  function reset() { S.birds = []; S.fx = []; S.fullness = 0; S.phase = 'alive'; S.exprFace = null; S.exprItem = null; sm.reset(); sm.setIdleClip('idle'); setMood('idle'); }
  function reactByName(name) { const r = MANIFEST.reactions[name]; if (r) { S.phase = 'alive'; S.exprFace = null; S.exprItem = null; sm.react({ ...r, name }); return true; } return false; }
  function toIdle() { return sm.release(); }

  // ── applySpec — the FULL FeatureSpec render path (Route 2's seam) ───────────────
  // composeExpression maps the appraisal AXES → a face + FX + prop; we render that
  // composed face (not just the base mood) and fire the matching one-shot FX. Route 3
  // wires the SSE `express` cmd to call pet.applySpec(spec).
  function applySpec(spec) {
    if (!spec || typeof spec !== 'object') return false;
    const { face, fx, item } = composeExpression(spec);
    S.phase = 'alive';
    S.exprFace = face;                 // sticky visual override until the next mood/react/reset
    S.exprItem = item || null;
    if (fx.flash) S.errFlash = 1;      // red external-setback wince
    if (fx.burst) burst();             // confetti on a big win
    if (fx.shake) S.shake = Math.max(S.shake, fx.shake);
    // a little squash-pop so the change is FELT; expression only feeds the react's tint hooks
    sm.react({ clip: 'react', expression: spec.expression || 'neutral', priority: 5, return: 'idle' });
    return true;
  }

  // ── draw ─────────────────────────────────────────────────────────────────────
  function drawPet(now) {
    const cur = sm.current();
    const exprId = S.phase === 'sleeping' ? 'sleepy' : (cur.expression || 'neutral');
    // a spec override (from applySpec) wins over the dictionary mood face — except while
    // asleep, where 'sleepy' always shows.
    const useSpec = S.exprFace && S.phase !== 'sleeping';
    const face = useSpec ? { ...S.exprFace } : { ...((byId(exprId) && byId(exprId).face) || {}) };

    const m = motionFor(cur.clip, cur.t, now);
    const shakeX = S.shake > 0 ? Math.sin(now * 0.05) * S.shake * 0.6 : 0;
    const tf = { sx: m.sx, sy: m.sy, offX: (m.offX || 0) + shakeX, offY: m.offY || 0, rot: m.rot || 0 };

    const fullness = S.fullness, errFlash = S.errFlash;
    // per-cell heat gradient on the body (yellow base → red dome), + a red failure flash
    const colorFor = (fullness > 0.01 || errFlash > 0.02)
      ? (x, y, c) => {
        if (c !== 'B' && c !== 'S') return null;
        const p = clamp((y - yTop) / (yBot - yTop), 0, 1);
        let rgb = heatColor(p, fullness);
        if (errFlash > 0.02) rgb = mix(rgb, RED, Math.min(1, errFlash));
        if (c === 'S') rgb = rgb.map((v) => clamp(v + 30, 0, 255));
        return rgbHex(rgb);
      }
      : null;
    // localized swell: ONLY the dome above the eyes puffs up + out (base stays planted).
    // The lift tapers GRADUALLY from apex to mid-face so adjacent rows don't tear apart;
    // body cells also grow to overlap their neighbours and keep the dome a solid mass.
    const warp = fullness > 0.01
      ? (x, y, c) => {
        const p = clamp((y - yTop) / (yBot - yTop), 0, 1);
        const topAmt = 1 - smoothstep(0.0, 0.5, p);     // 1 at apex … 0 by the eyes
        const s = topAmt * fullness;
        if (s <= 0.001) return null;
        return { dx: (x - cxCells) * s * 0.36, dy: -s * 3.0, grow: (c === 'B' || c === 'S') ? s * 1.3 : 0 };
      }
      : null;

    const props = (useSpec && S.exprItem) ? [S.exprItem] : (cur.prop ? [cur.prop] : []);
    const cells = compose(face, { blink: !!m.blink, props });
    render(ctx, cells, PALETTE, { gridW: GRID.w, gridH: GRID.h, cell, transform: tf, colorFor, warp, eps: fullness > 0.05 ? 0.12 : 0.04 });
  }

  // forehead beads — drawn on top of the body; each a subtle 1×2-pixel droplet
  function drawBeads() {
    if (S.fullness <= 0.45) return;
    const intensity = clamp((S.fullness - 0.45) / 0.3, 0, 1);
    const startY = yTop + 2.5, travel = 9;
    const bw = Math.max(2, Math.round(cell * 0.6)), bh = Math.max(2, Math.round(cell * 1.4));
    for (const bd of BEADS) {
      if (bd.t < 0 || bd.t > 1.05) continue;
      const yCell = startY + bd.t * travel;
      const a = clamp(bd.t / 0.12, 0, 1) * (1 - smoothstep(0.6, 1.0, bd.t)) * intensity * 0.85;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#EAF6FF';
      ctx.fillRect(Math.round((cxCells + bd.dx) * cell), Math.round(yCell * cell), bw, bh);
      ctx.globalAlpha = 1;
    }
  }

  function drawBirds(now) {
    const n = S.birds.length; if (!n) return;
    const u = Math.max(2, Math.round(cell * 0.5));
    for (let i = 0; i < n; i++) {
      const b = S.birds[i];
      const ang = now * 0.0013 + (i / n) * TAU;
      const x = CX + Math.cos(ang) * 7 * cell;
      const y = (BODY_TOP + 1) * cell + Math.sin(ang) * 2.4 * cell;
      b._x = x; b._y = y;
      const age = clamp((S.lastT - b.born) / 0.35, 0, 1); if (age < 0.12) continue;
      // a tiny mustard triangle (a baby Dijon helper)
      ctx.fillStyle = PALETTE.B;
      ctx.fillRect(Math.round(x - u / 2), Math.round(y - u), u, u);
      ctx.fillRect(Math.round(x - u * 1.5), Math.round(y), u * 3, u);
      ctx.fillStyle = PALETTE.D; // two dot eyes
      ctx.fillRect(Math.round(x - u), Math.round(y), Math.max(1, u * 0.4), Math.max(1, u * 0.4));
      ctx.fillRect(Math.round(x + u * 0.6), Math.round(y), Math.max(1, u * 0.4), Math.max(1, u * 0.4));
    }
  }

  function drawFx() {
    for (let i = S.fx.length - 1; i >= 0; i--) {
      const f = S.fx[i];
      f.x += f.vx; f.y += f.vy; if (f.steam) f.vx *= 0.96; else f.vy += 0.04 * cell * 0.2;
      if (--f.life <= 0) { S.fx.splice(i, 1); continue; }
      ctx.globalAlpha = f.steam ? clamp(f.life / 50, 0, f.cap || 0.8) : clamp(f.life / 20, 0, 1);
      ctx.fillStyle = f.col;
      ctx.fillRect(Math.round(f.x), Math.round(f.y), f.sz, f.sz);
      ctx.globalAlpha = 1;
    }
  }

  let raf = 0;
  function frame(nowMs) {
    const t = nowMs / 1000;
    const dt = S.lastT ? (t - S.lastT) * 1000 : 16;
    S.lastT = t; S.now = nowMs;
    sm.tick(dt);
    S.shake *= 0.86; if (S.shake < 0.004) S.shake = 0;
    S.errFlash *= 0.94; if (S.errFlash < 0.02) S.errFlash = 0;
    // /compact relief: ease the fullness down over 8s, hissing smoke from the sides
    if (REL.active) {
      const k = clamp((S.now - REL.t0) / REL.dur, 0, 1);
      S.fullness = REL.from + (REL.to - REL.from) * easeInOutCubic(k);
      if (k < 0.72 && S.now - REL.lastPuff > 110) { REL.lastPuff = S.now; sideSmoke(); }
      if (k >= 1) { REL.active = false; sm.react({ clip: 'react', expression: 'happy', priority: 6, return: 'idle' }); }
    }
    // advance the forehead beads (and respawn at the top after a short gap)
    if (S.fullness > 0.45) for (const bd of BEADS) { bd.t += bd.speed * dt; if (bd.t > 1.25) bd.t = -0.2 - Math.random() * 0.35; }
    // drifting Zzz while asleep
    if (S.phase === 'sleeping' && nowMs - S.lastZ > 900) { S.lastZ = nowMs; S.fx.push({ x: CX + 5 * cell, y: BODY_TOP * cell, vx: 0.05 * cell, vy: -0.5 * cell * 0.2, life: 54, col: '#9BB3C9', sz: Math.max(2, cell * 0.3) }); }
    drawPet(nowMs);
    drawBeads();
    drawBirds(nowMs);
    drawFx();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function resize(c) { cell = c; CX = cxCells * cell; ctx = sizeCanvas(canvas, GRID.w, GRID.h, cell, dpr); }

  return {
    setMood, setFullness, addBird, removeBird, clearBirds, relief, sleep, wake, reset, reactByName, toIdle, applySpec, resize,
    get state() { const c = sm.current(); return { mood: S.mood, fullness: S.fullness, birds: S.birds.length, phase: S.phase, expression: c.expression, clip: c.clip, kind: c.kind, prop: (S.exprFace ? S.exprItem : c.prop), fx: S.fx.length, relief: REL.active, spec: !!S.exprFace }; },
    stop() { cancelAnimationFrame(raf); },
    sm,
  };
}
