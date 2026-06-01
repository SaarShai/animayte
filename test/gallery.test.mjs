#!/usr/bin/env node
/*
 * animayte — GALLERY self-test.
 *   node test/gallery.test.mjs
 *
 * Proves the art-team gallery (tools/animayte-gallery.mjs) actually drives the LIVE pet
 * through its entire reaction range over the REAL endpoints. It:
 *   1. spawns an EPHEMERAL daemon on a FREE port (never :4321, never kills anything),
 *   2. opens a live SSE collector on /events,
 *   3. runs the gallery in --selftest mode against that daemon,
 *   4. asserts the collector SAW a representative command for EVERY category
 *      (mood · react · express · addBird/removeBird · relief · fullness · sleep/wake),
 *   5. also asserts the tool-fixture table can't drift from classifyTool, and that the
 *      catalog is exhaustive vs the real source lists.
 *
 * Node builtins only. The gallery is run as a child process exactly as a human would run it,
 * so this is a true end-to-end check of the actual CLI, not a re-implementation.
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_EVENTS, classifyTool } from '../lib/anim/events.mjs';
import { MOOD_EXPRESSION } from '../grid/manifest.mjs';
import { buildCatalog, TOOL_FIXTURE } from '../tools/animayte-gallery.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => {
  const tick = (n) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); });
    req.on('error', () => (n <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(n - 1), 100)));
    req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); });
  };
  tick(tries);
});
async function startDaemon(port) {
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' });
  await waitHealth(port);
  return child;
}
const stopDaemon = (child) => new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); });

// a live SSE collector that records every broadcast command (newest appended)
function sseCollector(port) {
  let raw = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => { res.on('data', (c) => (raw += c)); });
  req.on('error', () => {});
  return {
    cmds: () => raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean),
    close: () => { try { req.destroy(); } catch {} },
  };
}

console.log('\n· gallery self-test — the art-team tour drives every reaction over the real endpoints');

// ── Part A (pure, no daemon): the catalog can't silently drift from the real source ─────────
{
  // every tool fixture really classifies to its own event (so the gag shown matches the label)
  let fixtureOk = true, badFx = null;
  for (const ev of TOOL_EVENTS) {
    const fx = TOOL_FIXTURE[ev];
    const got = fx ? (classifyTool(fx.tool_name, fx.tool_input) || {}).event : null;
    if (got !== ev) { fixtureOk = false; badFx = `${ev} → ${got}`; break; }
  }
  ok('every tool fixture classifies to its own TOOL_EVENT (no drift from classifyTool)', fixtureOk, badFx);

  // the built catalog covers every mood bucket and every tool event (exhaustive vs source)
  const catalog = buildCatalog();
  const names = new Set(catalog.map((s) => s.name));
  const moodsCovered = Object.keys(MOOD_EXPRESSION).every((m) => names.has('mood:' + m));
  ok('catalog covers every MOOD_EXPRESSION bucket', moodsCovered, Object.keys(MOOD_EXPRESSION).filter((m) => !names.has('mood:' + m)).join(','));
  const toolsCovered = TOOL_EVENTS.every((e) => names.has('react:' + e));
  ok('catalog covers every classifyTool TOOL_EVENT', toolsCovered, TOOL_EVENTS.filter((e) => !names.has('react:' + e)).join(','));
  ok('catalog includes the Asking + Waiting notification gags', names.has('react:Asking') && names.has('react:Waiting'));
  ok('catalog includes relief, sleep, wake, fullness, birds, express', ['relief', 'sleep', 'wake', 'birds:up', 'birds:down'].every((n) => names.has(n)) && catalog.some((s) => s.name.startsWith('express:')) && catalog.some((s) => s.name.startsWith('fullness:')));
}

// ── Part B (end-to-end): run the REAL CLI against an ephemeral daemon, watch the wire ────────
const port = await freePort();
ok('chose a free, non-default port for the ephemeral daemon (never :4321)', port !== 4321, 'port=' + port);
const child = await startDaemon(port);
const sse = sseCollector(port);
await sleep(150);

let runOut = '';
try {
  // run the gallery EXACTLY as a person would — its own CLI, --selftest pace, our ephemeral port
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/animayte-gallery.mjs'), '--selftest', '--port', String(port)], { encoding: 'utf8', timeout: 60000 });
  runOut = (r.stdout || '') + (r.stderr || '');
  ok('gallery CLI exited cleanly', r.status === 0, 'status=' + r.status + (r.error ? ' err=' + r.error.message : ''));

  await sleep(300);   // let the last broadcasts flush to the collector
  const cmds = sse.cmds();
  const count = (cmd, pred) => cmds.filter((c) => c.cmd === cmd && (!pred || pred(c))).length;

  // category coverage on the WIRE — the headline guarantee for the art team
  const cats = {
    mood:        count('mood'),
    react:       count('react'),
    express:     count('express'),
    addBird:     count('addBird'),
    removeBird:  count('removeBird'),
    relief:      count('relief'),
    fullness:    count('fullness'),
    sleep:       count('sleep'),
    wake:        count('wake'),
  };
  for (const [cat, n] of Object.entries(cats)) {
    ok(`SSE saw ≥1 «${cat}» command`, n >= 1, 'count=' + n);
  }

  // deeper coverage: a react for EACH tool event landed (so every gag was exercised)
  const reactNames = new Set(cmds.filter((c) => c.cmd === 'react').map((c) => c.name));
  const everyToolReact = TOOL_EVENTS.every((e) => reactNames.has(e));
  ok('SSE saw a «react» for every TOOL_EVENT', everyToolReact, 'missing: ' + TOOL_EVENTS.filter((e) => !reactNames.has(e)).join(',') + ' | saw: ' + [...reactNames].join(','));
  ok('SSE saw the Asking + Waiting notification reacts', reactNames.has('Asking') && reactNames.has('Waiting'));

  // a mood broadcast for every mood bucket (the legacy face sweep)
  const moodVals = new Set(cmds.filter((c) => c.cmd === 'mood').map((c) => c.value));
  const everyMood = Object.keys(MOOD_EXPRESSION).every((m) => moodVals.has(m));
  ok('SSE saw a «mood» for every MOOD_EXPRESSION bucket', everyMood, 'missing: ' + Object.keys(MOOD_EXPRESSION).filter((m) => !moodVals.has(m)).join(','));

  // birds ramped all the way to the 5-cap and drained back
  ok('birds ramped to the cap (≥5 addBird) and drained (≥5 removeBird)', cats.addBird >= 5 && cats.removeBird >= 5, `add=${cats.addBird} remove=${cats.removeBird}`);

  // fullness actually swept up to ~full at some point
  const maxFull = Math.max(0, ...cmds.filter((c) => c.cmd === 'fullness').map((c) => c.value || 0));
  ok('fullness sweep reached ≈100%', maxFull >= 0.9, 'max=' + maxFull.toFixed(2));

  // print the counts-per-category table (the report the task asks for)
  console.log('\n  category coverage on the SSE wire (gallery --selftest):');
  for (const [cat, n] of Object.entries(cats)) console.log(`    ${cat.padEnd(11)} ${String(n).padStart(3)}`);
  console.log(`    react names  ${[...reactNames].sort().join(', ')}`);
  console.log(`    mood values  ${[...moodVals].sort().join(', ')}`);
} finally {
  sse.close();
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} gallery checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); if (runOut) console.log('\n--- gallery output ---\n' + runOut); process.exit(1); }
console.log('');
