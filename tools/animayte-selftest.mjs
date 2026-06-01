#!/usr/bin/env node
/*
 * animayte · selftest — a LIVE round-trip connection probe (Node 18+, zero deps).
 *
 * The #1 recurring pain is "is the pet actually connected to THIS session and reacting?".
 * `bin/animayte doctor` reads /health (static config + ownership), but it CANNOT prove that a
 * real event makes it all the way back out the SSE stream — the actual reaction path. This tool
 * does exactly that, end-to-end, over the real transport, using only existing daemon endpoints:
 *
 *   1) GET /health           → is the daemon up? who OWNS the pet vs THIS session?
 *                              (owner ≠ this session = the silent-death failure: every hook dropped)
 *   2) open a real SSE client on GET /events, then POST an OWNED `Notification` /event carrying a
 *      unique random marker. The daemon turns a plain notification into a `say` cmd whose text is
 *      "🔔 <marker>" (see animayte.mjs handleEvent → Notification → say()). We wait for that exact
 *      marker to come back on the SSE stream — proving the full hook → state → broadcast → client loop.
 *   3) print a clear PASS/FAIL with the EXACT remedy (claim the pet / start the daemon / no window).
 *
 * Usage:
 *   node tools/animayte-selftest.mjs                 # probe the live daemon on :4321 as THIS session
 *   node tools/animayte-selftest.mjs --port 4322
 *   node tools/animayte-selftest.mjs --timeout 5000
 *   ANIMAYTE_PORT=4322 node tools/animayte-selftest.mjs
 *
 * Exit code: 0 = PASS (the pet is connected and reacting to this session), non-zero = FAIL.
 * It NEVER mutates persistent config and NEVER starts/kills any process — pure observation + one
 * synthetic owned event (a harmless notification the pet would surface anyway).
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';

// ---- args ----
function parseArgs(argv) {
  const a = { port: Number(process.env.ANIMAYTE_PORT) || 4321, timeout: 4000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port' || k === '-p') a.port = Number(argv[++i]);
    else if (k === '--timeout' || k === '-t') a.timeout = Number(argv[++i]);
    else if (k.startsWith('--port=')) a.port = Number(k.slice(7));
    else if (k.startsWith('--timeout=')) a.timeout = Number(k.slice(10));
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  if (!Number.isFinite(a.port) || a.port <= 0) a.port = 4321;
  if (!Number.isFinite(a.timeout) || a.timeout <= 0) a.timeout = 4000;
  return a;
}

// ---- tiny ANSI (auto-off when not a TTY, e.g. piped into a log) ----
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n, s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);
const short = (s) => (s ? String(s).slice(0, 8) + '…' : '(none)');

// ---- HTTP helpers (no deps) ----
function getJson(port, path, timeout) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => { try { resolve({ ok: true, status: r.statusCode, body: JSON.parse(b) }); } catch { resolve({ ok: true, status: r.statusCode, body: null }); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: new Error('timeout') }); });
  });
}

function postJson(port, path, obj, timeout) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout }, (r) => {
      r.resume();
      r.on('end', () => resolve({ ok: true, status: r.statusCode }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: new Error('timeout') }); });
    req.write(data);
    req.end();
  });
}

// Open a raw SSE client and resolve when a `say` command containing `marker` arrives (or timeout).
// Returns { hit, frames } — frames is every parsed cmd seen (for debugging). Resolves a connected()
// promise once the stream's headers land, so the caller can POST the event only after we're listening
// (otherwise a fast daemon could broadcast before we've subscribed and we'd miss it).
function openSseWaiter(port, marker, timeout) {
  let onConnected;
  const connected = new Promise((r) => (onConnected = r));
  const result = new Promise((resolve) => {
    const frames = [];
    let buf = '';
    let done = false;
    const finish = (hit) => { if (done) return; done = true; clearTimeout(timer); try { req.destroy(); } catch {} resolve({ hit, frames }); };
    const timer = setTimeout(() => finish(false), timeout);
    if (timer.unref) timer.unref();

    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Accept: 'text/event-stream' } }, (r) => {
      if (r.statusCode !== 200) { finish(false); return; }
      onConnected(true);
      r.setEncoding('utf8');
      r.on('data', (chunk) => {
        buf += chunk;
        // SSE frames are separated by a blank line; each `data:` line holds one JSON cmd
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            const m = line.match(/^data:\s?(.*)$/);
            if (!m) continue;
            let cmd; try { cmd = JSON.parse(m[1]); } catch { continue; }
            frames.push(cmd);
            // the daemon turns our notification into:  { cmd:'say', text:'🔔 <marker>', ms? }
            if (cmd && cmd.cmd === 'say' && typeof cmd.text === 'string' && cmd.text.includes(marker)) finish(true);
          }
        }
      });
      r.on('end', () => finish(false));
      r.on('error', () => finish(false));
    });
    req.on('error', () => { onConnected(false); finish(false); });
  });
  return { connected, result };
}

// ---- report ----
function line(sym, label, detail) { console.log(`  ${sym} ${label}${detail ? '  ' + dim(detail) : ''}`); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`animayte selftest — live round-trip connection probe

  node tools/animayte-selftest.mjs [--port <n>] [--timeout <ms>] [--json]

Verifies the pet is connected to THIS session and reacting, end-to-end, over SSE.
Exit 0 = healthy, non-zero = a problem (with the exact remedy printed).`);
    return 0;
  }

  const liveSid = process.env.CLAUDE_CODE_SESSION_ID || null;
  const findings = [];                 // structured findings for --json / the skill
  const remedies = [];                 // ordered remedy lines for the human
  let fail = false;
  const failWith = (code, remedy) => { fail = true; findings.push({ level: 'fail', code }); if (remedy) remedies.push(remedy); };

  if (!args.json) {
    console.log('\n' + bold('🩺 animayte selftest') + dim(`  ·  live round-trip probe  ·  :${args.port}`));
    console.log(dim(`     this session: ${liveSid ? short(liveSid) : '(CLAUDE_CODE_SESSION_ID not set — running outside a CC session)'}`) + '\n');
  }

  // ---- step 1: /health — daemon up? owner vs this session? ----
  const h = await getJson(args.port, '/health', Math.min(args.timeout, 3000));
  const health = h.ok ? h.body : null;
  if (!h.ok || !health || !health.ok) {
    if (!args.json) line(red('✗'), 'daemon not reachable', `http://127.0.0.1:${args.port}/health`);
    findings.push({ level: 'fail', code: 'daemon-down' });
    remedies.push(`Start the pet for this session:  ${bold('/animayte')}   (or  bin/animayte start ).`);
    return finishReport(args, findings, remedies, true, liveSid, null, null);
  }
  if (!args.json) line(green('✓'), 'daemon is up', `clients=${health.clients}, owner=${short(health.owner)}`);
  findings.push({ level: 'ok', code: 'daemon-up', clients: health.clients, owner: health.owner || null });

  // ownership: the silent-death failure mode — owner ≠ this session ⇒ every owned hook is dropped
  let ownershipBlocked = false;
  if (health.owner && liveSid && health.owner !== liveSid) {
    ownershipBlocked = true;
    if (!args.json) line(red('✗'), 'pet is owned by a DIFFERENT session', `owner ${short(health.owner)} ≠ this session ${short(liveSid)}`);
    failWith('ownership-mismatch', `Every hook from this session is being dropped. Claim the pet for THIS session:  ${bold('/animayte')}   (or  bin/animayte start ).`);
  } else if (health.owner && liveSid) {
    if (!args.json) line(green('✓'), 'pet is owned by THIS session', short(health.owner));
    findings.push({ level: 'ok', code: 'ownership-match' });
  } else if (health.owner && !liveSid) {
    // we can't compare — but we CAN still impersonate the owner for the round-trip (see below)
    if (!args.json) line(yellow('•'), 'cannot compare ownership', 'CLAUDE_CODE_SESSION_ID not set — will probe AS the current owner');
    findings.push({ level: 'info', code: 'no-live-sid' });
  } else {
    if (!args.json) line(yellow('•'), 'pet is not bound to a session', 'accepts events from any session (single-session default)');
    findings.push({ level: 'info', code: 'no-owner' });
  }

  // no window connected: the pet daemon is up but nothing is rendering — the round-trip can still
  // PASS (the daemon broadcasts to 0 clients fine), but the human sees nothing, so surface it.
  if (health.clients === 0) {
    if (!args.json) line(yellow('•'), 'no pet window connected', 'clients=0 — the daemon has no renderer attached');
    findings.push({ level: 'warn', code: 'no-clients' });
    remedies.push(`No pet WINDOW is connected (clients=0). Open one:  ${bold('/animayte')}  (native), or point a browser at  http://127.0.0.1:${args.port}`);
  }

  // ---- step 2: the live round-trip over SSE ----
  // Use a session_id the daemon WILL accept for the probe: the live session if it matches/owns,
  // else the current owner (so we test the real reaction path even from a helper shell). If owner ≠
  // live session we already flagged the mismatch above; we still drive the probe AS the owner to
  // prove the stream itself works (separating "owned by someone else" from "the stream is broken").
  const probeSid = ownershipBlocked ? health.owner : (liveSid || health.owner || null);
  const marker = 'selftest-' + randomBytes(4).toString('hex');     // short: survives say()'s 48-char slice
  const { connected, result } = openSseWaiter(args.port, marker, args.timeout);
  const streamUp = await connected;     // wait until our SSE client is actually subscribed
  if (!streamUp) {
    if (!args.json) line(red('✗'), 'could not open the SSE stream', `GET /events on :${args.port}`);
    failWith('sse-unreachable', `The event stream (GET /events) wouldn't open. Restart the pet:  bin/animayte restart .`);
    const rt = await result;     // drain
    return finishReport(args, findings, remedies, fail, liveSid, health, rt);
  }

  // POST a synthetic OWNED Notification carrying the marker. A plain (non-permission/non-waiting)
  // notification becomes a `say` of "🔔 <marker>" — our beacon. session_id makes it pass ownsEvent.
  const post = await postJson(args.port, '/event', { session_id: probeSid, hook_event_name: 'Notification', message: marker }, Math.min(args.timeout, 3000));
  if (!post.ok) {
    if (!args.json) line(red('✗'), 'could not POST the probe event', '/event');
    failWith('event-post-failed', `Couldn't POST to /event. Restart the pet:  bin/animayte restart .`);
  }

  const rt = await result;       // wait for the marker to come back (or timeout)
  if (rt.hit) {
    if (!args.json) line(green('✓'), 'round-trip confirmed', `event → daemon → SSE reaction in <${args.timeout}ms`);
    findings.push({ level: 'ok', code: 'roundtrip' });
  } else {
    if (!args.json) line(red('✗'), 'no reaction came back on the SSE stream', `waited ${args.timeout}ms (saw ${rt.frames.length} frame(s))`);
    // distinguish WHY it didn't round-trip → the most actionable remedy
    if (ownershipBlocked) {
      failWith('roundtrip-blocked-ownership', `The reaction never arrived because the pet is owned by ${short(health.owner)}, not this session. Claim it:  ${bold('/animayte')} .`);
    } else {
      failWith('roundtrip-timeout', `The daemon accepted the event but no reaction reached the stream in ${args.timeout}ms — try a longer  --timeout , then  bin/animayte restart .`);
    }
  }

  return finishReport(args, findings, remedies, fail, liveSid, health, rt);
}

function finishReport(args, findings, remedies, fail, liveSid, health, rt) {
  if (args.json) {
    console.log(JSON.stringify({ ok: !fail, port: args.port, liveSession: liveSid, owner: health ? (health.owner || null) : null, clients: health ? health.clients : null, findings, remedies: remedies.map((r) => r.replace(/\x1b\[[0-9;]*m/g, '')) }, null, 2));
    return fail ? 1 : 0;
  }
  console.log('');
  if (!fail) {
    console.log('  ' + green(bold('PASS')) + dim('  — the pet is connected and reacting to this session.'));
    // a soft note if there's no window even though the wire works
    if (health && health.clients === 0) console.log('  ' + yellow('note:') + dim(' the daemon works, but no pet WINDOW is open — run /animayte to see it.'));
  } else {
    console.log('  ' + red(bold('FAIL')) + dim('  — the pet is NOT reliably reacting to this session.'));
    console.log('');
    console.log('  ' + bold('Remedy:'));
    for (const r of remedies) console.log('    • ' + r);
  }
  console.log('');
  return fail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => { console.error('animayte selftest — unexpected error:', (e && e.message) || e); process.exit(2); });
