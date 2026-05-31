#!/usr/bin/env node
/*
 * animayte · map-appraise — run a REAL session transcript through appraise() (the brain)
 * and emit the RICH per-message FeatureSpec, so the fan-out is visible: the same base
 * feeling spreads across cause / arousal / valence / expectedness instead of collapsing
 * to one flat face. The sibling grid/map-session.mjs shows only the base family (what the
 * detector picks); THIS shows what the appraisal axes make of it.
 *
 *   node test/map-appraise.mjs <transcript.jsonl> [--json grid/maps/x.appraise.json]
 *
 * History is real: a slow mood meter (lib/anim/mood.mjs) drifts with the run, so a setback
 * after a streak of wins reads 'surprising' and one amid an ongoing slump reads 'routine'.
 * Extraction mirrors the daemon / grid/map-session.mjs (Claude Code + Codex shapes).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { appraise } from '../lib/appraise.mjs';
import { createMoodMeter } from '../lib/anim/mood.mjs';

const args = process.argv.slice(2);
const path = args[0];
const jsonIdx = args.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
if (!path) { console.error('usage: node test/map-appraise.mjs <transcript.jsonl> [--json out.json]'); process.exit(2); }

// ── extract assistant texts, chronological (same shape the daemon reads) ────────────────
function extract(p) {
  const out = [];
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const l = raw.trim(); if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const msg = o.message || o.payload || o;
    const isAssistant = msg && (msg.role === 'assistant' || o.type === 'assistant');
    if (isAssistant && Array.isArray(msg.content)) {
      const t = msg.content.filter((b) => (b.type === 'text' || b.type === 'output_text') && b.text).map((b) => b.text).join(' ').trim();
      if (t) out.push(t);
    }
  }
  return out;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const messages = extract(path);

// ── appraise each line, carrying real history (prev valence + slow mood meter) ──────────
const meter = createMoodMeter();
let prevValence = 0;
const rows = [];
for (let i = 0; i < messages.length; i++) {
  const text = messages[i];
  meter.decayStep();                                   // time passed since the last beat
  const spec = appraise({ recentTexts: [text] }, { valence: prevValence, mood: meter.level });
  if (spec) { prevValence = spec.valence; meter.feel(spec.expression); }
  rows.push({
    n: i + 1,
    text: oneLine(text).slice(0, 150),
    mood: Number(meter.level.toFixed(2)),
    spec: spec && { expression: spec.expression, valence: spec.valence, arousal: spec.arousal, cause: spec.cause, expectedness: spec.expectedness, item: spec.item, reason: spec.reason },
  });
}

// ── report — the fan-out, especially within a single base family ────────────────────────
const PAD = (s, n) => String(s).padEnd(n);
console.log(`\nSession: ${path.split('/').slice(-1)[0]}  ·  ${messages.length} assistant messages\n`);
console.log(PAD('#', 3), PAD('expr', 12), PAD('val', 6), PAD('aro', 4), PAD('cause', 9), PAD('expected', 11), PAD('item', 10), 'why');
for (const r of rows) {
  const s = r.spec;
  if (!s) { console.log(PAD(r.n, 3), PAD('· (none)', 12), '', '   ', '', '', '', oneLine(r.text).slice(0, 46)); continue; }
  console.log(PAD(r.n, 3), PAD(s.expression, 12), PAD(s.valence, 6), PAD(s.arousal, 4), PAD(s.cause, 9), PAD(s.expectedness, 11), PAD(s.item || '—', 10), oneLine(r.text).slice(0, 40));
}

// fan-out summary: for each base family, how many DISTINCT (cause,arousal,expectedness) specs?
const byFamily = {};
for (const r of rows) {
  if (!r.spec) continue;
  const fam = r.spec.expression;
  (byFamily[fam] ||= new Set()).add(`${r.spec.cause}/${r.spec.arousal}/${r.spec.expectedness}/${r.spec.valence}`);
}
console.log('\nfan-out (distinct specs per base family):');
for (const [fam, set] of Object.entries(byFamily)) {
  const n = rows.filter((r) => r.spec && r.spec.expression === fam).length;
  console.log(`  ${PAD(fam, 12)} ${n} rows → ${set.size} distinct spec${set.size === 1 ? '' : 's'}`);
}

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  const data = { name: path.split('/').slice(-1)[0], count: messages.length, rows };
  writeFileSync(jsonOut, JSON.stringify(data, null, 0));
  console.log(`\nwrote ${jsonOut}  (${rows.length} rows)`);
}
console.log('');
