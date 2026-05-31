#!/usr/bin/env node
/*
 * animayte — PLUGIN PLUMBING test (Route 3).
 *   node test/plugin.test.mjs
 *
 * Covers the pieces the unit tests don't: the `doctor` diagnosis branches, the statusline
 * script's forward-and-print, and the `bin/animayte` bash dispatch (install/doctor/uninstall).
 * Everything runs against a throwaway settings file + an ephemeral daemon — never ~/.claude.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor, installToFile } from '../bin/animayte-install.mjs';

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
    req.on('error', () => (n <= 0 ? reject(new Error('no daemon on ' + port)) : setTimeout(() => tick(n - 1), 100)));
    req.on('timeout', () => { req.destroy(); n <= 0 ? reject(new Error('timeout')) : setTimeout(() => tick(n - 1), 100); });
  };
  tick(tries);
});
async function startDaemon(port) {
  const child = spawn(process.execPath, [join(ROOT, 'animayte.mjs')], { env: { ...process.env, ANIMAYTE_PORT: String(port) }, stdio: 'ignore' });
  await waitHealth(port);
  return child;
}
const stop = (child) => new Promise((r) => { if (!child) return r(); child.once('exit', () => r()); child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000); });
const getJSON = (port, path) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path, timeout: 1000 }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});
const post = (port, path, body) => new Promise((resolve) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 1000 }, (r) => { r.resume(); r.on('end', resolve); });
  req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
  req.write(data); req.end();
});
// run a child process, feed stdin, collect stdout + exit code
const run = (cmd, args, env, input) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => resolve({ code, out, err }));
  if (input != null) child.stdin.write(input);
  child.stdin.end();
});
// capture doctor()'s console output (it prints one multi-line block)
async function runDoctor(port) {
  const lines = []; const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let problems;
  try { problems = await doctor({ port }); } finally { console.log = orig; }
  return { problems, text: lines.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'animayte-plugin-'));
const port = await freePort();
let daemon = null;

try {
  // ---- doctor: daemon DOWN, no global install ----
  console.log('\n· doctor — daemon down');
  {
    const settings = join(dir, 'down.json');
    process.env.ANIMAYTE_SETTINGS = settings; // empty/missing → no global hooks
    const { problems, text } = await runDoctor(port);
    ok('flags the daemon as unreachable', /daemon is not reachable/.test(text));
    ok('reports at least one problem', problems >= 1);
  }

  // ---- doctor: installed + daemon UP, but no session events yet ----
  console.log('· doctor — daemon up, idle (no real events)');
  {
    const settings = join(dir, 'idle.json');
    await installToFile(settings, { port, repoRoot: ROOT });
    process.env.ANIMAYTE_SETTINGS = settings;
    daemon = await startDaemon(port);
    const { text } = await runDoctor(port);
    ok('sees the global hook install', /hooks installed globally/.test(text));
    ok('sees the daemon is up', /daemon is up/.test(text));
    ok('does NOT falsely claim a live session when idle', /no recent session events/.test(text) && !/a live session is driving/.test(text));
  }

  // ---- doctor: a real hook event arrives → now it IS live ----
  console.log('· doctor — a real session is driving');
  {
    await post(port, '/event', { hook_event_name: 'UserPromptSubmit', prompt: 'hello there' });
    const { problems, text } = await runDoctor(port);
    ok('now reports a live session driving the pet', /a live session is driving the pet/.test(text));
    ok('all clear (0 problems) when up + installed + live', problems === 0);
  }

  // ---- statusline: forwards to /status AND prints a compact line ----
  console.log('· statusline — forward + print');
  {
    const statusJSON = JSON.stringify({
      model: { display_name: 'Opus 4.8' },
      context_window: { used_percentage: 42, context_window_size: 1_000_000, total_input_tokens: 420_000 },
      cost: { total_cost_usd: 1.23 },
    });
    const r = await run(process.execPath, [join(ROOT, 'bin', 'animayte-statusline.mjs')], { ANIMAYTE_PORT: String(port) }, statusJSON);
    ok('statusline prints the model', /Opus 4\.8/.test(r.out));
    ok('statusline prints the context %', /ctx 42%/.test(r.out));
    ok('statusline prints the cost', /\$1\.23/.test(r.out));
    await new Promise((res) => setTimeout(res, 150)); // let the fire-and-forget POST land
    const h = await getJSON(port, '/health');
    ok('daemon received the forwarded status (ctx% updated)', h && h.state && h.state.ctxPct === 42);
    ok('daemon picked up the model from statusline', h && h.state && /Opus 4\.8/.test(h.state.model || ''));
  }

  // ---- bin/animayte bash dispatch: install → doctor → uninstall ----
  console.log('· bin/animayte — CLI dispatch (install / doctor / uninstall)');
  {
    const settings = join(dir, 'cli.json');
    const env = { ANIMAYTE_SETTINGS: settings, ANIMAYTE_PORT: String(port) };
    const bin = join(ROOT, 'bin', 'animayte');
    const ins = await run(bin, ['install'], env);
    ok('`bin/animayte install` exits 0', ins.code === 0);
    ok('install wrote 9 animayte hook groups', existsSync(settings) &&
      Object.values(JSON.parse(readFileSync(settings, 'utf8')).hooks).flat().filter((g) => g.hooks.some((h) => h.command.includes('#animayte'))).length === 9);
    const doc = await run(bin, ['doctor'], env);
    ok('`bin/animayte doctor` exits 0 when healthy', doc.code === 0);
    ok('doctor output mentions the daemon', /daemon is up/.test(doc.out));
    const un = await run(bin, ['uninstall'], env);
    ok('`bin/animayte uninstall` exits 0', un.code === 0);
    ok('uninstall removed every animayte hook group', !/#animayte/.test(readFileSync(settings, 'utf8')));
  }

  // ---- session ownership: the pet follows ONE session, ignores other concurrent ones ----
  console.log('· session ownership — one session drives the pet, others are ignored');
  {
    await post(port, '/claim', { session_id: 'SESS_A' });
    let h = await getJSON(port, '/health');
    ok('claim sets the owner', h && h.owner === 'SESS_A');
    ok('claim resets the pet to idle', h && h.state.mood === 'idle');

    await post(port, '/event', { hook_event_name: 'UserPromptSubmit', prompt: 'this is amazing, you nailed it!', session_id: 'SESS_B' });
    h = await getJSON(port, '/health');
    ok('a praise event from ANOTHER session is ignored (mood unchanged)', h.state.mood === 'idle');

    await post(port, '/event', { hook_event_name: 'UserPromptSubmit', prompt: 'this is amazing, you nailed it!', session_id: 'SESS_A' });
    h = await getJSON(port, '/health');
    ok("the OWNER's praise event takes effect", h.state.mood === 'excited');

    await post(port, '/claim', { session_id: 'SESS_C' });
    h = await getJSON(port, '/health');
    ok('re-claim transfers ownership to a new session', h.owner === 'SESS_C');
  }
} finally {
  await stop(daemon);
  delete process.env.ANIMAYTE_SETTINGS;
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} plugin-plumbing checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
