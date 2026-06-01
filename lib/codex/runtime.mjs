/*
 * animayte · codex/runtime — play a Codex / Petdex pet in our Canvas2D engine (browser ES module).
 *
 * A Codex pet is a flat BAKED atlas (8×9 grid of 192×208 cells; one motion state per row;
 * see codex/format.mjs). Unlike our layered slime (procedural face + palette + props), the
 * art bakes everything — so this player is thin: it resolves a session signal to a Codex
 * STATE, plays that row frame-by-frame (col = frame), and that's the pet.
 *
 * The behaviour brain is the SHARED state machine (lib/anim/state-machine.mjs), fed a
 * synthetic clips/reactions manifest derived from the Codex spec — so idle ↔ reaction ↔
 * return + priority arbitration + per-frame timing all behave identically to the slime.
 * On top we layer animayte's UNIQUE, art-agnostic depth: the context-window fullness swell,
 * orbiting sub-agent birds, particles, and reduced-motion — the moat that no Codex host has.
 *
 *   const pet = await createCodexRuntime(canvasEl, { manifestUrl: '/pets/pixel-coder/pet.json' });
 *   pet.setMood('working');  pet.reactByName('Reading');  pet.setFullness(0.7);  pet.addBird('search');
 *
 * Exposes the SAME controller contract as lib/anim/runtime.mjs, so the daemon/SSE and the
 * page's demo drive a Codex pet with zero changes.
 */
import { createStateMachine } from '../anim/state-machine.mjs';
import {
  ATLAS, buildCodexClips, rowOf, isLoopState, validateAtlasDims,
} from './format.mjs';
import { stateForMood, buildCodexReactions } from './mapping.mjs';

const loadImage = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img ' + src)); im.src = src; });
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const resolveSibling = (url, name) => url.slice(0, url.lastIndexOf('/') + 1) + name;

// one-shot mood gestures (waving/jumping/failed) fire as reactions; these priorities sit
// above routine tool reactions (≤4) so a celebration/stumble reads through ongoing work.
const MOOD_GESTURE_PRIORITY = { waving: 5, jumping: 6, failed: 6 };

export async function createCodexRuntime(canvas, opts = {}) {
  const manifestUrl = opts.manifestUrl || '/pets/codex/pet.json';
  const manifest = opts.manifest || await fetch(manifestUrl).then((r) => r.json());
  const sheetName = manifest.spritesheetPath || 'spritesheet.webp';
  const sheet = await loadImage(opts.sheetUrl || resolveSibling(manifestUrl, sheetName));
  const dimErrors = validateAtlasDims(sheet.width, sheet.height);
  if (dimErrors.length) console.warn('animayte/codex: ' + dimErrors.join('; ') + ' — playing it anyway (cells derived from the 8×9 grid).');

  const bird = await loadImage(opts.birdUrl || '/assets/bird.png').catch(() => null);

  // a Codex atlas is ALWAYS the 8×9 grid; derive the cell from the real image so an
  // off-spec sheet (e.g. a 2× export) still tiles correctly.
  const cellW = sheet.width / ATLAS.cols;
  const cellH = sheet.height / ATLAS.rows;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;          // Codex art is often illustrated (not pixel) — smooth the downscale
  ctx.imageSmoothingQuality = 'high';
  const AW = canvas.width, AH = canvas.height;
  const CX = AW / 2;
  // the creature is centered in its (taller) cell; fit ~94% of canvas height, nudged slightly
  // low so the jump (which lifts the art within the cell) has headroom and it reads "grounded".
  const baseScale = (AH * 0.94) / cellH;

  const reduceMotion = opts.reduceMotion === true || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const persona = { reactionIntensity: 1, ...(opts.personality || {}) };
  const intensity = (typeof persona.reactionIntensity === 'number' && persona.reactionIntensity > 0) ? persona.reactionIntensity : 1;

  // synthetic manifest → the shared brain. Pure idle loop (Codex idle already carries
  // micro-variation); the reactions map drives tool gags; no bored/sleep row exists.
  const smManifest = {
    clips: buildCodexClips(),
    reactions: buildCodexReactions(),
    idle: { base: 'idle', secondary: [], boredAfterMs: Infinity },
  };
  const sm = createStateMachine(smManifest, { defaultExpression: 'neutral', personality: persona });

  const S = {
    mood: 'idle', fullness: 0, phase: 'alive', moodLevel: 0,
    birds: [], fx: [], shake: 0, lastZ: 0, lastT: 0,
  };
  let nextBirdId = 1;

  // ── particles (art-agnostic flourishes) ──
  function burst(x, y, n, palette) { if (reduceMotion) return; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; S.fx.push({ x, y, vx: Math.cos(a) * (1.2 + Math.random()), vy: Math.sin(a) * 1.2 - 0.6, life: 30 + Math.random() * 16, kind: 'dot', col: palette[i % palette.length] }); } }
  function poof(x, y) { if (reduceMotion) return; for (let i = 0; i < 7; i++) S.fx.push({ x, y, vx: (Math.random() - 0.5) * 1.8, vy: (Math.random() - 0.5) * 1.8, life: 18, kind: 'dot', col: '#cfe0ff' }); }
  function steam(x, y) { if (reduceMotion) return; for (let i = 0; i < 10; i++) S.fx.push({ x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 0.5, vy: -0.7 - Math.random() * 0.6, life: 40 + Math.random() * 20, kind: 'steam', col: '#dceaf2' }); }

  // ── public controls (the same contract every animayte renderer exposes) ──
  function setMood(mood) {
    S.phase = 'alive';
    S.mood = mood || 'idle';
    const target = stateForMood(S.mood);
    if (isLoopState(target)) {
      sm.setIdleClip(target);                     // sticky base: the pet lives in this loop while the mood holds
    } else {
      const priority = (MOOD_GESTURE_PRIORITY[target] || 5) * 1; // transient gesture, returns to the current idle base
      sm.react({ clip: target, priority, return: 'idle' });
    }
    if (S.mood === 'excited') burst(CX, AH * 0.45, 14, ['#FEE761', '#F6757A', '#9BE86A', '#fff']);
    if (S.mood === 'oops' || S.mood === 'bashful' || S.mood === 'sad') S.shake = 1;
  }
  function setFullness(v) { S.fullness = clamp(v, 0, 1); }
  function addBird(label) { if (S.birds.length >= 5) return; S.birds.push({ id: nextBirdId++, label: label || 'task', born: S.lastT }); }
  function removeBird() { const b = S.birds.shift(); if (b) poof(b._x || CX, b._y || 60); }
  function clearBirds() { S.birds = []; }
  function relief() { steam(CX - 14, AH * 0.55); steam(CX + 14, AH * 0.55); sm.react({ clip: 'jumping', priority: 6, return: 'idle' }); }
  function sleep() { S.phase = 'sleeping'; sm.setIdleClip('idle'); sm.release(); }   // Codex has no sleep row → rest = idle
  function wake() { if (S.phase === 'sleeping') { S.phase = 'alive'; setMood('happy'); } }
  function reset() { S.birds = []; S.fx = []; S.fullness = 0; S.phase = 'alive'; sm.reset(); setMood('idle'); }
  function reactByName(name) { const r = sm.react(name); if (r) S.phase = 'alive'; return !!r; }
  function toIdle() { return sm.release(); }
  function setMoodLevel(v) { S.moodLevel = clamp(typeof v === 'number' ? v : 0, -1, 1); }

  // ── draw ──
  function drawPet() {
    const cur = sm.current();
    const row = rowOf(cur.clip); if (row < 0) return;
    const col = cur.frame || 0;
    const full = 1 + S.fullness * 0.18 * (reduceMotion ? 0.4 : 1);
    const scale = baseScale * full;
    const drawW = Math.round(cellW * scale), drawH = Math.round(cellH * scale);
    const shakeX = reduceMotion ? 0 : Math.sin(S.lastT * 42) * S.shake * 4;
    const dx = Math.round(CX - drawW / 2 + shakeX);
    const dy = Math.round((AH - drawH) / 2 + AH * 0.04);
    ctx.drawImage(sheet, col * cellW, row * cellH, cellW, cellH, dx, dy, drawW, drawH);
  }
  function drawBirds() {
    if (!bird) return;
    const n = S.birds.length;
    for (let i = 0; i < n; i++) { const b = S.birds[i]; const ang = S.lastT * 0.6 + (i / n) * Math.PI * 2; const x = CX + Math.cos(ang) * (AW * 0.32), y = AH * 0.22 + Math.sin(ang) * (AH * 0.12); b._x = x; b._y = y; const age = clamp((S.lastT - b.born) / 0.35, 0, 1); if (age < 0.15) continue; const fr = Math.floor(S.lastT * 9 + i) % 2, s = 24 * age; ctx.drawImage(bird, fr * 24, 0, 24, 24, Math.round(x - s / 2), Math.round(y - s / 2), Math.round(s), Math.round(s)); }
  }
  function drawFx() {
    for (let i = S.fx.length - 1; i >= 0; i--) { const f = S.fx[i]; f.x += f.vx; f.y += f.vy; if (f.kind === 'steam') f.vx *= 0.96; f.life--; if (f.life <= 0) { S.fx.splice(i, 1); continue; } ctx.fillStyle = f.col; ctx.globalAlpha = f.kind === 'steam' ? clamp(f.life / 50, 0, 0.8) : 1; const sz = f.kind === 'steam' ? 3 : 2; ctx.fillRect(Math.round(f.x), Math.round(f.y), sz, sz); ctx.globalAlpha = 1; }
  }

  let raf = 0;
  function frame(nowMs) {
    const t = nowMs / 1000;
    const dt = S.lastT ? (t - S.lastT) * 1000 : 16;
    S.lastT = t;
    sm.tick(dt);
    S.shake *= 0.86; if (S.shake < 0.004) S.shake = 0;
    if (S.phase === 'sleeping' && !reduceMotion && nowMs - S.lastZ > 900) { S.lastZ = nowMs; S.fx.push({ x: CX + 16, y: AH * 0.4, vx: 0.25, vy: -0.5, life: 54, kind: 'dot', col: '#9bb3c9' }); }
    ctx.clearRect(0, 0, AW, AH);
    drawPet();
    drawBirds();
    drawFx();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setMood, setFullness, addBird, removeBird, clearBirds, relief, sleep, wake, reset, reactByName, toIdle, setMoodLevel,
    get state() { const c = sm.current(); return { mood: S.mood, fullness: S.fullness, birds: S.birds.length, phase: S.phase, state: c.clip, frame: c.frame, kind: c.kind, reduceMotion }; },
    stop() { cancelAnimationFrame(raf); },
    sm,
  };
}
