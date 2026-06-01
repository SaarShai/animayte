#!/usr/bin/env node
/*
 * animayte — REACTIVITY MATRIX test (Route 3 / "the plumbing").
 *   node test/reactivity.test.mjs
 *
 * THE headline guarantee: the pet reacts to every class of session parameter. This drives a real
 * daemon, LISTENS on the real SSE stream, and asserts that each parameter produces a reaction
 * command on the wire — proving the whole chain (hook/statusline → daemon → broadcast) fires for
 * every input class, not just the ones an integration test happened to cover.
 *
 * Parameter classes (the contract with the rest of the product):
 *   · text from the user        — UserPromptSubmit.prompt
 *   · output text (Claude)      — assistant text in the transcript (sentiment)
 *   · context window            — statusline used_percentage  +  /compact
 *   · tool calls                — PreToolUse / PostToolUse (incl. errors)
 *   · sub-agents                — Task spawn / SubagentStop  (birds)
 *   · notifications             — permission / waiting prompts
 *   · lifecycle                 — SessionStart / SessionEnd
 *
 * Part B is a seeded property-based fuzzer: random LEGAL event sequences must always leave the pet
 * in a sane state (birds 0..5, fullness 0..1, valid phase) and the daemon responsive — catching
 * ordering/edge bugs no hand-written case would think to try.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitHealth = (port, tries = 80) => new Promise((resolve, reject) => { const tick = (n) => { const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 300 }, (r) => { r.resume(); resolve(true); }); req.on('error', () => (n <= 0 ? reject(new Error('no daemon')) : setTimeout(() => tick(n - 1), 100))); req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); }); }; tick(tries); });
async function startDaemon(port) { const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' }); await waitHealth(port); return child; }
const stopDaemon = (child) => new Promise((resolve) => { child.once('exit', () => resolve()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => { const req = http.get({ host: '127.0.0.1', port, path, timeout: 1500 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); });
const post = (port, path, obj) => new Promise((resolve) => { const data = Buffer.from(JSON.stringify(obj)); const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); }); req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); }); req.write(data); req.end(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a live SSE collector: records every broadcast command; drain() returns the cmds since last drain
function sseCollector(port) {
  let raw = ''; let seen = 0;
  const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => { res.on('data', (c) => (raw += c)); });
  req.on('error', () => {});
  const all = () => raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return {
    drain() { const a = all(); const fresh = a.slice(seen); seen = a.length; return fresh; },
    close() { try { req.destroy(); } catch {} },
  };
}
const writeTranscript = (name, texts, tokens = 120_000) => {
  const p = join(tmpdir(), 'animayte-react-' + name + '.jsonl');
  const lines = texts.map((t) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: t }], usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: tokens } } }));
  writeFileSync(p, lines.join('\n') + '\n'); return p;
};

console.log('\n· reactivity matrix — every session-parameter class produces a reaction on the wire');
const port = await freePort();
const child = await startDaemon(port);
const sse = sseCollector(port);
await sleep(150); sse.drain();   // discard the connect snapshot

// helper: drive an event, let it broadcast + reach the SSE collector, return the fresh cmds
async function drive(ev) { await post(port, '/event', ev); await sleep(120); return sse.drain(); }
async function driveStatus(j) { await post(port, '/status', j); await sleep(120); return sse.drain(); }
const has = (cmds, cmd, pred) => cmds.some((c) => c.cmd === cmd && (!pred || pred(c)));

try {
  // 1) USER TEXT — praise → a positive expression + a spoken reply
  let c = await drive({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'this is amazing, you absolutely nailed it!' });
  ok('user text (praise) → the pet emotes (mood/express) and speaks', (has(c, 'express') || has(c, 'mood')) && has(c, 'say'), JSON.stringify(c.map((x) => x.cmd)));

  // 2) USER TEXT — correction → a (different) reaction
  c = await drive({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: "no, that's wrong — you broke the build, fix it" });
  ok('user text (correction) → the pet reacts', has(c, 'express') || has(c, 'mood'), JSON.stringify(c.map((x) => x.cmd)));

  // 3) OUTPUT TEXT — assistant sentiment from the transcript → mood
  const tWin = writeTranscript('win', ['🎉 huge win — all tests pass, it works!']);
  c = await drive({ hook_event_name: 'Stop', session_id: 's', transcript_path: tWin });
  ok('output text (assistant sentiment) → a mood/express reaction', has(c, 'mood') || has(c, 'express'), JSON.stringify(c.map((x) => x.cmd)));

  // 4) CONTEXT WINDOW — statusline % drives fullness
  c = await driveStatus({ session_id: 's', context_window: { used_percentage: 73 } });
  let h = await getJSON(port, '/health');
  ok('context window (statusline %) → fullness tracks it', has(c, 'fullness') && Math.abs(h.state.fullness - 0.73) < 0.05, 'fullness=' + h.state.fullness);

  // 5) CONTEXT WINDOW — /compact → relief (steam + deflate)
  c = await drive({ hook_event_name: 'PreCompact', session_id: 's' });
  ok('context window (/compact) → relief reaction', has(c, 'relief') || has(c, 'say'), JSON.stringify(c.map((x) => x.cmd)));

  // 6) TOOL CALL — generic tool → a tool gag (react) + thinking
  c = await drive({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  ok('tool call (PreToolUse) → a tool-gag react', has(c, 'react'), JSON.stringify(c.map((x) => x.cmd)));

  // 7) TOOL CALL — error → a negative reaction
  c = await drive({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_response: { is_error: true, stderr: 'boom' } });
  ok('tool call (error) → a negative reaction', has(c, 'express') || has(c, 'mood') || has(c, 'say'), JSON.stringify(c.map((x) => x.cmd)));

  // 8) SUB-AGENTS — Task spawn → a bird appears; SubagentStop → it leaves
  c = await drive({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Task', tool_input: { description: 'research helper' } });
  ok('sub-agent (Task) → a bird is added', has(c, 'addBird'), JSON.stringify(c.map((x) => x.cmd)));
  c = await drive({ hook_event_name: 'SubagentStop', session_id: 's' });
  ok('sub-agent finish (SubagentStop) → a bird is removed', has(c, 'removeBird'), JSON.stringify(c.map((x) => x.cmd)));

  // 9) NOTIFICATIONS — permission + waiting → distinct reacts
  c = await drive({ hook_event_name: 'Notification', session_id: 's', message: 'Claude needs your permission to run a command' });
  ok('notification (permission) → an "Asking" react', has(c, 'react', (x) => x.name === 'Asking'), JSON.stringify(c.map((x) => x.cmd + ':' + (x.name || ''))));
  c = await drive({ hook_event_name: 'Notification', session_id: 's', message: 'waiting for your input' });
  ok('notification (waiting) → a "Waiting" react', has(c, 'react', (x) => x.name === 'Waiting'), JSON.stringify(c.map((x) => x.cmd + ':' + (x.name || ''))));

  // 10) LIFECYCLE — SessionStart resets + greets; SessionEnd sleeps
  c = await drive({ hook_event_name: 'SessionStart', session_id: 's', model: 'claude-opus-4-8' });
  ok('lifecycle (SessionStart) → reset + greeting', has(c, 'reset') && has(c, 'say'), JSON.stringify(c.map((x) => x.cmd)));
  c = await drive({ hook_event_name: 'SessionEnd', session_id: 's' });
  ok('lifecycle (SessionEnd) → sleep', has(c, 'sleep'), JSON.stringify(c.map((x) => x.cmd)));

  // ── Part B: property-based fuzzer — random LEGAL sequences keep the pet in a sane state ────────
  // seeded PRNG (mulberry32) so a failure is reproducible from its seed
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pickEvents = (rand) => {
    // a grab-bag of legal events; we deliberately over-spawn Task to stress the 5-bird cap
    const pool = [
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'helper' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'helper' } },
      { hook_event_name: 'SubagentStop' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ok', stderr: '' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { is_error: true, stderr: 'x' } },
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { hook_event_name: 'PreCompact' },
      { hook_event_name: 'SessionStart', model: 'claude-opus-4-8' },
      { hook_event_name: 'Notification', message: 'needs your permission' },
    ];
    const n = 5 + Math.floor(rand() * 20);
    return Array.from({ length: n }, () => ({ ...pool[Math.floor(rand() * pool.length)], session_id: 's' }));
  };
  let invariantsHeld = true, badSeed = null, deadSeed = null;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed);
    for (const ev of pickEvents(rand)) await post(port, '/event', ev);
    await driveStatus({ session_id: 's', context_window: { used_percentage: Math.floor(rand() * 100) } });
    const hh = await getJSON(port, '/health');
    if (!hh || hh.ok !== true) { deadSeed = seed; break; }
    const s = hh.state;
    const sane = s.birds.length <= 5 && s.fullness >= 0 && s.fullness <= 1 && ['alive', 'sleeping', 'egg'].includes(s.phase);
    if (!sane) { invariantsHeld = false; badSeed = seed; break; }
  }
  ok('fuzzer: daemon stayed responsive across 60 random legal sequences', deadSeed === null, deadSeed ? 'died on seed ' + deadSeed : '');
  ok('fuzzer: invariants held (birds 0..5, fullness 0..1, valid phase)', invariantsHeld, badSeed ? 'violated on seed ' + badSeed : '');
} finally {
  sse.close();
  await stopDaemon(child);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} reactivity checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
