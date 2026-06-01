#!/usr/bin/env node
/*
 * animayte · replay — replay a REAL Claude Code session transcript into a running daemon,
 * so a dev can REPRODUCE "the pet did X wrong on my session" and watch it happen live.
 *
 *   node tools/animayte-replay.mjs --latest                  # newest transcript in THIS project
 *   node tools/animayte-replay.mjs path/to/session.jsonl     # an explicit transcript
 *   node tools/animayte-replay.mjs --session <id>            # by session id (this project dir)
 *   node tools/animayte-replay.mjs --latest --dry            # print the event plan, POST nothing
 *   node tools/animayte-replay.mjs --latest --realtime       # honor original timing gaps (capped)
 *
 * Unlike tools/sim-session.mjs (a CANNED, synthetic arc), this walks a REAL transcript in order
 * and rebuilds the exact hook stream Claude Code would have produced:
 *   · each user prompt           → POST UserPromptSubmit  (the real prompt text)
 *   · each assistant tool_use    → POST PreToolUse        (real tool_name + tool_input)
 *     · its matching tool_result → POST PostToolUse       (real tool_response, preserving is_error)
 *   · each assistant text turn   → POST Stop  with transcript_path = a TEMP file TRUNCATED to that
 *                                  message, so the daemon's OWN readTranscriptTail()+appraise()
 *                                  run on the REAL text + usage → faithful context% + sentiment.
 *   · a compact_boundary         → POST PreCompact        (the /compact relief)
 *   · sidechain (sub-agent) turns are still POSTed (so you can verify sidechain handling).
 * It POSTs /claim with the transcript's session id first, so ownership matches the real session.
 *
 * Zero dependencies — Node builtins only. READ-ONLY on the source transcript and ~/.claude.
 * Self-test (own ephemeral daemon on a free port; never touches :4321):  --selftest
 */
import http from 'node:http';
import { readFile, writeFile, stat, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── transcript discovery ─────────────────────────────
// Claude Code stores transcripts under ~/.claude/projects/<slug>/<session>.jsonl, where the slug
// is the cwd with every non-alphanumeric char turned into "-". We mirror that to find THIS
// project's dir without copying anything.
function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}
function projectDir(cwd = process.cwd()) {
  return join(homedir(), '.claude', 'projects', projectSlug(cwd));
}

// newest *.jsonl in a dir, by mtime (the "current" session). Read-only stat, no copies.
async function newestTranscript(dir) {
  let names;
  try { names = await readdir(dir); } catch { return null; }
  const jsonl = names.filter((n) => n.endsWith('.jsonl'));
  let best = null, bestMtime = -1;
  for (const n of jsonl) {
    const p = join(dir, n);
    try { const s = await stat(p); if (s.mtimeMs > bestMtime) { bestMtime = s.mtimeMs; best = p; } } catch {}
  }
  return best;
}

// Resolve the transcript path from CLI flags: explicit path | --session <id> | --latest.
async function resolveTranscript({ path, session, latest, cwd = process.cwd() }) {
  if (path) {
    const p = isAbsolute(path) ? path : resolve(cwd, path);
    await stat(p);   // throws a clear ENOENT if it's wrong
    return p;
  }
  const dir = projectDir(cwd);
  if (session) {
    const p = join(dir, session.endsWith('.jsonl') ? session : session + '.jsonl');
    await stat(p);
    return p;
  }
  if (latest) {
    const p = await newestTranscript(dir);
    if (!p) throw new Error(`no .jsonl transcripts found in ${dir}`);
    return p;
  }
  throw new Error('give a transcript path, or --latest, or --session <id>');
}

// ───────────────────────────── transcript → event plan ─────────────────────────────
// Read the WHOLE transcript ONCE into ordered records (a transcript line is a small JSON object;
// even a multi-MB file is a few MB of text). We keep, per assistant message, the RAW source lines
// up to and including it so we can later write a TRUNCATED temp transcript the daemon reads itself.

function parseLine(raw) { try { return JSON.parse(raw); } catch { return null; } }

// Claude Code injects machinery into the transcript as type:"user" records that are NOT things the
// human actually typed: slash-command envelopes (<command-name>…</command-name>), the stdout a local
// command printed back (<local-command-stdout>…), "[Request interrupted by user]" markers, hook
// "Caveat:" preambles, and the "This session is being continued…" compaction summary. The real
// UserPromptSubmit hook does NOT fire for these — and feeding their XML/markup to appraise() would
// produce a bogus face. So a faithful replay skips them. (A genuine prompt that merely MENTIONS
// these words is unaffected: we only match the system-injected forms, anchored at the start.)
const NOISE_PROMPT = /^\s*(<command-(name|message|args|contents)>|<local-command-stdout>|\[Request interrupted|Caveat: The messages below|This session is being continued from a previous conversation)/;
function isNoisePrompt(text) { return NOISE_PROMPT.test(text); }

// Is this record a REAL user prompt (vs a tool_result echo, an image-attachment meta note, etc.)?
// Real prompt: type:"user", content is a string OR an array carrying a text block, and it is NOT a
// meta note and NOT a tool_result envelope. (Claude Code wraps tool outputs as type:"user" too.)
// Returns the prompt text, or null if this isn't a real prompt. Command-noise is returned tagged so
// the planner can record (but skip POSTing) it — the dry-run still SHOWS it was seen and why.
function userPromptText(o) {
  if (!o || o.type !== 'user' || o.isMeta) return null;
  const c = o.message && o.message.content;
  let text = null;
  if (typeof c === 'string') text = c.trim() || null;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return null;   // tool output, not a prompt
    text = c.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n').trim() || null;
  }
  return text;
}

// Pull every tool_result block out of a (type:"user") record, keyed by tool_use_id, preserving the
// real response shape + is_error so PostToolUse reproduces the daemon's error path faithfully.
function toolResultsIn(o) {
  const out = [];
  const c = o && o.message && o.message.content;
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (b && b.type === 'tool_result' && b.tool_use_id) {
      // Reconstruct a tool_response in the shape the daemon's isErrorResponse() expects. The block's
      // `content` is the visible output (string | array of {type,text}); `is_error` is the flag.
      let response = b.content;
      if (Array.isArray(response)) {
        // collapse to a {is_error, output} object so daemon's object-path (r.is_error===true) fires
        const text = response.filter((x) => x && (x.type === 'text' || typeof x.text === 'string')).map((x) => x.text).join('\n');
        response = { is_error: !!b.is_error, output: text };
      } else if (typeof response === 'string') {
        response = b.is_error ? { is_error: true, output: response } : response;
      } else if (response == null) {
        response = { is_error: !!b.is_error };
      } else if (typeof response === 'object') {
        response = { is_error: !!b.is_error, ...response };
      }
      out.push({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, response, raw: o.toolUseResult });
    }
  }
  return out;
}

function ts(o) { const t = o && o.timestamp; const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : null; }

// Does this transcript carry the REAL Stop markers Claude Code writes (type:"system",
// subtype:"stop_hook_summary") — one per actual Stop-hook fire? If so we use them verbatim; if not
// (older/partial transcript) we synthesize a Stop at each turn boundary instead.
function hasStopMarkers(records) {
  return records.some((r) => r.o && r.o.type === 'system' && r.o.subtype === 'stop_hook_summary');
}

/**
 * Build the ordered event plan from a transcript's raw lines.
 * Each step carries { kind, at, sidechain, lineIndex, ... } where kind ∈
 *   prompt | prompt_noise | tool_use | subagent_stop | stop | compact
 * `lineIndex` is the source-line index this step maps to; a stop/post step truncates the temp
 * transcript to include lines [0..lineIndex] so the daemon's readTranscriptTail sees exactly up to
 * that point (faithful context% + sentiment).
 *
 * Stop fidelity: we anchor Stop to the transcript's own stop_hook_summary markers (the REAL hook
 * fires) when present — these land precisely at turn end, so one Stop per turn, never per assistant
 * message. Without markers we fall back to synthesizing a Stop where an assistant text turn is the
 * last assistant record before a user/system record (a turn boundary).
 */
function buildPlan(rawLines, fallbackSession) {
  const records = rawLines.map((raw, i) => ({ raw, o: parseLine(raw), i }));
  // session id: prefer the first record that carries one; fall back to the filename-derived id.
  let sessionId = fallbackSession || null;
  for (const r of records) { if (r.o && r.o.sessionId) { sessionId = r.o.sessionId; break; } }

  // index every tool_result by its tool_use_id → the line index it lives at (for truncation).
  const resultByToolId = new Map();
  for (const r of records) {
    if (!r.o) continue;
    for (const tr of toolResultsIn(r.o)) {
      if (!resultByToolId.has(tr.tool_use_id)) resultByToolId.set(tr.tool_use_id, { ...tr, lineIndex: r.i, at: ts(r.o) });
    }
  }

  const realStops = hasStopMarkers(records);

  // when SYNTHESIZING stops: a turn ends at an assistant record that has text AND whose next non-
  // empty record is NOT an assistant tool_use continuation (i.e. a user prompt, a compact, or EOF).
  // Pre-compute which assistant indices are turn-enders so the main loop can emit a Stop there.
  const synthStopAt = new Set();
  if (!realStops) {
    for (let i = 0; i < records.length; i++) {
      const o = records[i].o; if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      const hasText = o.message.content.some((b) => b && b.type === 'text' && b.text && b.text.trim());
      const hasUsage = !!o.message.usage;
      if (!hasText && !hasUsage) continue;
      // look ahead to the next meaningful record
      let next = null;
      for (let j = i + 1; j < records.length; j++) { if (records[j].o) { next = records[j].o; break; } }
      const continues = next && next.type === 'assistant';   // another assistant record ⇒ same turn
      const nextIsToolResult = next && next.type === 'user' && Array.isArray(next.message && next.message.content) && next.message.content.some((b) => b && b.type === 'tool_result');
      if (!continues && !nextIsToolResult) synthStopAt.add(i);   // turn boundary
    }
  }

  const steps = [];
  for (const r of records) {
    const o = r.o; if (!o) continue;
    const side = o.isSidechain === true;
    const at = ts(o);

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      steps.push({ kind: 'compact', at, sidechain: side, lineIndex: r.i });
      continue;
    }
    // the REAL Stop marker → one Stop, truncated to here (the turn's final assistant text precedes it)
    if (realStops && o.type === 'system' && o.subtype === 'stop_hook_summary') {
      steps.push({ kind: 'stop', at, sidechain: side, lineIndex: r.i, hasText: true });
      continue;
    }

    const prompt = userPromptText(o);
    if (prompt != null) {
      steps.push({ kind: isNoisePrompt(prompt) ? 'prompt_noise' : 'prompt', at, sidechain: side, prompt, lineIndex: r.i });
      continue;
    }

    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const blocks = o.message.content;
      const toolUses = blocks.filter((b) => b && b.type === 'tool_use');

      for (const tu of toolUses) {
        const result = tu.id ? resultByToolId.get(tu.id) || null : null;
        const isTask = tu.name === 'Task' || tu.name === 'Agent';
        steps.push({
          kind: 'tool_use', at, sidechain: side, lineIndex: r.i,
          tool_name: tu.name, tool_input: tu.input || {}, tool_use_id: tu.id || null,
          result,                                   // may be null if the session was cut off mid-tool
          isTask,
        });
        // a sub-agent (Task) returning a result == the SubagentStop hook fires (a bird flies off).
        // Emit it right after the tool_use so birds added on PreToolUse are balanced by removal.
        if (isTask && result) {
          steps.push({ kind: 'subagent_stop', at: result.at != null ? result.at : at, sidechain: side, lineIndex: result.lineIndex });
        }
      }
      // SYNTHESIZED Stop (only when the transcript lacks real markers): turn boundary on a text turn.
      if (!realStops && synthStopAt.has(r.i)) {
        const hasText = blocks.some((b) => b && b.type === 'text' && b.text && b.text.trim());
        steps.push({ kind: 'stop', at, sidechain: side, lineIndex: r.i, hasText });
      }
    }
  }
  return { sessionId, steps, records, realStops };
}

// ───────────────────────────── HTTP plumbing (builtins only) ─────────────────────────────
function post(port, path, body, timeout = 2500) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout },
      (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, body: b })); }
    );
    req.on('error', (e) => resolve({ error: e.message })); req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.write(data); req.end();
  });
}
function getJson(port, path, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// A tiny raw-SSE client so the dev SEES the cmds the daemon emits as it reproduces the session.
// (No EventSource in Node; we parse the `data:` lines off the keep-alive socket ourselves.)
function openSse(port, onCmd, onOpen) {
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { accept: 'text/event-stream' } }, (res) => {
    if (onOpen) onOpen();
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = line.match(/^data:\s?(.*)$/);
        if (m) { try { onCmd(JSON.parse(m[1])); } catch {} }
      }
    });
  });
  req.on('error', () => {});
  return () => { try { req.destroy(); } catch {} };
}

// ───────────────────────────── the replay engine ─────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Replay a plan into a daemon on `port`.
 * opts: { dry, quiet, realtime, speed, from, to, log, onCmd, tmpDir }
 *   - tmpDir: directory for the per-Stop truncated temp transcript (caller owns cleanup).
 *   - log(line): sink for the step-by-step narration (defaults to console.log unless quiet).
 *   - onCmd: optional — replay calls it for nothing; the SSE collector is wired by the caller.
 * Returns { posted, steps, sessionId }.
 */
async function replayPlan(plan, opts = {}) {
  const { port = 4321, dry = false, quiet = false, realtime = false, speed = 1, tmpDir } = opts;
  const log = opts.log || ((line) => { if (!quiet) console.log(line); });
  const { sessionId, steps, records } = plan;

  // slice [from,to) over the emitted steps (1-based, inclusive `to`) for narrowing a repro.
  const from = opts.from ? Math.max(1, opts.from) : 1;
  const to = opts.to ? Math.min(steps.length, opts.to) : steps.length;
  const slice = steps.slice(from - 1, to);

  // The temp transcript the daemon reads on Stop/PostToolUse. We write it INCREMENTALLY: truncated
  // to each step's source line. Read-only on the original — we only ever write THIS temp file.
  const tmpTranscript = tmpDir ? join(tmpDir, 'replay-transcript.jsonl') : null;
  async function writeTruncated(lineIndex) {
    if (!tmpTranscript) return null;
    // include source lines [0 .. lineIndex]; join with newline + trailing newline (jsonl shape)
    const slabLines = records.slice(0, lineIndex + 1).map((r) => r.raw);
    await writeFile(tmpTranscript, slabLines.join('\n') + '\n');
    return tmpTranscript;
  }

  const base = (extra) => ({ session_id: sessionId, cwd: process.cwd(), ...extra });

  if (!dry) {
    // claim ownership so the daemon accepts our events exactly as the real session's.
    await post(port, '/claim', { session_id: sessionId });
  }
  log(`▶ replaying ${slice.length} step(s)` + (from > 1 || to < steps.length ? ` (slice ${from}–${to} of ${steps.length})` : ` of ${steps.length}`) + `  · session ${sessionId || '(none)'}` + (dry ? '  · DRY RUN' : ''));

  let posted = 0;
  let prevAt = null;

  for (let n = 0; n < slice.length; n++) {
    const step = slice[n];
    const idx = from + n;   // human-facing step number within the full plan

    // realtime pacing: honor the original gap between timestamps, scaled and capped so a 6-hour
    // session doesn't take 6 hours (and a missing timestamp doesn't stall).
    if (realtime && !dry && step.at != null) {
      if (prevAt != null) {
        const gap = Math.max(0, step.at - prevAt);
        const wait = Math.min(4000, gap) / (speed || 1);
        if (wait > 0) await sleep(wait);
      }
      prevAt = step.at;
    } else if (!dry && !realtime) {
      // a light default cadence so an attached SSE viewer can SEE each reaction land
      await sleep(Math.max(0, Math.round(60 / (speed || 1))));
    }

    const tag = step.sidechain ? ' [sidechain]' : '';
    switch (step.kind) {
      case 'prompt': {
        const preview = step.prompt.replace(/\s+/g, ' ').slice(0, 64);
        log(`  ${idx}. UserPromptSubmit${tag} — "${preview}"  → pet reads how you spoke (praise/correction → face)`);
        if (!dry) { await post(port, '/event', base({ hook_event_name: 'UserPromptSubmit', prompt: step.prompt })); posted++; }
        break;
      }
      case 'prompt_noise': {
        // command machinery (slash-command envelope / stdout echo / interrupt marker / compaction
        // summary): the real UserPromptSubmit hook does NOT fire for these, so we SHOW it was seen
        // but do not POST — keeping the replayed stream faithful to what Claude Code actually emits.
        const preview = step.prompt.replace(/\s+/g, ' ').slice(0, 48);
        log(`  ${idx}. (skip) command machinery${tag} — "${preview}…"  (no UserPromptSubmit hook fires)`);
        break;
      }
      case 'tool_use': {
        const isTask = step.isTask;
        const expl = isTask ? 'spawns a 🐦 sub-agent bird (addBird)' : `tool gag for ${step.tool_name} + 🤔 thinking`;
        log(`  ${idx}. PreToolUse${tag} — ${step.tool_name}  → ${expl}`);
        if (!dry) { await post(port, '/event', base({ hook_event_name: 'PreToolUse', tool_name: step.tool_name, tool_use_id: step.tool_use_id, tool_input: step.tool_input })); posted++; }
        // pair the matching PostToolUse right after (that's the real lifecycle order). A Task's
        // SubagentStop is emitted as its own step (see 'subagent_stop'); for Task we still POST the
        // PostToolUse so the tool lifecycle closes, but the bird removal rides on SubagentStop.
        if (step.result) {
          const err = step.result.is_error;
          log(`     └ PostToolUse — ${step.tool_name}  → ${err ? '😟 hit a snag (is_error)' : 'endReact → idle/sentiment'}`);
          if (!dry) {
            const tx = await writeTruncated(step.result.lineIndex != null ? step.result.lineIndex : step.lineIndex);
            await post(port, '/event', base({ hook_event_name: 'PostToolUse', tool_name: step.tool_name, tool_use_id: step.tool_use_id, tool_input: step.tool_input, tool_response: step.result.response, transcript_path: tx }));
            posted++;
          }
        }
        break;
      }
      case 'subagent_stop': {
        log(`  ${idx}. SubagentStop${tag} — 🐦 a helper finished (removeBird)`);
        if (!dry) { await post(port, '/event', base({ hook_event_name: 'SubagentStop', agent_type: 'general' })); posted++; }
        break;
      }
      case 'stop': {
        const why = step.hasText ? 'reflect sentiment of what it just said' : 'read usage → context% (fullness)';
        log(`  ${idx}. Stop${tag} — ${why}`);
        if (!dry) {
          const tx = await writeTruncated(step.lineIndex);
          await post(port, '/event', base({ hook_event_name: 'Stop', transcript_path: tx })); posted++;
        }
        break;
      }
      case 'compact': {
        log(`  ${idx}. PreCompact${tag} — 😮‍💨 relief: steam + deflate (guarded against re-inflation)`);
        if (!dry) { await post(port, '/event', base({ hook_event_name: 'PreCompact' })); posted++; }
        break;
      }
    }
  }

  // accurate POST count for the dry summary: a tool_use POSTs PreToolUse (+PostToolUse if it has a
  // result), a prompt_noise POSTs nothing, everything else POSTs one event.
  const plannedPosts = slice.reduce((n, s) => n + (s.kind === 'prompt_noise' ? 0 : s.kind === 'tool_use' ? (s.result ? 2 : 1) : 1), 0);
  log(`✔ replay ${dry ? 'planned' : 'complete'} — ${dry ? plannedPosts + ' events would be POSTed' : posted + ' events POSTed'}`);
  return { posted: dry ? plannedPosts : posted, steps: slice.length, sessionId };
}

// ───────────────────────────── CLI ─────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--latest') a.latest = true;
    else if (t === '--dry') a.dry = true;
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--realtime') a.realtime = true;
    else if (t === '--selftest') a.selftest = true;
    else if (t === '--no-sse') a.noSse = true;
    else if (t === '--session') a.session = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--speed') a.speed = Number(argv[++i]);
    else if (t === '--from') a.from = Number(argv[++i]);
    else if (t === '--to') a.to = Number(argv[++i]);
    else if (t.startsWith('--session=')) a.session = t.slice(10);
    else if (t.startsWith('--port=')) a.port = Number(t.slice(7));
    else if (t.startsWith('--speed=')) a.speed = Number(t.slice(8));
    else if (t.startsWith('--from=')) a.from = Number(t.slice(7));
    else if (t.startsWith('--to=')) a.to = Number(t.slice(5));
    else if (t === '-h' || t === '--help') a.help = true;
    else if (!t.startsWith('-')) a._.push(t);
  }
  return a;
}

const HELP = `
animayte · replay — reproduce a REAL session transcript into a running daemon

usage:
  node tools/animayte-replay.mjs <transcript.jsonl> [flags]
  node tools/animayte-replay.mjs --latest            # newest transcript in this project
  node tools/animayte-replay.mjs --session <id>      # by session id (this project dir)

flags:
  --port <n>       daemon port (default 4321)
  --dry            print the event plan; POST nothing (no daemon needed)
  --realtime       honor original timestamp gaps (capped at 4s/step)
  --speed <x>      speed multiplier for pacing/realtime (e.g. 2 = twice as fast)
  --from <n> --to <n>   replay only steps n..n (1-based, inclusive) — narrow a repro
  --no-sse         don't attach the live SSE viewer
  --quiet          suppress the step-by-step log
  --selftest       run the self-test against an OWN ephemeral daemon (never touches :4321)
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(HELP); return; }
  if (a.selftest) { const ok = await selfTest(); process.exit(ok ? 0 : 1); }

  const port = a.port || 4321;
  let transcriptPath;
  try {
    transcriptPath = await resolveTranscript({ path: a._[0], session: a.session, latest: a.latest });
  } catch (e) { console.error('animayte-replay:', e.message); console.error(HELP); process.exit(2); }

  const fallbackSession = transcriptPath.replace(/.*[/\\]/, '').replace(/\.jsonl$/, '');
  const raw = (await readFile(transcriptPath, 'utf8')).split('\n');
  // drop a trailing empty line so line indices line up with non-empty records when we re-join
  while (raw.length && raw[raw.length - 1] === '') raw.pop();
  const plan = buildPlan(raw, fallbackSession);

  if (!plan.steps.length) { console.error(`animayte-replay: no replayable events in ${transcriptPath}`); process.exit(3); }
  console.log(`\n🎬 animayte-replay  ·  ${transcriptPath}`);
  console.log(`   ${raw.length} transcript lines → ${plan.steps.length} replay events  · session ${plan.sessionId}\n`);

  if (a.dry) {
    await replayPlan(plan, { port, dry: true, quiet: a.quiet, from: a.from, to: a.to });
    return;
  }

  // require a live daemon (don't start one — we never touch the user's :4321 lifecycle).
  const h = await getJson(port, '/health');
  if (!h || !h.ok) {
    console.error(`animayte-replay: no daemon on :${port}. Start one first (bin/animayte start), or use --dry.\n`);
    process.exit(4);
  }

  // attach the live SSE viewer so the dev sees the ACTUAL cmds that come back as it reproduces.
  let closeSse = null;
  if (!a.noSse && !a.quiet) {
    const seen = [];
    closeSse = openSse(port, (cmd) => {
      if (cmd.cmd === 'ping') return;   // keepalive — not a reaction
      seen.push(cmd.cmd);
      const detail = cmd.value != null ? ` ${JSON.stringify(cmd.value)}` : cmd.name ? ` ${cmd.name}` : cmd.spec ? ` ${cmd.spec.expression}` : cmd.text ? ` "${String(cmd.text).slice(0, 40)}"` : '';
      console.log(`        ⟵ SSE  ${cmd.cmd}${detail}`);
    });
    await sleep(200);   // let the snapshot drain before we start driving
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'animayte-replay-'));
  try {
    await replayPlan(plan, { port, quiet: a.quiet, realtime: a.realtime, speed: a.speed, from: a.from, to: a.to, tmpDir });
    await sleep(400);   // let the final reactions flush to the viewer
  } finally {
    if (closeSse) closeSse();
    await rm(tmpDir, { recursive: true, force: true });
  }
  const f = await getJson(port, '/health');
  console.log(`\n✅ done. final pet state: mood ${f?.state?.mood}, ctx ${f?.state?.ctxPct}%, birds ${f?.state?.birds?.length}, reliefSeq ${f?.state?.reliefSeq}.`);
  console.log(`   (re-summon your real session's pet with /animayte to hand it back.)\n`);
}

// ───────────────────────────── SELF-TEST ─────────────────────────────
// Spawns the REAL daemon on a FREE port (never :4321), replays a tiny real-shaped fixture, and
// asserts via /health + an SSE collector that the expected reactions fired. Exported so a test
// suite can import and run it headless.
async function freePort() {
  const net = await import('node:net');
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

// A tiny, REAL-SHAPED transcript: a praise prompt, a Bash tool_use + its (ok) result, an assistant
// turn carrying a usage object + happy text, then a compact_boundary. Mirrors the real JSONL shape.
function fixtureLines(session = 'replay-selftest') {
  const a = (content, usage, extra = {}) => JSON.stringify({ type: 'assistant', isSidechain: false, sessionId: session, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-4-8', content, usage }, ...extra });
  const u = (content) => JSON.stringify({ type: 'user', isSidechain: false, sessionId: session, timestamp: new Date().toISOString(), message: { role: 'user', content } });
  const sys = (subtype) => JSON.stringify({ type: 'system', subtype, sessionId: session, content: 'Conversation compacted' });
  return [
    u('this is brilliant, exactly what I wanted!'),                                 // praise → proud/excited + blush
    a([{ type: 'tool_use', id: 'toolu_replay_1', name: 'Bash', input: { command: 'npm test' } }], { input_tokens: 5000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 100 }),
    u([{ type: 'tool_result', tool_use_id: 'toolu_replay_1', is_error: false, content: 'all tests passed' }]),  // PostToolUse ok
    a([{ type: 'text', text: 'Fixed it — all tests pass now, looks great!' }], { input_tokens: 60000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 410000, output_tokens: 200 }),  // big ctx + happy
    sys('compact_boundary'),                                                        // /compact → relief
  ];
}

async function selfTest() {
  const ok = (label, cond) => { console.log(`   ${cond ? '✓' : '✗'} ${label}`); return cond; };
  console.log('\n🧪 animayte-replay self-test (ephemeral daemon on a free port)\n');
  const port = await freePort();
  const daemon = join(dirname(fileURLToPath(import.meta.url)), '..', 'animayte.mjs');

  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [daemon], { env: { ...process.env, ANIMAYTE_PORT: String(port), ANIMAYTE_SESSION: '' }, stdio: 'ignore' });

  let pass = true;
  const tmpDir = await mkdtemp(join(tmpdir(), 'animayte-replay-selftest-'));
  const collected = [];
  let closeSse = null;
  try {
    // wait for the daemon to be listening
    let up = false;
    for (let i = 0; i < 60; i++) { const h = await getJson(port, '/health'); if (h && h.ok) { up = true; break; } await sleep(100); }
    pass = ok('daemon booted on free port :' + port, up) && pass;
    if (!up) return false;

    // attach an SSE collector BEFORE replaying so we capture every reaction
    closeSse = openSse(port, (cmd) => { if (cmd.cmd !== 'ping') collected.push(cmd); });
    await sleep(250);

    // build the plan from the in-memory fixture (no file on the source side needed)
    const plan = buildPlan(fixtureLines(), 'replay-selftest');
    const kinds = new Set(plan.steps.map((s) => s.kind));
    pass = ok(`plan has prompt+tool_use+stop+compact (${plan.steps.length} steps: ${[...kinds].join(',')})`,
      kinds.has('prompt') && kinds.has('tool_use') && kinds.has('stop') && kinds.has('compact')) && pass;

    await replayPlan(plan, { port, quiet: true, tmpDir });
    await sleep(600);   // let the relief deflate kick off + the final reactions land

    const got = (c) => collected.filter((x) => x.cmd === c);
    const moods = got('mood').map((x) => x.value);
    const exprs = got('express').map((x) => x.spec && x.spec.expression);

    // 1) the praise prompt produced a POSITIVE face (proud/excited/happy) via mood + express
    const praised = moods.some((m) => /excited|happy|proud/.test(String(m))) || exprs.some((e) => /excited|happy|proud/.test(String(e)));
    pass = ok('praise prompt → positive face (mood/express)', praised) && pass;

    // 2) the tool_use produced a react (tool gag) and a PostToolUse endReact
    pass = ok('tool_use → react (tool gag)', got('react').length > 0) && pass;
    pass = ok('PostToolUse → endReact', got('endReact').length > 0) && pass;

    // 3) the assistant turn with a big usage drove fullness up (context% read from real usage)
    const maxFull = Math.max(0, ...got('fullness').map((x) => x.value));
    pass = ok(`assistant usage → fullness rose (peak ${maxFull.toFixed(2)})`, maxFull > 0.2) && pass;

    // 4) the compact_boundary fired relief, and /health shows reliefSeq incremented
    pass = ok('compact_boundary → relief cmd', got('relief').length > 0) && pass;
    const h = await getJson(port, '/health');
    pass = ok(`/health reliefSeq incremented (=${h?.state?.reliefSeq})`, (h?.state?.reliefSeq || 0) >= 1) && pass;

    // 5) ownership: the daemon adopted our session id via /claim
    pass = ok(`/health owner == replayed session (${h?.owner})`, h?.owner === 'replay-selftest') && pass;

    console.log(`\n   captured ${collected.length} SSE cmds: ${[...new Set(collected.map((c) => c.cmd))].join(', ')}`);
  } finally {
    if (closeSse) closeSse();
    await rm(tmpDir, { recursive: true, force: true });
    child.kill('SIGTERM');
  }
  console.log(`\n${pass ? '✅ self-test PASSED' : '❌ self-test FAILED'}\n`);
  return pass;
}

// run as a script
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('animayte-replay: fatal —', e && e.stack || e); process.exit(1); });

export { buildPlan, replayPlan, resolveTranscript, projectDir, newestTranscript, userPromptText, toolResultsIn, fixtureLines, selfTest };
