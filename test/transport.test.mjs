#!/usr/bin/env node
/*
 * animayte — TRANSPORT / robustness test (Route 3 / "the plumbing").
 *   node test/transport.test.mjs
 *
 * Hardening the HTTP/SSE surface against the failure modes that bite this product class but that
 * the behavioural suites never exercise:
 *   · SSE header contract — a regression to a non-200 status, a non-event-stream content-type, or a
 *     204 would (per the SSE spec) make the browser STOP reconnecting → a permanently dead pet that
 *     no human would notice. Locked here.
 *   · path traversal — the static-file server must never serve a file outside its own directory,
 *     across encodings (the cross-platform / security gap).
 *   · slow-client backpressure — a stalled pet window (socket buffer full, not yet errored) must be
 *     dropped, not buffered forever (unbounded RSS → OOM on an old/constrained machine).
 *   · malformed input — half-valid JSON must not wedge the daemon or corrupt state.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => {
  const tick = (n) => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); }); req.on('error', () => (n <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(n - 1), 100))); req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); }); };
  tick(tries);
});
async function startDaemon(port, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port), ...extraEnv }, stdio: 'ignore' });
  await waitHealth(port); return child;
}
const stopDaemon = (child) => new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });
// raw GET returning {status, headers, body} — needed to inspect the SSE handshake + traversal
const rawGet = (port, path, { read = true } = {}) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: 1200 }, (r) => {
    let b = ''; if (read) { r.on('data', (c) => (b += c)); }
    // for streams, resolve on first chunk (don't wait for end, it never comes)
    if (r.headers['content-type'] && r.headers['content-type'].includes('event-stream')) { setTimeout(() => { req.destroy(); resolve({ status: r.statusCode, headers: r.headers, body: b }); }, 150); }
    else { r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }
  });
  req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
  req.on('timeout', () => { req.destroy(); resolve({ status: -1, headers: {}, body: '' }); });
});
const postRaw = (port, path, body) => new Promise((resolve) => {
  const data = Buffer.from(body); const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }); req.on('error', () => resolve({ status: 0 })); req.on('timeout', () => { req.destroy(); resolve({ status: -1 }); }); req.write(data); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n· transport — SSE header contract, path traversal, slow-client backpressure, malformed input');

// ── A. SSE header contract ────────────────────────────────────────────────────────────────────
{
  const port = await freePort(); const child = await startDaemon(port);
  try {
    const r = await rawGet(port, '/events');
    ok('/events returns 200 (not 204 — 204 makes EventSource STOP reconnecting)', r.status === 200, 'status=' + r.status);
    ok('/events content-type is text/event-stream', (r.headers['content-type'] || '').includes('text/event-stream'), r.headers['content-type']);
    ok('/events advertises a retry interval (auto-reconnect)', /retry:\s*\d+/.test(r.body), JSON.stringify(r.body.slice(0, 40)));
  } finally { await stopDaemon(child); }
}

// ── B. path traversal — never serve outside the daemon's own directory ─────────────────────────
{
  const port = await freePort(); const child = await startDaemon(port);
  try {
    const attempts = ['/../../../../etc/passwd', '/..%2f..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/animayte.mjs', '/grid/../../../etc/passwd'];
    let leaked = null;
    for (const p of attempts) {
      const r = await rawGet(port, p);
      if (r.status === 200 && /root:.*:0:0:/.test(r.body)) { leaked = p; break; }
    }
    ok('static server never serves a file outside its root (path traversal)', leaked === null, leaked ? 'LEAKED via ' + leaked : '');
    // a legit in-root file still serves (proves the guard isn't over-blocking)
    const good = await rawGet(port, '/grid/pet.html');
    ok('a legitimate in-root file still serves', good.status === 200 && /<html/i.test(good.body));
  } finally { await stopDaemon(child); }
}

// ── C. slow-client backpressure — drop a stalled consumer, don't buffer forever ────────────────
{
  const port = await freePort();
  const child = await startDaemon(port, { ANIMAYTE_SLOW_BUFFER: '4096' });   // tiny cap so the test is fast
  try {
    // open a raw SSE client and NEVER read it (pause): its socket buffer fills, write() goes to backpressure
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((res) => sock.on('connect', res));
    sock.write('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
    sock.pause();                                   // the crucial bit: consumer never drains
    await sleep(150);
    let h = await getJSON(port, '/health');
    ok('slow client is connected before the flood', h && h.clients >= 1, 'clients=' + (h && h.clients));
    // flood big broadcasts (each ~2KB say) until we blow past the OS buffer + the 4KB cap
    const big = 'x'.repeat(2000);
    for (let i = 0; i < 500; i++) { http.get({ host: '127.0.0.1', port, path: '/set?say=' + big }).on('error', () => {}); if (i % 50 === 0) await sleep(8); }
    // poll for the daemon to drop the stalled client (and stay responsive throughout)
    let dropped = false;
    for (let i = 0; i < 40; i++) { h = await getJSON(port, '/health'); if (h && h.clients === 0) { dropped = true; break; } await sleep(50); }
    ok('daemon drops the stalled slow client (no unbounded buffering)', dropped, 'final clients=' + (h && h.clients));
    ok('daemon stays responsive while a slow client is flooded', !!h && h.ok === true);
    try { sock.destroy(); } catch {}
  } finally { await stopDaemon(child); }
}

// ── D. malformed input never wedges the daemon or corrupts state ───────────────────────────────
{
  const port = await freePort(); const child = await startDaemon(port);
  try {
    await postRaw(port, '/event', '{"hook_event_name":"PostToolUse","tool_response":');   // half-valid JSON
    await postRaw(port, '/event', 'not json at all');
    await postRaw(port, '/event', '');
    await postRaw(port, '/status', '{"context_window":');
    const h = await getJSON(port, '/health');
    ok('daemon still responds after malformed bodies', !!h && h.ok === true);
    ok('malformed bodies leave state uncorrupted (still idle/fresh)', !!h && h.state && h.state.fullness === 0 && Array.isArray(h.state.birds));
  } finally { await stopDaemon(child); }
}

// ── E. EADDRINUSE — the daemon must NOT crash if the port is briefly taken (the `restart` race) ──
//    On restart the just-killed daemon may still hold the port for a moment; animayte.mjs retries
//    listen() a few times instead of dying. Occupy the port, spawn the daemon, free the port within
//    the retry window, and assert it recovers and serves — rather than exiting on the first bind error.
{
  const port = await freePort();
  const blocker = net.createServer(() => {});
  await new Promise((res) => blocker.listen(port, '127.0.0.1', res));
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' });
  let died = false; child.once('exit', () => { died = true; });
  await sleep(600);                                  // daemon is mid-retry (8×250ms ≈ 2s window)
  ok('daemon does not crash on EADDRINUSE (still retrying)', died === false);
  await new Promise((res) => blocker.close(res));    // free the port
  let recovered = false;
  for (let i = 0; i < 30; i++) { const h = await getJSON(port, '/health'); if (h && h.ok) { recovered = true; break; } await sleep(100); }
  ok('daemon binds once the port frees (retry safety net)', recovered);
  await stopDaemon(child);
}

// ── F. SECURITY — localhost is not a trust boundary (DNS-rebinding / cross-site CSRF) ───────────
const reqH = (port, path, { method = 'GET', headers = {} } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 1200 }, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode, acao: r.headers['access-control-allow-origin'] })); });
  req.on('error', () => resolve({ status: 0 })); req.on('timeout', () => { req.destroy(); resolve({ status: -1 }); }); req.end();
});
{
  const port = await freePort(); const child = await startDaemon(port);
  try {
    const same = await reqH(port, '/health', { headers: { Origin: `http://127.0.0.1:${port}` } });
    ok('same-origin /health works + reflects the origin', same.status === 200 && same.acao === `http://127.0.0.1:${port}`, 'acao=' + same.acao);
    ok('a no-Origin client (curl/node) is unaffected', (await reqH(port, '/health')).status === 200);
    const cross = await reqH(port, '/health', { headers: { Origin: 'http://evil.example' } });
    ok('a cross-origin reader gets NO Access-Control-Allow-Origin (can’t read /health)', cross.status === 200 && !cross.acao, 'acao=' + cross.acao);
    ok('a foreign Host is rejected — 421 (DNS-rebinding defense)', (await reqH(port, '/health', { headers: { Host: 'evil.example' } })).status === 421);
    const before = (await getJSON(port, '/health')).owner;
    ok('a cross-site POST /claim is blocked (403)', (await reqH(port, '/claim', { method: 'POST', headers: { Origin: 'http://evil.example', 'content-type': 'application/json' } })).status === 403);
    ok('the blocked /claim did NOT change ownership', (await getJSON(port, '/health')).owner === before);
    ok('a cross-site GET /set (Image/no-cors) is blocked via Sec-Fetch-Site (403)', (await reqH(port, '/set?mood=excited', { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);
  } finally { await stopDaemon(child); }
}
// ── G. SSE client cap — bound concurrent connections (connection-exhaustion DoS) ─────────────────
{
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port), ANIMAYTE_MAX_CLIENTS: '2' }, stdio: 'ignore' });
  await waitHealth(port);
  const socks = [];
  const openSSE = () => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); socks.push(s); let buf = ''; s.on('connect', () => s.write(`GET /events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)); s.on('data', (c) => { buf += c; if (buf.includes('\r\n')) res(buf.split('\r\n')[0]); }); s.on('error', () => res('')); setTimeout(() => res(buf.split('\r\n')[0] || ''), 700); });
  try {
    const s1 = await openSSE(); const s2 = await openSSE(); await sleep(200);
    const s3 = await openSSE();   // exceeds the cap of 2
    ok('first two SSE connections accepted (200)', /200/.test(s1) && /200/.test(s2), `s1=${s1} s2=${s2}`);
    ok('the connection past the cap is refused (503)', /503/.test(s3), 's3=' + s3);
  } finally { for (const s of socks) { try { s.destroy(); } catch {} } await stopDaemon(child); }
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} transport checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
