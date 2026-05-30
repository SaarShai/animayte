/*
 * animayte · manifest — the pet-pack format (load + validate, friendly errors).
 *
 * A pet IS data: `pets/<name>/pet.json` describes layers, expressions, clips
 * (frame sequences + procedural transform tracks), props, palettes (mood swaps),
 * reactions (event → clip+expression+prop+palette+priority+return) and idle
 * behaviour. It's a thin superset of the de-facto Aseprite JSON (frames + tags),
 * extended with the procedural pieces a living cartoon needs.
 *
 * The slime's manifest is GENERATED from lib/expressions.mjs (the single source of
 * truth for feelings), so the dictionary stays authoritative — see buildSlimeManifest().
 *
 * Public API:
 *   FORMAT                       — the format tag string
 *   LAYERS                       — the canonical bottom→top layer order
 *   validateManifest(obj)        — → string[] of friendly errors ([] = valid)
 *   assertManifest(obj)          — throws Error(joined errors) or returns obj
 *   buildSlimeManifest()         — derive the slime manifest from EXPRESSIONS
 */
import { EXPRESSIONS } from '../expressions.mjs';
import { isEasing } from './easing.mjs';

export const FORMAT = 'animayte-pet/1';

// canonical layer stack, bottom → top (§4.1). A pet may use a subset, in this order.
export const LAYERS = ['shadow', 'outline', 'body', 'eyes', 'mouth', 'brows', 'prop'];

// face feature vocabulary (kept loose — renderers own the pixels; we sanity-check types)
const ACCENTS = ['blush', 'flush', 'sweat', 'zzz', 'tears', 'steam'];

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * validateManifest(obj) → string[]   (empty array means valid)
 * Every message names the exact path + what was expected, so a malformed pack
 * fails loudly and actionably rather than rendering garbage.
 */
export function validateManifest(m) {
  const E = [];
  const err = (path, msg) => E.push(`${path}: ${msg}`);
  if (!isObj(m)) { return ['manifest must be a JSON object']; }

  if (m.format !== FORMAT) err('format', `must be "${FORMAT}" (got ${JSON.stringify(m.format)})`);
  if (!isStr(m.name)) err('name', 'must be a non-empty string');
  if (!isPosInt(m.cell)) err('cell', 'must be a positive integer (sprite cell size in px)');
  if (m.anchor !== undefined && !(Array.isArray(m.anchor) && m.anchor.length === 2 && m.anchor.every(isNum)))
    err('anchor', 'must be [ax, ay] numbers in 0..1');
  if (m.sheet !== undefined && !isStr(m.sheet)) err('sheet', 'must be a spritesheet filename (string) relative to the pack dir');

  // ── layers ──
  if (!Array.isArray(m.layers) || m.layers.length === 0) err('layers', 'must be a non-empty array');
  else m.layers.forEach((l, i) => { if (!LAYERS.includes(l)) err(`layers[${i}]`, `unknown layer "${l}" (known: ${LAYERS.join(', ')})`); });

  // ── palettes ──
  const palNames = isObj(m.palettes) ? Object.keys(m.palettes) : [];
  if (!isObj(m.palettes) || palNames.length === 0) err('palettes', 'must be an object with ≥1 named palette');
  else for (const [pname, pal] of Object.entries(m.palettes)) {
    if (!isObj(pal)) { err(`palettes.${pname}`, 'must be an object of role → hex color'); continue; }
    for (const [role, hex] of Object.entries(pal)) {
      if (!(typeof hex === 'string' && HEX.test(hex))) err(`palettes.${pname}.${role}`, `must be a hex color #rrggbb[aa] (got ${JSON.stringify(hex)})`);
    }
  }
  if (m.defaultPalette !== undefined && !palNames.includes(m.defaultPalette))
    err('defaultPalette', `"${m.defaultPalette}" is not a defined palette (have: ${palNames.join(', ') || 'none'})`);
  // every palette should expose the SAME roles so a mood swap is a clean re-index
  if (palNames.length > 1) {
    const ref = new Set(Object.keys(m.palettes[m.defaultPalette] || m.palettes[palNames[0]]));
    for (const pname of palNames) {
      const have = new Set(Object.keys(m.palettes[pname]));
      for (const role of ref) if (!have.has(role)) err(`palettes.${pname}`, `missing role "${role}" present in the reference palette (palettes must share roles for clean mood-swap)`);
    }
  }

  // ── expressions (face-layer states) ──
  const exprNames = isObj(m.expressions) ? Object.keys(m.expressions) : [];
  if (!isObj(m.expressions) || exprNames.length === 0) err('expressions', 'must be an object with ≥1 expression');
  else for (const [ename, ex] of Object.entries(m.expressions)) {
    if (!isObj(ex)) { err(`expressions.${ename}`, 'must be an object { eyes, mouth, brows?, accents? }'); continue; }
    if (!isStr(ex.eyes)) err(`expressions.${ename}.eyes`, 'must be a non-empty string (an eye style)');
    if (!isStr(ex.mouth)) err(`expressions.${ename}.mouth`, 'must be a non-empty string (a mouth style)');
    if (ex.brows !== undefined && !isStr(ex.brows)) err(`expressions.${ename}.brows`, 'must be a string when present');
    if (ex.accents !== undefined) {
      if (!Array.isArray(ex.accents)) err(`expressions.${ename}.accents`, 'must be an array of accent names');
      else ex.accents.forEach((a, i) => { if (!ACCENTS.includes(a)) err(`expressions.${ename}.accents[${i}]`, `unknown accent "${a}" (known: ${ACCENTS.join(', ')})`); });
    }
  }

  // ── clips (frame sequences + transform tracks) ──
  const clipNames = isObj(m.clips) ? Object.keys(m.clips) : [];
  if (!isObj(m.clips) || clipNames.length === 0) err('clips', 'must be an object with ≥1 clip');
  else for (const [cname, clip] of Object.entries(m.clips)) {
    if (!isObj(clip)) { err(`clips.${cname}`, 'must be an object { frames, loop?, tracks? }'); continue; }
    if (!Array.isArray(clip.frames) || clip.frames.length === 0) err(`clips.${cname}.frames`, 'must be a non-empty array');
    else clip.frames.forEach((fr, i) => {
      if (!isObj(fr)) { err(`clips.${cname}.frames[${i}]`, 'must be an object { dur }'); return; }
      if (!(isNum(fr.dur) && fr.dur > 0)) err(`clips.${cname}.frames[${i}].dur`, `must be a positive number of ms (got ${JSON.stringify(fr.dur)})`);
    });
    if (clip.loop !== undefined && typeof clip.loop !== 'boolean') err(`clips.${cname}.loop`, 'must be a boolean');
    if (clip.tracks !== undefined) {
      if (!isObj(clip.tracks)) err(`clips.${cname}.tracks`, 'must be an object of layer → keyframe[]');
      else for (const [layer, track] of Object.entries(clip.tracks)) {
        if (!LAYERS.includes(layer)) err(`clips.${cname}.tracks.${layer}`, `unknown layer "${layer}"`);
        if (!Array.isArray(track)) { err(`clips.${cname}.tracks.${layer}`, 'must be an array of keyframes'); continue; }
        let prevT = -Infinity;
        track.forEach((kf, i) => {
          const at = `clips.${cname}.tracks.${layer}[${i}]`;
          if (!isObj(kf)) { err(at, 'keyframe must be an object'); return; }
          if (!(isNum(kf.t) && kf.t >= 0 && kf.t <= 1)) err(`${at}.t`, `must be a number in 0..1 (got ${JSON.stringify(kf.t)})`);
          else { if (kf.t < prevT) err(`${at}.t`, `keyframe times must be ascending (${kf.t} < ${prevT})`); prevT = kf.t; }
          if (kf.ease !== undefined && !isEasing(kf.ease)) err(`${at}.ease`, `unknown easing "${kf.ease}"`);
          for (const f of ['sx', 'sy', 'tx', 'ty', 'rot']) if (kf[f] !== undefined && !isNum(kf[f])) err(`${at}.${f}`, 'must be a number');
        });
      }
    }
  }

  // ── props (overlay sprites) ──
  if (m.props !== undefined) {
    if (!isObj(m.props)) err('props', 'must be an object of name → prop');
    else for (const [pname, prop] of Object.entries(m.props)) {
      if (!isObj(prop)) { err(`props.${pname}`, 'must be an object'); continue; }
      if (prop.anchor !== undefined && !(Array.isArray(prop.anchor) && prop.anchor.length === 2 && prop.anchor.every(isNum)))
        err(`props.${pname}.anchor`, 'must be [ax, ay] numbers');
      if (prop.pop !== undefined && !isPosInt(prop.pop)) err(`props.${pname}.pop`, 'must be a positive integer (pop-in frame count)');
    }
  }

  // ── reactions (event → clip+expression+prop+palette+priority+return) ──
  if (m.reactions !== undefined) {
    if (!isObj(m.reactions)) err('reactions', 'must be an object of event → reaction');
    else for (const [rname, r] of Object.entries(m.reactions)) {
      if (!isObj(r)) { err(`reactions.${rname}`, 'must be an object'); continue; }
      if (r.clip !== undefined && !clipNames.includes(r.clip)) err(`reactions.${rname}.clip`, `references unknown clip "${r.clip}"`);
      if (r.expression !== undefined && !exprNames.includes(r.expression)) err(`reactions.${rname}.expression`, `references unknown expression "${r.expression}"`);
      if (r.prop !== undefined && r.prop !== null && !(m.props && r.prop in m.props)) err(`reactions.${rname}.prop`, `references unknown prop "${r.prop}"`);
      if (r.palette !== undefined && !palNames.includes(r.palette)) err(`reactions.${rname}.palette`, `references unknown palette "${r.palette}"`);
      if (r.priority !== undefined && !Number.isInteger(r.priority)) err(`reactions.${rname}.priority`, 'must be an integer');
      if (r.return !== undefined && r.return !== 'idle' && !clipNames.includes(r.return)) err(`reactions.${rname}.return`, `must be "idle" or a known clip (got "${r.return}")`);
    }
  }

  // ── idle behaviour ──
  if (m.idle !== undefined) {
    if (!isObj(m.idle)) err('idle', 'must be an object');
    else {
      if (m.idle.base !== undefined && !clipNames.includes(m.idle.base)) err('idle.base', `references unknown clip "${m.idle.base}"`);
      if (m.idle.secondary !== undefined) {
        if (!Array.isArray(m.idle.secondary)) err('idle.secondary', 'must be an array of clip names');
        else m.idle.secondary.forEach((s, i) => { if (!clipNames.includes(s)) err(`idle.secondary[${i}]`, `references unknown clip "${s}"`); });
      }
      if (m.idle.boredClip !== undefined && !clipNames.includes(m.idle.boredClip)) err('idle.boredClip', `references unknown clip "${m.idle.boredClip}"`);
      for (const f of ['boredAfterMs']) if (m.idle[f] !== undefined && !(isNum(m.idle[f]) && m.idle[f] > 0)) err(`idle.${f}`, 'must be a positive number of ms');
      if (m.idle.blink !== undefined) {
        if (!isObj(m.idle.blink)) err('idle.blink', 'must be an object { minMs, maxMs }');
        else { if (m.idle.blink.minMs !== undefined && !(isNum(m.idle.blink.minMs) && m.idle.blink.minMs > 0)) err('idle.blink.minMs', 'must be a positive number'); }
      }
    }
  }

  return E;
}

/** Throw with all friendly errors joined, or return the manifest if valid. */
export function assertManifest(m, label = 'manifest') {
  const errs = validateManifest(m);
  if (errs.length) throw new Error(`Invalid ${label}:\n  - ${errs.join('\n  - ')}`);
  return m;
}

// ════════════════════════════════════════════════════════════════════════════
//  Build the slime manifest FROM the expression dictionary (source of truth).
// ════════════════════════════════════════════════════════════════════════════

// §4.2 target palette — a hue-shifted ramp with cool shadows → warm rim, ~9 colors.
// Mood = palette swap: every palette exposes the SAME roles (clean re-index).
const PALETTES = {
  calm: {
    shadowCool: '#1E4D3B', shadow: '#2E7D4F', base: '#5BC661', highlight: '#9BE86A',
    rim: '#E8FBB0', outline: '#16352B', halo: '#FFFFFF4D', dropShadow: '#10231C59',
    eyeDark: '#16352B', catchlight: '#F2FBE9', blush: '#F6757A',
  },
  tired: { // shift cooler/bluer as context fills
    shadowCool: '#1B3A47', shadow: '#2C5E6E', base: '#4FA6B0', highlight: '#7FCFCB',
    rim: '#CFEFE6', outline: '#15303B', halo: '#FFFFFF40', dropShadow: '#0E1F2659',
    eyeDark: '#15303B', catchlight: '#EAF7F4', blush: '#E58BA0',
  },
  error: { // brief red flash — never STAYS red (state machine snaps back)
    shadowCool: '#5A1E22', shadow: '#8E2C30', base: '#E04A4A', highlight: '#F58A6A',
    rim: '#FDE0C0', outline: '#3A1416', halo: '#FFFFFF4D', dropShadow: '#2A0E1059',
    eyeDark: '#3A1416', catchlight: '#FFF0E8', blush: '#FF9BA0',
  },
};

// mood-independent accent colors for props/emotes (§4.5)
const ACCENT_COLORS = { warm: '#FEE761', alert: '#E43B44', neutral: '#3A4466', sweat: '#7DC6FF', white: '#FFFFFF' };

/** Map an EXPRESSIONS[].face → a manifest expression entry (normalised accents). */
function faceToExpression(face) {
  const out = { eyes: face.eyes || 'dots', mouth: face.mouth || 'small' };
  if (face.brows) out.brows = face.brows;
  const accents = ACCENTS.filter((a) => face[a]);
  if (accents.length) out.accents = accents;
  return out;
}

export function buildSlimeManifest() {
  const expressions = {};
  for (const ex of EXPRESSIONS) expressions[ex.id] = faceToExpression(ex.face);

  // baseline clips — today's behaviour expressed as data (breathing idle + a blink
  // frame + a generic reaction bounce). Phase 2 (B3/B4) layers the rich library on top.
  const clips = {
    idle: {
      loop: true,
      frames: [{ dur: 460 }, { dur: 460 }, { dur: 460 }, { dur: 460 }],
      tracks: {
        body: [
          { t: 0, sy: 1, ty: 0 },
          { t: 0.5, sy: 1.03, ty: -1, ease: 'easeInOutSine' },
          { t: 1, sy: 1, ty: 0, ease: 'easeInOutSine' },
        ],
      },
    },
    blink: { loop: false, frames: [{ dur: 90 }] },
    react: {
      loop: false,
      frames: [{ dur: 80 }, { dur: 110 }, { dur: 140 }, { dur: 160 }],
      tracks: {
        body: [
          { t: 0, sy: 1 },
          { t: 0.2, sy: 0.88, ease: 'easeOutQuad' }, // anticipation: squash
          { t: 0.5, sy: 1.16, ease: 'easeOutBack' },  // extreme: stretch up
          { t: 1, sy: 1, ease: 'easeOutBounce' },      // settle
        ],
      },
    },
  };

  return {
    format: FORMAT,
    name: 'slime',
    cell: 64,
    anchor: [0.5, 1],
    sheet: 'sheet.png',
    layers: ['shadow', 'outline', 'body', 'eyes', 'mouth', 'brows', 'prop'],
    palettes: PALETTES,
    defaultPalette: 'calm',
    accentColors: ACCENT_COLORS,
    expressions,
    clips,
    props: {},
    reactions: {},
    idle: {
      base: 'idle',
      blink: { minMs: 3000, maxMs: 6000 },
      secondary: [],
      boredAfterMs: 30000,
    },
    // provenance: the dictionary stays the source of truth for feelings
    source: { expressions: 'lib/expressions.mjs', generatedBy: 'lib/anim/manifest.mjs#buildSlimeManifest' },
  };
}
