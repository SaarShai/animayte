/*
 * animayte · command dispatch — the ONE place that maps a daemon SSE command to a pet method.
 *
 * This is the renderer half of the wiring contract: the daemon broadcasts {cmd, …}; this routes
 * each cmd to the matching control method on the runtime (the same public API grid/runtime.mjs and
 * lib/anim/runtime.mjs expose). It is pure and DOM-free — its only effects are on the injected
 * `pet` and the injected `say` callback — so the overlay hosts share ONE vocabulary and it can be
 * unit-tested with a mock pet (test/dispatch.test.mjs). Keep it in lockstep with the daemon's
 * broadcast vocabulary; test/contract.test.mjs fails loudly if the two ever drift.
 *
 * `ping` (keepalive) and `moodLevel` (mood-drift tint — the grid runtime has none) are deliberately
 * unhandled here; they are listed in test/contract.test.mjs's IGNORED set so the drop is documented,
 * not accidental.
 */
export function applyCommand(pet, m, { say } = {}) {
  if (!pet || !m || typeof m.cmd !== 'string') return false;
  switch (m.cmd) {
    case 'hatch': case 'wake': pet.wake(); return true;
    case 'reset': case 'resetEgg': pet.reset(); return true;
    case 'mood': pet.setMood(m.value); return true;
    case 'fullness': pet.setFullness(m.value); return true;
    case 'addBird': pet.addBird(m.label); return true;
    case 'removeBird': pet.removeBird(); return true;
    case 'clearBirds': pet.clearBirds(); return true;
    case 'relief': pet.relief(); return true;
    case 'react': pet.reactByName(m.name); return true;
    case 'endReact': pet.toIdle(); return true;
    case 'sleep': pet.sleep(); return true;
    case 'say': if (say) say(m.text, m.ms); return true;
    // additive rich path: the full FeatureSpec. No-op until the runtime exposes applySpec.
    case 'express': if (pet.applySpec) { pet.applySpec(m.spec); return true; } return false;
    default: return false;   // unknown / intentionally-ignored (ping, moodLevel)
  }
}
