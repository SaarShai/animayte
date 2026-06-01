#!/usr/bin/env node
/*
 * animayte · NEW-PET SCAFFOLDER — start a new sprite pet pack against the real contract.
 *
 * WHO THIS IS FOR: an ARTIST (or the community) who wants to re-skin animayte without
 * touching the plumbing. animayte's pet is extensible via PET PACKS: a folder with a
 * `pet.json` manifest (schema `animayte-pet/1`) + a `sheet.png` spritesheet (and optional
 * `props.png`). This tool writes that folder, pre-filled so it VALIDATES on day one, and
 * tells you exactly which pictures to draw.
 *
 * WHAT IT GUARANTEES (and why it can't drift): the set of reactions a pet MUST cover and the
 * set of faces it must define are DERIVED FROM THE REAL SOURCE, the same three places the
 * wiring-contract test reads (test/contract.test.mjs):
 *   · tool-gag reactions ← TOOL_EVENTS                         (lib/anim/events.mjs)
 *   · notification gags  ← `cmd:'react', name:'…'` literals    (animayte.mjs, parsed)
 *   · item-bridge gags   ← REACTION_FOR_ITEM values           (animayte.mjs, parsed)
 *   · faces / moods      ← MOOD_EXPRESSION values             (grid/manifest.mjs)
 * So when the daemon learns a new reaction, this scaffolder asks the artist for it too — no
 * hand-kept list to fall out of date. The scaffold is then VALIDATED with the REAL validator
 * (lib/anim/manifest.mjs#validateManifest) before it's written, so a pack can't ship broken.
 *
 * USAGE
 *   node tools/animayte-new-pet.mjs <name> [options]
 *     <name>              pack name (lowercase letters/digits/-/_), e.g. "robo" or "pixel-cat"
 *   options:
 *     --dir <path>       where to create the pack   (default: pets/<name>)
 *     --from slime|bean  copy a real, complete animation library to start from (recommended);
 *                        omit to get a minimal STUB library you flesh out yourself
 *     --force            overwrite a non-empty target directory
 *     --quiet            only print the coverage summary + created files
 *     --help             this help
 *
 * SELF-TEST (no args needed — scaffolds into a temp dir, asserts it validates, then breaks it
 * and asserts validation FAILS with a clear message):
 *   node tools/animayte-new-pet.mjs --selftest
 *
 * It ONLY writes files under the target dir. It never spawns a daemon, never touches git,
 * :4321, or ~/.claude. Zero dependencies — Node builtins only.
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { validateManifest, FORMAT, LAYERS, buildSlimeManifest, buildBeanManifest } from '../lib/anim/manifest.mjs';
import { TOOL_EVENTS } from '../lib/anim/events.mjs';
import { MOOD_EXPRESSION } from '../grid/manifest.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// ── tiny ANSI (auto-off when not a TTY / NO_COLOR) ──────────────────────────────────────────
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36');

// ════════════════════════════════════════════════════════════════════════════════════════════
//  DERIVE THE CONTRACT FROM REAL SOURCE — so the scaffold can never drift from the daemon.
//  (Mirrors how test/contract.test.mjs computes the closed react-name set.)
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Parse the daemon source for the react names it can put on the wire (besides the tool gags). */
function reactNamesFromDaemon() {
  let src = '';
  try { src = readFileSync(join(ROOT, 'animayte.mjs'), 'utf8'); } catch { return { hardcoded: [], bridge: [] }; }
  // hardcoded notification reacts: broadcast({ cmd: 'react', name: 'Asking' })
  const hardcoded = [...src.matchAll(/cmd:\s*'react',\s*name:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
  // the transitional item→reaction bridge: const REACTION_FOR_ITEM = { hammer: 'Writing', … }
  const blk = src.match(/REACTION_FOR_ITEM\s*=\s*\{([^}]*)\}/);
  const bridge = blk ? [...blk[1].matchAll(/:\s*'([A-Za-z]+)'/g)].map((m) => m[1]) : [];
  return { hardcoded: [...new Set(hardcoded)], bridge: [...new Set(bridge)] };
}

/**
 * The full contract a pet must satisfy, derived live:
 *   reactions  — every `react` name the daemon can emit (must exist in pet.reactions)
 *   faces      — every expression id the daemon can ask for via mood/express (MOOD_EXPRESSION values)
 */
function deriveContract() {
  const { hardcoded, bridge } = reactNamesFromDaemon();
  const reactions = [...new Set([...TOOL_EVENTS, ...hardcoded, ...bridge])].sort();
  const faces = [...new Set(Object.values(MOOD_EXPRESSION))].sort();
  return {
    reactions,
    faces,
    provenance: {
      toolGags: 'lib/anim/events.mjs#TOOL_EVENTS',
      notifGags: 'animayte.mjs (cmd:react literals)',
      itemBridge: 'animayte.mjs#REACTION_FOR_ITEM',
      faces: 'grid/manifest.mjs#MOOD_EXPRESSION',
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  SCAFFOLD — build a valid `animayte-pet/1` manifest for a brand-new pack.
// ════════════════════════════════════════════════════════════════════════════════════════════

// A neutral starter ramp (cool shadow → warm rim) the artist recolors. EVERY palette exposes
// the SAME roles (the validator requires it for a clean mood-swap re-index). Roles mirror the
// slime's so a renderer that reads them by name finds what it expects.
const ROLES = ['shadowCool', 'shadow', 'base', 'highlight', 'rim', 'outline', 'halo', 'dropShadow', 'eyeDark', 'catchlight', 'blush'];
const STARTER_PALETTES = {
  // resting look — a friendly mid-tone the artist replaces with the pet's real hue
  calm:  { shadowCool: '#3A3A52', shadow: '#5A5A78', base: '#8A8AB0', highlight: '#B8B8D8', rim: '#E8E8F4', outline: '#26263A', halo: '#FFFFFF4D', dropShadow: '#1A1A2659', eyeDark: '#26263A', catchlight: '#F4F4FB', blush: '#F6757A' },
  // drained / context-full — shift cooler & desaturated
  tired: { shadowCool: '#2E3640', shadow: '#4A5662', base: '#73828E', highlight: '#A0AEB8', rim: '#D2DCE2', outline: '#202830', halo: '#FFFFFF40', dropShadow: '#16202659', eyeDark: '#202830', catchlight: '#EEF3F6', blush: '#D69BA0' },
  // brief error flash — never STAYS red (the state machine snaps back)
  error: { shadowCool: '#5A1E22', shadow: '#8E2C30', base: '#E04A4A', highlight: '#F58A6A', rim: '#FDE0C0', outline: '#3A1416', halo: '#FFFFFF4D', dropShadow: '#2A0E1059', eyeDark: '#3A1416', catchlight: '#FFF0E8', blush: '#FF9BA0' },
};

// Sensible default face features per mood id, drawn from the feature vocabulary the slime uses
// (eyes/mouth/brows/accents). The artist redraws the pixels; these just make a coherent stub
// that VALIDATES and gives the spritesheet rows their meaning.
const FACE_DEFAULTS = {
  neutral:     { eyes: 'dots',      mouth: 'slight_smile' },
  thinking:    { eyes: 'look_up',   mouth: 'flat_skew',  brows: 'one_raised' },
  happy:       { eyes: 'happy_arc', mouth: 'open_smile', accents: ['blush'] },
  excited:     { eyes: 'stars',     mouth: 'big_grin',   accents: ['blush'] },
  oops:        { eyes: 'open',      mouth: 'awkward',    brows: 'worried', accents: ['sweat'] },
  embarrassed: { eyes: 'wide',      mouth: 'small',      accents: ['flush'] },
  sad:         { eyes: 'open',      mouth: 'frown',      brows: 'sad' },
  sleepy:      { eyes: 'closed',    mouth: 'small',      accents: ['zzz'] },
};
const faceFor = (id) => FACE_DEFAULTS[id] || { eyes: 'dots', mouth: 'small' };

// A held prop suggestion per reaction so the stub is legible ("what's it doing?"). These are
// just names the artist draws into props.png; unmapped reactions get no prop (still valid).
const PROP_FOR_REACTION = {
  Reading: 'book', Searching: 'magnifier', Writing: 'pencil', Running: 'dust', Testing: 'ellipsis',
  Installing: 'ellipsis', Committing: 'check', Fetching: 'telescope', Planning: 'checklist',
  Asking: 'question', Waiting: 'ellipsis', Idea: 'idea',
};
// A face suggestion per reaction (falls back to thinking — "I'm busy").
const FACE_FOR_REACTION = {
  Committing: 'happy', Testing: 'oops', Installing: 'neutral', Waiting: 'neutral', Idea: 'excited',
};

/**
 * Build a self-contained STUB manifest for `name` covering the whole derived contract.
 * Every reaction gets its own loopable stub clip + the right face; idle/blink are real enough
 * to animate. The artist swaps art + tunes timing; the SHAPE is correct and validates.
 */
function buildStubManifest(name, contract) {
  // expressions: one per required face id
  const expressions = {};
  for (const id of contract.faces) {
    const f = faceFor(id);
    const e = { eyes: f.eyes, mouth: f.mouth };
    if (f.brows) e.brows = f.brows;
    if (f.accents) e.accents = f.accents;
    expressions[id] = e;
  }

  // clips: a breathing idle, a blink, a generic react beat, the secondary fidget pool + bored,
  // and ONE loopable stub clip per reaction (named lowercased). cell 3 is the blink column —
  // breathing avoids it so the runtime can fire its own randomized blinks.
  const loop4 = (dur, cells = [0, 1, 2, 1]) => ({ loop: true, frames: cells.map((cell) => ({ dur, cell })) });
  const clips = {
    idle: { loop: true, frames: [{ dur: 460, cell: 0 }, { dur: 460, cell: 1 }, { dur: 460, cell: 2 }, { dur: 460, cell: 1 }],
            tracks: { body: [{ t: 0, sy: 1, ty: 0 }, { t: 0.5, sy: 1.03, ty: -1, ease: 'easeInOutSine' }, { t: 1, sy: 1, ty: 0, ease: 'easeInOutSine' }] } },
    blink: { loop: false, frames: [{ dur: 110, cell: 3 }] },
    react: { loop: false, frames: [{ dur: 80, cell: 0 }, { dur: 110, cell: 1 }, { dur: 140, cell: 2 }, { dur: 160, cell: 1 }],
             tracks: { body: [{ t: 0, sy: 1 }, { t: 0.2, sy: 0.88, ease: 'easeOutQuad' }, { t: 0.5, sy: 1.16, ease: 'easeOutBack' }, { t: 1, sy: 1, ease: 'easeOutBounce' }] } },
    sway: { loop: false, frames: [{ dur: 230, cell: 0 }, { dur: 230, cell: 1 }, { dur: 230, cell: 2 }, { dur: 230, cell: 1 }],
            tracks: { body: [{ t: 0, tx: 0, rot: 0 }, { t: 0.3, tx: -3, rot: -0.05, ease: 'easeInOutSine' }, { t: 0.7, tx: 3, rot: 0.05, ease: 'easeInOutSine' }, { t: 1, tx: 0, rot: 0, ease: 'easeInOutSine' }] } },
    bounce: { loop: false, frames: [{ dur: 120, cell: 0 }, { dur: 150, cell: 2 }, { dur: 150, cell: 1 }, { dur: 140, cell: 0 }],
              tracks: { body: [{ t: 0, sy: 1, ty: 0 }, { t: 0.2, sy: 0.9, ease: 'easeOutQuad' }, { t: 0.5, sy: 1.08, ty: -7, ease: 'easeOutQuad' }, { t: 1, sy: 1, ty: 0, ease: 'easeOutBounce' }] } },
    doze: { loop: true, frames: [{ dur: 900, cell: 3 }, { dur: 900, cell: 3 }],
            tracks: { body: [{ t: 0, sy: 1, ty: 0 }, { t: 0.5, sy: 0.97, ty: 1, ease: 'easeInOutSine' }, { t: 1, sy: 1, ty: 0, ease: 'easeInOutSine' }] } },
  };
  // one stub clip per reaction (lowercased name). Committing returns to idle (a one-shot stamp);
  // the rest loop while the tool runs.
  for (const r of contract.reactions) {
    const key = r.toLowerCase();
    if (clips[key]) continue;
    clips[key] = key === 'committing'
      ? { loop: false, frames: [{ dur: 110, cell: 0 }, { dur: 130, cell: 2 }, { dur: 170, cell: 1 }],
          tracks: { body: [{ t: 0, sy: 1, ty: 0 }, { t: 0.3, sy: 0.84, ty: 3, ease: 'easeOutQuad' }, { t: 1, sy: 1, ty: 0, ease: 'easeOutBounce' }] } }
      : loop4(360);
  }

  // props referenced by the stub reactions (deduped). cell = column in props.png the artist draws.
  const props = {};
  const wantedProps = [...new Set(contract.reactions.map((r) => PROP_FOR_REACTION[r]).filter(Boolean))];
  wantedProps.forEach((p, i) => { props[p] = { cell: i, anchor: [0.75, 0.16], pop: 2 }; });

  // reactions: map every required name → its stub clip + face (+ prop if suggested).
  const reactions = {};
  for (const r of contract.reactions) {
    const entry = {
      clip: clips[r.toLowerCase()] ? r.toLowerCase() : 'react',
      expression: FACE_FOR_REACTION[r] && expressions[FACE_FOR_REACTION[r]] ? FACE_FOR_REACTION[r] : (expressions.thinking ? 'thinking' : contract.faces[0]),
      palette: 'calm',
      priority: 2,
      return: 'idle',
    };
    const prop = PROP_FOR_REACTION[r];
    if (prop && props[prop]) entry.prop = prop;
    reactions[r] = entry;
  }

  return {
    format: FORMAT,
    name,
    cell: 64,
    anchor: [0.5, 1],
    sheet: 'sheet.png',
    propSheet: 'props.png',
    propCell: 24,
    layers: [...LAYERS],
    palettes: STARTER_PALETTES,
    defaultPalette: 'calm',
    expressions,
    clips,
    props,
    reactions,
    idle: { base: 'idle', blink: { minMs: 3000, maxMs: 6000 }, secondary: ['sway', 'bounce'], boredClip: 'doze', boredAfterMs: 30000 },
    source: { scaffoldedBy: 'tools/animayte-new-pet.mjs', contract: contract.provenance },
  };
}

/** Build a manifest by copying a real, complete library (slime/bean) and re-skinning the name. */
function buildFromTemplate(name, from) {
  const base = from === 'bean' ? buildBeanManifest() : buildSlimeManifest();
  return {
    ...base,
    name,
    source: { scaffoldedBy: 'tools/animayte-new-pet.mjs', from, note: `copied the ${from} animation library; redraw sheet.png/props.png and recolor palettes` },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  COVERAGE — report exactly what art the pack still needs.
// ════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Given a manifest + the derived contract, compute what's covered vs. still-needed. A reaction
 * counts as covered iff it is present in m.reactions; a face iff present in m.expressions.
 */
function coverage(m, contract) {
  const haveReacts = new Set(Object.keys(m.reactions || {}));
  const haveFaces = new Set(Object.keys(m.expressions || {}));
  const missingReacts = contract.reactions.filter((r) => !haveReacts.has(r));
  const missingFaces = contract.faces.filter((f) => !haveFaces.has(f));
  // expressions referenced by reactions but not defined (would be a dangling reference)
  const danglingExpr = [];
  for (const [rn, r] of Object.entries(m.reactions || {})) if (r.expression && !haveFaces.has(r.expression)) danglingExpr.push(`${rn}→${r.expression}`);
  return { missingReacts, missingFaces, danglingExpr,
    reactsCovered: contract.reactions.length - missingReacts.length, reactsTotal: contract.reactions.length,
    facesCovered: contract.faces.length - missingFaces.length, facesTotal: contract.faces.length };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  FILE WRITERS — pet.json, README checklist, assets/ placeholder layout.
// ════════════════════════════════════════════════════════════════════════════════════════════

function readmeFor(name, m, contract, cov) {
  const sheetRows = Object.keys(m.expressions).map((id, i) => `  - row ${i}: \`${id}\` — ${m.expressions[id].eyes} eyes / ${m.expressions[id].mouth} mouth${m.expressions[id].brows ? ' / ' + m.expressions[id].brows + ' brows' : ''}${m.expressions[id].accents ? ' / accents: ' + m.expressions[id].accents.join(', ') : ''}`).join('\n');
  const propRows = Object.keys(m.props || {}).map((p, i) => `  - col ${m.props[p].cell ?? i}: \`${p}\``).join('\n') || '  _(no props yet — add props.png columns and reference them from reactions)_';
  const reactList = contract.reactions.map((r) => `  - [ ] \`${r}\` → clip \`${m.reactions[r]?.clip}\`, face \`${m.reactions[r]?.expression}\`${m.reactions[r]?.prop ? ', prop `' + m.reactions[r].prop + '`' : ''}`).join('\n');
  const faceList = contract.faces.map((f) => `  - [ ] \`${f}\` (spritesheet row "${f}")`).join('\n');

  return `# ${name} — an animayte pet pack

Scaffolded by \`tools/animayte-new-pet.mjs\` to the **\`${FORMAT}\`** schema. This pack already
**validates** — it's a working skeleton with placeholder art. Your job: replace the placeholder
pixels and tune the motion. Nothing here touches the plumbing.

> This is the **sprite pet-pack path** (\`pets/<name>/pet.json\` + \`sheet.png\`). The LIVE
> on-screen pet ("Dijon") is a different, **procedural** renderer whose art lives in \`grid/\`
> (art-team territory) — it is NOT a sprite pack. See \`docs/ARCHITECTURE.md\` and
> \`docs/making-a-pet-pack.md\`.

## 1. What to draw

### \`sheet.png\` — the spritesheet  (\`cell\` = ${m.cell}px square per frame)
Rows = expressions **in this exact order** (row 0 first). Columns = animation frames; keep the
eye/mouth spacing constant across a row. **Column 3 is the blink frame** (eyes closed) — the
breathing clip avoids it so the runtime can blink on its own timer.

${sheetRows}

### \`props.png\` — the prop / emote strip  (\`propCell\` = ${m.propCell ?? 24}px square per cell)
One column per prop, in this order:

${propRows}

## 2. Coverage checklist  (derived live from the daemon — see provenance below)

You must provide a face + a clip for everything the daemon can emit. ${cov.missingReacts.length || cov.missingFaces.length ? red('Some are still stubs.') : green('All present (as stubs) ✓')}

**Faces / moods (${cov.facesCovered}/${cov.facesTotal})** — the daemon sets these via \`mood\`/\`express\`:
${faceList}

**Reactions (${cov.reactsCovered}/${cov.reactsTotal})** — the daemon plays these via \`react\`:
${reactList}

## 3. Validate & preview

\`\`\`bash
# VALIDATE after every edit (every error names its exact JSON path):
node -e "import('./lib/anim/manifest.mjs').then(m=>{const e=m.validateManifest(JSON.parse(require('fs').readFileSync('${name === 'pet' ? './pet.json' : 'pets/' + name + '/pet.json'}','utf8')));console.log(e.length?e.join('\\n'):'valid ✓')})"
# (or run the animayte-lint skill / tools/animayte-lint.mjs if present — same checks, nicer report)

# PREVIEW — point the live pet at this pack and watch it on screen:
ANIMAYTE_PET=${name} node animayte.mjs        # daemon on http://127.0.0.1:4321 — then run /animayte
node tools/animayte-gallery.mjs               # drive every reaction on demand (run /animayte first)
\`\`\`

The loader (\`lib/anim/loader.mjs\`) also validates this manifest with
\`lib/anim/manifest.mjs#validateManifest\` and refuses to load it if malformed.

## Provenance (why the checklist can't go stale)

The required set is derived from the real source at scaffold time, not a hand-kept list:

- reactions ← \`${contract.provenance.toolGags}\` + \`${contract.provenance.notifGags}\` + \`${contract.provenance.itemBridge}\`
- faces ← \`${contract.provenance.faces}\`
`;
}

const ASSET_README = `# assets/ — working files (optional, not loaded at runtime)

Keep your editable sources here (Aseprite \`.aseprite\`, layered \`.psd\`, reference PNGs, a
palette swatch). The RUNTIME only reads the BAKED files in the pack root:

  ../sheet.png    rows = expressions (see ../README.md §1), cols = frames, cell×cell each
  ../props.png    one column per prop (propCell×propCell each)

Export/flatten from here into the pack root when you're happy. Suggested layout:

  body/      the creature's body frames (idle breathe, react squash/stretch, fidgets)
  faces/     one file per expression row (neutral, thinking, happy, …)
  props/     one file per prop (book, magnifier, …)
  palette.png  your color ramp (shadowCool → rim) for quick recolors
`;

/** Write the whole pack to `dir`. Returns the list of created file paths. */
function writePack(dir, name, m, contract, cov) {
  const created = [];
  const put = (rel, data) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); created.push(p); };
  put('pet.json', JSON.stringify(m, null, 2) + '\n');
  put('README.md', readmeFor(name, m, contract, cov));
  put('assets/README.md', ASSET_README);
  put('assets/body/.gitkeep', '');
  put('assets/faces/.gitkeep', '');
  put('assets/props/.gitkeep', '');
  return created;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  CLI
// ════════════════════════════════════════════════════════════════════════════════════════════

const HELP = `${bold('animayte-new-pet')} — scaffold a new sprite pet pack (schema ${FORMAT})

${bold('USAGE')}
  node tools/animayte-new-pet.mjs <name> [options]

${bold('ARGUMENTS')}
  <name>              pack name: lowercase letters, digits, '-' or '_' (e.g. robo, pixel-cat)

${bold('OPTIONS')}
  --dir <path>       where to create the pack            (default: pets/<name>)
  --from slime|bean  copy a real, complete animation library to start from (recommended)
                     omit for a minimal STUB library you flesh out yourself
  --force            overwrite a non-empty target directory
  --quiet            print only the coverage summary + created files
  --selftest         scaffold to a temp dir, prove it validates, then prove a break FAILS
  --help, -h         show this help

${bold('EXAMPLES')}
  node tools/animayte-new-pet.mjs robo
  node tools/animayte-new-pet.mjs pixel-cat --from slime
  node tools/animayte-new-pet.mjs my-pet --dir /tmp/my-pet --force

The required reactions + faces are ${bold('derived from the real daemon source')}, so the
scaffold can't drift. The pack is ${bold('validated with the real schema')} before it's written.`;

function parseArgs(argv) {
  const a = { _: [], from: null, dir: null, force: false, quiet: false, help: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') a.help = true;
    else if (t === '--force') a.force = true;
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--selftest') a.selftest = true;
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--dir') a.dir = argv[++i];
    else if (t.startsWith('--from=')) a.from = t.slice(7);
    else if (t.startsWith('--dir=')) a.dir = t.slice(6);
    else if (t.startsWith('-')) { console.error(red(`unknown option: ${t}`)); process.exit(2); }
    else a._.push(t);
  }
  return a;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
function validateName(name) {
  if (!name) return 'a pack <name> is required (e.g. "robo")';
  if (!NAME_RE.test(name)) return `invalid name "${name}" — use lowercase letters, digits, '-' or '_', starting alphanumeric`;
  return null;
}

function dirIsNonEmpty(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

/** Core scaffold op shared by the CLI and the self-test. Returns { dir, manifest, created, cov, contract }. */
function scaffold({ name, dir, from, force }) {
  const contract = deriveContract();
  const manifest = from ? buildFromTemplate(name, from) : buildStubManifest(name, contract);

  // VALIDATE with the real schema BEFORE writing — never emit a broken pack.
  const errs = validateManifest(manifest);
  if (errs.length) throw new Error(`internal: scaffolded manifest failed the real validator:\n  - ${errs.join('\n  - ')}`);

  if (existsSync(dir) && dirIsNonEmpty(dir) && !force) {
    const e = new Error(`target dir is not empty: ${dir}\n  pass --force to overwrite, or choose another --dir`);
    e.code = 'ENOTEMPTY_REFUSE';
    throw e;
  }
  mkdirSync(dir, { recursive: true });
  const cov = coverage(manifest, contract);
  const created = writePack(dir, name, manifest, contract, cov);
  return { dir, manifest, created, cov, contract };
}

function printReport({ name, dir, from, manifest, created, cov, contract }, quiet) {
  const line = (s = '') => process.stdout.write(s + '\n');
  if (!quiet) {
    line('');
    line(bold(`🎨 scaffolded pet pack "${name}"`) + dim(`  (${from ? 'from ' + from : 'stub library'})`));
    line(dim('   ' + dir));
    line('');
    line(bold('contract derived from real source:'));
    line(dim('   reactions ← ') + contract.provenance.toolGags + dim(' + ') + 'notif/bridge literals in animayte.mjs');
    line(dim('   faces     ← ') + contract.provenance.faces);
    line('');
  }
  // coverage summary (always)
  const reactsOk = cov.missingReacts.length === 0;
  const facesOk = cov.missingFaces.length === 0;
  line(bold('coverage:'));
  line(`  faces      ${facesOk ? green(`${cov.facesCovered}/${cov.facesTotal} ✓`) : yellow(`${cov.facesCovered}/${cov.facesTotal}`)}   ` + dim('(' + Object.keys(manifest.expressions).join(', ') + ')'));
  line(`  reactions  ${reactsOk ? green(`${cov.reactsCovered}/${cov.reactsTotal} ✓`) : yellow(`${cov.reactsCovered}/${cov.reactsTotal}`)}`);
  if (cov.missingFaces.length) line(yellow('  you still need art for faces:    ') + cov.missingFaces.join(', '));
  if (cov.missingReacts.length) line(yellow('  you still need art for reactions: ') + cov.missingReacts.join(', '));
  if (cov.danglingExpr.length) line(red('  ⚠ reactions referencing undefined faces: ') + cov.danglingExpr.join(', '));
  if (reactsOk && facesOk && !cov.danglingExpr.length) line(green('  every reaction + face is present as a STUB — now replace the placeholder art.'));
  line('');
  line(bold('created:'));
  for (const f of created) line('  ' + cyan(f));
  if (!quiet) {
    line('');
    line(bold('next:'));
    line('  1. open ' + cyan(join(dir, 'README.md')) + ' — it lists every picture to draw (in row/column order).');
    line('  2. replace ' + cyan('sheet.png') + ' / ' + cyan('props.png') + ' with your art; recolor the palettes in pet.json.');
    line('  3. validate: re-run this tool (it validates on write), or load the pack — the loader validates too.');
    line('  4. preview: ' + dim('ANIMAYTE_PET=' + name + ' node animayte.mjs') + '  then run /animayte and ' + dim('node tools/animayte-gallery.mjs') + '.');
    line('');
  }
}

// ── self-test: scaffold → validate → BREAK → assert failure (per the build spec) ─────────────
function runSelfTest() {
  const line = (s = '') => process.stdout.write(s + '\n');
  let failures = 0;
  const check = (label, cond, detail) => { const okk = !!cond; line(`  ${okk ? green('PASS') : red('FAIL')}  ${label}${detail ? dim('  — ' + detail) : ''}`); if (!okk) failures++; return okk; };

  line(bold('\n· animayte-new-pet self-test\n'));
  const tmp = mkdtempSync(join(tmpdir(), 'animayte-newpet-'));
  const dir = join(tmp, 'selftest-pet');
  let res;
  try {
    // 1) scaffold into a temp dir
    res = scaffold({ name: 'selftest-pet', dir, from: null, force: false });
    check('scaffold creates files in a temp dir', res.created.length >= 3, res.created.length + ' files');

    // 2) pet.json parses as JSON
    const raw = readFileSync(join(dir, 'pet.json'), 'utf8');
    let parsed = null, parseErr = null;
    try { parsed = JSON.parse(raw); } catch (e) { parseErr = e; }
    check('pet.json is valid JSON', parsed && !parseErr, parseErr ? parseErr.message : 'format=' + (parsed && parsed.format));

    // 3) it VALIDATES against the real schema
    const errs = validateManifest(parsed);
    check('pet.json validates against the real animayte-pet/1 schema', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : 'no errors');

    // 4) the README lists the required reactions (the derived contract)
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    const contract = deriveContract();
    const reactsListed = contract.reactions.every((r) => readme.includes('`' + r + '`'));
    check('README lists every required reaction', reactsListed, contract.reactions.length + ' reactions: ' + contract.reactions.join(', '));
    const facesListed = contract.faces.every((f) => readme.includes('`' + f + '`'));
    check('README lists every required face/mood', facesListed, contract.faces.join(', '));

    // 5) coverage report says everything is present (as a stub)
    check('coverage reports full stub coverage (no missing reactions/faces)', res.cov.missingReacts.length === 0 && res.cov.missingFaces.length === 0,
      `reactions ${res.cov.reactsCovered}/${res.cov.reactsTotal}, faces ${res.cov.facesCovered}/${res.cov.facesTotal}`);

    // 6) NOW BREAK IT — remove a required field — and assert validation FAILS with a clear message
    const broken = JSON.parse(raw);
    delete broken.cell;                          // `cell` is required (positive integer)
    const brokenErrs = validateManifest(broken);
    const cellErr = brokenErrs.find((e) => e.startsWith('cell:'));
    check('a broken manifest (missing `cell`) FAILS validation', brokenErrs.length > 0, brokenErrs.length + ' errors');
    check('the failure names the offending field clearly', !!cellErr, cellErr || '(no cell-specific message!)');

    // 7) break a deeper field too — a reaction pointing at a clip that doesn't exist
    const broken2 = JSON.parse(raw);
    const firstReact = Object.keys(broken2.reactions)[0];
    broken2.reactions[firstReact].clip = 'no_such_clip_xyz';
    const broken2Errs = validateManifest(broken2);
    const refErr = broken2Errs.find((e) => e.includes('unknown clip'));
    check('a dangling reaction→clip reference FAILS with a path', !!refErr, refErr || '(no reference error!)');

    // 8) refuses to overwrite a non-empty dir without --force
    let refused = false, refuseMsg = '';
    try { scaffold({ name: 'selftest-pet', dir, from: null, force: false }); } catch (e) { refused = e.code === 'ENOTEMPTY_REFUSE'; refuseMsg = e.message.split('\n')[0]; }
    check('refuses to overwrite a non-empty dir without --force', refused, refuseMsg);

    // 9) --from slime produces a valid manifest too (template path)
    const dir2 = join(tmp, 'from-slime');
    const res2 = scaffold({ name: 'from-slime', dir: dir2, from: 'slime', force: false });
    const slimeErrs = validateManifest(res2.manifest);
    check('--from slime scaffolds a valid pack', slimeErrs.length === 0, slimeErrs.length ? slimeErrs[0] : res2.cov.reactsCovered + '/' + res2.cov.reactsTotal + ' reactions');
  } finally {
    // clean the temp dir (it's in os.tmpdir(), never the repo)
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  line('');
  if (failures === 0) line(green(bold('✅ self-test PASSED — scaffold validates, and a broken manifest is rejected with clear messages.')));
  else line(red(bold(`❌ self-test FAILED (${failures} check${failures === 1 ? '' : 's'}).`)));
  line('');
  return failures === 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (args.selftest) { process.exit(runSelfTest() ? 0 : 1); }

  const name = args._[0];
  const nameErr = validateName(name);
  if (nameErr) { console.error(red('error: ') + nameErr + '\n'); console.error(HELP); process.exit(2); }
  if (args.from && args.from !== 'slime' && args.from !== 'bean') {
    console.error(red('error: ') + `--from must be "slime" or "bean" (got "${args.from}")`); process.exit(2);
  }

  const dir = resolve(args.dir || join(ROOT, 'pets', name));
  // Guardrail: refuse to scaffold ON TOP of the repo's own real pets unless --dir was explicit.
  // (We only ever WRITE under `dir`; this just stops an accidental overwrite of pets/slime etc.)
  if (!args.dir && existsSync(dir) && dirIsNonEmpty(dir) && !args.force) {
    console.error(red('error: ') + `pets/${name} already exists and is not empty.\n` +
      `  choose a different name, pass ${bold('--dir <path>')} to scaffold elsewhere, or ${bold('--force')} to overwrite.`);
    process.exit(2);
  }

  let res;
  try {
    res = scaffold({ name, dir, from: args.from, force: args.force });
  } catch (e) {
    console.error(red('error: ') + e.message);
    process.exit(e.code === 'ENOTEMPTY_REFUSE' ? 2 : 1);
  }
  printReport({ name, dir, from: args.from, ...res }, args.quiet);
}

main();
