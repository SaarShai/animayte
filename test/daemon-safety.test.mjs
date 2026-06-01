#!/usr/bin/env node
/*
 * animayte — DAEMON SAFETY test (Route 3 / "the plumbing").
 *   node test/daemon-safety.test.mjs
 *
 * Locks the crash-safety + cross-session-bleed fixes found by the adversarial daemon review:
 *   · a malformed request-target must NOT crash the daemon (a bad `new URL` used to be an unhandled
 *     rejection that exits the process → dead pet for the whole session)
 *   · /claim mid-/compact must cancel the in-flight relief deflate AND reset the rich per-session
 *     readout (ctx%/cost/lines) — otherwise the new owner inherits the old session's numbers and a
 *     dangling timer re-inflates its head
 *   · a stray/duplicate SubagentStop must NOT force mood:'happy' (it carries no tool_use_id, so it's
 *     never deduped)
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => { const tick = (n) => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); }); req.on('error', () => (n <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(n - 1), 100))); req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); }); }; tick(tries); });
async function startDaemon(port) { const c = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' }); await waitHealth(port); return c; }
const stopDaemon = (c) => new Promise((resolve) => { c.once('exit', () => resolve()); c.kill('SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });
const post = (port, path, obj) => new Promise((resolve) => { const data = Buffer.from(JSON.stringify(obj)); const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); }); req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.write(data); req.end(); });
// send a RAW (possibly malformed) request line over a socket; resolve with the status line (or '')
const rawRequest = (port, line) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.on('connect', () => sock.write(line + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
  sock.on('data', (c) => (buf += c));
  sock.on('close', () => resolve(buf.split('\r\n')[0] || ''));
  sock.on('error', () => resolve(''));
  setTimeout(() => { try { sock.destroy(); } catch {} resolve(buf.split('\r\n')[0] || ''); }, 800);
});

console.log('\n· daemon safety — malformed-request survival, /claim cleanup, stray SubagentStop');
const port = await freePort();
let child = await startDaemon(port);
try {
  // 1) a malformed request-target must not crash the daemon
  await rawRequest(port, 'GET /%');                 // `new URL('/%')` throws — must be caught, not fatal
  await rawRequest(port, 'GET /%c0%af..');
  await sleep(150);
  let h = await getJSON(port, '/health');
  ok('daemon survives a malformed request-target (no crash)', !!h && h.ok === true);

  // 2) /claim mid-/compact cancels the relief deflate AND resets the rich per-session readout
  await getJSON(port, '/set?fullness=0.85');
  await post(port, '/status', { session_id: 's1', context_window: { used_percentage: 77 }, cost: { total_cost_usd: 9.99, total_lines_added: 1234, total_lines_removed: 567 } });
  // (no owner yet, so the status is accepted) — confirm the rich readout is populated
  h = await getJSON(port, '/health');
  const hadRich = h.state.costUsd > 0 || h.state.ctxPct > 0;
  await post(port, '/event', { hook_event_name: 'PreCompact', session_id: 's1' });   // relief deflate starts
  await post(port, '/claim', { session_id: 's2' });                                   // transfer mid-relief
  await sleep(1900);   // let any DANGLING relief interval finish (it would drive fullness back to 0.30)
  h = await getJSON(port, '/health');
  ok('/claim precondition: the old session had a rich readout', hadRich);
  ok('/claim cancels the in-flight relief (head stays empty, not re-inflated to 0.30)', h.state.fullness < 0.1, 'fullness=' + h.state.fullness);
  ok('/claim resets the rich readout (no cost/ctx bleed to the new owner)', h.state.costUsd === 0 && h.state.ctxPct === 0 && h.state.linesAdded === 0, `cost=${h.state.costUsd} ctx=${h.state.ctxPct} +${h.state.linesAdded}`);

  // 3) a stray SubagentStop (0 birds, never deduped) must not force mood:'happy'
  await post(port, '/claim', { session_id: 's3' });   // freshStart → mood idle, 0 birds
  await post(port, '/event', { hook_event_name: 'SubagentStop', session_id: 's3' });
  await sleep(120);
  h = await getJSON(port, '/health');
  ok('a stray SubagentStop on 0 birds does NOT force mood:happy', h.state.mood !== 'happy', 'mood=' + h.state.mood);
} finally {
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} daemon-safety checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
