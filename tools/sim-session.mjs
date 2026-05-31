#!/usr/bin/env node
/*
 * animayte · sim-session — drive the LIVE daemon through a realistic Claude Code session
 * over the real transport (HTTP), so you can WATCH the floating pet go through a full arc.
 *
 *   node tools/sim-session.mjs                  # claims a sim session, ~40s arc
 *   node tools/sim-session.mjs --fast           # quicker
 *   ANIMAYTE_PORT=4321 node tools/sim-session.mjs
 *
 * Unlike tools/simulate.mjs (offline state-machine replay), this POSTs REAL-shaped hook +
 * statusline JSON to the running daemon — including a growing transcript file so the body
 * fills for real — exercising the exact path a real session takes. Great for a screen demo
 * and for manually confirming the pet reacts to the active session.
 */
import http from 'node:http';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.ANIMAYTE_PORT) || 4321;
const FAST = process.argv.includes('--fast');
const SID = (process.argv.find((a) => a.startsWith('--session=')) || '').split('=')[1] || 'sim-' + process.pid;
const scale = FAST ? 0.4 : 1;
const wait = (ms) => new Promise((r) => setTimeout(r, ms * scale));

const tx = join(mkdtempSync(join(tmpdir(), 'animayte-sim-')), 'transcript.jsonl');
writeFileSync(tx, '');
let tokens = 0, seq = 0;
function say(text, addTokens = 0) { // append an assistant turn (text + growing usage) to the transcript
  tokens += addTokens;
  appendFileSync(tx, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], usage: { input_tokens: Math.round(tokens * 0.4), cache_read_input_tokens: Math.round(tokens * 0.6) } } }) + '\n');
}

function send(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 2000 }, (r) => { r.resume(); r.on('end', resolve); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(data); req.end();
  });
}
const ev = (extra) => send('/event', { session_id: SID, transcript_path: tx, cwd: process.cwd(), ...extra });
const tool = (hook, name, extra = {}) => ev({ hook_event_name: hook, tool_name: name, tool_use_id: 'toolu_sim_' + ++seq, ...extra });
const status = (pct, cost) => send('/status', { session_id: SID, model: { display_name: 'Opus 4.8' }, context_window: { used_percentage: pct, context_window_size: 1_000_000, total_input_tokens: Math.round(pct / 100 * 1e6) }, cost: { total_cost_usd: cost } });

async function health() { return new Promise((res) => { const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1000 }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }

const log = (m) => console.log('  · ' + m);

(async () => {
  const h = await health();
  if (!h || !h.ok) { console.error(`\nanimayte daemon not reachable on :${PORT} — start it first:  bin/animayte start\n`); process.exit(1); }
  console.log(`\n🎬 simulating a live session into the pet (:${PORT}, session "${SID}")\n   watch the floating pet — this claims the pet for the sim, then runs a full arc.\n`);

  await send('/claim', { session_id: SID });                                  log('SessionStart — the pet wakes');
  await ev({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-4-8' }); await wait(1600);

  await ev({ hook_event_name: 'UserPromptSubmit', prompt: 'this is brilliant, exactly what I wanted!' }); log('user praises it → proud/excited + blush'); await wait(2600);

  say('Let me read the project files.', 40_000);
  await tool('PreToolUse', 'Read'); log('reading files → 👓 working, body starts to fill'); await wait(900);
  await tool('PostToolUse', 'Read', { tool_response: 'ok' }); await status(6, 0.04); await wait(1400);

  say('Now writing the fix.', 60_000);
  await tool('PreToolUse', 'Edit'); log('editing → ✏️ scribbles'); await wait(900);
  await tool('PostToolUse', 'Edit', { tool_response: 'ok' }); await status(12, 0.09); await wait(1400);

  for (const d of ['search docs', 'write tests', 'refactor']) { await tool('PreToolUse', 'Task', { tool_input: { description: d } }); await wait(500); }
  log('spawned 3 sub-agents → 3 birds orbit'); await wait(1800);
  for (let i = 0; i < 3; i++) { await ev({ hook_event_name: 'SubagentStop', agent_type: 'general' }); await wait(500); }
  log('sub-agents finished → birds fly off'); await wait(1200);

  await tool('PreToolUse', 'Bash', { tool_input: { command: 'npm test' } }); await wait(900);
  await tool('PostToolUse', 'Bash', { tool_response: { is_error: true, stderr: 'build failed' } }); log('a tool error → 😟 worried wince (recovers)'); await wait(2400);

  say('Fixed it — all tests pass now! ✅', 520_000);
  await tool('PostToolUse', 'Read', { tool_response: 'ok' }); await status(70, 1.2); log('big win + context ~70% → swollen happy body'); await wait(2600);

  await ev({ hook_event_name: 'PreCompact' }); log('/compact → 😮‍💨 deflate + steam'); await wait(2600);

  say('All done — anything else?');
  await ev({ hook_event_name: 'Stop' }); log('turn ends → settles, then looks around for you'); await wait(1500);

  const f = await health();
  console.log(`\n✅ sim complete. final pet state: mood ${f?.state?.mood}, ctx ${f?.state?.ctxPct}%, birds ${f?.state?.birds?.length}.`);
  console.log(`   (re-run your real session's  bin/animayte start  to hand the pet back to it.)\n`);
})();
