#!/usr/bin/env node
/*
 * animayte daemon — zero-dependency Node server (Node 18+).
 *
 *  - serves the pet UI (animayte.html)        at  http://127.0.0.1:4321
 *  - accepts Claude Code hook events           at  POST /event    (hook JSON)
 *  - accepts Claude Code statusline JSON        at  POST /status   (rich session snapshot)
 *  - streams pet "commands" to the browser      at  GET  /events   (SSE)
 *  - exposes the full live session state        at  GET  /health   (the Swift/Tk pets poll this)
 *
 * Context % is REAL: computed from the transcript's last `usage` object
 * (input + cache_creation + cache_read) / context-window-size, and/or taken
 * directly from the statusline's context_window.used_percentage.
 */
import http from 'node:http';
import { readFile, open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { detectMood } from './lib/sentiment.mjs';           // still used by the /detect endpoint
import { appraise } from './lib/appraise.mjs';              // Route 1: signal → FeatureSpec (the translation layer)
import { classifyTool } from './lib/anim/events.mjs';
import { createMoodMeter } from './lib/anim/mood.mjs';
import { loadConfig } from './lib/anim/config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.ANIMAYTE_PORT ? Number(process.env.ANIMAYTE_PORT) : 4321;

// ---- persisted config (C7): env vars still win at runtime ----
const cfg = loadConfig();

// ---- live session state (everything the pet can reflect graphically) ----
const state = {
  phase: 'alive', mood: 'idle', fullness: 0, birds: [] /* {id,label} */,
  pet: process.env.ANIMAYTE_PET || cfg.pet,             // which pet pack to load (pets/<pet>/)
  personality: process.env.ANIMAYTE_PERSONALITY || cfg.personality,  // re-weights idle/reaction (C3)
  sound: cfg.sound, volume: cfg.volume,                 // SFX infra (C5) — OFF unless config enables it
  activeTool: null,                            // current tool category (read/search/edit/run/test/install/git) — C6
  // rich signals (see docs/session-signals.md):
  model: null, ctxPct: 0, ctxTokens: 0, ctxWindow: 0,
  costUsd: 0, linesAdded: 0, linesRemoved: 0,
  rateLimitPct: 0, effort: null, thinking: false,
  moodLevel: 0, moodLabel: 'level',            // slow-moving mood drift (C4): up / level / stressed
  reliefSeq: 0, updated: Date.now(),
  lastEventAt: 0,                              // last REAL hook/statusline arrival (0 = never) — doctor's "is a session driving?" signal
};
const moodMeter = createMoodMeter();
let birdSeq = 1;
const clients = new Set();

// ---- session ownership (reliable connection) ----
// Every Claude Code session in a repo POSTs to the same daemon, so without this the pet
// shows a BLEND of all concurrent sessions. The session that summons the pet (bin/animayte
// → POST /claim with CLAUDE_CODE_SESSION_ID) becomes the owner; events/status from any other
// session_id are ignored until a different session claims. No owner set ⇒ accept all (the
// single-session default).
let ownerSession = process.env.ANIMAYTE_SESSION || null;
// Once a session owns the pet, require a MATCHING session_id — a payload with no session_id must
// NOT slip through (that would silently re-open the cross-session bleed). No owner ⇒ accept all.
const ownsEvent = (sid) => !ownerSession || sid === ownerSession;

function broadcast(cmd) {
  const line = `data: ${JSON.stringify(cmd)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }  // drop dead sockets
}
// Full, authoritative state sync sent to every (re)connecting client. After a daemon
// restart the server's state is fresh (0 birds, idle), so we clearBirds + re-set phase,
// fullness and mood — otherwise a client that reconnects keeps stale birds/mood (a "stuck
// pet"). Every command here is idempotent, so this is safe on the first connect too.
function snapshotTo(res) {
  const send = (cmd) => { try { res.write(`data: ${JSON.stringify(cmd)}\n\n`); } catch {} };
  send({ cmd: state.phase === 'sleeping' ? 'sleep' : 'wake' });
  send({ cmd: 'clearBirds' });
  for (const b of state.birds) send({ cmd: 'addBird', label: b.label });
  send({ cmd: 'fullness', value: state.fullness });
  send({ cmd: 'mood', value: state.mood });
  send({ cmd: 'moodLevel', value: state.moodLevel, label: state.moodLabel });
}

const setMood     = (value, ms) => { state.mood = value; state.updated = Date.now(); broadcast({ cmd: 'mood', value, ms }); applyMoodDrift(value); };
// C4 — feed the slow mood meter; broadcast only when the LABEL crosses (up/level/stressed)
function applyMoodDrift(moodId) {
  const before = state.moodLabel;
  moodMeter.feel(moodId);
  state.moodLevel = Math.round(moodMeter.level * 100) / 100;
  state.moodLabel = moodMeter.label;
  if (state.moodLabel !== before) broadcast({ cmd: 'moodLevel', value: state.moodLevel, label: state.moodLabel });
}
const setFullness = (v) => {
  const nv = Math.max(0, Math.min(1, v));
  const changed = Math.abs(nv - state.fullness) >= 0.004;   // skip broadcasting imperceptible/no-op changes
  state.fullness = nv; state.updated = Date.now();
  if (changed) broadcast({ cmd: 'fullness', value: nv });
};

// /compact relief: bump reliefSeq (pets play steam-from-ears), then deflate the head over ~1.8s.
// While relieving, transcript-fullness updates are skipped so the deflation reads cleanly.
let reliefActive = false;
let reliefTimer = null;
function triggerRelief() {
  state.reliefSeq++;
  broadcast({ cmd: 'relief' });
  say('😮‍💨 phew — compacted!', 3500);
  reliefActive = true;
  if (reliefTimer) clearInterval(reliefTimer);
  const from = state.fullness, to = 0.30, t0 = Date.now();
  reliefTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / 1800);
    setFullness(from + (to - from) * k);
    if (k >= 1) { clearInterval(reliefTimer); reliefTimer = null; reliefActive = false; setMood('happy', 1600); }
  }, 80);
}
const addBird     = (label) => { if (state.birds.length >= 5) return; state.birds.push({ id: birdSeq++, label }); broadcast({ cmd: 'addBird', label }); };
const removeBird  = () => { const b = state.birds.shift(); if (b) broadcast({ cmd: 'removeBird' }); };
const hatch       = () => { if (state.phase !== 'alive') { state.phase = 'alive'; broadcast({ cmd: 'wake' }); } };
const say         = (text, ms) => broadcast({ cmd: 'say', text, ms });
const sleepPet    = () => { if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; } state.phase = 'sleeping'; broadcast({ cmd: 'sleep' }); };
const freshStart  = () => { state.phase = 'alive'; state.birds = []; state.fullness = 0; state.mood = 'idle'; moodMeter.reset(); state.moodLevel = 0; state.moodLabel = 'level'; broadcast({ cmd: 'reset' }); };

// context window size by model (2026): haiku=200k, opus/sonnet 4.x = 1M. Statusline overrides this.
function windowFor(model) {
  const m = String(model || state.model || '').toLowerCase();
  if (/haiku/.test(m)) return 200_000;
  if (/opus|sonnet/.test(m)) return 1_000_000;
  return state.ctxWindow || 200_000;
}

// Tail-read the transcript once, returning BOTH the real context usage and the
// newest assistant text (for sentiment). One read, two signals.
let lastSentimentText = '';
let waitTimer = null;   // pending "looking around for the user" glance after a turn ends
async function readTranscriptTail(path) {
  try {
    if (!path) return null;
    const { size } = await stat(path);
    const start = Math.max(0, size - 512 * 1024);
    const fh = await open(path, 'r');
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    const lines = buf.toString('utf8').split('\n');
    let usage = null, model = null;
    const recentTexts = [];   // newest-first; a few real assistant texts (skip tool_use-only lines)
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim(); if (!l) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const msg = o.message || o;
      const isAssistant = msg && (msg.role === 'assistant' || o.type === 'assistant');
      if (!usage && msg && msg.usage) { usage = msg.usage; model = msg.model || o.model || state.model; }
      if (isAssistant && Array.isArray(msg.content)) {
        const t = msg.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ').trim();
        if (t && recentTexts.length < 4) recentTexts.push(t);
      }
      if (usage && recentTexts.length >= 4) break;
    }
    // newest text is what's "current"; but for emotion we want the most recent text that ACTUALLY carries one
    const text = recentTexts[0] || null;
    let ctx = null;
    if (usage) {
      const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      const win = windowFor(model);
      if (model) state.model = model;
      ctx = { tokens, win, pct: Math.min(1, tokens / win) };
    }
    return { ctx, text, recentTexts };
  } catch {}
  return null;
}

// Was this tool call an ERROR? Only a STRUCTURED flag is reliable: Claude Code's Bash
// tool_response has no exit code and ALWAYS carries an (often empty) "stderr" key, and normal
// output routinely contains words like "error"/"failed" (grep, logs, test summaries). Inferring
// an error from the response shape or text produced a constant false "😟 hit a snag" after every
// command. MCP/real tool errors set `is_error: true`; everything else defers to the agent's own
// words (the sentiment path), which is where a Bash failure naturally surfaces ("that didn't work").
function isErrorResponse(ev) {
  const r = ev.tool_response;
  if (!r) return false;
  if (Array.isArray(r)) return r.some((b) => b && b.is_error === true);
  // OBJECT responses (Bash, Read, …) ALWAYS carry an (often empty) "stderr" key and normal output
  // routinely contains "error"/"failed" — so trust ONLY the structured flag, never the shape/text.
  if (typeof r === 'object') return r.is_error === true;
  // a STRING response that IS an error message (rare; most tools return objects) — word-boundaried.
  if (typeof r === 'string') return /\b(error|failed|exception|traceback|denied)\b/i.test(r);
  return false;
}

// Translation now lives in lib/appraise.mjs (Route 1). The daemon is transport (Route 3):
// it builds a SIGNAL, calls appraise() → a FeatureSpec, and broadcasts it. RECENCY-FIRST
// text selection + cause/intensity/expectedness all happen inside appraise().
let lastValence = 0;
// TRANSITIONAL BRIDGE (Goal #5). abstract item (prop) → the legacy reaction the current
// renderers understand. The `express` cmd below already carries spec.item, so once Art's
// renderer exposes pet.applySpec (the overlays wire `case 'express': pet.applySpec(spec)`
// guarded), retiring this is a one-liner: delete REACTION_FOR_ITEM + the `react` broadcast
// marked RETIRE below. Until every renderer consumes the spec, we must send both.
const REACTION_FOR_ITEM = { hammer: 'Writing', terminal: 'Running', magnifier: 'Searching', globe: 'Fetching', lightbulb: 'Planning' };

function applySpec(spec, ms = 3000) {
  if (!spec) return false;
  const key = spec.expression + '|' + String(spec._text || spec.reason).slice(0, 40);
  if (key === lastSentimentText) return true;        // already reacted to this exact feeling
  lastSentimentText = key;
  lastValence = spec.valence;
  state.sentiment = spec.expression;
  setMood(spec.expression, ms);                      // legacy mood cmd — current renderers react
  if (spec.item && REACTION_FOR_ITEM[spec.item]) broadcast({ cmd: 'react', name: REACTION_FOR_ITEM[spec.item] });  // RETIRE with the bridge
  const { _text, ...clean } = spec;
  broadcast({ cmd: 'express', spec: clean });        // the full FeatureSpec for spec-aware renderers (already authoritative)
  return true;
}
// agent's own recent words → a FeatureSpec (recency-first inside appraise)
function applySentiment(recentTexts, ms = 3000) {
  return applySpec(appraise({ recentTexts }, { valence: lastValence }), ms);
}

// De-dup: a hook can be registered in two places (project settings AND the plugin) and we
// MEASURED Claude Code delivering the same event twice (its command-string dedup doesn't span
// plugin↔settings here). Tool events carry a unique `tool_use_id`, so we drop a repeat of the
// same (event, tool_use_id) — precise, version-tolerant, and it never touches events without an
// id, so legitimate repeats (e.g. two SubagentStops) are unaffected.
const seenTool = new Map();
let lastStatusCtxAt = 0;   // when the statusline last gave an authoritative context % (transcript estimate yields to it)
function isDuplicateTool(name, ev) {
  if (name !== 'PreToolUse' && name !== 'PostToolUse') return false;
  const id = ev.tool_use_id;
  if (!id) return false;
  const key = name + ':' + id;
  if (seenTool.has(key)) return true;
  seenTool.set(key, Date.now());
  // hard cap (Map keeps insertion order) — evict the oldest half so memory stays bounded under any load
  if (seenTool.size > 1024) { let drop = seenTool.size - 512; for (const k of seenTool.keys()) { if (drop-- <= 0) break; seenTool.delete(k); } }
  return false;
}

// Serialize event handling: concurrent /event POSTs (parallel tool use) would otherwise
// interleave their awaited transcript reads and let a STALE context/sentiment land after a
// fresher one. Chaining through one promise keeps state mutations strictly in arrival order.
let evQueue = Promise.resolve();
const enqueueEvent = (ev) => (evQueue = evQueue.then(() => handleEvent(ev)).catch(() => {}));

// ---- hook event -> pet behavior (+ real context + sentiment from agent text) ----
async function handleEvent(ev) {
  const name = ev.hook_event_name || '';
  state.lastEventAt = Date.now();   // a real hook arrived → a live session is driving us (doctor reads this)
  if (isDuplicateTool(name, ev)) return;  // drop a double-delivered tool event
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }  // any event = activity resumed; cancel the pending wait-glance
  // Only the text/context events read the transcript — keeps PreToolUse and other high-frequency
  // events I/O-free (context only changes on assistant messages, which these two reflect).
  let tail = null;
  if (name === 'PostToolUse' || name === 'Stop') {
    tail = await readTranscriptTail(ev.transcript_path);
    // the transcript estimate yields to a fresh authoritative statusline % (avoids the two fighting)
    if (tail && tail.ctx && !reliefActive && Date.now() - lastStatusCtxAt > 8000) { state.ctxTokens = tail.ctx.tokens; state.ctxWindow = tail.ctx.win; state.ctxPct = Math.round(tail.ctx.pct * 100); setFullness(tail.ctx.pct); }
  }

  switch (name) {
    case 'SessionStart':     if (ev.model) state.model = ev.model; freshStart(); setMood('happy', 2500); say('👋 hi! a new session'); break;
    case 'UserPromptSubmit': {
      hatch();
      // react to HOW the user spoke to the pet — praise makes it proud, a correction sheepish
      const spec = appraise({ userText: ev.prompt || '' }, { valence: lastValence });
      if (spec && spec.cause === 'user') {
        applySpec(spec, 3200);
        if (spec.valence > 0) say(spec.expression === 'excited' ? '🤩 aw — thank you!' : '😊 aw, thanks!');
        else say(spec.expression === 'embarrassed' ? '🙈 sorry — let me fix that' : '😅 my bad — on it');
      } else { setMood('thinking'); say('👀 reading your request…'); }
      break;
    }
    case 'PreToolUse': {
      const tool = ev.tool_name || '';
      if (tool === 'Task' || tool === 'Agent') {
        const d = (ev.tool_input && (ev.tool_input.description || ev.tool_input.subagent_type)) || 'helper';
        addBird(String(d).slice(0, 22));
        say('🐦 spawned a helper: ' + String(d).slice(0, 22));
      } else {
        const gag = classifyTool(tool, ev.tool_input);
        state.activeTool = gag ? gag.category : null;
        setMood('thinking');                              // legacy renderers (mood-only) still react
        if (gag) broadcast({ cmd: 'react', name: gag.event });  // rich runtime plays the tool gag
      }
      break;
    }
    case 'PostToolUse':
      state.activeTool = null;
      broadcast({ cmd: 'endReact' });                     // tool finished → rich runtime returns to idle
      // a tool error = BAD NEWS, cause=external (appraise composes the red wince), not the
      // agent's own fault (that comes through as oops/embarrassed via the text path)
      if (isErrorResponse(ev)) { applySpec(appraise({ isError: true }, { valence: lastValence }), 2200); say('😟 hit a snag, recovering…'); }
      else if (!applySentiment(tail && tail.recentTexts)) setMood('thinking');
      break;
    case 'SubagentStop': removeBird(); if (state.birds.length === 0) setMood('happy', 1600); break;
    case 'Notification': {
      const msg = String(ev.message || '');
      if (/permission|needs your (permission|approval)|approve|wants to|allow\b/i.test(msg)) {
        broadcast({ cmd: 'react', name: 'Asking' });           // look up expectantly with a "?" — may I proceed?
        say('🙋 may I? ' + msg.slice(0, 40));
      } else if (/waiting for your input|is waiting|idle|are you (there|still)/i.test(msg)) {
        broadcast({ cmd: 'react', name: 'Waiting' });
        say('👀 your turn…');
      } else if (msg) { say('🔔 ' + msg.slice(0, 48)); }
      break;
    }
    case 'Stop':
      // when Claude finishes a turn, reflect the emotion of what it just said
      if (!applySentiment(tail && tail.recentTexts, 5000)) setMood(state.fullness > 0.8 ? 'sleepy' : 'neutral');
      // then, after a beat with no follow-up event, look up and around — expecting the user
      waitTimer = setTimeout(() => { waitTimer = null; if (state.phase === 'alive') broadcast({ cmd: 'react', name: 'Waiting' }); }, 3500);
      if (waitTimer.unref) waitTimer.unref();
      break;
    case 'PreCompact':   triggerRelief(); break;   // dramatic deflate + steam from the "ears"
    case 'SessionEnd':   sleepPet(); break;
    default: break;
  }
}

// ---- statusline snapshot -> rich state (the continuous, every-turn feed) ----
function handleStatus(j) {
  state.lastEventAt = Date.now();   // the statusline feed is also a live-session signal (doctor reads this)
  const cw = j.context_window || {};
  // statusline used_percentage is authoritative; don't yank fullness back up mid-/compact deflate
  if (typeof cw.used_percentage === 'number') { state.ctxPct = Math.round(cw.used_percentage); if (!reliefActive) setFullness(Math.max(0, Math.min(1, cw.used_percentage / 100))); lastStatusCtxAt = Date.now(); }
  if (cw.context_window_size) state.ctxWindow = cw.context_window_size;
  if (typeof cw.total_input_tokens === 'number') state.ctxTokens = cw.total_input_tokens;
  if (j.model) state.model = j.model.display_name || j.model.id || state.model;
  if (j.cost) { state.costUsd = j.cost.total_cost_usd ?? state.costUsd; state.linesAdded = j.cost.total_lines_added ?? state.linesAdded; state.linesRemoved = j.cost.total_lines_removed ?? state.linesRemoved; }
  if (j.rate_limits) { const r = j.rate_limits.five_hour || j.rate_limits.seven_day; if (r && typeof r.used_percentage === 'number') state.rateLimitPct = Math.round(r.used_percentage); }
  if (j.effort && j.effort.level) state.effort = j.effort.level;
  if (j.thinking) state.thinking = !!j.thinking.enabled;
  if (state.phase === 'sleeping') hatch();
  state.updated = Date.now();
}

// scripted demo: each step holds long enough for the native pets (which poll /health
// every 1.5s) to clearly show it. Drives mood, context fullness, and birds.
let demoRunning = false;
async function runDemo() {
  if (demoRunning) return; demoRunning = true;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (patch) => {
    if (patch.phase) state.phase = patch.phase;
    if (patch.phase === 'alive') broadcast({ cmd: 'hatch' });
    if (patch.fullness != null) setFullness(patch.fullness);
    if (patch.birds != null) { state.birds = Array.from({ length: patch.birds }, (_, i) => ({ id: birdSeq++, label: 'task ' + (i + 1) })); broadcast({ cmd: 'clearBirds' }); state.birds.forEach((b) => broadcast({ cmd: 'addBird', label: b.label })); }
    if (patch.mood) setMood(patch.mood);
    if (patch.say) say(patch.say, 3500);
  };
  try {
    state.phase = 'alive'; broadcast({ cmd: 'reset' }); state.birds = []; setMood('idle'); await wait(1500);
    step({ phase: 'alive', mood: 'happy', say: '👋 hi! watch my face change…' }); await wait(3800);
    step({ mood: 'listening', say: '👂 listening…' }); await wait(3500);
    step({ mood: 'working', fullness: 0.25, say: '⚙️ working on it…' }); await wait(3800);
    step({ mood: 'happy', say: '✅ that worked!' }); await wait(3800);
    step({ mood: 'excited', say: '🎉 found a great solution!' }); await wait(3800);
    step({ mood: 'oops', say: '😬 oops — a mistake' }); await wait(3800);
    step({ mood: 'bashful', say: '🙈 sorry, my bad — fixing it' }); await wait(3800);
    step({ mood: 'working', birds: 3, fullness: 0.5, say: '🐦 spawning 3 helpers…' }); await wait(4200);
    step({ birds: 0, mood: 'happy', say: '✅ helpers done!' }); await wait(3800);
    step({ mood: 'tired', fullness: 0.9, say: '😪 context almost full…' }); await wait(4000);
    step({ fullness: 0.3, mood: 'excited', say: '😌 phew — compacted, so light!' }); await wait(3800);
    step({ mood: 'idle', say: '🌿 that’s the full range!' });
  } finally { demoRunning = false; }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.riv': 'application/octet-stream' };

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { if (body.length < 4_000_000) body += c; });  // cap accumulation, but still respond on end
  req.on('end', () => cb(body));
  req.on('error', () => cb(''));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    clients.add(res);
    snapshotTo(res);
    // a REAL ping event (not an SSE `:` comment) so the client's onmessage fires — that lets the
    // overlay run a heartbeat watchdog and detect a half-open stream. Renderers ignore cmd:'ping'.
    const ping = setInterval(() => { try { res.write('data: {"cmd":"ping"}\n\n'); } catch { clearInterval(ping); clients.delete(res); } }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (url.pathname === '/event' && req.method === 'POST') {
    readBody(req, async (body) => {
      try {
        const ev = JSON.parse(body || '{}');
        if (ownsEvent(ev.session_id)) await enqueueEvent(ev);  // ignore other sessions; serialize ours
      } catch {}
      try { res.writeHead(200); res.end('ok'); } catch {}     // poster (curl -m) may have already hung up
    });
    return;
  }
  if (url.pathname === '/status' && req.method === 'POST') {
    readBody(req, (body) => {
      try {
        const j = JSON.parse(body || '{}');
        if (ownsEvent(j.session_id)) handleStatus(j);
      } catch {}
      try { res.writeHead(200); res.end('ok'); } catch {}
    });
    return;
  }
  // claim the pet for one session — bin/animayte passes CLAUDE_CODE_SESSION_ID so the pet
  // follows exactly the session that summoned it (re-summon from another session to transfer).
  if (url.pathname === '/claim' && req.method === 'POST') {
    readBody(req, (body) => {
      let sid = null; try { sid = JSON.parse(body || '{}').session_id || null; } catch {}
      ownerSession = sid;
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }  // no stray "waiting" glance from the previous owner
      freshStart();
      say('👋 hi! I’m watching this session');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, owner: ownerSession }));
    });
    return;
  }
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, owner: ownerSession, clients: clients.size, rss: process.memoryUsage().rss, state })); return; }

  // expression tester — run the REAL detector on arbitrary text and report the result
  if (url.pathname === '/detect') {
    const text = url.searchParams.get('text') || '';
    const push = url.searchParams.get('push') === '1';
    const r = detectMood(text);
    if (r && push) { state.phase = 'alive'; setMood(r.mood, 4000); if (r.emoji) say(r.emoji, 4000); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: r }));
    return;
  }

  // direct control (for testing/demo + the /animayte commands)
  if (url.pathname === '/set') {
    const q = url.searchParams;
    if (q.has('phase')) { state.phase = q.get('phase'); if (state.phase === 'alive') broadcast({ cmd: 'wake' }); }
    if (q.has('mood')) { state.phase = 'alive'; setMood(q.get('mood')); }
    if (q.has('fullness')) { const f = Number(q.get('fullness')); if (Number.isFinite(f)) setFullness(f); }
    if (q.has('say')) say(q.get('say'), Number(q.get('ms')) || 3500);
    if (q.has('birds')) { const n = Math.max(0, Math.min(5, Math.round(Number(q.get('birds')) || 0))); state.birds = Array.from({ length: n }, (_, i) => ({ id: birdSeq++, label: 'task ' + (i + 1) })); broadcast({ cmd: 'clearBirds' }); state.birds.forEach((b) => broadcast({ cmd: 'addBird', label: b.label })); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, state })); return;
  }

  // scripted, visible demo — drives the live pet through the full range
  if (url.pathname === '/demo') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, running: 'demo' }));
    runDemo();
    return;
  }

  const rel = url.pathname === '/' ? 'animayte.html' : url.pathname.replace(/^\/+/, '');
  const fp = join(__dir, rel);
  if (!fp.startsWith(__dir)) { res.writeHead(403); res.end('no'); return; }
  try {
    const data = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});

// C4 — quiet time pulls the mood drift back toward neutral
const moodDecay = setInterval(() => {
  const before = state.moodLabel;
  moodMeter.decayStep();
  state.moodLevel = Math.round(moodMeter.level * 100) / 100;
  state.moodLabel = moodMeter.label;
  if (state.moodLabel !== before) broadcast({ cmd: 'moodLevel', value: state.moodLevel, label: state.moodLabel });
}, 15000);
if (moodDecay.unref) moodDecay.unref();   // don't keep the process alive just for decay

// On EADDRINUSE, retry a few times before giving up: on `restart` the just-killed daemon may
// not have released the port yet (async socket teardown), and exiting immediately would leave
// no daemon. After the retries, assume a real daemon is already running and exit cleanly.
let listenRetries = 8;
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    if (--listenRetries > 0) { setTimeout(() => { try { server.close(); } catch {} server.listen(PORT, '127.0.0.1'); }, 250); return; }
    console.error(`\n  🐣 animayte: port ${PORT} is already in use — a daemon is probably already running.`);
    console.error(`     • open it:        http://127.0.0.1:${PORT}`);
    console.error(`     • restart it:     bin/animayte restart`);
    console.error(`     • or another port: ANIMAYTE_PORT=4322 npm start\n`);
    process.exit(1);
  }
  console.error('  🐣 animayte daemon error:', (err && err.message) || err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  🐣 animayte daemon →  http://127.0.0.1:${PORT}`);
  console.log(`     context % is now REAL (from the transcript usage object).\n`);
});
