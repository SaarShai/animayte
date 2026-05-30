/*
 * animayte · runtime — the web REFERENCE renderer (Canvas2D, zero-dep, browser ES module).
 *
 * This is the rich reference the other renderers are kept honest against (C2). It
 * imports ONLY the pure engine modules (easing / transform / state-machine) — never
 * png/compositor, which pull node:zlib and would break in the browser. It plays the
 * BAKED spritesheet (no redrawing the body → no drift) and layers the living parts on
 * top procedurally: state-machine-driven expression + clip, squash/stretch transform
 * tracks, the context-fullness swell, mood tint, sub-agent birds, and particles.
 *
 *   const pet = await createRuntime(canvasEl, { manifestUrl });
 *   pet.setMood('excited'); pet.setFullness(0.8); pet.addBird('search'); pet.relief();
 *
 * Served over http by the daemon; the standalone file:// demo keeps its own inline
 * fallback in animayte.html (browsers don't load ES modules over file://).
 */
import { identity, sampleTrack } from './transform.mjs';
import { createStateMachine } from './state-machine.mjs';
import { easeOutBack } from './easing.mjs';

// daemon "mood" (sticky activity) → one of the 8 baked expression rows.
// Mirrors animayte.html's moodState so the served + standalone renderers agree.
export const MOOD_EXPRESSION = {
  neutral: 'neutral', idle: 'neutral',
  thinking: 'thinking', working: 'thinking', listening: 'thinking',
  happy: 'happy', excited: 'excited',
  oops: 'oops', bashful: 'oops', embarrassed: 'embarrassed',
  sad: 'sad', sleepy: 'sleepy', tired: 'sleepy',
};

const loadImage = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img ' + src)); im.src = src; });
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const resolveSibling = (url, name) => url.slice(0, url.lastIndexOf('/') + 1) + name;

// in-browser indexed palette-swap (the Node compositor can't run here — node:zlib).
const hexToRgbB = (h) => { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
function buildSwapB(from, to) { const m = new Map(); for (const role of Object.keys(from)) { if (!(role in to)) continue; const f = hexToRgbB(from[role]), t = hexToRgbB(to[role]); m.set((f[0] << 16) | (f[1] << 8) | f[2], t); } return m; }
function recolorSheet(img, swap) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
  for (let i = 0; i < a.length; i += 4) { if (a[i + 3] === 0) continue; const to = swap.get((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]); if (to) { a[i] = to[0]; a[i + 1] = to[1]; a[i + 2] = to[2]; } }
  x.putImageData(d, 0, 0); return c;
}

export async function createRuntime(canvas, opts = {}) {
  const manifestUrl = opts.manifestUrl || '/pets/slime/pet.json';
  const manifest = opts.manifest || await fetch(manifestUrl).then((r) => r.json());
  const cell = manifest.cell || 64;
  const sheet = await loadImage(opts.sheetUrl || resolveSibling(manifestUrl, manifest.sheet || 'sheet.png'));
  const bird = await loadImage(opts.birdUrl || '/assets/bird.png').catch(() => null);

  // pre-bake one recolored sheet per non-default palette → mood is a real indexed swap
  // (§4.2), cross-faded by fullness. Falls back gracefully if a palette can't be built.
  const palettes = manifest.palettes || {};
  const calmPal = palettes[manifest.defaultPalette] || palettes[Object.keys(palettes)[0]] || {};
  const sheets = { [manifest.defaultPalette]: sheet };
  try { for (const name of Object.keys(palettes)) { if (name === manifest.defaultPalette) continue; sheets[name] = recolorSheet(sheet, buildSwapB(calmPal, palettes[name])); } } catch (_) { /* keep calm-only */ }
  const tiredSheet = sheets.tired || sheet;
  const errorSheet = sheets.error || sheet;

  // prop/emote overlay strip (§4.5) — optional
  const propCell = manifest.propCell || 24;
  const propDefs = manifest.props || {};
  const propImg = manifest.propSheet ? await loadImage(resolveSibling(manifestUrl, manifest.propSheet)).catch(() => null) : null;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const AW = canvas.width, AH = canvas.height;
  const CX = AW / 2, GROUND = Math.round(AH * 0.70);
  const cols = Math.max(1, Math.round(sheet.width / cell));
  const exprRows = Object.keys(manifest.expressions);
  const rowOf = (expr) => { const i = exprRows.indexOf(expr); return i < 0 ? 0 : i; };

  const sm = createStateMachine(manifest, { secondaryEveryMs: 7000, defaultExpression: 'neutral' });

  const S = {
    mood: 'idle', fullness: 0, phase: 'alive',
    birds: [], fx: [], shake: 0, errFlash: 0, lastZ: 0, lastT: 0,
    blinking: false, blinkUntil: 0, nextBlinkAt: 0,
  };
  let nextBirdId = 1;

  // ── particles ──
  function burst(x, y, n, palette) { for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; S.fx.push({ x, y, vx: Math.cos(a) * (1.2 + Math.random()), vy: Math.sin(a) * 1.2 - 0.6, life: 30 + Math.random() * 16, kind: 'dot', col: palette[i % palette.length] }); } }
  function poof(x, y) { for (let i = 0; i < 7; i++) S.fx.push({ x, y, vx: (Math.random() - 0.5) * 1.8, vy: (Math.random() - 0.5) * 1.8, life: 18, kind: 'dot', col: '#cfe0ff' }); }
  function steam(x, y) { for (let i = 0; i < 10; i++) S.fx.push({ x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 0.5, vy: -0.7 - Math.random() * 0.6, life: 40 + Math.random() * 20, kind: 'steam', col: '#dceaf2' }); }

  // ── public controls (wired to SSE / buttons) ──
  function setMood(mood, ms) {
    S.phase = 'alive';
    S.mood = mood || 'idle';
    const expr = MOOD_EXPRESSION[S.mood] || 'neutral';
    sm.setIdleExpression(expr);
    if (S.mood === 'happy') sm.react({ clip: 'react', expression: expr, priority: 4, return: 'idle' });
    if (S.mood === 'excited') { sm.react({ clip: 'react', expression: expr, priority: 6, return: 'idle' }); burst(CX, GROUND - 34, 14, ['#FEE761', '#F6757A', '#9BE86A', '#fff']); }
    if (S.mood === 'oops' || S.mood === 'bashful') { S.shake = 1; sm.react({ clip: 'react', expression: expr, priority: 4, return: 'idle' }); }
    if (S.mood === 'sad') { sm.react({ clip: 'react', expression: 'sad', priority: 5, return: 'idle' }); S.errFlash = 1; }
  }
  function setFullness(v) { S.fullness = clamp(v, 0, 1); if (S.fullness > 0.82 && !['sad', 'oops', 'excited'].includes(S.mood)) { S.mood = 'tired'; sm.setIdleExpression('sleepy'); } }
  function addBird(label) { if (S.birds.length >= 5) return; S.birds.push({ id: nextBirdId++, label: label || 'task', born: S.lastT }); }
  function removeBird() { const b = S.birds.shift(); if (b) poof(b._x || CX, b._y || 60); }
  function clearBirds() { S.birds = []; }
  function relief() { steam(CX - 14, GROUND - 40); steam(CX + 14, GROUND - 40); sm.react({ clip: 'react', expression: 'happy', priority: 6, return: 'idle' }); }
  function sleep() { S.phase = 'sleeping'; sm.setIdleExpression('sleepy'); }
  function wake() { if (S.phase === 'sleeping') { S.phase = 'alive'; setMood('happy', 1200); } }
  function reset() { S.birds = []; S.fx = []; S.fullness = 0; S.phase = 'alive'; setMood('idle'); sm.reset(); }
  // play a named manifest reaction (tool gags etc.) — wired to SSE 'react' by the daemon (C6)
  function reactByName(name) { const r = manifest.reactions && manifest.reactions[name]; if (r) { S.phase = 'alive'; sm.react({ ...r, name }); return true; } return false; }

  // ── draw ──
  function drawPet(dt) {
    const cur = sm.current();
    const clip = manifest.clips[cur.clip];
    const tf = clip && clip.tracks && clip.tracks.body ? sampleTrack(clip.tracks.body, cur.t) : identity();
    const full = 1 + S.fullness * 0.22;
    const sx = tf.sx * full, sy = tf.sy * full;
    const drawW = Math.round(cell * sx), drawH = Math.round(cell * sy);
    const shakeX = Math.sin(S.lastT * 42) * S.shake * 4;
    const dx = Math.round(CX - drawW / 2 + tf.tx * sx + shakeX);
    const dy = Math.round(GROUND - drawH + 8 * sy + tf.ty * sy);
    const row = (S.phase === 'sleeping') ? rowOf('sleepy') : rowOf(cur.expression);
    const fr = clip && clip.frames ? clip.frames[cur.frame] : null;
    let col = (fr && fr.cell != null) ? fr.cell : (cur.frame % cols);
    // randomized blink overlays the breathing loop (col 3 = closed eyes for blink-able faces)
    if (S.blinking && cur.kind !== 'reaction') col = 3;
    col = Math.min(cols - 1, Math.max(0, col));
    const blit = (img) => ctx.drawImage(img, col * cell, row * cell, cell, cell, dx, dy, drawW, drawH);
    // rotation (e.g. the sway secondary) is applied about the ground anchor
    const rot = tf.rot || 0;
    if (rot) { ctx.save(); ctx.translate(CX, GROUND); ctx.rotate(rot); ctx.translate(-CX, -GROUND); }
    // base (calm) sheet, then cross-fade the cool "tired" sheet in as context fills,
    // then a brief "error" flash on top — a true indexed palette swap (§4.2).
    blit(sheet);
    const expr = MOOD_EXPRESSION[S.mood];
    const tiredA = Math.max(smoothstep(0.5, 0.95, S.fullness), expr === 'sleepy' ? 0.65 : 0);
    if (tiredA > 0.01 && tiredSheet !== sheet) { ctx.save(); ctx.globalAlpha = tiredA; blit(tiredSheet); ctx.restore(); }
    if (S.errFlash > 0.02 && errorSheet !== sheet) { ctx.save(); ctx.globalAlpha = Math.min(1, S.errFlash); blit(errorSheet); ctx.restore(); }
    if (rot) ctx.restore();

    // prop/emote overlay — anchored on the body, 2-frame scale pop-in (§4.5)
    const pd = cur.prop && propImg ? propDefs[cur.prop] : null;
    if (pd) {
      const pop = easeOutBack(clamp((cur.elapsed || 0) / 170, 0, 1));
      if (pop > 0.02) {
        const ps = propCell * (drawW / cell) * pop;
        const ax = pd.anchor ? pd.anchor[0] : 0.5, ay = pd.anchor ? pd.anchor[1] : 0.5;
        const pcx = dx + drawW * ax, pcy = dy + drawH * ay;
        ctx.drawImage(propImg, (pd.cell || 0) * propCell, 0, propCell, propCell, Math.round(pcx - ps / 2), Math.round(pcy - ps / 2), Math.round(ps), Math.round(ps));
      }
    }
  }
  function drawBirds() {
    if (!bird) return;
    const n = S.birds.length;
    for (let i = 0; i < n; i++) { const b = S.birds[i]; const ang = S.lastT * 0.6 + (i / n) * Math.PI * 2; const x = CX + Math.cos(ang) * 46, y = 52 + Math.sin(ang) * 20; b._x = x; b._y = y; const age = clamp((S.lastT - b.born) / 0.35, 0, 1); if (age < 0.15) continue; const fr = Math.floor(S.lastT * 9 + i) % 2, s = 24 * age; ctx.drawImage(bird, fr * 24, 0, 24, 24, Math.round(x - s / 2), Math.round(y - s / 2), Math.round(s), Math.round(s)); }
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
    S.errFlash *= 0.94; if (S.errFlash < 0.02) S.errFlash = 0;
    // randomized blink (every ~3–6s) — independent of the breathing cycle
    if (!S.nextBlinkAt) S.nextBlinkAt = nowMs + 1200 + Math.random() * 2000;
    S.blinking = false;
    if (S.phase === 'alive') {
      if (nowMs >= S.nextBlinkAt) { S.blinkUntil = nowMs + 110; S.nextBlinkAt = nowMs + 3000 + Math.random() * 3000; }
      if (nowMs < S.blinkUntil) S.blinking = true;
    }
    if (S.phase === 'sleeping' && nowMs - S.lastZ > 900) { S.lastZ = nowMs; S.fx.push({ x: CX + 16, y: GROUND - 30, vx: 0.25, vy: -0.5, life: 54, kind: 'dot', col: '#9bb3c9' }); }
    ctx.clearRect(0, 0, AW, AH);
    drawPet(dt);
    drawBirds();
    drawFx();
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setMood, setFullness, addBird, removeBird, clearBirds, relief, sleep, wake, reset, reactByName,
    get state() { const c = sm.current(); return { mood: S.mood, fullness: S.fullness, birds: S.birds.length, phase: S.phase, expression: c.expression, clip: c.clip, kind: c.kind, prop: c.prop }; },
    stop() { cancelAnimationFrame(raf); },
    sm,
  };
}
