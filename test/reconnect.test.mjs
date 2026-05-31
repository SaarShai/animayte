#!/usr/bin/env node
/*
 * animayte — SSE RECONNECT test (Route 3 / "the plumbing").
 *   node test/reconnect.test.mjs
 *
 * Proves the daemon's /events stream is reconnect-friendly so the overlay never gets stuck:
 *   · it advertises a retry interval (the browser EventSource auto-reconnects)
 *   · every (re)connection gets a FULL authoritative state snapshot (phase + birds + mood),
 *     so a reconnecting client resyncs instead of keeping stale birds
 *   · after the daemon is killed and restarted on the same port, a new connection succeeds
 *     and receives a fresh snapshot — i.e. the pet recovers on its own.
 *
 * This is the server half of the reconnect story; the client half (the EventSource
 * supervisor) lives in animayte.html / grid/pet.html.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } };

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => {
  const tick = (n) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); });
    req.on('error', () => (n <= 0 ? reject(new Error('daemon never came up on ' + port)) : setTimeout(() => tick(n - 1), 100)));
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
  child.once('exit', () => resolve()); // 'exit' guarantees the port is released before we rebind
  child.kill('SIGTERM');
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
});
const get = (port, path) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: 1000 }, (r) => { r.resume(); r.on('end', resolve); });
  req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
});
// open /events, collect for `ms`, return the raw text + parsed `data:` commands
const collectSSE = (port, ms) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
    let raw = '';
    res.on('data', (c) => (raw += c));
    setTimeout(() => {
      req.destroy();
      const events = raw.split('\n').filter((l) => l.startsWith('data: '))
        .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      resolve({ raw, events });
    }, ms);
  });
  req.on('error', () => resolve({ raw: '', events: [] }));
});

console.log('\n· SSE reconnect — snapshot, resync, recover-after-restart');
const port = await freePort();
let child = await startDaemon(port);
try {
  // 1) first connect → full snapshot + a retry hint
  const first = await collectSSE(port, 350);
  ok('stream advertises a retry interval (auto-reconnect)', /retry:\s*\d+/.test(first.raw));
  const cmds = first.events.map((e) => e.cmd);
  ok('snapshot includes phase (wake/sleep)', cmds.includes('wake') || cmds.includes('sleep'));
  ok('snapshot includes clearBirds (no stale birds on (re)connect)', cmds.includes('clearBirds'));
  ok('snapshot includes fullness', cmds.includes('fullness'));
  ok('snapshot includes mood', cmds.includes('mood'));

  // 2) drive state, then a NEW connection must reflect it (snapshot = live truth)
  await get(port, '/set?birds=2&mood=excited&fullness=0.5');
  const driven = await collectSSE(port, 350);
  const addBirds = driven.events.filter((e) => e.cmd === 'addBird');
  ok('new connection snapshots the 2 live birds', addBirds.length === 2);
  ok('new connection snapshots the live mood', driven.events.some((e) => e.cmd === 'mood' && e.value === 'excited'));
  ok('new connection snapshots the live fullness', driven.events.some((e) => e.cmd === 'fullness' && Math.abs(e.value - 0.5) < 1e-9));

  // 3) kill + restart on the SAME port → a reconnection succeeds with a FRESH snapshot
  await stopDaemon(child);
  const down = await collectSSE(port, 200);
  ok('stream is unavailable while the daemon is down', down.events.length === 0);
  child = await startDaemon(port);
  const recovered = await collectSSE(port, 350);
  ok('reconnect after restart delivers a snapshot', recovered.events.some((e) => e.cmd === 'clearBirds'));
  ok('restarted daemon reports fresh state (no leftover birds)', recovered.events.filter((e) => e.cmd === 'addBird').length === 0);
} finally {
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} reconnect checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
