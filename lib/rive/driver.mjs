/*
 * animayte · rive/driver — drive a Rive `.riv` from the daemon (browser ES module).
 *
 * Exposes the SAME controller interface as the Canvas2D runtime (setMood/setFullness/
 * addBird/relief/reactByName/toIdle/sleep/wake/reset/setMoodLevel/get state), but
 * implemented by setting the Rive state-machine INPUTS defined in contract.mjs. So
 * animayte.html can pick Rive or Canvas2D and everything downstream (SSE dispatch,
 * buttons, demo) is identical. The Rive runtime itself is passed in by the page (it
 * loads the vendored rive.js UMD), so THIS module stays importable in Node for syntax
 * checks — all browser/Rive calls live inside createRiveController().
 */
import { INPUT_NAMES, commandToOps, nextBirds } from './contract.mjs';

const loadImageNoop = () => {};

/**
 * createRiveController(rive, { canvas, src, artboard, stateMachine, reduceMotion })
 *   rive   — the @rive-app/canvas module (window.rive)
 *   → resolves a controller once the .riv has loaded. Missing contract inputs are
 *     skipped (so a partial / sample .riv still loads and renders).
 */
export function createRiveController(rive, opts = {}) {
  const { canvas, src, buffer, artboard, stateMachine, reduceMotion = false } = opts;
  return new Promise((resolve, reject) => {
    const cfg = {
      canvas, artboard, autoplay: true,
      onLoad: () => onLoaded(),
      onLoadError: (e) => reject(e instanceof Error ? e : new Error('rive load error: ' + e)),
    };
    if (src) cfg.src = src; else if (buffer) cfg.buffer = buffer;
    if (stateMachine) cfg.stateMachines = stateMachine;
    const r = new rive.Rive(cfg);

    function onLoaded() {
      try { r.resizeDrawingSurfaceToCanvas(); } catch (_) { loadImageNoop(); }
      // resolve the state machine: explicit > first available
      const names = (() => { try { return r.stateMachineNames || []; } catch (_) { return []; } })();
      const smName = stateMachine || names[0] || null;
      if (smName && !stateMachine) { try { r.play(smName); } catch (_) { /* default anim */ } }

      // grab input handles by name (number/boolean have .value; trigger has .fire())
      const handles = {};
      if (smName) { try { for (const inp of r.stateMachineInputs(smName) || []) handles[inp.name] = inp; } catch (_) { /* none */ } }
      const present = INPUT_NAMES.filter((n) => n in handles);
      const missing = INPUT_NAMES.filter((n) => !(n in handles));
      if (!present.length) console.warn('[rive] "' + smName + '" exposes none of the animayte contract inputs — it renders but will not react. Author the .riv to docs/rive-contract.md.');
      else if (missing.length) console.warn('[rive] .riv missing contract inputs (skipped):', missing.join(', '));

      const S = { mood: 'idle', fullness: 0, birds: 0, phase: 'alive', moodLevel: 0 };
      const applyOps = (ops) => { for (const op of ops) { const h = handles[op.name]; if (!h) continue; if (op.kind === 'trigger') { try { h.fire(); } catch (_) { /* */ } } else { try { h.value = op.value; } catch (_) { /* */ } } } };
      const dispatch = (cmd) => applyOps(commandToOps(cmd, { birds: S.birds }));
      if ('reduceMotion' in handles) { try { handles.reduceMotion.value = !!reduceMotion; } catch (_) { /* */ } }

      resolve({
        // shared controller interface (mirrors lib/anim/runtime.mjs)
        setMood: (m) => { S.mood = m || 'idle'; dispatch({ cmd: 'mood', value: S.mood }); },
        setFullness: (v) => { S.fullness = Math.max(0, Math.min(1, v)); dispatch({ cmd: 'fullness', value: S.fullness }); },
        addBird: () => { S.birds = nextBirds(S.birds, 'addBird'); dispatch({ cmd: 'addBird' }); },
        removeBird: () => { S.birds = nextBirds(S.birds, 'removeBird'); dispatch({ cmd: 'removeBird' }); },
        clearBirds: () => { S.birds = 0; dispatch({ cmd: 'clearBirds' }); },
        relief: () => dispatch({ cmd: 'relief' }),
        reactByName: (n) => dispatch({ cmd: 'react', name: n }),
        toIdle: () => dispatch({ cmd: 'endReact' }),
        setMoodLevel: (v) => { S.moodLevel = v; dispatch({ cmd: 'moodLevel', value: v }); },
        sleep: () => { S.phase = 'sleeping'; dispatch({ cmd: 'sleep' }); },
        wake: () => { if (S.phase === 'sleeping') { S.phase = 'alive'; dispatch({ cmd: 'wake' }); } },
        reset: () => { S.mood = 'idle'; S.fullness = 0; S.birds = 0; S.phase = 'alive'; S.moodLevel = 0; dispatch({ cmd: 'reset' }); },
        dispatch, // raw SSE command passthrough
        resize: () => { try { r.resizeDrawingSurfaceToCanvas(); } catch (_) { /* */ } },
        get state() { return { mood: S.mood, fullness: S.fullness, birds: S.birds, phase: S.phase, engine: 'rive', stateMachine: smName, inputs: Object.keys(handles) }; },
        get rive() { return r; },
        stop() { try { r.cleanup(); } catch (_) { /* */ } },
      });
    }
  });
}
