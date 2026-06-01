/*
 * animayte · codex/format — the Codex pet sprite-atlas spec (pure, isomorphic, zero-dep).
 *
 * Codex (OpenAI), Petdex (2700+ pets), and the openai/skills `hatch-pet` skill all
 * share ONE de-facto pet format: a flat baked atlas. A pet is a folder with a tiny
 * `pet.json` { id, displayName, description, spritesheetPath } + a spritesheet:
 *
 *   1536 × 1872 px · 8 columns × 9 rows · 192 × 208 px cells · transparent · frames
 *   centered in each cell · one fixed animation state per ROW (the per-row frame
 *   counts + timings are an app contract, NOT carried in pet.json).
 *
 * This module is the single source of truth for that contract — transcribed verbatim
 * from the canonical scripts (openai/skills/.curated/hatch-pet: compose_atlas.py,
 * validate_atlas.py, references/animation-rows.md). It stays browser-safe (no node:)
 * so the Canvas2D player and the Node loader/tests share exactly one spec.
 *
 *   ATLAS                          — atlas geometry { width, height, cols, rows, cellW, cellH }
 *   ROW_SPECS / CODEX_STATES       — the 9 ordered states + frame counts + per-frame ms
 *   buildCodexClips()              — synthetic animayte-style clips (drive the shared state machine)
 *   isCodexManifest(obj)           — shape-detect a Codex pet.json (vs animayte-pet/1)
 *   validateCodexManifest(obj)     — → string[] friendly errors ([] = valid)
 *   validateAtlasDims(w, h)        — → string[] ([] = a conformant atlas)
 */

// ── atlas geometry (compose_atlas.py / validate_atlas.py) ──
export const ATLAS = Object.freeze({
  width: 1536, height: 1872,   // 8·192 × 9·208
  cols: 8, rows: 9,
  cellW: 192, cellH: 208,
});

// per-frame durations for the "N at <each> ms, final <final> ms" rows (animation-rows.md)
const evenWithFinal = (n, each, final) => Array.from({ length: n }, (_, i) => (i === n - 1 ? final : each));

/*
 * The nine ordered states (one per row). `frames` cells are USED (columns 0..frames-1);
 * the remaining columns in the row are fully transparent. `loop` separates the continuous
 * states (idle / processing / movement) from the transient gestures (a wave/jump/error that
 * plays once and settles back to idle). `durations` are verbatim from references/animation-rows.md.
 */
export const ROW_SPECS = Object.freeze([
  { state: 'idle',          row: 0, loop: true,  durations: [280, 110, 110, 140, 140, 320] },
  { state: 'running-right', row: 1, loop: true,  durations: evenWithFinal(8, 120, 220) },
  { state: 'running-left',  row: 2, loop: true,  durations: evenWithFinal(8, 120, 220) },
  { state: 'waving',        row: 3, loop: false, durations: evenWithFinal(4, 140, 280) },
  { state: 'jumping',       row: 4, loop: false, durations: evenWithFinal(5, 140, 280) },
  { state: 'failed',        row: 5, loop: false, durations: evenWithFinal(8, 140, 240) },
  { state: 'waiting',       row: 6, loop: true,  durations: evenWithFinal(6, 150, 260) },
  { state: 'running',       row: 7, loop: true,  durations: evenWithFinal(6, 120, 220) },
  { state: 'review',        row: 8, loop: true,  durations: evenWithFinal(6, 150, 280) },
].map((s) => Object.freeze({ ...s, frames: s.durations.length, durations: Object.freeze(s.durations) })));

/** State names in row order (index === row). */
export const CODEX_STATES = Object.freeze(ROW_SPECS.map((s) => s.state));

const ROW_BY_STATE = Object.freeze(Object.fromEntries(ROW_SPECS.map((s) => [s.state, s])));

/** rowOf(state) → row index (0..8), or -1 for an unknown state. */
export const rowOf = (state) => (ROW_BY_STATE[state] ? ROW_BY_STATE[state].row : -1);

/** isLoopState(state) → true for the continuous states (idle/processing/movement),
 *  false for the transient gestures (wave/jump/failed) that play once and settle. */
export const isLoopState = (state) => !!(ROW_BY_STATE[state] && ROW_BY_STATE[state].loop);

/**
 * buildCodexClips() → { [state]: { loop, frames: [{ dur, cell }] } }
 *
 * One clip per state, shaped exactly like an animayte-pet clip so the SHARED state
 * machine (lib/anim/state-machine.mjs) can play a Codex pet unchanged: `cell` is the
 * COLUMN within the row (the row itself is the state → the player resolves it via rowOf).
 */
export function buildCodexClips() {
  const clips = {};
  for (const s of ROW_SPECS) {
    clips[s.state] = { loop: s.loop, frames: s.durations.map((dur, cell) => ({ dur, cell })) };
  }
  return clips;
}

// ── pet.json detection + validation ──
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * isCodexManifest(obj) — true for a Codex pet manifest, false for an animayte-pet/1
 * pack (or anything else). Codex manifests carry `spritesheetPath` and DON'T tag a
 * format; an animayte pack always sets format "animayte-pet/1". Shape, not a flag.
 */
export function isCodexManifest(obj) {
  if (!isObj(obj)) return false;
  if (obj.format) return false;            // animayte-pet/1 (or any future tagged format) is not Codex
  return isStr(obj.spritesheetPath);
}

/**
 * validateCodexManifest(obj) → string[]  (empty = valid)
 * The minimal 4-field Codex contract. Friendly, path-named errors — same idiom as
 * lib/anim/manifest.mjs so a malformed pack fails loudly, not silently.
 */
export function validateCodexManifest(m) {
  const E = [];
  if (!isObj(m)) return ['manifest must be a JSON object'];
  if (!isStr(m.id)) E.push('id: must be a non-empty string (the pet identifier)');
  if (!isStr(m.displayName)) E.push('displayName: must be a non-empty string');
  if (!isStr(m.description)) E.push('description: must be a non-empty string');
  if (!isStr(m.spritesheetPath)) E.push('spritesheetPath: must be a spritesheet filename (string) relative to the pack dir');
  else if (!/\.(png|webp)$/i.test(m.spritesheetPath)) E.push('spritesheetPath: must end in .png or .webp (a transparent atlas)');
  return E;
}

/**
 * validateAtlasDims(width, height) → string[]  (empty = conformant)
 * The atlas MUST be exactly 1536×1872 (validate_atlas.py rejects anything else).
 */
export function validateAtlasDims(width, height) {
  if (width === ATLAS.width && height === ATLAS.height) return [];
  return [`atlas must be ${ATLAS.width}×${ATLAS.height} (8×9 cells of ${ATLAS.cellW}×${ATLAS.cellH}); got ${width}×${height}`];
}
