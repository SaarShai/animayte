#!/usr/bin/env node
/*
 * animayte — WIRING CONTRACT test (Route 3 / "the plumbing").
 *   node test/contract.test.mjs
 *
 * The pet only reacts to a session signal if an UNBROKEN CHAIN holds:
 *
 *     hook/statusline ─▶ daemon broadcasts cmd ─▶ renderer dispatch routes cmd ─▶ pet.method()
 *                                              └─▶ react NAME exists in the art manifest
 *
 * Every other suite tests the daemon HALF (does it broadcast the right thing). NONE tested that
 * the renderer actually HANDLES what the daemon emits, or that a `react` name the daemon sends is
 * one the art manifest knows. A drift there is a SILENT no-op — the daemon looks healthy, every
 * other test stays green, and the pet just… doesn't move. This suite parses the real source files
 * and the real art manifest and locks all three links so that drift fails loudly instead.
 *
 * It is intentionally source-parsing (not behavioural): it is the structural backbone that proves
 * the vocabulary is closed. Behaviour is covered by integration/compact/dispatch suites.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const uniq = (a) => [...new Set(a)].sort();
const matchAll = (s, re) => [...s.matchAll(re)].map((m) => m[1]);

// ── the three vocabularies, parsed from the REAL sources ─────────────────────────────────────
const daemon = read('animayte.mjs');
// every cmd the daemon broadcasts/sends, plus the raw keepalive ping (a literal write, not a cmd:)
const emittedCmds = uniq([...matchAll(daemon, /cmd:\s*'([a-zA-Z]+)'/g), 'ping']);

const petHtml = read('grid/pet.html');         // the LIVE Dijon renderer host (WKWebView)
const gridDispatch = read('grid/dispatch.mjs'); // the SHARED command vocabulary the live renderer uses
const webHtml = read('animayte.html');          // the browser / multi-engine host (still inline)
const casesOf = (src) => uniq(matchAll(src, /case\s*'([a-zA-Z]+)'/g));
// the grid renderer's vocabulary now lives in the shared dispatch module, not inline in the HTML
const petCases = casesOf(gridDispatch);
const webCases = casesOf(webHtml);

// cmds a renderer may legitimately ignore (documented design choices, not bugs)
const IGNORED = {
  'grid/dispatch.mjs': new Set(['moodLevel', 'ping']),   // grid runtime has no mood-drift tint; ping is keepalive
  'animayte.html': new Set(['ping']),
};

console.log('\n· wiring contract — daemon cmds ⊆ renderer dispatch ⊆ pet methods; react names ⊆ manifest');

// 1) every cmd the daemon emits must be handled (or explicitly ignored) by EACH renderer
for (const [name, cases] of [['grid/dispatch.mjs', petCases], ['animayte.html', webCases]]) {
  const handled = new Set([...cases, ...IGNORED[name]]);
  const dropped = emittedCmds.filter((c) => !handled.has(c));
  ok(`${name}: handles every cmd the daemon emits`, dropped.length === 0, dropped.length ? 'silently drops: ' + dropped.join(', ') : '');
}
// guard the reverse too: a renderer case with no daemon emitter is dead code worth knowing about
// (resetEgg is the documented alias the daemon never sends but the egg flow may) — informational only.
ok('daemon emits a non-trivial vocabulary (sanity)', emittedCmds.length >= 12, 'got ' + emittedCmds.length);

// 2) every pet.METHOD the live renderer calls must exist on the real grid runtime API
//    (instantiate the REAL runtime with stubbed browser globals + a no-op canvas, then introspect)
let runtimeApi = null;
try {
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.window = { devicePixelRatio: 1 };
  const noop = () => fakeCtx;                                  // chainable no-op 2D context
  const fakeCtx = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? fakeCanvas : (k === 'measureText' ? () => ({ width: 0 }) : (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: () => {} }) : noop))) });
  const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0, style: {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const { createGridRuntime } = await import(join(ROOT, 'grid/runtime.mjs'));
  const pet = createGridRuntime(fakeCanvas, { cell: 10 });
  runtimeApi = new Set(Object.keys(pet));
  if (typeof pet.stop === 'function') pet.stop();
} catch (e) {
  ok('grid runtime instantiates for introspection', false, e.message);
}
if (runtimeApi) {
  ok('grid runtime exposes a non-trivial control API', runtimeApi.size >= 10, 'only ' + runtimeApi.size + ' methods');
  // pet.METHOD calls live both in the host (the /health seed + resize) and in the shared dispatch module.
  // applySpec is the ONE optional method: the dispatch calls it GUARDED (`if (pet.applySpec)`) so the
  // `express` rich-face path degrades to the legacy mood face on a renderer that hasn't shipped it yet.
  // So it must not be REQUIRED — only the unguarded methods must exist.
  const OPTIONAL = new Set(['applySpec']);
  const petMethods = uniq([...matchAll(petHtml, /\bpet\.([a-zA-Z]+)\s*\(/g), ...matchAll(gridDispatch, /\bpet\.([a-zA-Z]+)\s*\(/g)]);
  const missing = petMethods.filter((m) => !OPTIONAL.has(m) && !runtimeApi.has(m));
  ok('the live renderer calls only methods the runtime exposes (excl. guarded-optional)', missing.length === 0, missing.length ? 'runtime lacks: ' + missing.join(', ') : '');
  // applySpec presence is INFORMATIONAL, not a hard gate — express degrades gracefully without it.
  console.log('  · note: grid runtime ' + (runtimeApi.has('applySpec') ? 'exposes applySpec — the rich `express` face is live' : 'lacks applySpec — `express` degrades to the mood face (legacy renderer)'));
}

// 3) every `react` NAME the daemon can emit must exist in the art manifest, or the pet won't react
const reactNames = uniq([
  ...matchAll(read('lib/anim/events.mjs'), /event:\s*'([A-Za-z]+)'/g),   // classifyTool tool-gags
  ...matchAll(daemon, /cmd:\s*'react',\s*name:\s*'([A-Za-z]+)'/g),        // hardcoded (Asking/Waiting)
  ...matchAll(daemon, /REACTION_FOR_ITEM\s*=\s*\{([^}]*)\}/g).flatMap((blk) => matchAll(blk, /'([A-Za-z]+)'/g)),
]);
const { MANIFEST } = await import(join(ROOT, 'grid/manifest.mjs'));
const known = new Set(Object.keys(MANIFEST.reactions || {}));
const unknownReacts = reactNames.filter((n) => !known.has(n));
ok('every react name the daemon emits exists in the manifest', unknownReacts.length === 0, unknownReacts.length ? 'manifest lacks: ' + unknownReacts.join(', ') : '');
ok('react vocabulary is non-trivial (sanity)', reactNames.length >= 9, 'got ' + reactNames.length);

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} contract checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
