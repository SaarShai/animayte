#!/usr/bin/env node
/*
 * animayte · APPRAISE LAB — a hands-on REPL for feeling out the translation layer.
 *
 *   node test/appraise-lab.mjs              # interactive: type lines, watch the pet react
 *   node test/appraise-lab.mjs "fixed it!"  # one-shot: appraise a single line
 *   node test/appraise-lab.mjs --demo       # play a scripted neutral tour of the fan-out
 *
 * For every signal it prints BOTH halves of the decision:
 *   • the BRAIN  — appraise() → the FeatureSpec (expression + valence/arousal/cause/expectedness/item)
 *   • the BODY   — composeExpression() → the face + FX + prop the renderer would actually draw
 * plus a plain-English gloss of what you'd see. History is live: a rolling mood meter drifts
 * with what you type, so a setback after a streak of wins reads 'surprising' and one amid a
 * slump reads 'routine'. Tweak it and tell me where a face feels wrong — that's the calibration.
 *
 * INPUT FORMS (interactive):
 *   <any text>            the agent's own words            ("fixed it 🚀", "the build crashed")
 *   user: <text>          the USER talking to the pet      ("thanks!", "no, that's wrong")
 *   tool: <Tool> [cmd]    a live tool activity             ("tool: Edit", "tool: Bash npm test")
 *   err: <text>           a tool failure (PostToolUse)     ("err: ENOENT no such file")
 * COMMANDS:
 *   :mood <n>   set the slow mood meter (-1..1)      :reset   clear history
 *   :demo       scripted neutral tour               :help    show this        :q / :quit
 */
import readline from 'node:readline';
import { appraise } from '../lib/appraise.mjs';
import { composeExpression } from '../grid/compose.mjs';
import { appleFor } from '../lib/expressions.mjs';
import { createMoodMeter } from '../lib/anim/mood.mjs';

const meter = createMoodMeter();
let prevValence = 0;

// ── turn one input line into a normalized appraise() signal ─────────────────────────────
function signalFor(line) {
  const t = line.trim();
  let m;
  if ((m = t.match(/^user:\s*(.+)$/is))) return { userText: m[1] };
  if ((m = t.match(/^err(?:or)?:\s*(.+)$/is))) return { isError: true, errorText: m[1] };
  if ((m = t.match(/^tool:\s*(\S+)\s*(.*)$/is))) {
    const [, tool, rest] = m;
    return rest ? { tool, toolInput: { command: rest } } : { tool };
  }
  return { recentTexts: [t] };
}

// ── render the composed face/FX/prop as a one-line, plain-English "what you'd see" ──────
function gloss(spec, body) {
  if (!spec) return 'nothing — no feeling to show (the pet holds its current face)';
  const bits = [];
  const f = body.face, fx = body.fx;
  const MOUTH = { big_grin: 'a big grin', open_smile: 'an open smile', slight_smile: 'a soft smile', flat_skew: 'a focused mouth', awkward: 'an awkward line', frown: 'a frown', small: 'a small mouth' };
  const EYES = { stars: 'starry eyes', happy_arc: 'happy arcs', wide: 'wide eyes', open: 'open eyes', dots: 'dot eyes', look_up: 'eyes glancing up', closed: 'closed eyes' };
  bits.push(`${EYES[f.eyes] || f.eyes || 'eyes'}, ${MOUTH[f.mouth] || f.mouth || 'mouth'}`);
  if (f.sweat) bits.push('a nervous bead (owns the slip)');
  if (f.blush) bits.push('a bashful blush');
  if (f.flush) bits.push('flushed red');
  if (f.zzz) bits.push('drowsy');
  if (fx.flash) bits.push('a RED error-wince (external setback)');
  if (fx.shake) bits.push(`a shake (${fx.shake})`);
  if (fx.burst) bits.push('a CONFETTI burst');
  if (spec.expectedness === 'surprising' && f.eyes === 'wide') bits.push('caught off guard');
  if (body.item) bits.push(`holding the ${body.item}`);
  return bits.join(' · ');
}

const PAD = (s, n) => String(s).padEnd(n);
function react(line) {
  const sig = signalFor(line);
  meter.decayStep();                                  // time passes since the last beat
  const prevMood = meter.level;
  const spec = appraise(sig, { valence: prevValence, mood: prevMood });
  if (spec) { prevValence = spec.valence; meter.feel(spec.expression); }
  const apple = spec ? appleFor(spec.expression) : '·';
  const body = spec ? composeExpression(spec) : { face: {}, fx: {}, item: null };

  console.log('\n  ' + apple + '  \x1b[1m' + (spec ? spec.expression : '(no feeling)') + '\x1b[0m'
    + (spec ? `   valence ${PAD(spec.valence, 5)} arousal ${spec.arousal}  cause ${PAD(spec.cause, 8)} ${spec.expectedness}` : ''));
  if (spec && spec.item) console.log('     item: ' + spec.item);
  console.log('     \x1b[2m' + gloss(spec, body) + '\x1b[0m');
  console.log(`     \x1b[2mmood meter now ${meter.level.toFixed(2)} (${meter.label})\x1b[0m`);
}

const DEMO = [
  '— a happy path —',
  'Let me take a look at the parser.',
  'tool: Edit',
  'Fixed it, all tests pass! ✅',
  '🚀 huge breakthrough, this is brilliant',
  '— then a setback (note: surprising, because mood was high) —',
  'the request returned an error',
  'a small lint nit, no big deal',          // milder — calmer face
  'I broke the parser with my last edit',   // own-fault → sweat, no red flash
  "now I'm restarting the worker",          // recovering → calmer
  '— how the USER speaks to it —',
  'user: thanks, that works great',         // content, not a grin
  'user: this is amazing, you nailed it!!', // a real grin
  "user: no, that's wrong",                 // sheepish
];

function help() {
  console.log(`
  \x1b[1mappraise lab\x1b[0m — type how the session sounds; see what the pet feels + shows.
    <any text>          the agent's own words      e.g.  the build crashed
    user: <text>        the user talking to it     e.g.  user: nice work!
    tool: <Tool> [cmd]  a live tool activity        e.g.  tool: Bash npm test
    err: <text>         a tool failure             e.g.  err: ENOENT
    :mood <n>  set mood (-1..1)   :reset  clear history   :demo  tour   :q  quit\n`);
}

// ── entry ───────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === '--demo' || args[0] === ':demo') {
  for (const l of DEMO) { if (l.startsWith('—')) console.log('\n\x1b[36m' + l + '\x1b[0m'); else { console.log('\n\x1b[1m› ' + l + '\x1b[0m'); react(l); } }
  console.log('');
} else if (args.length) {
  react(args.join(' '));
  console.log('');
} else {
  help();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[1msay›\x1b[0m ' });
  rl.prompt();
  rl.on('line', (line) => {
    const t = line.trim();
    if (t === ':q' || t === ':quit' || t === ':exit') return rl.close();
    if (t === ':help' || t === '?') help();
    else if (t === ':reset') { meter.reset(); prevValence = 0; console.log('  (history cleared)'); }
    else if (t === ':demo') { for (const l of DEMO) { if (l.startsWith('—')) console.log('\n\x1b[36m' + l + '\x1b[0m'); else { console.log('\n\x1b[1m› ' + l + '\x1b[0m'); react(l); } } }
    else if (/^:mood\s+(-?[\d.]+)$/.test(t)) { const n = Math.max(-1, Math.min(1, parseFloat(RegExp.$1))); meter.reset(); for (let i = 0; i < 40 && Math.abs(meter.level) < Math.abs(n) - 0.01; i++) meter.feel(n >= 0 ? 'excited' : 'sad'); console.log(`  (mood ≈ ${meter.level.toFixed(2)})`); }
    else if (t) react(t);
    rl.prompt();
  });
  rl.on('close', () => { console.log('\n  bye 👋\n'); process.exit(0); });
}
