#!/usr/bin/env node
/*
 * animayte · map-session — run a REAL session transcript through the detector and print
 * a reviewable map: for each assistant message, what feeling it triggers (+ why) and what
 * the pet would actually show (salience over the last 4 messages, like the daemon).
 *
 *   node grid/map-session.mjs <path-to-transcript.jsonl> [maxMessages]
 *
 * Assistant-text extraction mirrors animayte.mjs readTranscriptTail() exactly, so the map
 * reflects what the live pet would have felt.
 */
import { readFileSync } from 'node:fs';
import { detectExpression, appleFor } from '../lib/expressions.mjs';

const path = process.argv[2];
const cap = Number(process.argv[3] || 60);
if (!path) { console.error('usage: node grid/map-session.mjs <transcript.jsonl> [maxMessages]'); process.exit(2); }

// ── extract assistant texts, chronological (same shape the daemon reads) ──────
const lines = readFileSync(path, 'utf8').split('\n');
const messages = [];
for (const raw of lines) {
  const l = raw.trim(); if (!l) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  const msg = o.message || o;
  const isAssistant = msg && (msg.role === 'assistant' || o.type === 'assistant');
  if (isAssistant && Array.isArray(msg.content)) {
    const t = msg.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ').trim();
    if (t) messages.push(t);
  }
}

// salience rule mirrored from animayte.mjs applySentiment (most-salient over last 4)
function pickSalient(windowNewestFirst) {
  let best = null;
  windowNewestFirst.forEach((t, i) => {
    const r = detectExpression(t); if (!r) return;
    const recency = windowNewestFirst.length - i;
    if (!best || r.priority > best.priority || (r.priority === best.priority && recency > best._recency)) best = { ...r, _recency: recency };
  });
  return best;
}

const clip = (s, n) => { const one = s.replace(/\s+/g, ' ').trim(); return (one.length > n ? one.slice(0, n - 1) + '…' : one).replace(/\|/g, '\\|'); };

// for a keyword match, show the surrounding context so a false trigger is obvious
function why(text, det) {
  if (!det) return '*(no emotion)*';
  if (!det.reason.startsWith('kw:')) return det.reason;          // emoji match: self-explanatory
  const kw = det.reason.slice(3);
  const m = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
  if (!m) return det.reason;
  const ctx = text.slice(Math.max(0, m.index - 16), m.index + kw.length + 16).replace(/\s+/g, ' ').trim();
  return `\`${kw}\` ⟨…${clip(ctx, 40)}…⟩`;
}

// ── print a markdown table + a feeling timeline ───────────────────────────────
console.log(`\nSession: ${path.split('/').slice(-1)[0]}  ·  ${messages.length} assistant messages (showing ${Math.min(cap, messages.length)})\n`);
console.log('| # | what the agent said | detected | why | pet shows |');
console.log('|---|---|---|---|---|');
const timeline = [];
let prevPick = null;
messages.slice(0, cap).forEach((text, i) => {
  const det = detectExpression(text);
  const win = messages.slice(0, i + 1).slice(-4).reverse();
  const sal = pickSalient(win);
  const pick = sal ? sal.id : 'neutral';
  const changed = pick !== prevPick; prevPick = pick;
  timeline.push(pick);
  const detLabel = det ? `${det.id} ${appleFor(det.id)}` : '—';
  const showLabel = `${changed ? '**' : ''}${pick} ${appleFor(pick)}${changed ? '**' : ''}`;
  console.log(`| ${i + 1} | ${clip(text, 78)} | ${detLabel} | ${why(text, det)} | ${showLabel} |`);
});

// distribution + timeline
const dist = {};
messages.slice(0, cap).forEach((t) => { const r = detectExpression(t); const k = r ? r.id : '(none)'; dist[k] = (dist[k] || 0) + 1; });
console.log(`\n**detected distribution:** ${Object.entries(dist).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(`**pet-shows timeline:** ${timeline.join(' → ')}\n`);
