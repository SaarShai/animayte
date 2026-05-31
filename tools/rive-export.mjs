#!/usr/bin/env node
/*
 * animayte · rive-export — translate OUR library into a Rive-editor BUILD PACKAGE.
 *
 * Rive content is authored in the (proprietary, visual) Rive editor — an agent can't
 * operate it or emit a polished .riv. So instead of hand-rolling a binary serializer
 * (high-risk, and crude shapes would defeat Rive's whole point), this "imports/adapts
 * our library" into the most useful editor-ready form:
 *   rive-export/build-spec.json  — the FULL library as a Rive build plan (artboard,
 *                                  state machine graph, every expression/clip/palette/
 *                                  prop, and how each maps to the contract inputs)
 *   rive-export/slime-body.svg   — our actual slime silhouette as clean vector art the
 *   rive-export/bean-body.svg      designer imports as the base shape (preserves identity)
 *
 * A designer follows docs/rive-build-guide.md with these to reproduce animayte in Rive,
 * faithful to the existing library. Run: node tools/rive-export.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSlimeManifest, buildBeanManifest } from '../lib/anim/manifest.mjs';
import { EXPRESSIONS } from '../lib/expressions.mjs';
import { INPUTS, MOODS, TOOLS, REACTION_TOOL, moodToIndex, reactionToToolIndex } from '../lib/rive/contract.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'rive-export');
mkdirSync(OUT, { recursive: true });

// ── body silhouette → an SVG path (ported from tools/make-assets.mjs half-width fns) ──
const slimeHalfWidth = (t, RX) => { const s = Math.sin(0.30 + t * (Math.PI / 2 - 0.30)); return RX * Math.pow(s, 0.62); };
const beanHalfWidth = (t, RX) => RX * Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - 1, 4)));

function bodySvg(name, halfWidth, palette, { RX = 42, BH = 78, cx = 50, baseY = 92, samples = 28 } = {}) {
  const topY = baseY - BH;
  const left = [], right = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, y = +(topY + t * BH).toFixed(2), hw = +halfWidth(t, RX).toFixed(2);
    left.push([+(cx - hw).toFixed(2), y]); right.push([+(cx + hw).toFixed(2), y]);
  }
  const pts = [...left, ...right.reverse()];
  const d = 'M ' + pts.map((p) => p.join(' ')).join(' L ') + ' Z';
  const p = palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.rim}"/>
      <stop offset="14%" stop-color="${p.highlight}"/>
      <stop offset="45%" stop-color="${p.base}"/>
      <stop offset="78%" stop-color="${p.shadow}"/>
      <stop offset="100%" stop-color="${p.shadowCool}"/>
    </linearGradient>
  </defs>
  <ellipse cx="${cx}" cy="${baseY + 3}" rx="${RX * 0.7}" ry="4" fill="${p.dropShadow}"/>
  <path d="${d}" fill="url(#body)" stroke="${p.outline}" stroke-width="2" stroke-linejoin="round"/>
  <ellipse cx="${cx - RX * 0.32}" cy="${topY + BH * 0.22}" rx="${RX * 0.18}" ry="${RX * 0.22}" fill="${p.rim}" opacity="0.5"/>
  <!-- ${name}: import as the base body shape; the §4.2 ramp is the gradient above; redraw the face per build-spec.json -->
</svg>\n`;
}

// ── the build spec: our whole library, mapped to the Rive contract ──
function buildSpec() {
  const slime = buildSlimeManifest();
  const exprByMood = {};
  for (const ex of EXPRESSIONS) exprByMood[moodToIndex(ex.id)] = { id: ex.id, ...slime.expressions[ex.id], apple: ex.apple, meaning: ex.meaning };
  return {
    format: 'animayte-rive-build/1',
    generatedFrom: ['lib/expressions.mjs', 'lib/anim/manifest.mjs', 'lib/rive/contract.mjs'],
    artboard: 'Pet',
    stateMachine: 'animayte',
    inputs: INPUTS,
    moods: MOODS.map((m, i) => ({ index: i, id: m })),
    tools: TOOLS.map((t, i) => ({ index: i, id: t })),
    palettes: slime.palettes,
    accentColors: slime.accentColors,
    expressions: exprByMood,                                 // mood index → face spec (eyes/mouth/brows/accents)
    clips: slime.clips,                                      // transform tracks → editor timelines (t, sx, sy, tx, ty, ease)
    props: slime.props,
    reactions: Object.fromEntries(Object.entries(slime.reactions).map(([k, r]) => [k, { ...r, toolIndex: reactionToToolIndex(k) }])),
    stateMachineGraph: {
      layers: [
        { name: 'Body/Mood', driver: 'mood (number 0..7)', behaviour: 'a state per expression (or one face artboard with the eyes/mouth/brows swapped by the mood value); blend transitions for a soft change' },
        { name: 'Tool', driver: 'tool (number 0..9)', behaviour: 'a tool-gag pose per category (0=none → hidden); props per TOOLS' },
        { name: 'OneShots', driver: 'triggers', behaviour: 'react/win/error/compact/wake fire transient timelines that auto-return (recovery, never stuck)' },
      ],
      dataBinds: [
        'fullness (0..100) → body Y-scale (swell) AND cross-fade calm→tired palette (the signature)',
        'moodLevel (-100..100) → a cool "stressed" tint floor / warm "up" lift',
        'reduceMotion (bool) → reduce timeline amplitude',
        'birds (0..5) → show N orbiting sub-agent birds (nested artboard, count-driven)',
        'sleeping (bool) → curled-down idle + Z\'s',
      ],
    },
    timingBudgets: { idle: '2–4 frames ~6fps, randomized blink', reactions: '3–5 frames anticipation→extreme→settle', propsPopIn: '2 frames scale' },
    notes: 'Faithful to the existing pixel library; can be pixel-look or vector. The daemon drives the inputs above via lib/rive/driver.mjs — nothing else to wire.',
  };
}

// write the export package only when run directly (importing for tests must not write files)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const spec = buildSpec();
  writeFileSync(join(OUT, 'build-spec.json'), JSON.stringify(spec, null, 2) + '\n');
  const slimeCal = buildSlimeManifest().palettes.calm, beanCal = buildBeanManifest().palettes.calm;
  writeFileSync(join(OUT, 'slime-body.svg'), bodySvg('slime', slimeHalfWidth, slimeCal));
  writeFileSync(join(OUT, 'bean-body.svg'), bodySvg('bean', beanHalfWidth, beanCal, { RX: 38 }));
  console.log(`rive-export/  build-spec.json (${Object.keys(spec.expressions).length} expressions, ${Object.keys(spec.clips).length} clips, ${spec.inputs.length} inputs) + slime-body.svg + bean-body.svg`);
}

export { buildSpec, bodySvg, slimeHalfWidth, beanHalfWidth };
