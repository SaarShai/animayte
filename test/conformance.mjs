#!/usr/bin/env node
/*
 * animayte — RENDERER CONFORMANCE GOLDEN (C2). The drift guard.
 *
 * Pins the engine's deterministic output so any renderer (web / preview / native) — or
 * any accidental change to easing/transform/clip-data/state-machine — that diverges fails
 * `npm test`. Two goldens:
 *   1. clips:    for canonical (clip, t) samples → { cell, transform{sx,sy,tx,ty,rot} }
 *   2. timeline: a replayed session → (kind, clip, expression, prop, birds) sequence
 *
 * Intentionally changed the engine/art? Regenerate the golden:
 *   node test/conformance.mjs --update
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSlimeManifest } from '../lib/anim/manifest.mjs';
import { sampleTrack, identity } from '../lib/anim/transform.mjs';
import { frameAt, clipDuration } from '../lib/anim/state-machine.mjs';
import { replaySession, SESSIONS } from '../tools/simulate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'conformance.golden.json');
const SAMPLE_TS = [0, 0.25, 0.5, 0.75, 0.99];
const r4 = (v) => Math.round(v * 10000) / 10000;

/** The canonical engine output for every clip at the sample times + a replayed timeline. */
export function computeGolden() {
  const m = buildSlimeManifest();
  const clips = {};
  for (const [name, clip] of Object.entries(m.clips)) {
    const total = clipDuration(clip);
    clips[name] = SAMPLE_TS.map((t) => {
      const fa = frameAt(clip, t * total);
      const fr = clip.frames[fa.index] || {};
      const tf = clip.tracks && clip.tracks.body ? sampleTrack(clip.tracks.body, t) : identity();
      return { t, cell: fr.cell != null ? fr.cell : fa.index, sx: r4(tf.sx), sy: r4(tf.sy), tx: r4(tf.tx), ty: r4(tf.ty), rot: r4(tf.rot) };
    });
  }
  // a replayed session timeline (drops volatile timestamps; keeps the visible sequence)
  const timeline = replaySession(SESSIONS.happy).map((e) => ({ event: e.event, kind: e.kind, clip: e.clip, expression: e.expression, prop: e.prop || null, birds: e.birds }));
  return { format: 'animayte-conformance/1', cell: m.cell, expressions: Object.keys(m.expressions), clips, timeline };
}

// ── --update: (re)write the golden, then exit ──
if (process.argv.includes('--update')) {
  writeFileSync(GOLDEN, JSON.stringify(computeGolden(), null, 2) + '\n');
  console.log('✓ wrote', GOLDEN);
  process.exit(0);
}

// ── compare current engine output against the committed golden ──
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } };

console.log('\nRenderer conformance — golden (state,t) → output (drift guard)\n');

if (!existsSync(GOLDEN)) {
  console.log('❌  no golden found — run: node test/conformance.mjs --update');
  process.exit(1);
}
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
const current = computeGolden();

ok('cell size matches golden', current.cell === golden.cell);
ok('expression rows match golden (order is the sheet row order)', JSON.stringify(current.expressions) === JSON.stringify(golden.expressions));

// clip-by-clip transform/cell conformance
const gClips = Object.keys(golden.clips);
ok('clip set matches golden', JSON.stringify(Object.keys(current.clips).sort()) === JSON.stringify(gClips.slice().sort()));
for (const name of gClips) {
  const g = golden.clips[name], c = current.clips[name];
  ok(`clip "${name}" sample count matches`, !!c && c.length === g.length);
  if (!c) continue;
  for (let i = 0; i < g.length; i++) {
    ok(`clip "${name}" @t=${g[i].t} → exact {cell,transform}`, JSON.stringify(c[i]) === JSON.stringify(g[i]));
  }
}

// session timeline conformance (the visible sequence a renderer must reproduce)
ok('session timeline length matches', current.timeline.length === golden.timeline.length);
for (let i = 0; i < golden.timeline.length; i++) {
  ok(`timeline[${i}] (${golden.timeline[i].event}) matches`, JSON.stringify(current.timeline[i]) === JSON.stringify(golden.timeline[i]));
}

const total = pass + fail;
console.log(`${fail === 0 ? '✅' : '❌'}  ${pass}/${total} conformance checks passed` + (fail ? `, ${fail} FAILED (engine output drifted from the golden — if intentional: node test/conformance.mjs --update):` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
