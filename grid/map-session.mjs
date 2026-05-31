#!/usr/bin/env node
/*
 * animayte · map-session — run a REAL session transcript through the detector and emit a
 * reviewable map: per assistant message, the detected feeling (+ why) and what the pet
 * would actually show (salience over the last 4 messages, like the daemon).
 *
 *   node grid/map-session.mjs <transcript.jsonl> [maxMessages]            → markdown (stdout)
 *   node grid/map-session.mjs <transcript.jsonl> --json grid/maps/x.json  → data for the viewer
 *
 * Works across agents: Claude Code (o.message|o, content[].text) and Codex
 * (o.payload, role assistant, content[].output_text). Extraction mirrors the daemon.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { detectExpression, appleFor } from '../lib/expressions.mjs';

const args = process.argv.slice(2);
const path = args[0];
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const cap = Number(args.find((a, i) => i > 0 && /^\d+$/.test(a)) || 80);
if (!path) { console.error('usage: node grid/map-session.mjs <transcript.jsonl> [max] [--json out.json]'); process.exit(2); }

// ── extract assistant texts, chronological (same shape the daemon reads) ──────
const messages = [];
for (const raw of readFileSync(path, 'utf8').split('\n')) {
  const l = raw.trim(); if (!l) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  const msg = o.message || o.payload || o;
  const isAssistant = msg && (msg.role === 'assistant' || o.type === 'assistant');
  if (isAssistant && Array.isArray(msg.content)) {
    const t = msg.content.filter((b) => (b.type === 'text' || b.type === 'output_text') && b.text).map((b) => b.text).join(' ').trim();
    if (t) messages.push(t);
  }
}

// salience rule mirrored from animayte.mjs applySentiment (RECENCY-FIRST: the newest
// text carrying a feeling wins; priority arbitrates only within a single text)
function pickSalient(windowNewestFirst) {
  for (const t of windowNewestFirst) {
    const r = detectExpression(t);
    if (r) return r;
  }
  return null;
}
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
function whyText(text, det) {
  if (!det) return 'no emotion';
  if (!det.reason.startsWith('kw:')) return det.reason;
  const kw = det.reason.slice(3);
  const m = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
  if (!m) return det.reason;
  const ctx = oneLine(text.slice(Math.max(0, m.index - 16), m.index + kw.length + 16));
  return `"${kw}" …${ctx}…`;
}

// ── build the row data ─────────────────────────────────────────────────────────
const rows = []; const timeline = []; const dist = {}; let prev = null;
messages.slice(0, cap).forEach((text, i) => {
  const det = detectExpression(text);
  const win = messages.slice(0, i + 1).slice(-4).reverse();
  const sal = pickSalient(win);
  const pick = sal ? sal.id : 'neutral';
  const changed = pick !== prev; prev = pick;
  timeline.push(pick);
  const k = det ? det.id : '(none)'; dist[k] = (dist[k] || 0) + 1;
  rows.push({ n: i + 1, text: oneLine(text).slice(0, 200), detId: det ? det.id : null, detApple: det ? appleFor(det.id) : '', why: whyText(text, det), pick, pickApple: appleFor(pick), changed });
});

const data = { name: path.split('/').slice(-1)[0], count: messages.length, shown: rows.length, rows, dist, timeline };

// ── output ───────────────────────────────────────────────────────────────────
if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(data, null, 0));
  console.log(`wrote ${jsonOut}  (${rows.length} rows)`);
} else {
  console.log(`\nSession: ${data.name}  ·  ${data.count} assistant messages (showing ${rows.length})\n`);
  console.log('| # | what the agent said | detected | why | pet shows |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    const det = r.detId ? `${r.detId} ${r.detApple}` : '—';
    const show = `${r.changed ? '**' : ''}${r.pick} ${r.pickApple}${r.changed ? '**' : ''}`;
    console.log(`| ${r.n} | ${r.text.slice(0, 78).replace(/\|/g, '\\|')} | ${det} | ${r.why.replace(/\|/g, '\\|')} | ${show} |`);
  }
  console.log(`\n**detected:** ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`**timeline:** ${timeline.join(' → ')}\n`);
}
