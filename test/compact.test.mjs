#!/usr/bin/env node
/*
 * animayte — /compact context test (Route 3 / "the plumbing").
 *   node test/compact.test.mjs
 *
 * WHY THIS EXISTS — a methodology fix. The earlier unit tests fed the daemon SYNTHETIC payloads
 * shaped the way I *assumed* Claude Code writes them, so they were green while a real bug shipped:
 * right after `/compact` the pet jumped back to a near-full head. The cause only shows up against a
 * REAL transcript — so this suite drives the real daemon over HTTP against fixtures that are
 * verbatim lines copied out of an actual session transcript (test/fixtures/*.jsonl), including the
 * real `{"type":"system","subtype":"compact_boundary"}` marker.
 *
 * Ground truth captured from the fixture lines:
 *   · pre-compact assistant turns report  usage total ≈ 830,763 tokens  (~83% of a 1M opus window)
 *   · the compact_boundary system entry sits between them and the continuation
 *   · the first post-compact assistant turn reports usage total ≈ 39,739 tokens (~4%)
 *
 * What must hold:
 *   1. CONTROL  — a transcript whose newest usage is the real 830k and NO boundary ⇒ pet reads ~83%
 *      (proves the daemon really does surface a near-full head; the fix didn't just zero everything).
 *   2. GAP      — pre-compact usage + boundary + (no new turn yet) ⇒ the pet must NOT read 830k
 *      across the boundary. This is the actual bug: it used to re-inflate to ~83%.
 *   3. RECOVERED— boundary + the real 39k post-compact turn ⇒ pet reads ~4%.
 *   4. GUARD    — after a PreCompact relief deflate, a STALE 83% statusline (a lagging render) must
 *      not snap the head back up; a true low % still applies.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = (n) => join(ROOT, 'test', 'fixtures', n);
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => {
  const tick = (n) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); });
    req.on('error', () => (n <= 0 ? reject(new Error('daemon never came up')) : setTimeout(() => tick(n - 1), 100)));
    req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('health timeout')) : setTimeout(() => tick(n - 1), 100); });
  };
  tick(tries);
});
async function startDaemon(port) {
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' });
  await waitHealth(port);
  return child;
}
const stopDaemon = (child) => new Promise((resolve) => {
  child.once('exit', () => resolve());
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
});
const getJSON = (port, path) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => {
    let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});
const health = (port) => getJSON(port, '/health');
// POST a body and WAIT for the response — /event and /status both finish processing before replying,
// so the daemon state is settled by the time this resolves (no racey sleeps).
const post = (port, path, obj) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify(obj));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); });
  req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
  req.write(data); req.end();
});
// reset the daemon to a fresh, low-fullness state between cases (freshStart zeroes fullness)
const reset = (port) => post(port, '/claim', {});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stopEvent = (fixture) => ({ hook_event_name: 'Stop', session_id: 'test-sess', transcript_path: FIX(fixture) });

console.log('\n· /compact — read REAL transcript fixtures, respect the compaction boundary');
const port = await freePort();
let child = await startDaemon(port);
try {
  // 1) CONTROL — real near-full transcript, no boundary ⇒ the pet genuinely reads ~83%
  await reset(port);
  await post(port, '/event', stopEvent('full-no-compact.jsonl'));
  let h = await health(port);
  ok('CONTROL: near-full transcript (830k) drives the head to ~83%', near(h.state.fullness, 0.83, 0.03), 'fullness=' + h.state.fullness);
  ok('CONTROL: ctxPct ≈ 83', near(h.state.ctxPct, 83, 3), 'ctxPct=' + h.state.ctxPct);

  // 2) GAP — boundary present, no post-compact turn yet ⇒ must NOT read the pre-compact 830k.
  //    This is the regression the user caught: the head used to snap back to ~83% right after /compact.
  await reset(port);
  h = await health(port);
  ok('GAP precondition: reset leaves the head empty', h.state.fullness < 0.05, 'fullness=' + h.state.fullness);
  await post(port, '/event', stopEvent('compact-gap.jsonl'));
  h = await health(port);
  ok('GAP: a read across the boundary does NOT re-inflate the head', h.state.fullness < 0.1, 'fullness=' + h.state.fullness);

  // 3) RECOVERED — boundary + the real first post-compact turn (39k) ⇒ ~4%
  await reset(port);
  await post(port, '/event', stopEvent('compact-recovered.jsonl'));
  h = await health(port);
  ok('RECOVERED: post-compact usage (39k) reads ~4%', near(h.state.fullness, 0.04, 0.03), 'fullness=' + h.state.fullness);

  // 4) GUARD — relief deflate, then a STALE 83% statusline must not snap the head back up
  await reset(port);
  await getJSON(port, '/set?fullness=0.85');                            // simulate a full session
  await post(port, '/event', { hook_event_name: 'PreCompact', session_id: 'test-sess' }); // relief: 0.85 → 0.30
  await wait(2200);                                                     // let the ~1.8s deflate finish (still inside the 12s guard)
  h = await health(port);
  ok('GUARD precondition: relief deflated the head to ~0.30', near(h.state.fullness, 0.30, 0.06), 'fullness=' + h.state.fullness);
  await post(port, '/status', { session_id: 'test-sess', context_window: { used_percentage: 83 } }); // stale pre-compact %
  h = await health(port);
  ok('GUARD: a stale 83% statusline does NOT re-inflate within the guard window', h.state.fullness < 0.4, 'fullness=' + h.state.fullness);
  await post(port, '/status', { session_id: 'test-sess', context_window: { used_percentage: 4 } });  // the true low %
  h = await health(port);
  ok('GUARD: a true low % still applies (head can always deflate)', near(h.state.fullness, 0.04, 0.03), 'fullness=' + h.state.fullness);
} finally {
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} compact checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
