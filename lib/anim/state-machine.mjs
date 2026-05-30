/*
 * animayte · state-machine — the behaviour brain (pure, deterministic, testable).
 *
 * Pattern borrowed from vscode-pets: a tiny FrameResult state machine that arbitrates
 * idle ↔ transient-reaction ↔ return-to-idle by integer priority, plus the idle life
 * a desktop pet actually lives in: a base breathing loop, a randomized secondary-idle
 * pool with ANTI-REPETITION, and a bored state after inactivity.
 *
 *   const sm = createStateMachine(manifest, { rng, secondaryEveryMs })
 *   sm.react('Error')        // event → reaction (interrupts lower priority)
 *   sm.tick(dtMs)            // advance time; auto-returns finished one-shots
 *   sm.current()             // { kind, clip, expression, palette, prop, t, frame, priority }
 *
 * Time is injected (tick(dt)) and randomness is injected (opts.rng) so a test can
 * replay an exact event/clock timeline and assert the resulting state sequence.
 * Guardrail: reactions are TRANSIENT and always return to idle — no state is a dead
 * end (recovery, never punishment).
 */

export const FrameResult = { CONTINUE: 'CONTINUE', COMPLETE: 'COMPLETE', CANCEL: 'CANCEL' };

/** Total duration (ms) of a clip = sum of frame durations. */
export function clipDuration(clip) {
  if (!clip || !Array.isArray(clip.frames)) return 0;
  return clip.frames.reduce((s, f) => s + (f && f.dur > 0 ? f.dur : 0), 0);
}

/**
 * frameAt(clip, elapsedMs) → { index, t, total }
 *   index — current frame (looping wraps; non-looping holds the last frame)
 *   t     — normalised progress across the WHOLE clip in [0,1] (drives transform tracks)
 */
export function frameAt(clip, elapsedMs) {
  const total = clipDuration(clip);
  const frames = (clip && clip.frames) || [];
  if (total <= 0 || frames.length === 0) return { index: 0, t: 0, total: 0 };
  const loop = !!clip.loop;
  const e = loop ? ((elapsedMs % total) + total) % total : Math.min(elapsedMs, total - 0.0001);
  const t = e / total;
  let acc = 0;
  for (let i = 0; i < frames.length; i++) {
    acc += frames[i].dur;
    if (e < acc) return { index: i, t, total };
  }
  return { index: frames.length - 1, t: loop ? t : 1, total };
}

const isFinitePositive = (n) => Number.isFinite(n) && n > 0;

export function createStateMachine(manifest, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const clips = manifest.clips || {};
  const reactions = manifest.reactions || {};
  const idleCfg = manifest.idle || {};
  const defaultPalette = manifest.defaultPalette || Object.keys(manifest.palettes || { calm: 1 })[0];
  let defaultExpression = opts.defaultExpression || 'neutral';

  const baseIdle = clips[idleCfg.base] ? idleCfg.base : Object.keys(clips)[0];
  const secondaryPool = (idleCfg.secondary || []).filter((c) => clips[c]);
  const boredClip = clips[idleCfg.boredClip] ? idleCfg.boredClip : null;
  const boredAfterMs = isFinitePositive(idleCfg.boredAfterMs) ? idleCfg.boredAfterMs : 30000;
  const secondaryEveryMs = isFinitePositive(opts.secondaryEveryMs) ? opts.secondaryEveryMs : 9000;

  let now = 0;
  let lastActivityAt = 0;        // last reaction → resets bored & defers secondaries
  let lastSecondary = null;      // anti-repetition memory
  let nextSecondaryAt = Infinity;
  let bored = false;
  let state = null;              // active state object
  const log = [];                // transition timeline (for tests / debugging)

  const pushLog = () => log.push({ at: now, kind: state.kind, clip: state.clip, expression: state.expression, palette: state.palette, prop: state.prop });

  function scheduleSecondary() {
    if (secondaryPool.length === 0) { nextSecondaryAt = Infinity; return; }
    const jitter = 0.6 + 0.8 * rng();            // 0.6×–1.4× the base interval
    nextSecondaryAt = now + secondaryEveryMs * jitter;
  }

  function setState(s, { activity = false } = {}) {
    state = { expression: defaultExpression, palette: defaultPalette, prop: null, priority: 0, oneShot: false, returnTo: 'idle', startedAt: now, ...s };
    if (activity) lastActivityAt = now;
    pushLog();
    return state;
  }

  function enterIdle() {
    bored = !!boredClip && (now - lastActivityAt) >= boredAfterMs;
    setState({ kind: bored ? 'bored' : 'idle', clip: bored ? boredClip : baseIdle, expression: defaultExpression, palette: defaultPalette, prop: null, priority: 0, oneShot: false });
    scheduleSecondary();
  }

  function playSecondary() {
    // pick a clip from the pool, never the same one twice in a row (anti-repetition)
    const eligible = secondaryPool.length > 1 ? secondaryPool.filter((c) => c !== lastSecondary) : secondaryPool;
    const pick = eligible[Math.min(eligible.length - 1, Math.floor(rng() * eligible.length))];
    lastSecondary = pick;
    setState({ kind: 'secondary', clip: pick, expression: defaultExpression, palette: defaultPalette, prop: null, priority: 0, oneShot: true, returnTo: 'idle' });
  }

  /** Resolve a reaction name (manifest.reactions) or accept an explicit reaction object. */
  function resolve(nameOrObj) {
    const r = typeof nameOrObj === 'string' ? reactions[nameOrObj] : nameOrObj;
    if (!r) return null;
    const clipName = clips[r.clip] ? r.clip : baseIdle;
    return {
      kind: 'reaction',
      name: typeof nameOrObj === 'string' ? nameOrObj : (r.name || 'reaction'),
      clip: clipName,
      expression: r.expression || defaultExpression,
      palette: r.palette || defaultPalette,
      prop: r.prop || null,
      priority: Number.isInteger(r.priority) ? r.priority : 1,
      oneShot: clips[clipName] ? !clips[clipName].loop : true,
      returnTo: r.return || 'idle',
    };
  }

  /**
   * react(event) — apply a reaction. Interrupts the active state UNLESS a
   * strictly-higher-priority reaction is currently playing (priority arbitration).
   * Returns the new current state, or null if ignored / unknown.
   */
  function react(nameOrObj) {
    const r = resolve(nameOrObj);
    if (!r) return null;
    if (state && state.kind === 'reaction' && state.priority > r.priority && !isOneShotDone()) {
      return null; // a more important reaction is mid-play — don't preempt it
    }
    return setState(r, { activity: true });
  }

  function isOneShotDone() {
    if (!state || !state.oneShot) return false;
    return (now - state.startedAt) >= clipDuration(clips[state.clip]);
  }

  /**
   * tick(dtMs) — advance the clock, complete finished one-shots (→ return target),
   * fire scheduled secondaries, and slip into bored after inactivity. Returns current().
   */
  function tick(dtMs = 0) {
    now += Math.max(0, dtMs);
    if (!state) enterIdle();

    // a finished transient → return to idle (or a named settle clip)
    if (state.oneShot && isOneShotDone()) {
      if (state.returnTo && state.returnTo !== 'idle' && clips[state.returnTo]) {
        setState({ kind: 'reaction', clip: state.returnTo, expression: state.expression, palette: state.palette, prop: null, priority: 0, oneShot: !clips[state.returnTo].loop, returnTo: 'idle' });
      } else {
        enterIdle();
      }
      return current();
    }

    if (state.kind === 'idle' || state.kind === 'bored') {
      // slip into bored once inactivity passes the threshold
      if (!bored && boredClip && (now - lastActivityAt) >= boredAfterMs) {
        enterIdle();
        return current();
      }
      // fire a scheduled secondary fidget (only while genuinely idle, not bored)
      if (!bored && now >= nextSecondaryAt && secondaryPool.length) {
        playSecondary();
      }
    }
    return current();
  }

  function current() {
    if (!state) enterIdle();
    const clip = clips[state.clip];
    const { index, t } = frameAt(clip, now - state.startedAt);
    return {
      kind: state.kind, clip: state.clip, expression: state.expression,
      palette: state.palette, prop: state.prop, priority: state.priority,
      frame: index, t, bored, now, elapsed: now - state.startedAt,
    };
  }

  // boot into idle at t=0
  enterIdle();

  /**
   * setIdleExpression(expr) — the face the pet wears while idling (breathing /
   * secondary / bored). Lets a sticky "mood" (thinking while working, sad after an
   * error) persist through idle life without forcing a transient reaction each tick.
   * Updates the live state immediately if currently idling.
   */
  function setIdleExpression(expr) {
    if (!expr) return;
    defaultExpression = expr;
    if (state && (state.kind === 'idle' || state.kind === 'secondary' || state.kind === 'bored')) state.expression = expr;
  }

  return {
    react,
    tick,
    current,
    setIdleExpression,
    get now() { return now; },
    get log() { return log; },
    reset() { now = 0; lastActivityAt = 0; lastSecondary = null; bored = false; log.length = 0; enterIdle(); },
  };
}
