#!/usr/bin/env node
/*
 * animayte-lint — the ART-FACING guardrail for the WIRING CONTRACT.
 *
 *   node tools/animayte-lint.mjs                       # lint the live grid manifest
 *   node tools/animayte-lint.mjs --manifest my/pet.mjs # lint a pet author's manifest
 *   node tools/animayte-lint.mjs --runtime my/run.mjs  # against a custom renderer runtime
 *   node tools/animayte-lint.mjs --json                # machine output for CI
 *
 * WHY THIS EXISTS (read docs/ARCHITECTURE.md §5/§6):
 *   The pet only reacts to a session signal if an UNBROKEN CHAIN holds:
 *
 *     daemon broadcasts cmd ─▶ renderer dispatch routes cmd ─▶ pet.method() exists
 *                           └─▶ react NAME exists in the art manifest
 *
 *   A break anywhere is a SILENT no-op: the daemon looks healthy, the tests an art
 *   dept doesn't run stay green, and the pet just… doesn't move. test/contract.test.mjs
 *   locks this for the *repo's own* manifest as part of `node test/run.mjs`. THIS tool is
 *   the same logic repackaged for the people who never touch the plumbing — an art author
 *   editing grid/manifest.mjs (or shipping their own pack) runs ONE command and gets a
 *   plain ✓/✗ report telling them whether their manifest still satisfies the daemon's
 *   live vocabulary, plus which clips they define that the daemon will never trigger.
 *
 *   It is COMPLEMENTARY to the test, not a replacement: the test guards the repo on every
 *   commit; the linter is a portable, manifest-targetable, JSON-emitting front door an
 *   art team can wire into their own CI / pre-commit without learning the test harness.
 *
 * Zero dependencies — Node builtins only. The daemon's vocabulary is extracted by parsing
 * the REAL sources exactly as the contract test does (see extractDaemonVocabulary), so the
 * two can never disagree about what the daemon emits.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── tiny parse helpers (identical semantics to test/contract.test.mjs) ────────────────────────
const uniq = (a) => [...new Set(a)].sort();
const matchAll = (s, re) => [...s.matchAll(re)].map((m) => m[1]);
const read = (p) => readFileSync(p, 'utf8');
const abs = (p) => (isAbsolute(p) ? p : resolve(process.cwd(), p));
const rel = (p) => { const r = relative(process.cwd(), p); return r.startsWith('..') ? p : r; };

/**
 * Parse the daemon's emitted vocabulary out of the REAL plumbing sources — the single
 * source of truth both this linter and test/contract.test.mjs derive from. Returns the
 * set of SSE `cmd`s the daemon can broadcast and every `react` NAME it can emit.
 *
 *   cmds      — `cmd:'…'` literals in animayte.mjs (incl. the keepalive `ping`).
 *   reactNames— `event:'…'` from lib/anim/events.mjs:classifyTool (the tool-gags),
 *               the hardcoded `cmd:'react',name:'…'` (Asking/Waiting), and every value
 *               in the REACTION_FOR_ITEM bridge map. These are the names a renderer's
 *               manifest.reactions MUST contain or the pet silently won't react.
 */
export function extractDaemonVocabulary(root = ROOT) {
  const daemon = read(join(root, 'animayte.mjs'));
  const events = read(join(root, 'lib/anim/events.mjs'));

  // every cmd the daemon broadcasts/sends. The \s* tolerates the bare `cmd:'ping'` write too,
  // but we union 'ping' in explicitly to stay bit-for-bit with the contract test's intent.
  const cmds = uniq([...matchAll(daemon, /cmd:\s*'([a-zA-Z]+)'/g), 'ping']);

  const reactNames = uniq([
    ...matchAll(events, /event:\s*'([A-Za-z]+)'/g),                      // classifyTool tool-gags
    ...matchAll(daemon, /cmd:\s*'react',\s*name:\s*'([A-Za-z]+)'/g),     // hardcoded (Asking/Waiting)
    ...matchAll(daemon, /REACTION_FOR_ITEM\s*=\s*\{([^}]*)\}/g)          // the express→react bridge
      .flatMap((blk) => matchAll(blk, /'([A-Za-z]+)'/g)),
  ]);

  return { cmds, reactNames };
}

/**
 * Parse the renderer half of the contract: which cmds the shared dispatch handles, and
 * which pet.METHOD()s the live overlay host + dispatch call. Mirrors contract.test.mjs.
 */
export function extractRendererVocabulary(root = ROOT) {
  const dispatch = read(join(root, 'grid/dispatch.mjs'));
  const petHtml = read(join(root, 'grid/pet.html'));
  const handledCmds = uniq(matchAll(dispatch, /case\s*'([a-zA-Z]+)'/g));
  const calledMethods = uniq([
    ...matchAll(petHtml, /\bpet\.([a-zA-Z]+)\s*\(/g),
    ...matchAll(dispatch, /\bpet\.([a-zA-Z]+)\s*\(/g),
  ]);
  return { handledCmds, calledMethods };
}

// cmds a renderer may legitimately ignore (documented design choices, not bugs).
// Mirrors test/contract.test.mjs's IGNORED set for grid/dispatch.mjs.
const IGNORED_CMDS = new Set(['moodLevel', 'ping']);
// applySpec is the ONE guarded-optional method: the dispatch calls it behind `if (pet.applySpec)`,
// so `express` degrades to the legacy mood face on a runtime that hasn't shipped it. Never required.
const OPTIONAL_METHODS = new Set(['applySpec']);

/**
 * Instantiate a renderer runtime headlessly (stubbed browser globals + a Proxy 2D context,
 * exactly like contract.test.mjs) and return the set of method names on its public control API.
 */
export async function introspectRuntime(runtimePath) {
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 0);
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});
  globalThis.window = globalThis.window || { devicePixelRatio: 1 };
  const noop = () => fakeCtx;                                  // chainable no-op 2D context
  const fakeCtx = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? fakeCanvas : (k === 'measureText' ? () => ({ width: 0 }) : (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop: () => {} }) : noop))) });
  const fakeCanvas = { getContext: () => fakeCtx, width: 0, height: 0, style: {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const mod = await import(pathToFileURL(runtimePath).href);
  if (typeof mod.createGridRuntime !== 'function') {
    throw new Error(`runtime ${rel(runtimePath)} does not export createGridRuntime(canvas, opts)`);
  }
  const pet = mod.createGridRuntime(fakeCanvas, { cell: 10 });
  const api = new Set(Object.keys(pet));
  if (typeof pet.stop === 'function') pet.stop();
  return api;
}

/** Load a manifest module and return its reaction names (Object.keys of MANIFEST.reactions). */
export async function loadManifestReactions(manifestPath) {
  const mod = await import(pathToFileURL(manifestPath).href);
  const M = mod.MANIFEST;
  if (!M || typeof M !== 'object') throw new Error(`manifest ${rel(manifestPath)} has no exported MANIFEST object`);
  if (!M.reactions || typeof M.reactions !== 'object') throw new Error(`manifest ${rel(manifestPath)} has no MANIFEST.reactions map`);
  return { reactions: new Set(Object.keys(M.reactions)), name: M.name, format: M.format };
}

// ── the lint itself: build a structured result of checks (no I/O — caller renders it) ─────────
/**
 * Run every contract check and return a structured report:
 *   { ok, checks:[{id,title,ok,detail,fix?}], facts:{…} }
 * `ok` is false iff any check failed → the CLI exits non-zero.
 */
export async function lint({ root = ROOT, manifestPath, runtimePath } = {}) {
  const mPath = abs(manifestPath || join(root, 'grid/manifest.mjs'));
  const rPath = abs(runtimePath || join(root, 'grid/runtime.mjs'));
  const checks = [];
  const add = (id, title, ok, detail = '', fix = '') => checks.push({ id, title, ok, detail, fix });

  // 1) extract the daemon's vocabulary from the real plumbing
  const { cmds, reactNames } = extractDaemonVocabulary(root);
  add('daemon-vocab', 'daemon emits a non-trivial command vocabulary', cmds.length >= 12,
    `${cmds.length} cmds: ${cmds.join(', ')}`);
  add('daemon-reacts', 'daemon emits a non-trivial react vocabulary', reactNames.length >= 9,
    `${reactNames.length} react names: ${reactNames.join(', ')}`);

  // 2) the renderer dispatch handles every cmd the daemon emits (or ignores it on purpose)
  const { handledCmds, calledMethods } = extractRendererVocabulary(root);
  const handled = new Set([...handledCmds, ...IGNORED_CMDS]);
  const droppedCmds = cmds.filter((c) => !handled.has(c));
  add('dispatch-covers-cmds', 'grid/dispatch.mjs handles every cmd the daemon emits',
    droppedCmds.length === 0,
    droppedCmds.length ? `silently drops: ${droppedCmds.join(', ')}` : 'all cmds routed (or explicitly ignored)',
    droppedCmds.length ? `add a \`case '${droppedCmds[0]}':\` to grid/dispatch.mjs (or list it in the IGNORED set) — otherwise that signal is a silent no-op` : '');

  // 3) the manifest defines a clip for every react NAME the daemon can emit  ← the art-author check
  let manifest = null, manifestErr = null;
  try { manifest = await loadManifestReactions(mPath); }
  catch (e) { manifestErr = e.message; }
  if (manifestErr) {
    add('manifest-loads', `manifest loads (${rel(mPath)})`, false, manifestErr,
      'check the path and that it `export const MANIFEST = { …, reactions: {…} }`');
  } else {
    const missing = reactNames.filter((n) => !manifest.reactions.has(n));
    add('manifest-covers-reacts', `manifest covers every react the daemon emits (${rel(mPath)})`,
      missing.length === 0,
      missing.length
        ? `missing clip(s) for: ${missing.join(', ')}`
        : `all ${reactNames.length} react names have a clip`,
      missing.length ? reactFix(missing[0]) : '');
    // reverse direction: reactions the manifest defines that the daemon will never emit = DEAD ART.
    // Informational (not a failure) — an author may stage clips ahead of new daemon signals.
    const dead = [...manifest.reactions].filter((n) => !reactNames.includes(n)).sort();
    add('manifest-dead-art', 'manifest has no dead reactions (informational)', true,
      dead.length
        ? `defined but never emitted by the daemon: ${dead.join(', ')} — harmless, but the pet will never play these`
        : 'every defined reaction is reachable');
  }

  // 4) the renderer runtime exposes every pet.METHOD the dispatch calls (excl. guarded-optional)
  let runtimeApi = null, runtimeErr = null;
  try { runtimeApi = await introspectRuntime(rPath); }
  catch (e) { runtimeErr = e.message; }
  if (runtimeErr) {
    add('runtime-instantiates', `runtime instantiates for introspection (${rel(rPath)})`, false, runtimeErr,
      'the runtime must `export function createGridRuntime(canvas, opts)` and run headless');
  } else {
    add('runtime-api', 'runtime exposes a non-trivial control API', runtimeApi.size >= 10,
      `${runtimeApi.size} methods: ${uniq([...runtimeApi]).join(', ')}`);
    const missingMethods = calledMethods.filter((m) => !OPTIONAL_METHODS.has(m) && !runtimeApi.has(m));
    add('runtime-covers-methods', 'runtime exposes every pet.method the dispatch calls (excl. guarded-optional)',
      missingMethods.length === 0,
      missingMethods.length ? `runtime lacks: ${missingMethods.join(', ')}` : 'all called methods exist',
      missingMethods.length ? `add ${missingMethods.map((m) => m + '()').join(', ')} to the runtime's returned control object — the dispatch calls it unguarded, so its absence throws at runtime` : '');
    // applySpec presence is informational: express degrades to the mood face without it.
    add('runtime-applyspec', 'rich `express` face support (informational)', true,
      runtimeApi.has('applySpec')
        ? 'runtime exposes applySpec — the rich `express` FeatureSpec face is live'
        : 'runtime lacks applySpec — `express` degrades to the legacy mood face (fine for a mood-only renderer)');
  }

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    facts: {
      manifest: manifestErr ? null : { path: rel(mPath), name: manifest.name, format: manifest.format, reactions: [...(manifest?.reactions || [])].sort() },
      runtime: runtimeErr ? null : { path: rel(rPath), methods: uniq([...(runtimeApi || [])]) },
      daemon: { cmds, reactNames },
    },
  };
}

function reactFix(name) {
  return `add \`${name}: { clip: 'react', expression: 'thinking', priority: 2 }\` to MANIFEST.reactions — without it the pet won't react when the daemon emits '${name}' (${reactMeaning(name)})`;
}
// human "what triggers this" hints for the most actionable misses.
function reactMeaning(name) {
  return ({
    Reading: 'a file read', Searching: 'a grep/glob/web search', Writing: 'an edit/write',
    Running: 'a shell command', Testing: 'a test run', Installing: 'a package install',
    Committing: 'a git commit', Fetching: 'a web fetch', Planning: 'a todo/plan update',
    Asking: 'a permission prompt', Waiting: 'the session waiting for you',
  })[name] || 'a session signal';
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--manifest') a.manifestPath = argv[++i];
    else if (t === '--runtime') a.runtimePath = argv[++i];
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t.startsWith('--manifest=')) a.manifestPath = t.slice('--manifest='.length);
    else if (t.startsWith('--runtime=')) a.runtimePath = t.slice('--runtime='.length);
    else { a.error = `unknown argument: ${t}`; }
  }
  return a;
}

const HELP = `animayte-lint — validate a renderer's art manifest against the daemon's live vocabulary

USAGE
  node tools/animayte-lint.mjs [--manifest <path>] [--runtime <path>] [--json]

FLAGS
  --manifest <path>   manifest module to lint   (default: grid/manifest.mjs)
  --runtime  <path>   renderer runtime module   (default: grid/runtime.mjs)
  --json              emit a machine-readable report for CI
  -h, --help          this help

EXIT CODE
  0  every contract check passed   ·   1  a contract violation (a silent no-op) was found`;

function render(report) {
  const C = process.stdout.isTTY;
  const g = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s);
  const r = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s);
  const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s);
  const out = [];
  out.push('');
  out.push(bold('· animayte art-contract lint') + dim('  — does this manifest satisfy the daemon?'));
  if (report.facts.manifest) out.push(dim(`  manifest: ${report.facts.manifest.path}  (name: ${report.facts.manifest.name})`));
  if (report.facts.runtime) out.push(dim(`  runtime:  ${report.facts.runtime.path}`));
  out.push('');
  for (const c of report.checks) {
    const mark = c.ok ? g('✓') : r('✗');
    out.push(`  ${mark} ${c.title}`);
    if (c.detail) out.push(dim(`      ${c.detail}`));
    if (!c.ok && c.fix) out.push(r(`      ↳ fix: ${c.fix}`));
  }
  const passed = report.checks.filter((c) => c.ok).length;
  out.push('');
  out.push(report.ok
    ? g(`✅  ${passed}/${report.checks.length} checks passed — this manifest covers the daemon's full vocabulary`)
    : r(`❌  ${passed}/${report.checks.length} checks passed — the pet will silently ignore some session signals`));
  out.push('');
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (args.error) { console.error(args.error + '\n\n' + HELP); return 2; }
  let report;
  try {
    report = await lint({ manifestPath: args.manifestPath, runtimePath: args.runtimePath });
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    else console.error('\n❌  animayte-lint failed to run: ' + e.message + '\n');
    return 1;
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  return report.ok ? 0 : 1;
}

// run only as a CLI, never on import (so the self-test can import the functions cleanly)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
}
