#!/usr/bin/env node
/*
 * animayte — ADOPT-ON-SILENCE test (Route 3 / "the plumbing").
 *   node test/adopt.test.mjs
 *
 * The pet must FOLLOW a session whose id CHANGED (a /clear or --resume mints a NEW uuid that CC
 * exposes no link to — so the launcher's locked claim now points at a dead id and the pet would sit
 * silently dead), WITHOUT ever bleeding two CONCURRENT live sessions into one pet. The rule: a
 * confirmed/locked owner is adoptable-away only after ADOPT_SILENCE_MS of silence — an ACTIVE owner
 * is never silent, so it's never stolen; a changed-id owner goes quiet, so its successor is followed.
 * Runs the real daemon with a SHORT grace window (ANIMAYTE_ADOPT_SILENCE_MS) so the test is fast.
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
async function startDaemon(port, silenceMs) { const c = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port), ANIMAYTE_ADOPT_SILENCE_MS: String(silenceMs) }, stdio: 'ignore' }); await waitHealth(port); return c; }
const stopDaemon = (c) => new Promise((resolve) => { c.once('exit', () => resolve()); c.kill('SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });
const post = (port, path, obj) => new Promise((resolve) => { const data = Buffer.from(JSON.stringify(obj)); const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); }); req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.write(data); req.end(); });
const praise = (sid) => ({ hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'this is amazing, you nailed it!' });

console.log('\n· adopt-on-silence — follow a changed session id, never bleed two concurrent ones');
const SILENCE = 150;   // short grace for the test

// 1) a session whose id CHANGED is auto-followed once the (now-dead) locked owner goes silent
{
  const port = await freePort(); const d = await startDaemon(port, SILENCE);
  try {
    await post(port, '/claim', { session_id: 'OLD_ID' });                                   // launcher claims (locked + alive)
    await post(port, '/event', { hook_event_name: 'UserPromptSubmit', session_id: 'OLD_ID', prompt: 'hi' });
    await sleep(SILENCE + 80);                                                                // OLD_ID is now "dead/silent"
    await post(port, '/event', { hook_event_name: 'SessionStart', session_id: 'NEW_ID', source: 'resume', model: 'claude-opus-4-8' }); // streak 1 (filtered)
    let h = await getJSON(port, '/health');
    ok('one event from the new id does NOT flip yet (streak guard)', h.owner === 'OLD_ID', 'owner=' + h.owner);
    await post(port, '/event', praise('NEW_ID'));                                            // streak 2 → ADOPT, this event then drives the pet
    h = await getJSON(port, '/health');
    ok('the pet auto-follows the changed session id (no longer silently dead)', h.owner === 'NEW_ID', 'owner=' + h.owner);
    ok('the adopted session drives the pet (reacts)', h.state.mood === 'excited' || !!h.state.sentiment, 'mood=' + h.state.mood);
  } finally { await stopDaemon(d); }
}

// 2) two CONCURRENT ACTIVE sessions must NOT bleed — an active owner is never adopted-away
{
  const port = await freePort(); const d = await startDaemon(port, SILENCE);
  try {
    await post(port, '/claim', { session_id: 'SESS_A' });
    for (let i = 0; i < 6; i++) {
      await post(port, '/event', { hook_event_name: 'PreToolUse', session_id: 'SESS_A', tool_name: 'Read', tool_use_id: 'a' + i, tool_input: { file_path: 'x' } }); // A speaks…
      await post(port, '/event', praise('SESS_B'));                                          // …while B hammers praise
      await sleep(40);                                                                        // each loop << the 150ms grace → A never looks silent
    }
    const h = await getJSON(port, '/health');
    ok('the ACTIVE owner is never adopted-away by a second live session', h.owner === 'SESS_A', 'owner=' + h.owner);
    ok("B's praise never lands (no cross-session bleed)", h.state.mood !== 'excited', 'mood=' + h.state.mood);
    ok('B’s events were recorded as filtered (observable)', h.filtered >= 6, 'filtered=' + h.filtered);
  } finally { await stopDaemon(d); }
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} adopt checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
