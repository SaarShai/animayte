#!/usr/bin/env node
/*
 * animayte — STRESS / LEAK / CONCURRENCY test (Route 3 / "the plumbing").
 *   node test/stress.test.mjs
 *
 * Hammers a REAL daemon to prove it stays correct and bounded under load:
 *   · SSE fan-out — N concurrent clients all receive every broadcast
 *   · no connection leak — clients open/close cleanly (clients.size returns to 0)
 *   · event flood — thousands of events, daemon stays responsive, memory bounded
 *   · dedup under load — duplicate tool_use_ids never double-count
 *   · ownership under load — interleaved foreign-session events never leak in
 *   · resilience — malformed / oversized bodies never crash it
 *
 * Zero-dependency (Node http only), so it runs in CI with no extra tooling.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra = '') => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? ' ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitHealth = (port, n = 80) => new Promise((resolve, reject) => {
  const tick = (k) => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); }); req.on('error', () => (k <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(k - 1), 100))); req.on('timeout', () => { req.destroy(); k <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(k - 1), 100); }); };
  tick(n);
});
async function startDaemon(port) { const c = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' }); await waitHealth(port); return c; }
const stop = (c) => new Promise((r) => { if (!c) return r(); c.once('exit', () => r()); c.kill('SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const post = (port, path, body) => new Promise((resolve) => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 4000 }, (r) => { r.resume(); r.on('end', resolve); });
  req.on('error', () => resolve()); req.on('timeout', () => { req.destroy(); resolve(); });
  req.write(data); req.end();
});
// an SSE subscriber that accumulates received commands
function openSSE(port) {
  const s = { raw: '', open: false, req: null };
  s.req = http.get({ host: '127.0.0.1', port, path: '/events', agent: new http.Agent({ keepAlive: true }) }, (res) => { s.open = true; res.on('data', (c) => (s.raw += c)); });
  s.req.on('error', () => {});
  return s;
}
const closeSSE = (s) => { try { s.req.destroy(); } catch {} };

const port = await freePort();
let daemon = await startDaemon(port);
try {
  await post(port, '/claim', { session_id: 'OWNER' });

  // 1) SSE fan-out — 30 clients all receive a broadcast
  console.log('· SSE fan-out — 30 concurrent clients receive every broadcast');
  const K = 30;
  const subs = Array.from({ length: K }, () => openSSE(port));
  for (let i = 0; i < 40 && (await getJSON(port, '/health')).clients < K; i++) await sleep(25);
  let h = await getJSON(port, '/health');
  ok(`all ${K} SSE clients registered`, h.clients === K, `(got ${h.clients})`);
  await getJSON(port, `/set?mood=excited`); // broadcasts mood
  await sleep(200);
  const gotIt = subs.filter((s) => /"cmd":"mood","value":"excited"/.test(s.raw)).length;
  ok(`every client received the broadcast`, gotIt === K, `(${gotIt}/${K})`);

  // 2) no leak — closing all clients returns clients.size to 0
  console.log('· no connection leak — clients.size returns to 0 after close');
  subs.forEach(closeSSE);
  for (let i = 0; i < 60 && (await getJSON(port, '/health')).clients > 0; i++) await sleep(25);
  h = await getJSON(port, '/health');
  ok('no SSE clients linger after close', h.clients === 0, `(got ${h.clients})`);

  // 2b) reconnect storm — open/close 100 clients across cycles, must always drain to 0
  for (let cycle = 0; cycle < 3; cycle++) {
    const burst = Array.from({ length: 40 }, () => openSSE(port));
    await sleep(120); burst.forEach(closeSSE); await sleep(120);
  }
  for (let i = 0; i < 80 && (await getJSON(port, '/health')).clients > 0; i++) await sleep(25);
  h = await getJSON(port, '/health');
  ok('reconnect storm leaves 0 lingering clients', h.clients === 0, `(got ${h.clients})`);

  // 3) event flood — thousands of events, daemon stays responsive + memory bounded
  console.log('· event flood — 3000 events, responsive + bounded memory');
  const rssBefore = (await getJSON(port, '/health')).rss;
  const N = 3000, BATCH = 100;
  const t0 = Date.now();
  for (let i = 0; i < N; i += BATCH) {
    const batch = [];
    for (let j = 0; j < BATCH; j++) {
      const n = i + j;
      batch.push(post(port, '/event', { hook_event_name: n % 2 ? 'PostToolUse' : 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' + n }, tool_use_id: 'toolu_' + n, session_id: 'OWNER' }));
    }
    await Promise.all(batch);
  }
  const floodMs = Date.now() - t0;
  h = await getJSON(port, '/health');
  ok('daemon still healthy after 3000 events', !!(h && h.ok), '');
  ok('flood throughput sane (<8s for 3000)', floodMs < 8000, `(${floodMs}ms)`);
  // settle + measure memory growth
  await sleep(500);
  const rssAfter = (await getJSON(port, '/health')).rss;
  const growthMB = (rssAfter - rssBefore) / 1e6;
  ok('memory growth bounded after flood (<60MB)', growthMB < 60, `(grew ${growthMB.toFixed(1)}MB)`);
  ok('dedup map did not balloon RSS (<300MB total)', rssAfter < 300e6, `(rss ${(rssAfter / 1e6).toFixed(0)}MB)`);

  // 4) dedup under load — 800 exact-duplicate Task spawns ⇒ never exceeds the bird cap, no crash
  console.log('· dedup + cap under load — duplicate + flood spawns stay capped at 5');
  await getJSON(port, '/set?birds=0');
  const dupBatch = [];
  for (let i = 0; i < 800; i++) dupBatch.push(post(port, '/event', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'd' + (i % 7) }, tool_use_id: 'toolu_dup_' + (i % 7), session_id: 'OWNER' }));
  await Promise.all(dupBatch);
  h = await getJSON(port, '/health');
  ok('birds capped at 5 under spawn flood (7 distinct ids, 800 posts)', h.state.birds.length === 5, `(got ${h.state.birds.length})`);

  // 5) ownership under load — interleave 1000 foreign-session events; owner state must not move
  console.log('· ownership under load — foreign-session events never leak in');
  await post(port, '/claim', { session_id: 'OWNER' }); // resets to idle
  const own = [];
  for (let i = 0; i < 1000; i++) own.push(post(port, '/event', { hook_event_name: 'UserPromptSubmit', prompt: 'this is terrible and broken', session_id: 'INTRUDER_' + (i % 5) }));
  await Promise.all(own);
  h = await getJSON(port, '/health');
  ok('1000 foreign-session events ignored (mood stays idle)', h.state.mood === 'idle', `(got ${h.state.mood})`);
  ok('owner unchanged after foreign flood', h.owner === 'OWNER', '');

  // 6) resilience — malformed + oversized bodies never crash
  console.log('· resilience — malformed + oversized bodies return ok, no crash');
  const postRaw = (path, body) => new Promise((resolve) => { const data = Buffer.from(body); const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': data.length } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(b)); }); req.on('error', () => resolve('ERR')); req.write(data); req.end(); });
  ok('malformed JSON → ok', (await postRaw('/event', '{ not json')) === 'ok');
  ok('huge body (3MB) → ok, no crash', (await postRaw('/event', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'x'.repeat(3_000_000), session_id: 'OWNER' }))) === 'ok');
  h = await getJSON(port, '/health');
  ok('daemon healthy after garbage', !!(h && h.ok), '');
} finally {
  await stop(daemon);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} stress checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
