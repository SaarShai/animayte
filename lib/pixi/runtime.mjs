/*
 * animayte · pixi/runtime — the GPU renderer (PixiJS v8, MIT). Code-first migration of
 * the WHOLE library: it reuses the exact engine (state machine, transform tracks, indexed
 * palette swap, contract) and only swaps the rendering primitives Canvas2D→PixiJS. Same
 * controller interface as lib/anim/runtime.mjs, so animayte.html / SSE / demo are unchanged.
 *
 *   const pet = await createPixiRuntime(canvasEl, { PIXI, manifestUrl });
 *
 * PixiJS is passed in by the page (it imports the vendored ESM) so this stays a normal
 * browser ES module. The body is three stacked sprites (calm/tired/error baked sheets)
 * cross-faded by fullness — a true §4.2 indexed swap on the GPU; squash/stretch is the
 * sprite's anchor-based scale/rotation; props/birds are sprites; particles are a Graphics.
 */
import { identity, sampleTrack } from '../anim/transform.mjs';
import { createStateMachine } from '../anim/state-machine.mjs';
import { easeOutBack } from '../anim/easing.mjs';
import { MOOD_EXPRESSION } from '../anim/runtime.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const resolveSibling = (url, name) => url.slice(0, url.lastIndexOf('/') + 1) + name;
const loadImage = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('img ' + src)); im.src = src; });
const hexNum = (h) => parseInt(String(h).replace('#', '').slice(0, 6), 16);
const hexToRgbB = (h) => { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; };
function buildSwapB(from, to) { const m = new Map(); for (const role of Object.keys(from)) { if (!(role in to)) continue; const f = hexToRgbB(from[role]), t = hexToRgbB(to[role]); m.set((f[0] << 16) | (f[1] << 8) | f[2], t); } return m; }
function recolorSheet(img, swap) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), a = d.data;
  for (let i = 0; i < a.length; i += 4) { if (a[i + 3] === 0) continue; const to = swap.get((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]); if (to) { a[i] = to[0]; a[i + 1] = to[1]; a[i + 2] = to[2]; } }
  x.putImageData(d, 0, 0); return c;
}
// optional SFX (off by default — identical contract to the Canvas2D runtime)
function createSound(enabled, volume) {
  let ctx = null; const cache = {};
  return { enabled: !!enabled, play(key, pitch = 1) { if (!this.enabled) return; try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); (cache[key] ? Promise.resolve(cache[key]) : fetch('/assets/sfx/' + key + '.wav').then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((bf) => (cache[key] = bf))).then((bf) => { const s = ctx.createBufferSource(); s.buffer = bf; s.playbackRate.value = pitch; const g = ctx.createGain(); g.gain.value = volume; s.connect(g); g.connect(ctx.destination); s.start(); }).catch(() => {}); } catch (_) { /* */ } } };
}

export async function createPixiRuntime(canvas, opts = {}) {
  const PIXI = opts.PIXI || await import('/assets/vendor/pixi/pixi.mjs');
  const manifestUrl = opts.manifestUrl || '/pets/slime/pet.json';
  const manifest = opts.manifest || await fetch(manifestUrl).then((r) => r.json());
  const cell = manifest.cell || 64;
  const sheetImg = await loadImage(opts.sheetUrl || resolveSibling(manifestUrl, manifest.sheet || 'sheet.png'));
  const birdImg = await loadImage(opts.birdUrl || '/assets/bird.png').catch(() => null);
  const propImg = manifest.propSheet ? await loadImage(resolveSibling(manifestUrl, manifest.propSheet)).catch(() => null) : null;

  // pre-bake recolored sheets per palette (indexed swap), then make GPU textures
  const palettes = manifest.palettes || {};
  const defPal = manifest.defaultPalette || Object.keys(palettes)[0];
  const calmPal = palettes[defPal] || {};
  const sources = { calm: sheetImg };
  try { for (const name of Object.keys(palettes)) { if (name === defPal) continue; sources[name] = recolorSheet(sheetImg, buildSwapB(calmPal, palettes[name])); } } catch (_) { /* calm only */ }

  const AW = canvas.width || 160, AH = canvas.height || 173;
  const app = new PIXI.Application();
  // retina-sharp: render the buffer at the device pixel ratio (Canvas2D was fixed at 1×)
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  await app.init({ canvas, width: AW, height: AH, backgroundAlpha: 0, antialias: false, resolution: dpr, autoDensity: false });

  // texture + per-frame sub-texture cache (nearest = crisp pixels)
  const baseTex = {};
  for (const k of Object.keys(sources)) { const t = PIXI.Texture.from(sources[k]); t.source.scaleMode = 'nearest'; baseTex[k] = t; }
  const propBase = propImg ? (() => { const t = PIXI.Texture.from(propImg); t.source.scaleMode = 'nearest'; return t; })() : null;
  const birdBase = birdImg ? (() => { const t = PIXI.Texture.from(birdImg); t.source.scaleMode = 'nearest'; return t; })() : null;
  // sub-texture caches — built ONCE per (sheet,col,row)/prop/bird-frame so the render loop
  // never allocates GPU textures per frame (which would leak).
  const subCache = new Map();
  const frameTex = (key, col, row) => {
    const id = key + ':' + col + ':' + row, hit = subCache.get(id);
    if (hit) return hit;
    const t = new PIXI.Texture({ source: baseTex[key].source, frame: new PIXI.Rectangle(col * cell, row * cell, cell, cell) });
    subCache.set(id, t); return t;
  };
  const pc = manifest.propCell || 24;
  const propTexCache = new Map();
  const propTex = (idx) => { if (!propBase) return null; let t = propTexCache.get(idx); if (!t) { t = new PIXI.Texture({ source: propBase.source, frame: new PIXI.Rectangle(idx * pc, 0, pc, pc) }); propTexCache.set(idx, t); } return t; };
  const birdTexCache = [];
  const birdTex = (f) => { if (!birdBase) return null; if (!birdTexCache[f]) birdTexCache[f] = new PIXI.Texture({ source: birdBase.source, frame: new PIXI.Rectangle(f * 24, 0, 24, 24) }); return birdTexCache[f]; };

  const cols = Math.max(1, Math.round(sheetImg.width / cell));
  const exprRows = Object.keys(manifest.expressions);
  const rowOf = (e) => { const i = exprRows.indexOf(e); return i < 0 ? 0 : i; };
  const CX = AW / 2, GROUND = Math.round(AH * 0.70);

  // ── display list (back → front): GLOW halo · body(calm/tired/error) · prop · birds · particles ──
  // GPU-only flourish: a blurred, warm copy of the body behind it — a soft halo that
  // blooms on wins/relief (cheap on the GPU, awkward on Canvas2D). Degrades gracefully.
  const glowSprite = new PIXI.Sprite(frameTex('calm', 0, 0)); glowSprite.anchor.set(0.5, 1); glowSprite.tint = 0xFFF6C0; glowSprite.alpha = 0;
  try { glowSprite.filters = [new PIXI.BlurFilter({ strength: 7, quality: 3 })]; } catch (_) { /* no blur → a soft tinted halo */ }
  app.stage.addChild(glowSprite);
  const mkBody = (key) => { const s = new PIXI.Sprite(frameTex(key, 0, 0)); s.anchor.set(0.5, 1); app.stage.addChild(s); return s; };
  const bodyCalm = mkBody('calm');
  const bodyTired = mkBody(sources.tired ? 'tired' : 'calm'); bodyTired.alpha = 0;
  const bodyError = mkBody(sources.error ? 'error' : 'calm'); bodyError.alpha = 0;
  const propSprite = propBase ? new PIXI.Sprite(propBase) : null;
  if (propSprite) { propSprite.anchor.set(0.5, 0.5); propSprite.visible = false; app.stage.addChild(propSprite); }
  const birdLayer = new PIXI.Container(); app.stage.addChild(birdLayer);   // birds in FRONT of the body (matches Canvas2D)
  const fxG = new PIXI.Graphics(); app.stage.addChild(fxG);
  const birdSprites = [];
  if (birdBase) for (let i = 0; i < 5; i++) { const b = new PIXI.Sprite(birdTex(0)); b.anchor.set(0.5, 0.5); b.visible = false; birdLayer.addChild(b); birdSprites.push(b); }

  // ── engine (identical to the Canvas2D runtime) ──
  const persona = { secondaryEveryMsScale: 1, boredAfterMsScale: 1, reactionIntensity: 1, secondaryWeights: {}, ...(opts.personality || {}) };
  const intensity = (typeof persona.reactionIntensity === 'number' && persona.reactionIntensity > 0) ? persona.reactionIntensity : 1;
  const reduceMotion = opts.reduceMotion === true || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const motionK = reduceMotion ? 0.25 : 1;
  const sound = createSound(opts.sound === true, typeof opts.volume === 'number' ? opts.volume : 0.6);
  const sm = createStateMachine(manifest, { secondaryEveryMs: 7000, defaultExpression: 'neutral', personality: persona });
  const S = { mood: 'idle', fullness: 0, phase: 'alive', moodLevel: 0, birds: [], fx: [], shake: 0, errFlash: 0, glow: 0, lastZ: 0, lastT: 0, blinking: false, blinkUntil: 0, nextBlinkAt: 0 };
  let nextBirdId = 1;

  function burst(x, y, n, pal) { if (reduceMotion) return; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.random() * 0.5; const sp = 1.5 + Math.random() * 1.9; S.fx.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.2, life: 42 + Math.random() * 30, kind: 'confetti', sz: 2 + Math.floor(Math.random() * 3), col: pal[i % pal.length] }); } }
  function poof(x, y) { if (reduceMotion) return; for (let i = 0; i < 7; i++) S.fx.push({ x, y, vx: (Math.random() - 0.5) * 1.8, vy: (Math.random() - 0.5) * 1.8, life: 18, kind: 'dot', col: '#cfe0ff' }); }
  function steam(x, y) { if (reduceMotion) return; for (let i = 0; i < 10; i++) S.fx.push({ x: x + (Math.random() - 0.5) * 10, y, vx: (Math.random() - 0.5) * 0.5, vy: -0.7 - Math.random() * 0.6, life: 40 + Math.random() * 20, kind: 'steam', col: '#dceaf2' }); }

  function setMood(mood) {
    S.phase = 'alive'; S.mood = mood || 'idle';
    const expr = MOOD_EXPRESSION[S.mood] || 'neutral';
    sm.setIdleExpression(expr);
    if (S.mood === 'happy') { sm.react({ clip: 'react', expression: expr, priority: 4, return: 'idle' }); S.glow = Math.max(S.glow, 0.55); }
    if (S.mood === 'excited') { sm.react({ clip: 'react', expression: expr, priority: 6, return: 'idle' }); burst(CX, GROUND - 34, 22, ['#FEE761', '#F6757A', '#9BE86A', '#7DC6FF', '#ffffff']); S.glow = 1; }
    if (S.mood === 'oops' || S.mood === 'bashful') { S.shake = 1; sm.react({ clip: 'react', expression: expr, priority: 4, return: 'idle' }); }
    if (S.mood === 'sad') { sm.react({ clip: 'react', expression: 'sad', priority: 5, return: 'idle' }); S.errFlash = 1; }
    const sk = { happy: 'happy', excited: 'excited', sad: 'sad', oops: 'oops', bashful: 'oops' }[S.mood]; if (sk) sound.play(sk);
  }
  function setFullness(v) { S.fullness = clamp(v, 0, 1); if (S.fullness > 0.82 && !['sad', 'oops', 'excited'].includes(S.mood)) { S.mood = 'tired'; sm.setIdleExpression('sleepy'); } }
  function addBird(label) { if (S.birds.length >= 5) return; S.birds.push({ id: nextBirdId++, born: S.lastT }); sound.play('bird'); }
  function removeBird() { const b = S.birds.shift(); if (b) poof(b._x || CX, b._y || 60); }
  function clearBirds() { S.birds = []; }
  function relief() { steam(CX - 14, GROUND - 40); steam(CX + 14, GROUND - 40); sm.react({ clip: 'react', expression: 'happy', priority: 6, return: 'idle' }); S.glow = Math.max(S.glow, 0.8); sound.play('relief'); }
  function sleep() { S.phase = 'sleeping'; sm.setIdleExpression('sleepy'); }
  function wake() { if (S.phase === 'sleeping') { S.phase = 'alive'; setMood('happy'); } }
  function reset() { S.birds = []; S.fx = []; S.fullness = 0; S.phase = 'alive'; setMood('idle'); sm.reset(); }
  function reactByName(name) { const r = manifest.reactions && manifest.reactions[name]; if (r) { S.phase = 'alive'; sm.react({ ...r, name }); if (r.prop) sound.play('prop'); return true; } return false; }
  function toIdle() { return sm.release(); }
  function setMoodLevel(v) { S.moodLevel = clamp(typeof v === 'number' ? v : 0, -1, 1); }

  function render() {
    const cur = sm.current();
    const clip = manifest.clips[cur.clip];
    const raw = clip && clip.tracks && clip.tracks.body ? sampleTrack(clip.tracks.body, cur.t) : identity();
    const k = (cur.kind === 'reaction' ? intensity * (1 + S.moodLevel * 0.15) : 1) * motionK;
    const tf = { sx: 1 + (raw.sx - 1) * k, sy: 1 + (raw.sy - 1) * k, tx: raw.tx * k, ty: raw.ty * k, rot: raw.rot * k };
    const full = 1 + S.fullness * 0.22;
    const sx = tf.sx * full, sy = tf.sy * full;
    const shakeX = Math.sin(S.lastT * 42) * S.shake * 4;
    const row = (S.phase === 'sleeping') ? rowOf('sleepy') : rowOf(cur.expression);
    const fr = clip && clip.frames ? clip.frames[cur.frame] : null;
    let col = (fr && fr.cell != null) ? fr.cell : (cur.frame % cols);
    if (S.blinking && cur.kind !== 'reaction') col = 3;
    col = Math.min(cols - 1, Math.max(0, col));

    const expr = MOOD_EXPRESSION[S.mood];
    const tiredA = Math.max(smoothstep(0.5, 0.95, S.fullness), expr === 'sleepy' ? 0.65 : 0, S.moodLevel < 0 ? -S.moodLevel * 0.22 : 0);
    const px = CX + tf.tx * sx + shakeX, py = GROUND + 8 * sy + tf.ty * sy;
    for (const [spr, key, alpha] of [[bodyCalm, 'calm', 1], [bodyTired, sources.tired ? 'tired' : 'calm', sources.tired ? tiredA : 0], [bodyError, sources.error ? 'error' : 'calm', sources.error ? Math.min(1, S.errFlash) : 0]]) {
      spr.texture = frameTex(key, col, row);
      spr.position.set(px, py); spr.scale.set(sx, sy); spr.rotation = tf.rot || 0; spr.alpha = alpha;
    }

    // GPU glow halo — a blurred warm copy of the body behind it, pulsing on wins/relief
    const glowA = S.glow * (0.5 + 0.5 * Math.sin(S.lastT * 9));
    glowSprite.alpha = Math.max(0, glowA);
    if (glowSprite.alpha > 0.01) { glowSprite.texture = frameTex('calm', col, row); glowSprite.position.set(px, py); glowSprite.scale.set(sx * 1.14, sy * 1.14); glowSprite.rotation = tf.rot || 0; }

    // prop overlay
    if (propSprite) {
      const pd = cur.prop ? manifest.props[cur.prop] : null;
      if (pd) {
        const pop = easeOutBack(clamp((cur.elapsed || 0) / 170, 0, 1));
        propSprite.visible = pop > 0.02;
        if (propSprite.visible) {
          propSprite.texture = propTex(pd.cell || 0);
          const drawW = cell * sx;
          const ax = pd.anchor ? pd.anchor[0] : 0.5, ay = pd.anchor ? pd.anchor[1] : 0.5;
          propSprite.position.set(px - drawW / 2 + drawW * ax, py - cell * sy + cell * sy * ay);
          propSprite.scale.set((drawW / cell) * pop, (drawW / cell) * pop);
        }
      } else propSprite.visible = false;
    }
  }
  function renderBirds() {
    const n = S.birds.length;
    for (let i = 0; i < birdSprites.length; i++) {
      const b = birdSprites[i];
      if (i >= n || !birdBase) { b.visible = false; continue; }
      const bd = S.birds[i]; const ang = S.lastT * 0.6 + (i / Math.max(1, n)) * Math.PI * 2;
      const x = CX + Math.cos(ang) * 46, y = 52 + Math.sin(ang) * 20; bd._x = x; bd._y = y;
      const age = clamp((S.lastT - bd.born) / 0.35, 0, 1);
      b.visible = age >= 0.15;
      if (!b.visible) continue;
      const f = Math.floor(S.lastT * 9 + i) % 2;
      b.texture = birdTex(f);
      b.position.set(x, y); b.scale.set(age, age);
    }
  }
  function renderFx() {
    fxG.clear();
    for (let i = S.fx.length - 1; i >= 0; i--) {
      const f = S.fx[i];
      if (f.kind === 'steam') f.vx *= 0.96;
      if (f.kind === 'confetti') f.vy += 0.06;                 // gravity → confetti flutters down
      f.x += f.vx; f.y += f.vy; f.life--;
      if (f.life <= 0) { S.fx.splice(i, 1); continue; }
      const sz = f.kind === 'steam' ? 3 : (f.sz || 2);
      const a = f.kind === 'steam' ? clamp(f.life / 50, 0, 0.8) : clamp(f.life / 14, 0, 1);
      fxG.rect(Math.round(f.x), Math.round(f.y), sz, sz).fill({ color: hexNum(f.col), alpha: a });
    }
  }

  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS; S.lastT += dt / 1000;
    sm.tick(dt);
    S.shake *= 0.86; if (S.shake < 0.004) S.shake = 0;
    S.errFlash *= 0.94; if (S.errFlash < 0.02) S.errFlash = 0;
    S.glow *= 0.94; if (S.glow < 0.01) S.glow = 0;
    const nowMs = S.lastT * 1000;
    if (!S.nextBlinkAt) S.nextBlinkAt = nowMs + 1200 + Math.random() * 2000;
    S.blinking = false;
    if (S.phase === 'alive') { if (nowMs >= S.nextBlinkAt) { S.blinkUntil = nowMs + 110; S.nextBlinkAt = nowMs + 3000 + Math.random() * 3000; } if (nowMs < S.blinkUntil) S.blinking = true; }
    if (S.phase === 'sleeping' && nowMs - S.lastZ > 900) { S.lastZ = nowMs; S.fx.push({ x: CX + 16, y: GROUND - 30, vx: 0.25, vy: -0.5, life: 54, kind: 'dot', col: '#9bb3c9' }); }
    render(); renderBirds(); renderFx();
  });

  return {
    setMood, setFullness, addBird, removeBird, clearBirds, relief, sleep, wake, reset, reactByName, toIdle, setMoodLevel,
    dispatch(m) { switch (m && m.cmd) { case 'mood': return setMood(m.value); case 'fullness': return setFullness(m.value); case 'addBird': return addBird(m.label); case 'removeBird': return removeBird(); case 'clearBirds': return clearBirds(); case 'relief': return relief(); case 'react': return reactByName(m.name); case 'endReact': return toIdle(); case 'sleep': return sleep(); case 'wake': case 'hatch': return wake(); case 'reset': return reset(); case 'moodLevel': return setMoodLevel(m.value); } },
    resize() { try { app.renderer.resize(canvas.width, canvas.height); } catch (_) { /* */ } },
    get state() { const c = sm.current(); return { mood: S.mood, fullness: S.fullness, birds: S.birds.length, phase: S.phase, expression: c.expression, clip: c.clip, kind: c.kind, prop: c.prop, engine: 'pixi', reduceMotion }; },
    stop() { try { app.destroy(true); } catch (_) { /* */ } },
    sm,
  };
}
