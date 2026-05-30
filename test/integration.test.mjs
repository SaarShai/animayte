#!/usr/bin/env node
/*
 * animayte — END-TO-END INTEGRATION test.
 *   node test/integration.test.mjs
 *
 * Spins up a REAL daemon on a throwaway port, writes fixture transcript .jsonl
 * files, fires real hook-event JSON at POST /event (and statusline at /status),
 * then asserts the resulting pet state via /health. This exercises the actual
 * code path a live Claude Code session drives.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4399;                       // throwaway, not the user's 4321
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), 'animayte-test-'));

let pass = 0, fail = 0; const fails = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, got, want) { if (got === want) pass++; else { fail++; fails.push(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); } }
function ok(name, cond, extra = '') { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}${extra ? '  ' + extra : ''}`); } }

// build a fixture transcript: assistant turns (with usage) + an optional final agent text
function writeTranscript(name, { tokens = 100_000, model = 'claude-opus-4-8', texts = [] }) {
  const lines = [];
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'earlier turn' }], usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 50, output_tokens: 200 } } }));
  // append the provided agent texts as assistant turns (last one is newest)
  for (const t of texts) lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: t }] } }));
  // a trailing tool_use-only line (realistic: newest line is often not text)
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
  const p = join(TMP, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.text();
}
async function health() { return (await fetch(BASE + '/health').then((r) => r.json())).state; }
async function event(ev) { await post('/event', ev); await sleep(60); return health(); }

// ── boot daemon ───────────────────────────────────────────────────────────
const daemon = spawn('node', ['animayte.mjs'], { cwd: ROOT, env: { ...process.env, ANIMAYTE_PORT: String(PORT) }, stdio: 'ignore' });
let up = false;
for (let i = 0; i < 40; i++) { try { await fetch(BASE + '/health'); up = true; break; } catch { await sleep(100); } }
if (!up) { console.log('❌ daemon failed to start'); daemon.kill(); process.exit(1); }

try {
  console.log('\nEnd-to-end — hook events → pet state\n');

  // 1. SessionStart resets to a fresh, living pet
  let s = await event({ hook_event_name: 'SessionStart', model: 'claude-opus-4-8' });
  check('SessionStart → phase alive', s.phase, 'alive');
  check('SessionStart → birds cleared', s.birds.length, 0);

  // 2. UserPromptSubmit → thinking
  s = await event({ hook_event_name: 'UserPromptSubmit' });
  check('UserPromptSubmit → thinking', s.mood, 'thinking');

  // 3. REAL context % from a fixture transcript (277k / 1M = 28%)
  const tBig = writeTranscript('big.jsonl', { tokens: 277_000, model: 'claude-opus-4-8' });
  s = await event({ hook_event_name: 'PostToolUse', tool_name: 'Read', transcript_path: tBig });
  check('context window size from opus model', s.ctxWindow, 1_000_000);
  check('real ctx% computed (277k/1M)', s.ctxPct, 28);
  ok('fullness ≈ 0.28', Math.abs(s.fullness - 0.277) < 0.01, `(got ${s.fullness})`);

  // 3b. haiku model → 200k window, so same tokens = full
  const tHaiku = writeTranscript('haiku.jsonl', { tokens: 190_000, model: 'claude-haiku-4-5' });
  s = await event({ hook_event_name: 'PostToolUse', tool_name: 'Read', transcript_path: tHaiku });
  check('haiku window = 200k', s.ctxWindow, 200_000);
  ok('haiku 190k/200k ≈ 95%', s.ctxPct >= 94 && s.ctxPct <= 96, `(got ${s.ctxPct})`);

  // 4. SENTIMENT from agent text — the headline feature, end to end
  const sentimentCases = [
    ['🎉 found a great solution!', 'excited'],
    ['✅ all tests pass now', 'happy'],
    ['Sorry, my mistake — let me fix that', 'oops'],
    ['how embarrassing, a rookie mistake on my part', 'embarrassed'],
    ['😳 well, that is mortifying', 'embarrassed'],
    ['the build failed with an exception', 'sad'],
    ['Let me investigate the root cause', 'thinking'],
  ];
  for (const [text, want] of sentimentCases) {
    const tp = writeTranscript(`sent-${want}.jsonl`, { tokens: 120_000, texts: [text] });
    s = await event({ hook_event_name: 'Stop', transcript_path: tp });
    check(`Stop reads agent text "${text.slice(0, 24)}…" → ${want}`, s.mood, want);
  }

  // 4b. neutral-narration-last: emotional line is one BACK, trailing line is neutral.
  // The daemon scans the last ~4 texts and should still find the feeling.
  const tBuried = writeTranscript('buried.jsonl', { tokens: 120_000, texts: ['🎉 huge win, it works!', 'Now let me write that to disk and move on'] });
  s = await event({ hook_event_name: 'Stop', transcript_path: tBuried });
  check('emotion found even when newest line is neutral', s.mood, 'excited');

  // 5. real tool error → sad (bad news, not the agent's own fault)
  s = await event({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { is_error: true, stderr: 'boom' } });
  check('tool error → sad', s.mood, 'sad');

  s = await event({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'command failed: exit 1' });
  check('string error response → sad', s.mood, 'sad');

  // 6. sub-agents → birds (spawn / finish), capped at 5
  await event({ hook_event_name: 'SessionStart' });
  for (let i = 0; i < 7; i++) await event({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'helper ' + i } });
  s = await health();
  check('birds capped at 5', s.birds.length, 5);
  await event({ hook_event_name: 'SubagentStop' });
  s = await health();
  check('SubagentStop removes a bird', s.birds.length, 4);

  // 7. PreCompact → relief: bumps reliefSeq (pets play steam-from-ears) and deflates fullness
  const beforeSeq = (await health()).reliefSeq;
  await post('/event', { hook_event_name: 'PreCompact' });
  await sleep(120);
  s = await health();
  check('PreCompact bumps reliefSeq (steam trigger)', s.reliefSeq, beforeSeq + 1);
  await sleep(2000);  // let the ~1.8s deflation finish
  s = await health();
  ok('PreCompact deflates context toward ~30%', s.fullness <= 0.45, `(got ${s.fullness})`);

  // 8. statusline /status → rich fields + context %
  await post('/status', { model: { display_name: 'Opus' }, context_window: { used_percentage: 42, context_window_size: 1_000_000, total_input_tokens: 420_000 }, cost: { total_cost_usd: 2.5, total_lines_added: 100, total_lines_removed: 10 }, rate_limits: { five_hour: { used_percentage: 55 } }, effort: { level: 'high' }, thinking: { enabled: true } });
  await sleep(60); s = await health();
  check('statusline drives ctx%', s.ctxPct, 42);
  check('statusline cost', s.costUsd, 2.5);
  check('statusline rate limit', s.rateLimitPct, 55);
  check('statusline effort', s.effort, 'high');
  ok('statusline thinking flag', s.thinking === true);

  // 9. negation guard end-to-end: "clean, zero errors" must NOT be sad
  const tNeg = writeTranscript('neg.jsonl', { tokens: 120_000, texts: ['runs clean, zero errors'] });
  s = await event({ hook_event_name: 'Stop', transcript_path: tNeg });
  check('"zero errors" → happy (not sad)', s.mood, 'happy');

  // 10. C6 — PreToolUse tool → state.activeTool category (the daemon also broadcasts a
  // rich 'react' for the gag; thin renderers still get mood='thinking').
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } });
  check('Read → activeTool=read', s.activeTool, 'read');
  check('Read still drives mood=thinking (legacy renderers)', s.mood, 'thinking');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } });
  check('Grep → activeTool=search', s.activeTool, 'search');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} });
  check('Edit → activeTool=edit', s.activeTool, 'edit');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  check('Bash "npm test" → activeTool=test', s.activeTool, 'test');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m wip' } });
  check('Bash "git commit" → activeTool=git', s.activeTool, 'git');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pip install requests' } });
  check('Bash "pip install" → activeTool=install', s.activeTool, 'install');
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la && echo hi' } });
  check('Bash generic → activeTool=run', s.activeTool, 'run');
  s = await event({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: 'ok' });
  check('PostToolUse clears activeTool', s.activeTool, null);
  // Task still spawns a bird and is NOT a tool gag
  await event({ hook_event_name: 'SessionStart' });
  s = await event({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'helper' } });
  check('Task → no tool gag (activeTool stays null)', s.activeTool, null);
  ok('Task spawned a bird', s.birds.length === 1, `(got ${s.birds.length})`);

  // 11. C4 — slow mood drift from a run of events (unique texts dodge the sentiment de-dup)
  await event({ hook_event_name: 'SessionStart' });          // resets the mood meter
  for (let i = 0; i < 5; i++) { const tp = writeTranscript(`msad${i}.jsonl`, { tokens: 120_000, texts: [`build ${i} failed with an error`] }); s = await event({ hook_event_name: 'Stop', transcript_path: tp }); }
  check('a run of errors → moodLabel "stressed"', s.moodLabel, 'stressed');
  ok('moodLevel went negative', s.moodLevel < 0, `(got ${s.moodLevel})`);
  await event({ hook_event_name: 'SessionStart' });          // reset again
  for (let i = 0; i < 6; i++) { const tp = writeTranscript(`mwin${i}.jsonl`, { tokens: 120_000, texts: [`🎉 win ${i} — amazing breakthrough`] }); s = await event({ hook_event_name: 'Stop', transcript_path: tp }); }
  check('a streak of wins → moodLabel "up"', s.moodLabel, 'up');
  ok('moodLevel went positive', s.moodLevel > 0, `(got ${s.moodLevel})`);

} catch (e) {
  fail++; fails.push('  ✗ threw: ' + e.message + '\n' + (e.stack || ''));
} finally {
  daemon.kill();
}

const total = pass + fail;
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass}/${total} checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
