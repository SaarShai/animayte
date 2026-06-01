#!/usr/bin/env node
/*
 * animayte — sub-agent (sidechain) leak test (Route 3 / "the plumbing").
 *   node test/sidechain.test.mjs
 *
 * THE BUG — Claude Code interleaves SUB-AGENT turns into the SAME transcript file as the main
 * thread, tagged `"isSidechain": true` at the top level of the JSONL line (main-thread turns
 * carry `"isSidechain": false`). readTranscriptTail scans the tail newest→oldest for the newest
 * `usage` (context %) and newest assistant text (sentiment). It did NOT check isSidechain, so a
 * sub-agent's turn — being the newest lines — would drive the MAIN pet: a research sub-agent
 * saying "this is broken" makes the top-level pet look sad, and the sub-agent's small usage
 * deflates the body mid-session. The fix: skip `isSidechain === true` lines in readTranscriptTail.
 *
 * This suite drives the REAL daemon over HTTP against a REAL-shaped fixture
 * (test/fixtures/sidechain-leak.jsonl), like compact.test.mjs.
 *
 * Ground truth in the fixture (oldest→newest; the scan reads the newest line first):
 *   · MAIN turn      (isSidechain:false): usage total 800,000 (= 80% of a 1M opus window),
 *                                          text "all tests pass … green … looks good"  → happy
 *   · SUB-AGENT user (isSidechain:true) : the sub-agent's prompt (no usage)
 *   · SUB-AGENT turn (isSidechain:true) : usage total 40,000 (= 4%), the NEWEST line,
 *                                          text "completely broken … failed … nothing works" → sad
 *
 * What must hold (all RED against the pre-fix daemon, GREEN after):
 *   1. BODY — fullness/ctxPct track the MAIN-thread ~80%, NOT the sub-agent ~4%.
 *   2. FACE — mood/sentiment are NOT driven by the sub-agent's negative text (it must not read
 *             'sad'); the MAIN-thread positive turn drives the face instead.
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
// POST a body and WAIT for the response — /event finishes processing (awaits the queued handler)
// before replying, so daemon state is settled by the time this resolves (no racey sleeps).
const post = (port, path, obj) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify(obj));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); });
  req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
  req.write(data); req.end();
});
// reset the daemon to a fresh, low-fullness state between cases (freshStart zeroes fullness)
const reset = (port) => post(port, '/claim', {});
const stopEvent = (fixture) => ({ hook_event_name: 'Stop', session_id: 'test-sess', transcript_path: FIX(fixture) });

console.log('\n· sidechain — a sub-agent turn must NOT drive the MAIN pet (body or face)');
const port = await freePort();
let child = await startDaemon(port);
try {
  await reset(port);
  let h = await health(port);
  ok('precondition: reset leaves the head empty', h.state.fullness < 0.05, 'fullness=' + h.state.fullness);

  // A Stop fires after a turn that interleaved a sub-agent. The newest transcript lines are the
  // sub-agent's (4% usage, "completely broken"); the main turn underneath is 80% + "all tests pass".
  await post(port, '/event', stopEvent('sidechain-leak.jsonl'));
  h = await health(port);

  // 1) BODY — fullness must follow the MAIN turn (~80%), not the sub-agent's small ~4% usage.
  ok('BODY: fullness tracks the MAIN-thread ~80%, not the sub-agent ~4%', near(h.state.fullness, 0.80, 0.05), 'fullness=' + h.state.fullness);
  ok('BODY: ctxPct ≈ 80 (not ~4)', near(h.state.ctxPct, 80, 5), 'ctxPct=' + h.state.ctxPct);

  // 2) FACE — the sub-agent's negative text must NOT set the mood/sentiment to sad…
  ok('FACE: mood is NOT driven by the sidechain negative text', h.state.mood !== 'sad', 'mood=' + h.state.mood);
  ok('FACE: sentiment is NOT the sidechain "sad"', h.state.sentiment !== 'sad', 'sentiment=' + h.state.sentiment);
  // …and the MAIN-thread positive turn is what drives the face.
  ok('FACE: the MAIN-thread positive turn drives the face (happy)', h.state.mood === 'happy', 'mood=' + h.state.mood);
} finally {
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} sidechain checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
