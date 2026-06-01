#!/usr/bin/env node
/*
 * animayte — VIRTUAL-ENVIRONMENT end-to-end test (Route 3 / "the plumbing").
 *   node test/e2e.test.mjs
 *
 * WHY: every other suite feeds the daemon inputs I CONTROL (synthetic POSTs, matching session ids),
 * so it can't catch bugs in the SEAMS between Claude Code and the pet — which is exactly where the
 * real bugs lived (the /compact reinflate; the ownership silent-death where owner ≠ the live session).
 *
 * This stands up a faithful virtual session and wires the REAL components together:
 *   · fires the REAL hook commands FROM hooks.json (curl + stdin piping + the endpoint), port-substituted
 *   · runs the REAL statusline script (bin/animayte-statusline.mjs) with a real CLAUDE_CODE_SESSION_ID
 *   · writes a REAL transcript file the daemon tail-reads for sentiment + context
 *   · runs the REAL daemon (animayte.mjs)
 *   · drives a HEADLESS PET built from the REAL grid/dispatch.mjs + grid/sse.mjs over a LIVE SSE
 *     connection — so we assert the pet actually MOVES, not just that the daemon broadcast something.
 *
 * It then drives a full realistic session and asserts the pet reacts at each step, AND reproduces
 * the ownership failure mode (hooks from a non-owner session must be ignored — and that must be
 * OBSERVABLE, not silent).
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand } from '../grid/dispatch.mjs';
import { createSseSupervisor } from '../grid/sse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => { const tick = (n) => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); }); req.on('error', () => (n <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(n - 1), 100))); req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); }); }; tick(tries); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });

// ── a minimal Node EventSource so the REAL grid/sse.mjs supervisor can run headless ──────────────
class NodeEventSource {
  constructor(url) {
    this.url = url; this.readyState = 0; this.onopen = this.onmessage = this.onerror = null; this._buf = '';
    const u = new URL(url);
    this._req = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
      if (res.statusCode !== 200) { this.readyState = 2; this.onerror && this.onerror(); return; }
      this.readyState = 1; this.onopen && this.onopen();
      res.setEncoding('utf8');
      res.on('data', (c) => {
        this._buf += c; let i;
        while ((i = this._buf.indexOf('\n\n')) >= 0) {
          const frame = this._buf.slice(0, i); this._buf = this._buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line && this.onmessage) this.onmessage({ data: line.slice(6) });
        }
      });
      res.on('end', () => { this.readyState = 2; this.onerror && this.onerror(); });
      res.on('error', () => { this.readyState = 2; this.onerror && this.onerror(); });
    });
    this._req.on('error', () => { this.readyState = 2; this.onerror && this.onerror(); });
  }
  close() { this.readyState = 2; try { this._req.destroy(); } catch {} }
}

// ── the HEADLESS PET: the real dispatch + supervisor driving a mock pet whose state we can read ──
function makeHeadlessPet(port) {
  const state = { awake: false, asleep: false, mood: null, fullness: null, birds: 0, react: null, express: null, say: null };
  const pet = {
    wake() { state.awake = true; state.asleep = false; },
    reset() { state.birds = 0; state.mood = 'idle'; state.express = null; },
    setMood(m) { state.mood = m; }, setFullness(v) { state.fullness = v; },
    addBird() { state.birds++; }, removeBird() { state.birds = Math.max(0, state.birds - 1); }, clearBirds() { state.birds = 0; },
    relief() { state.react = 'relief'; }, reactByName(n) { state.react = n; }, toIdle() { state.react = null; },
    sleep() { state.asleep = true; }, applySpec(s) { state.express = s; },
  };
  const sup = createSseSupervisor({
    url: `http://127.0.0.1:${port}/events`, EventSource: NodeEventSource,
    onMessage: (e) => { try { applyCommand(pet, JSON.parse(e.data), { say: (t) => { state.say = t; } }); } catch {} },
  });
  return { state, sup, reset() { state.react = null; state.say = null; state.express = null; } };
}
// poll the pet state until predicate holds (SSE is async) — returns true if it became true in time
async function waitFor(fn, ms = 1500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); } return fn(); }

// ── fire the REAL hook command out of hooks.json, payload on stdin like CC does ─────────────────
// CC substitutes ${CLAUDE_PLUGIN_ROOT} and the launcher exports ANIMAYTE_PORT; we do the same so the
// node-forwarder posts to OUR ephemeral daemon. (Also handles the legacy literal-:4321 curl form.)
const hooksJson = JSON.parse(read('hooks/hooks.json'));
function fireHook(port, eventName, payload) {
  const entry = hooksJson.hooks[eventName];
  const cmd = entry[0].hooks[0].command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, ROOT)
    .replace(/4321/g, String(port));   // legacy curl form bakes the port literally
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ANIMAYTE_PORT: String(port) } });
    child.on('exit', resolve); child.on('error', resolve);
    child.stdin.write(JSON.stringify(payload)); child.stdin.end();
  });
}
// run the REAL statusline script exactly as CC would (JSON on stdin, session id in env)
function fireStatusline(port, statusJson, sid) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin/animayte-statusline.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port), CLAUDE_CODE_SESSION_ID: sid }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('exit', resolve); child.on('error', resolve);
    child.stdin.write(JSON.stringify(statusJson)); child.stdin.end();
  });
}
const writeTranscript = (texts, tokens = 120_000) => {
  const p = join(tmpdir(), 'animayte-e2e-' + texts.length + '-' + tokens + '.jsonl');
  writeFileSync(p, texts.map((t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: t }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: tokens } } })).join('\n') + '\n');
  return p;
};

console.log('\n· virtual environment — real hooks + statusline + daemon + headless pet (real dispatch/sse)');
// ── PORTABILITY GATE ──────────────────────────────────────────────────────────────────────
// This suite spawns `sh -c` and runs the REAL curl hook command from hooks.json (that fidelity is
// the whole point). A bare windows-latest CI runner often has no POSIX sh on PATH — skip LOUDLY
// there (exit 0) rather than fail spuriously; the daemon seam is covered cross-platform by the
// transport/plugin/integration suites (pure Node).
const hasBin = (bin, args) => { try { return spawnSync(bin, args, { stdio: 'ignore' }).status === 0; } catch { return false; } };
if (!hasBin('sh', ['-c', 'exit 0']) || !hasBin('curl', ['--version'])) {
  console.log('\n· e2e SKIPPED — needs a POSIX sh + curl on PATH (absent on this host: ' + process.platform + '). The daemon seam is covered by transport/plugin/integration (pure Node).');
  process.exit(0);
}

const SID = 'e2e-aaaaaaaa-bbbb-cccc';
const port = await freePort();
const daemon = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port), ANIMAYTE_SESSION: SID }, stdio: 'ignore' });
await waitHealth(port);
const petA = makeHeadlessPet(port);
petA.sup.open();
const connected = await waitFor(() => petA.sup.isLive(), 2000);

try {
  ok('headless pet connects to the daemon over real SSE', connected);

  // ── a full realistic session, every step fired through the REAL hook command ──────────────────
  // 1) SessionStart → wake + reset + greet
  petA.reset();
  await fireHook(port, 'SessionStart', { hook_event_name: 'SessionStart', session_id: SID, model: 'claude-opus-4-8' });
  ok('SessionStart → pet wakes', await waitFor(() => petA.state.awake));
  ok('SessionStart → pet greets (say)', await waitFor(() => !!petA.state.say));

  // 2) user text (praise) → positive emote
  petA.reset();
  await fireHook(port, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'this is amazing, you nailed it!' });
  ok('user praise → pet emotes (mood or express) + speaks', await waitFor(() => (petA.state.mood && petA.state.mood !== 'idle') || petA.state.express || petA.state.say));

  // 3) context window via the REAL statusline script
  await fireStatusline(port, { model: { display_name: 'Opus' }, context_window: { used_percentage: 64, context_window_size: 1_000_000 } }, SID);
  ok('statusline (real script) → fullness tracks context %', await waitFor(() => petA.state.fullness !== null && Math.abs(petA.state.fullness - 0.64) < 0.05), 'fullness=' + petA.state.fullness);

  // 4) tool call → a tool gag
  petA.reset();
  await fireHook(port, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  ok('PreToolUse → pet plays a tool gag (react)', await waitFor(() => !!petA.state.react), 'react=' + petA.state.react);

  // 5) sub-agent → bird appears, then leaves
  petA.reset();
  await fireHook(port, 'PreToolUse', { hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Task', tool_input: { description: 'helper' } });
  ok('Task spawn → a bird appears', await waitFor(() => petA.state.birds >= 1), 'birds=' + petA.state.birds);
  await fireHook(port, 'SubagentStop', { hook_event_name: 'SubagentStop', session_id: SID });
  ok('SubagentStop → the bird leaves', await waitFor(() => petA.state.birds === 0), 'birds=' + petA.state.birds);

  // 6) output text sentiment via a REAL transcript the daemon tail-reads on Stop
  petA.reset();
  const tWin = writeTranscript(['🎉 all tests pass — it works beautifully!']);
  await fireHook(port, 'Stop', { hook_event_name: 'Stop', session_id: SID, transcript_path: tWin });
  ok('Stop → pet reflects assistant-text sentiment', await waitFor(() => (petA.state.mood && petA.state.mood !== 'idle') || petA.state.express), 'mood=' + petA.state.mood);

  // 7) /compact → relief
  petA.reset();
  await fireHook(port, 'PreCompact', { hook_event_name: 'PreCompact', session_id: SID });
  ok('PreCompact → relief reaction', await waitFor(() => petA.state.react === 'relief' || !!petA.state.say));

  // 8) SessionEnd → sleep
  await fireHook(port, 'SessionEnd', { hook_event_name: 'SessionEnd', session_id: SID });
  ok('SessionEnd → pet sleeps', await waitFor(() => petA.state.asleep));

  // ── THE OWNERSHIP FAILURE MODE (the live bug) ─────────────────────────────────────────────────
  // wake + drive the owner so we have a known state, then fire a hook from a DIFFERENT session.
  await fireHook(port, 'SessionStart', { hook_event_name: 'SessionStart', session_id: SID, model: 'claude-opus-4-8' });
  await waitFor(() => petA.state.awake);
  petA.reset();
  const moodBefore = petA.state.mood;
  await fireHook(port, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 'SOME-OTHER-SESSION', prompt: 'this is amazing!' });
  await sleep(250);
  ok('a hook from a NON-OWNER session is ignored (no cross-session bleed)', petA.state.mood === moodBefore && !petA.state.say, 'mood=' + petA.state.mood);

  // …and that rejection must be OBSERVABLE, not silent: /health surfaces a filtered foreign event
  const h = await getJSON(port, '/health');
  ok('the daemon reports it is owned by the live session', h && h.owner === SID);
  ok('a filtered foreign event is OBSERVABLE in /health (not a silent drop)', h && typeof h.filtered === 'number' && h.filtered >= 1, 'filtered=' + (h && h.filtered));

  // and the owner's OWN events still drive the pet (ownership only blocks foreigners)
  petA.reset();
  await fireHook(port, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'great work!' });
  ok("the owner's own events still drive the pet", await waitFor(() => (petA.state.mood && petA.state.mood !== 'idle') || petA.state.express || petA.state.say));

  // doctor must DETECT a stale-owner mismatch (the silent-death made loud). Compare DELTA so the
  // assertion ignores environmental noise (the test daemon runs on a free port, not :4321).
  const { doctor } = await import('../bin/animayte-install.mjs');
  const origLog = console.log; console.log = () => {};                     // silence doctor's printed report
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = SID;            const matched = await doctor({ port });
  process.env.CLAUDE_CODE_SESSION_ID = 'a-stale-other-session'; const mismatched = await doctor({ port });
  if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = saved;
  console.log = origLog;
  ok('doctor flags a stale-owner mismatch (turns the silent death into a loud, fixable error)', mismatched > matched, `matched=${matched} mismatched=${mismatched}`);

  // ── SELF-HEAL — the exact shape of the live incident, now made self-correcting ────────────────
  // A daemon born pinned to a STALE session id that never speaks, while a DIFFERENT live session
  // drives it, must ADOPT the live session instead of sitting dead forever.
  {
    const sp = await freePort();
    const d2 = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(sp), ANIMAYTE_SESSION: 'STALE-dead-session' }, stdio: 'ignore' });
    await waitHealth(sp);
    const pet2 = makeHeadlessPet(sp); pet2.sup.open(); await waitFor(() => pet2.sup.isLive(), 2000);
    const LIVE = 'LIVE-real-session';
    try {
      await fireHook(sp, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: LIVE, prompt: 'hello' });
      await sleep(150);
      let h2 = await getJSON(sp, '/health');
      ok('self-heal: ONE foreign event does NOT flip a stale owner (stray/startup-race guard)', h2.owner === 'STALE-dead-session', 'owner=' + h2.owner);
      await fireHook(sp, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: LIVE, prompt: 'this is amazing!' });
      let adopted = false;
      for (let i = 0; i < 40 && !adopted; i++) { h2 = await getJSON(sp, '/health'); if (h2 && h2.owner === LIVE) adopted = true; else await sleep(50); }
      ok('self-heal: the daemon ADOPTS the live session after it keeps driving (incident is now self-correcting)', adopted, 'owner=' + (h2 && h2.owner));
      ok('self-heal: the pet then reacts to the adopted session', await waitFor(() => (pet2.state.mood && pet2.state.mood !== 'idle') || pet2.state.express || pet2.state.say));
    } finally { pet2.sup.close(); await new Promise((r) => { d2.once('exit', r); d2.kill('SIGTERM'); setTimeout(() => { try { d2.kill('SIGKILL'); } catch {} }, 2000); }); }
  }
  // ── …but an EXPLICITLY CLAIMED owner is authoritative — never auto-overridden (no bleed) ──────
  {
    const lp = await freePort();
    const d3 = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(lp) }, stdio: 'ignore' });
    await waitHealth(lp);
    try {
      await new Promise((res) => { const data = Buffer.from(JSON.stringify({ session_id: 'CLAIMED-owner' })); const req = http.request({ host: '127.0.0.1', port: lp, path: '/claim', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (r) => { r.resume(); r.on('end', res); }); req.on('error', res); req.write(data); req.end(); });
      for (let i = 0; i < 4; i++) await fireHook(lp, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 'INTRUDER', prompt: 'mine now' });
      const h3 = await getJSON(lp, '/health');
      ok('a CLAIMED (locked) owner is NEVER auto-overridden, even by a persistent foreigner', h3.owner === 'CLAIMED-owner', 'owner=' + h3.owner);
      ok('foreign events against a locked owner are still recorded as filtered (observable)', h3.filtered >= 4, 'filtered=' + h3.filtered);
    } finally { await new Promise((r) => { d3.once('exit', r); d3.kill('SIGTERM'); setTimeout(() => { try { d3.kill('SIGKILL'); } catch {} }, 2000); }); }
  }
} finally {
  petA.sup.close();
  await new Promise((resolve) => { daemon.once('exit', resolve); daemon.kill('SIGTERM'); setTimeout(() => { try { daemon.kill('SIGKILL'); } catch {} }, 2000); });
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} e2e checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
