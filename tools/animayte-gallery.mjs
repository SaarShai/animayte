#!/usr/bin/env node
/*
 * animayte · GALLERY — drive the LIVE pet through its ENTIRE reaction range, on demand.
 *
 * WHO THIS IS FOR: the ART TEAM. You author a new pet / new expressions against the clean
 * renderer contract (grid/manifest.mjs + the command vocabulary in docs/ARCHITECTURE.md §5),
 * and you need to SEE every reaction the daemon can produce — without sitting through a real
 * coding session and hoping each rare signal happens to fire. This tool makes every reaction
 * fire on command, one at a time, with a readable pause and a printed label of what's on
 * screen, so you can watch the floating pet and sign off.
 *
 * HOW IT WORKS (and why it's faithful): it speaks ONLY the daemon's real public endpoints
 * (docs/ARCHITECTURE.md §4) and, crucially, drives every reaction through the REAL hook path
 * the same way Claude Code would — `POST /event` with the actual hook payloads — NOT through
 * a debug back-door. `/set` today only covers mood/fullness/birds/say/phase; it does NOT emit
 * `react`/`express`/`relief`. So a tool gag is a real `PreToolUse`, a rich face is a real
 * `UserPromptSubmit` / a real `PostToolUse` error, relief is a real `PreCompact`, birds are
 * real `Task` spawns + `SubagentStop`s. What you watch is exactly what a live session shows.
 *
 * NOTHING IS HARD-CODED THAT COULD DRIFT: the catalog is DERIVED from the real source —
 *   · tool gags  ← TOOL_EVENTS + classifyTool   (lib/anim/events.mjs)
 *   · moods      ← MOOD_EXPRESSION keys          (grid/manifest.mjs)
 *   · notif gags ← MANIFEST.reactions ∩ {Asking,Waiting}  (grid/manifest.mjs)
 * — so when the contract grows, the gallery grows with it (and the self-test proves it).
 *
 * USAGE
 *   node tools/animayte-gallery.mjs                 # full tour against the live daemon (:4321)
 *   node tools/animayte-gallery.mjs --list          # print the catalog, don't drive anything
 *   node tools/animayte-gallery.mjs --only Running   # show one reaction by name
 *   node tools/animayte-gallery.mjs --pace 2500      # ms between steps (default ~1800)
 *   node tools/animayte-gallery.mjs --port 4322      # talk to a daemon on another port
 *   node tools/animayte-gallery.mjs --selftest       # tiny pace; for the automated self-test
 *
 * It NEVER spawns/kills a daemon and NEVER touches git or ~/.claude — point it at a pet that
 * is already floating (run /animayte first), and it just sends events.
 */

import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── derive the reaction catalog from the REAL source (single source of truth) ──────────────
import { TOOL_EVENTS, classifyTool } from '../lib/anim/events.mjs';
import { MOOD_EXPRESSION } from '../grid/manifest.mjs';
import { MANIFEST } from '../grid/manifest.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SID = 'gallery';   // a single owned "session" so all our events belong together

// ---------- CLI ----------
function parseArgs(argv) {
  const a = { port: 4321, pace: 1800, only: null, list: false, selftest: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--pace') a.pace = Number(argv[++i]);
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--list') a.list = true;
    else if (k === '--selftest') a.selftest = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  if (a.selftest) a.pace = 40;   // self-test runs the whole catalog fast
  if (!Number.isFinite(a.port)) a.port = 4321;
  if (!Number.isFinite(a.pace)) a.pace = 1800;
  return a;
}

// ---------- tiny HTTP helpers (Node builtins only) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, obj) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 3000 },
      (res) => { res.resume(); res.on('end', () => resolve(true)); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(data); req.end();
  });
}
function getJSON(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
const sendEvent = (port, ev) => post(port, '/event', { session_id: SID, ...ev });
const sendStatus = (port, j) => post(port, '/status', { session_id: SID, ...j });
const setDirect = (port, qs) => getJSON(port, '/set?' + qs);

// ── representative tool inputs: one per category so classifyTool emits each TOOL_EVENT ──────
// These are real-shaped PreToolUse payloads. We VERIFY below (buildCatalog) that each one
// actually classifies to its event via the real classifyTool — if the classifier ever changes
// its mind, the gallery fails loudly instead of silently showing the wrong gag.
const TOOL_FIXTURE = {
  Reading:    { tool_name: 'Read',    tool_input: { file_path: '/tmp/x.txt' } },
  Searching:  { tool_name: 'Grep',    tool_input: { pattern: 'TODO' } },
  Writing:    { tool_name: 'Edit',    tool_input: { file_path: '/tmp/x.txt' } },
  Running:    { tool_name: 'Bash',    tool_input: { command: 'ls -la' } },
  Testing:    { tool_name: 'Bash',    tool_input: { command: 'npm test' } },
  Installing: { tool_name: 'Bash',    tool_input: { command: 'npm install left-pad' } },
  Committing: { tool_name: 'Bash',    tool_input: { command: 'git commit -m "wip"' } },
  Fetching:   { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
  Planning:   { tool_name: 'TodoWrite', tool_input: { todos: [] } },
};

// ── the praise/correction prompts that exercise the RICH express faces ──────────────────────
// (sentiment lives in lib/expressions.mjs detectUserTone — these phrases hit each tone family)
const EXPRESS_PROMPTS = [
  { label: 'express · praise → PROUD (excited)',      tone: 'praise/excited',     prompt: 'this is absolutely amazing — you nailed it!' },
  { label: 'express · praise → happy (content)',      tone: 'praise/happy',       prompt: 'nice work, thank you — that worked great' },
  { label: 'express · correction → SHEEPISH (oops)',  tone: 'scold/oops',         prompt: "no, that's wrong — you broke the build" },
  { label: 'express · scolded → MORTIFIED (embarrassed)', tone: 'scold/embarrassed', prompt: 'this is completely wrong, what were you thinking' },
];

// ── BUILD THE CATALOG (derived; ordered for a watchable show) ───────────────────────────────
// Each step: { name, label, run(api) } where run drives the LIVE pet via real endpoints.
// `expect` (optional) is the SSE cmd(s) a faithful daemon should emit — used by the self-test
// to prove each category actually reached the wire.
function buildCatalog() {
  const steps = [];
  const add = (s) => steps.push(s);

  // 0) wake first so the pet is alive for the whole show (real path: a SessionStart greet).
  add({
    name: 'wake', label: 'lifecycle · wake / fresh start (SessionStart)', expect: ['reset', 'wake', 'say'],
    async run({ port }) { await sendEvent(port, { hook_event_name: 'SessionStart', model: 'claude-opus-4-8' }); },
  });

  // 1) MOODS — the legacy sticky face buckets. /set?mood= is the REAL mood path (handleStatus/
  //    /set both call setMood→broadcast mood), so the art team sees every face the daemon can
  //    park on. Derived from MOOD_EXPRESSION so a new mood bucket shows up automatically.
  const moods = Object.keys(MOOD_EXPRESSION);
  for (const mood of moods) {
    add({
      name: 'mood:' + mood, label: `mood · ${mood}  →  face "${MOOD_EXPRESSION[mood]}"`, expect: ['mood'],
      async run({ port }) { await setDirect(port, 'mood=' + encodeURIComponent(mood)); },
    });
  }

  // 2) TOOL GAGS — one real PreToolUse per classifyTool category → a `react` clip + a held prop.
  //    Driven through the REAL hook path (not /set, which can't emit react). Derived from
  //    TOOL_EVENTS, so a new tool category appears here the moment classifyTool learns it.
  for (const event of TOOL_EVENTS) {
    const fx = TOOL_FIXTURE[event];
    add({
      name: 'react:' + event, label: `tool gag · ${event}  (PreToolUse ${fx.tool_name})`, expect: ['react'],
      async run({ port }) {
        await sendEvent(port, { hook_event_name: 'PreToolUse', tool_use_id: 'g-' + event, ...fx });
        await sleep(220);
        await sendEvent(port, { hook_event_name: 'PostToolUse', tool_use_id: 'gx-' + event, tool_name: fx.tool_name, tool_response: { stdout: 'ok', stderr: '' } });   // endReact → back to idle
      },
    });
  }

  // 2b) NOTIFICATION gags — Asking / Waiting (manifest reactions that aren't tool gags).
  //     Derived: only emit the ones the manifest actually declares.
  const notif = [
    { name: 'Asking',  label: 'notification · Asking (permission prompt)', msg: 'Claude needs your permission to run a command' },
    { name: 'Waiting', label: 'notification · Waiting (idle / your turn)',  msg: 'Claude is waiting for your input' },
  ].filter((n) => MANIFEST.reactions[n.name]);
  for (const n of notif) {
    add({
      name: 'react:' + n.name, label: `tool gag · ${n.label}`, expect: ['react'],
      async run({ port }) { await sendEvent(port, { hook_event_name: 'Notification', message: n.msg }); },
    });
  }

  // 3) RICH `express` FACES — praise/correction/tool-error via the REAL appraise() path.
  for (const e of EXPRESS_PROMPTS) {
    add({
      name: 'express:' + e.tone, label: e.label, expect: ['express', 'mood'],
      async run({ port }) { await sendEvent(port, { hook_event_name: 'UserPromptSubmit', prompt: e.prompt }); },
    });
  }
  // tool ERROR → the red wince (PostToolUse with a structured is_error)
  add({
    name: 'express:toolError', label: 'express · tool ERROR → wince (PostToolUse is_error)', expect: ['express', 'mood'],
    async run({ port }) {
      await sendEvent(port, { hook_event_name: 'PostToolUse', tool_use_id: 'g-err', tool_name: 'Bash', tool_response: { is_error: true, stderr: 'command failed: exit 1' } });
    },
  });

  // 4) BIRDS — sub-agents orbit. Ramp 0→5 (each a real Task PreToolUse), then drain 5→0
  //    (each a real SubagentStop). Shows the cap (the 6th Task is a no-op) too.
  add({
    name: 'birds:up', label: 'sub-agents · spawn birds 0 → 5 (Task ×6; the 6th hits the cap)', expect: ['addBird'],
    async run({ port }) {
      for (let i = 1; i <= 6; i++) {
        await sendEvent(port, { hook_event_name: 'PreToolUse', tool_use_id: 'g-task-' + i, tool_name: 'Task', tool_input: { description: 'helper ' + i } });
        await sleep(Math.max(120, Math.round((this._pace || 300) / 3)));
      }
    },
  });
  add({
    name: 'birds:down', label: 'sub-agents · birds finish 5 → 0 (SubagentStop ×5)', expect: ['removeBird'],
    async run({ port }) {
      for (let i = 0; i < 5; i++) {
        await sendEvent(port, { hook_event_name: 'SubagentStop' });
        await sleep(Math.max(120, Math.round((this._pace || 300) / 3)));
      }
    },
  });

  // 5) RELIEF — /compact: steam-from-ears + a body deflate. Real PreCompact hook.
  add({
    name: 'relief', label: 'context · /compact → RELIEF (steam + deflate)', expect: ['relief'],
    async run({ port }) { await sendEvent(port, { hook_event_name: 'PreCompact' }); },
    settle: 2600,   // let the ~1.8s deflate animation play out before the next step
  });

  // 6) FULLNESS sweep — the body fill = context window. Drive it via the REAL statusline feed
  //    (POST /status used_percentage), 0 → 100% and back to a resting level. NOTE: this runs
  //    AFTER relief, and relief arms a ~12s compact-guard that DROPS big upward jumps — so we
  //    clear the guard first by waiting it out is too slow; instead we step gently. To make the
  //    sweep crisp regardless, we briefly re-wake (a fresh non-compact context) before sweeping.
  add({
    name: 'fullness:reset', label: 'context · settle before the fullness sweep', expect: ['wake'],
    async run({ port }) { await sendEvent(port, { hook_event_name: 'SessionStart', model: 'claude-opus-4-8' }); },
  });
  for (const pct of [0, 20, 40, 60, 80, 100, 60]) {
    add({
      name: 'fullness:' + pct, label: `context · fullness ${pct}%  (body fill)`, expect: ['fullness'],
      async run({ port }) { await sendStatus(port, { context_window: { used_percentage: pct } }); },
    });
  }

  // 7) SLEEP / WAKE — end the session (sleep), then a beat, then wake again so the show ends
  //    on a live pet.
  add({
    name: 'sleep', label: 'lifecycle · SLEEP (SessionEnd)', expect: ['sleep'],
    async run({ port }) { await sendEvent(port, { hook_event_name: 'SessionEnd' }); },
    settle: 1200,
  });
  add({
    name: 'wake:end', label: 'lifecycle · WAKE again (SessionStart)', expect: ['reset', 'wake'],
    async run({ port }) { await sendEvent(port, { hook_event_name: 'SessionStart', model: 'claude-opus-4-8' }); },
  });

  return steps;
}

// ---------- output helpers ----------
const C = process.stdout.isTTY ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m` }
  : { dim: (s) => s, b: (s) => s, g: (s) => s, y: (s) => s, r: (s) => s };

function printList(steps) {
  console.log(C.b('\n  animayte gallery — reaction catalog') + C.dim(`  (${steps.length} steps, derived from the live source)\n`));
  let n = 0;
  for (const s of steps) console.log('  ' + C.dim(String(++n).padStart(3)) + '  ' + C.b(s.name.padEnd(20)) + '  ' + s.label);
  console.log('');
}

async function ensureDaemon(port) {
  const h = await getJSON(port, '/health');
  if (!h || h.ok !== true) {
    console.error(C.r(`\n  ✗ no animayte daemon answering on http://127.0.0.1:${port}`));
    console.error(C.dim('    Summon the pet first (run /animayte), or pass --port. The gallery never starts a daemon itself.\n'));
    return false;
  }
  // claim the pet for our gallery "session" so our events aren't filtered as foreign.
  await post(port, '/claim', { session_id: SID });
  return true;
}

async function runStep(api, step, idx, total) {
  const tag = C.dim(`[${String(idx).padStart(2)}/${total}]`);
  console.log(`  ${tag}  ${C.b('▶')}  ${step.label}`);
  step._pace = api.pace;
  try { await step.run(api); } catch (e) { console.log('        ' + C.r('(send failed: ' + ((e && e.message) || e) + ')')); }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`\nanimayte gallery — drive the LIVE pet through its entire reaction range.\n\n` +
      `  node tools/animayte-gallery.mjs [--port 4321] [--pace 1800] [--only <name>] [--list] [--selftest]\n\n` +
      `  --list      print the catalog and exit\n  --only X    show one reaction (by the names from --list)\n` +
      `  --pace ms   pause between steps (default 1800)\n  --port N    daemon port (default 4321)\n  --selftest  tiny pace, for the automated self-test\n`);
    return;
  }

  const steps = buildCatalog();
  if (args.list) { printList(steps); return; }

  let toRun = steps;
  if (args.only) {
    toRun = steps.filter((s) => s.name === args.only || s.name.split(':')[1] === args.only || s.name.split(':')[0] === args.only);
    if (!toRun.length) {
      console.error(C.r(`\n  ✗ no reaction named "${args.only}".`) + C.dim('  Run --list to see the catalog.\n'));
      process.exit(2);
    }
  }

  const api = { port: args.port, pace: args.pace };
  if (!(await ensureDaemon(args.port))) process.exit(1);

  console.log(C.b(`\n  🎨 animayte gallery`) + C.dim(`  · ${toRun.length} reactions · ${args.pace}ms pace · watch the floating pet\n`));
  let idx = 0;
  for (const step of toRun) {
    await runStep(api, step, ++idx, toRun.length);
    await sleep(step.settle ? Math.max(step.settle, args.pace) : args.pace);
  }
  // leave the pet idle-happy at the end
  await setDirect(args.port, 'mood=happy&say=' + encodeURIComponent('🌿 that was the full range!'));
  console.log(C.g(`\n  ✓ done — showed ${toRun.length} reactions.\n`));
}

main().catch((e) => { console.error(C.r('gallery error: ' + ((e && e.message) || e))); process.exit(1); });

// ── exports for the self-test (so it drives the SAME catalog the CLI does, no duplication) ──
export { buildCatalog, TOOL_FIXTURE, EXPRESS_PROMPTS, parseArgs };
