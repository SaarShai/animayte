#!/usr/bin/env node
/*
 * animayte statusline — reads Claude Code's rich statusline JSON on stdin,
 * forwards it to the daemon (so the pet gets real context %, cost, rate limits,
 * effort, model…), and prints a compact one-line status that doubles as a
 * tiny text version of the pet. Configured via settings.json `statusLine`.
 *
 * Safe: if the daemon is off, forwarding silently fails and we still print.
 */
import http from 'node:http';

const PORT = process.env.ANIMAYTE_PORT ? Number(process.env.ANIMAYTE_PORT) : 4321;
const MOOD_EMOJI = { idle: '🙂', listening: '👂', working: '⚙️', happy: '😄', excited: '🤩', oops: '😬', bashful: '☺️', tired: '😪', sleepy: '😴' };

let s = '';
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  let j = {}; try { j = JSON.parse(s || '{}'); } catch {}

  // forward to daemon (fire-and-forget, tiny timeout)
  try {
    const data = Buffer.from(s || '{}');
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/status', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 350 },
      (res) => { res.resume(); });
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.write(data); req.end();
  } catch {}

  // compact, glanceable status line
  const cw = j.context_window || {};
  const pct = typeof cw.used_percentage === 'number' ? Math.round(cw.used_percentage) : null;
  const bar = pct == null ? '' : (() => {
    const n = Math.round(pct / 10);
    return ' [' + '█'.repeat(n) + '░'.repeat(10 - n) + ']';
  })();
  const model = (j.model && (j.model.display_name || j.model.id)) || '';
  const cost = j.cost && typeof j.cost.total_cost_usd === 'number' ? ` $${j.cost.total_cost_usd.toFixed(2)}` : '';
  const face = pct == null ? '🐣' : pct > 85 ? '😪' : pct > 60 ? '😅' : '🙂';

  const parts = [`${face} animayte`];
  if (model) parts.push(model);
  if (pct != null) parts.push(`ctx ${pct}%${bar}`);
  if (cost) parts.push(cost.trim());
  process.stdout.write(parts.join('  ·  '));
});
