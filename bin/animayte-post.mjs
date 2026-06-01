#!/usr/bin/env node
/*
 * animayte hook forwarder — reads the Claude Code hook event JSON on stdin and POSTs it to the
 * daemon's /<endpoint> (default /event). This REPLACES the old `curl` hook command so hooks fire on
 * EVERY platform: on Windows without Git Bash, CC runs the hook through PowerShell, where `curl` is
 * an alias for Invoke-WebRequest (which rejects `--data-binary @-`) — so the curl hooks failed
 * SILENTLY. `node` is guaranteed present (CC requires it) and behaves identically on macOS, Linux,
 * and Windows (cmd/PowerShell), with no shell-quoting traps.
 *
 * Guaranteed fire-and-forget + fail-safe: a short timeout and it ALWAYS exits 0, so a down, slow, or
 * missing daemon can NEVER block or error the user's Claude Code turn (same contract as the old
 * `curl -m 0.4 … || true`). It's the exact mechanism the statusline forwarder already uses in prod.
 *
 *   usage:  node animayte-post.mjs [endpoint=event] [port]
 *           port falls back to $ANIMAYTE_PORT, then 4321.
 */
import http from 'node:http';

const endpoint = String(process.argv[2] || 'event').replace(/^\/+/, '');
const PORT = Number(process.argv[3]) || Number(process.env.ANIMAYTE_PORT) || 4321;

let exited = false;
const done = () => { if (exited) return; exited = true; process.exit(0); };   // ALWAYS exit 0 — never error the session
setTimeout(done, 1500).unref?.();                                             // hard safety net: never hang the hook

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (body.length < 2_000_000) body += d; }); // bound the read (no unbounded buffering)
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try {
    const data = Buffer.from(body || '{}');
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/' + endpoint, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 400 },
      (res) => { res.resume(); res.on('end', done); });
    req.on('error', done);                            // daemon down / refused → swallow
    req.on('timeout', () => { try { req.destroy(); } catch {} done(); });
    req.write(data); req.end();
  } catch { done(); }
});
