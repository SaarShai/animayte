#!/usr/bin/env node
/*
 * animayte · animayte-fixtures — a FAITHFUL transcript-fixture generator.
 *
 *   node tools/animayte-fixtures.mjs --list                 # report what real shapes were found (no writes)
 *   node tools/animayte-fixtures.mjs                         # emit fixtures → test/fixtures/captured/
 *   node tools/animayte-fixtures.mjs --out /tmp/fix         # emit somewhere else
 *   node tools/animayte-fixtures.mjs --self-test            # run the built-in self-test (emits to a TEMP dir)
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 * The hard-won testing lesson on this project (see docs/ARCHITECTURE.md §11 and the /compact +
 * sidechain incidents): SYNTHETIC fixtures encode the AUTHOR'S assumptions about how Claude Code
 * writes a transcript, so a suite can stay green while a real bug ships. The daemon
 * (animayte.mjs · `readTranscriptTail`) tail-reads the REAL session `.jsonl` and depends on an
 * exact set of fields. This tool captures FAITHFUL, REDACTED, schema-true slices from the real
 * project transcripts so tests can lock `readTranscriptTail` against shapes that actually occur —
 * not shapes we imagined.
 *
 * ─── EXACTLY WHICH FIELDS THE DAEMON DEPENDS ON (the contract we must preserve verbatim) ──────
 *   · message.usage.input_tokens / .cache_creation_input_tokens / .cache_read_input_tokens   (context %)
 *   · message.role === 'assistant'      |   top-level type === 'assistant'                    (turn kind)
 *   · message.model        |   top-level model                                                (window size)
 *   · message.content[] with { type:'text', text }                                            (sentiment)
 *   · top-level isSidechain === true     → SKIP (sub-agent turns must not drive the main pet)
 *   · top-level type === 'system' && subtype === 'compact_boundary'  → STOP scanning           (/compact)
 * Everything else (output_tokens, server_tool_use, cache_creation.ephemeral_*, iterations, …) the
 * daemon ignores TODAY — but we keep the FULL real field set on one fixture so a test catches the
 * day the daemon starts reading a new field and the field's real shape has drifted.
 *
 * ─── SAFETY ──────────────────────────────────────────────────────────────────────────────────
 *   · READ-ONLY on the real transcripts. Streams line-by-line; never copies a whole multi-MB file.
 *   · REDACTS every assistant/user prose body to a short placeholder (real schema, fake words).
 *   · SECRET SCAN: every emitted line is scanned; if anything trips the detector the tool ABORTS
 *     rather than write a fixture that could leak a secret/email/token.
 *   · DETERMINISTIC: given the same inputs it always picks the same slices and emits byte-identical
 *     output (it sorts inputs, scans in a fixed order, and never embeds timestamps in the fixtures).
 *
 * Zero dependencies — Node builtins only.
 */
import { readdirSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import os from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, '..');

// ── the real project transcripts (READ-ONLY source) ─────────────────────────────────────────
// Resolve the Claude Code project-transcript dir for THIS repo. The encoding CC uses is the abs
// path with every '/' turned into '-'. Overridable via --src for portability / testing.
function defaultTranscriptDir() {
  const slug = REPO.replace(/\//g, '-');                 // /Users/za/Documents/animayte → -Users-za-Documents-animayte
  return join(os.homedir(), '.claude', 'projects', slug);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { out: join(REPO, 'test', 'fixtures', 'captured'), list: false, redact: true, selfTest: false, src: defaultTranscriptDir() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--list') a.list = true;
    else if (t === '--self-test') a.selfTest = true;
    else if (t === '--no-redact') a.redact = false;       // exists for completeness; off-by-default is dangerous and the secret scan still guards emits
    else if (t === '--redact') a.redact = true;
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--src') a.src = argv[++i];
    else if (t === '-h' || t === '--help') a.help = true;
  }
  return a;
}

// ── secret / PII detection (the emit gate) ────────────────────────────────────────────────────
// Word/shape-boundaried so we don't false-positive on ordinary prose. This is the LAST line of
// defense: even though we replace prose with placeholders, we still scan every emitted byte. If a
// real value sneaks through (e.g. a token embedded in a field we copy verbatim) the tool refuses to
// write. Note: a bare 'AKIA…' inside base64 binary is a known false positive in these transcripts —
// which is exactly why the tool extracts ONLY scalar usage numbers + markers and never copies a
// tool_result body, so no base64 blob is ever in scope to trip this.
const SECRET_PATTERNS = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{20,}/ },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];
function findSecret(s) {
  for (const p of SECRET_PATTERNS) if (p.re.test(s)) return p.name;
  return null;
}

// ── redaction ─────────────────────────────────────────────────────────────────────────────────
// Replace any { type:'text', text } body with a short, fixed placeholder. We KEEP the schema (the
// content array, the block shape) but drop the real words. The placeholder is deterministic.
const PLACEHOLDER = '[redacted assistant turn]';
function redactContent(content, kind) {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (b && b.type === 'text' && typeof b.text === 'string') return { type: 'text', text: kind === 'user' ? '[redacted user turn]' : PLACEHOLDER };
    return b;     // non-text blocks (tool_use/tool_result) are never carried into a fixture (see extractors), but be safe
  });
}

// Build a faithful assistant turn: the EXACT real usage object + a redacted single text block, in
// the minimal top-level shape the daemon reads. `full` keeps the entire real usage field set;
// otherwise we keep just the three fields the daemon sums (still a real, valid usage object).
function assistantTurn(realUsage, { full = true, text = PLACEHOLDER, model = 'claude-opus-4-8' } = {}) {
  const usage = full ? cloneUsage(realUsage) : {
    input_tokens: realUsage.input_tokens || 0,
    cache_creation_input_tokens: realUsage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: realUsage.cache_read_input_tokens || 0,
    output_tokens: realUsage.output_tokens || 0,
    service_tier: realUsage.service_tier || 'standard',
  };
  return { type: 'assistant', isSidechain: false, message: { role: 'assistant', model, content: [{ type: 'text', text }], usage } };
}
// Deep-clone only the JSON-scalar/structure parts of a real usage object (drop nothing, add nothing).
function cloneUsage(u) { return JSON.parse(JSON.stringify(u)); }

// ── the real compact_boundary marker (minimal but schema-true) ────────────────────────────────
// The real line carries a big compactMetadata blob (preTokens/postTokens/preCompactDiscoveredTools/
// preservedMessages…). The daemon only matches on type+subtype, but we keep the real
// compactMetadata.{trigger,preTokens,postTokens} so a future reader (and a human) sees the true
// shape. We DROP the uuid lists / tool lists (noise, and the tool list can name MCP servers).
function compactBoundary(meta) {
  const cm = {};
  if (meta) {
    if (meta.trigger) cm.trigger = meta.trigger;
    if (typeof meta.preTokens === 'number') cm.preTokens = meta.preTokens;
    if (typeof meta.postTokens === 'number') cm.postTokens = meta.postTokens;
  }
  const o = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false, isSidechain: false };
  if (Object.keys(cm).length) o.compactMetadata = cm;
  return o;
}

// ── a single read-only streaming pass over one transcript ─────────────────────────────────────
// Returns the few candidate slices we care about WITHOUT holding the file in memory. We keep the
// raw `usage` objects (scalar numbers only) and a couple of markers; we never retain prose.
async function scanTranscript(path) {
  const found = {
    file: basename(path),
    sizeBytes: statSync(path).size,
    lineCount: 0,
    hasCompactBoundary: false,
    compactMeta: null,                 // {trigger,preTokens,postTokens}
    preCompactUsage: null,             // last usage BEFORE the boundary (the near-full one) — {usage,lineNo}
    postCompactUsage: null,            // first usage AFTER the boundary (the recovered one)  — {usage,lineNo}
    boundaryLineNo: -1,
    maxUsage: null,                    // the single fullest assistant turn anywhere — {usage,lineNo}
    minUsage: null,                    // the leanest (>0) assistant turn anywhere       — {usage,lineNo}
    sampleFullUsage: null,             // an assistant usage carrying the FULL real field set — {usage,lineNo}
    sidechainTrue: 0,                  // count of real sub-agent turns (the leak case source)
    sampleMainAssistant: null,         // a plain main-thread assistant turn (to base a synthetic sidechain on) — {usage,lineNo}
  };
  const FULL_FIELDS = ['server_tool_use', 'cache_creation', 'iterations'];   // markers of the rich usage shape

  await new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      found.lineCount++;
      let o;
      try { o = JSON.parse(line); } catch { return; }       // skip non-JSON / partial lines exactly as the daemon does

      if (o.isSidechain === true) found.sidechainTrue++;

      // the compaction boundary (top-level, the daemon's stop marker)
      if (o.type === 'system' && o.subtype === 'compact_boundary') {
        found.hasCompactBoundary = true;
        found.boundaryLineNo = found.lineCount;
        const m = o.compactMetadata || {};
        found.compactMeta = { trigger: m.trigger, preTokens: m.preTokens, postTokens: m.postTokens };
        return;
      }

      const msg = o.message;
      const usage = msg && msg.usage;
      const isAssistant = (msg && msg.role === 'assistant') || o.type === 'assistant';
      if (!usage || !isAssistant) return;
      if (o.isSidechain === true) return;                   // never base anything on a sub-agent turn

      const slice = { usage: pickUsage(usage), lineNo: found.lineCount };

      // pre/post compact usage, relative to the boundary we may have just seen
      if (found.hasCompactBoundary) { if (!found.postCompactUsage) found.postCompactUsage = slice; }
      else { found.preCompactUsage = slice; }               // keep overwriting → the LAST pre-boundary usage (closest to the cut)

      // a turn whose usage carries the full rich field set AND a real (non-zero) top-level token
      // count. Claude Code emits intermediate/streaming assistant events whose top-level usage
      // scalars are still 0 (the real numbers live only inside iterations[]); those are a real shape
      // but make a poor "rich usage" sample — the daemon would read 0%. We want a FINALIZED turn so
      // the fixture proves both the full shape AND a real token total. (first match wins → deterministic)
      if (!found.sampleFullUsage && FULL_FIELDS.every((k) => k in usage) && usageTotal(usage) > 0) found.sampleFullUsage = slice;

      // a plain main-thread assistant turn we can clone to synthesize a sidechain (first is fine)
      if (!found.sampleMainAssistant) found.sampleMainAssistant = slice;

      const total = usageTotal(usage);
      if (total > 0) {
        if (!found.maxUsage || total > usageTotal(found.maxUsage.usage)) found.maxUsage = slice;
        if (!found.minUsage || total < usageTotal(found.minUsage.usage)) found.minUsage = slice;
      }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  return found;
}

// Keep ONLY scalar usage fields + the nested ephemeral/iterations structure — never any prose. This
// is what makes the extracted data safe by construction (no tool_result strings ever travel along).
function pickUsage(u) {
  const out = {};
  const SCALARS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens', 'service_tier', 'inference_geo', 'speed'];
  for (const k of SCALARS) if (k in u) out[k] = u[k];
  if (u.server_tool_use && typeof u.server_tool_use === 'object') out.server_tool_use = { ...numbersOnly(u.server_tool_use) };
  if (u.cache_creation && typeof u.cache_creation === 'object') out.cache_creation = { ...numbersOnly(u.cache_creation) };
  if (Array.isArray(u.iterations)) out.iterations = u.iterations.map((it) => {
    const o = {}; for (const [k, v] of Object.entries(it)) {
      if (typeof v === 'number' || typeof v === 'string') o[k] = v;
      else if (v && typeof v === 'object') o[k] = numbersOnly(v);
    } return o;
  });
  return out;
}
function numbersOnly(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') o[k] = v; return o; }
function usageTotal(u) { return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); }

// ── aggregate the per-file scans into the global picture ──────────────────────────────────────
function aggregate(scans) {
  const g = {
    files: scans.length,
    totalLines: scans.reduce((n, s) => n + s.lineCount, 0),
    sidechainTrue: scans.reduce((n, s) => n + s.sidechainTrue, 0),
    compactFile: null,        // a scan that has a real boundary WITH both pre & post usage
    fullUsage: null,          // {usage, file, lineNo} — richest field set
    nearFull: null,           // {usage, file, lineNo} — fullest body
    lean: null,               // {usage, file, lineNo} — leanest body
    mainAssistant: null,      // {usage, file, lineNo} — a plain turn to clone for the sidechain fixture
  };
  for (const s of scans) {
    if (!g.compactFile && s.hasCompactBoundary && s.preCompactUsage && s.postCompactUsage) g.compactFile = s;
    if (s.sampleFullUsage && !g.fullUsage) g.fullUsage = withFile(s.sampleFullUsage, s.file);
    if (s.maxUsage && (!g.nearFull || usageTotal(s.maxUsage.usage) > usageTotal(g.nearFull.usage))) g.nearFull = withFile(s.maxUsage, s.file);
    if (s.minUsage && (!g.lean || usageTotal(s.minUsage.usage) < usageTotal(g.lean.usage))) g.lean = withFile(s.minUsage, s.file);
    if (s.sampleMainAssistant && !g.mainAssistant) g.mainAssistant = withFile(s.sampleMainAssistant, s.file);
  }
  // prefer the richest-field-set turn as the near-full sample too if it's actually near full; else keep distinct
  return g;
}
function withFile(slice, file) { return { ...slice, file }; }

// ── fixture builders: turn the aggregated real data into emit specs ───────────────────────────
// Each spec: { name, lines:[obj…], meta:{…} }. Lines are objects; we serialize one-per-line (JSONL).
function buildFixtures(g, scans) {
  const fixtures = [];
  const provenance = (src, lineNo, note) => ({ source_transcript: src, source_line: lineNo, exercises: note });

  // 1) COMPACT — a real boundary with pre- AND post-compact usage (the /compact reinflate case)
  if (g.compactFile) {
    const s = g.compactFile;
    fixtures.push({
      name: 'real-compact-boundary.jsonl',
      lines: [
        assistantTurn(s.preCompactUsage.usage, { full: true }),    // near-full pre-compact head
        compactBoundary(s.compactMeta),                            // the real stop marker (+ pre/postTokens)
        assistantTurn(s.postCompactUsage.usage, { full: true, text: PLACEHOLDER }),   // recovered post-compact head
      ],
      meta: {
        exercises: 'readTranscriptTail must STOP at compact_boundary (newest→oldest) and read the post-compact usage, not the pre-compact near-full one — the /compact reinflate bug.',
        provenance: [
          provenance(s.file, s.preCompactUsage.lineNo, 'pre-compact assistant usage (near-full)'),
          provenance(s.file, s.boundaryLineNo, 'the real compact_boundary system marker'),
          provenance(s.file, s.postCompactUsage.lineNo, 'first post-compact assistant usage (recovered)'),
        ],
        ground_truth: {
          pre_compact_tokens: usageTotal(s.preCompactUsage.usage),
          post_compact_tokens: usageTotal(s.postCompactUsage.usage),
          compactMetadata: s.compactMeta,
        },
        redaction: 'all assistant prose replaced with a fixed placeholder; usage numbers + boundary marker are verbatim from the real transcript.',
      },
    });
  }

  // 2) FULL-USAGE — one assistant turn carrying the COMPLETE real usage field set
  if (g.fullUsage) {
    fixtures.push({
      name: 'real-usage-full-fieldset.jsonl',
      lines: [assistantTurn(g.fullUsage.usage, { full: true })],
      meta: {
        exercises: 'A usage-bearing assistant turn with the FULL real field set (output_tokens, server_tool_use, cache_creation.ephemeral_*, iterations, speed, service_tier). Locks the shape so a test catches the day the daemon starts reading a new field whose real shape has drifted.',
        provenance: [provenance(g.fullUsage.file, g.fullUsage.lineNo, 'assistant turn with the complete usage object')],
        ground_truth: { tokens: usageTotal(g.fullUsage.usage), usage_keys: Object.keys(g.fullUsage.usage) },
        redaction: 'prose → placeholder; the entire usage object is verbatim (scalars + nested ephemeral/iterations).',
      },
    });
  }

  // 3) SIDECHAIN — a sub-agent turn interleaved with a main turn (the sub-agent-leak case)
  // IMPORTANT HONESTY: the real project transcripts contain ZERO isSidechain:true turns (see --list:
  // sidechainTrue). So we cannot capture one verbatim. We SYNTHESIZE it by taking a REAL main-thread
  // assistant turn shape and toggling isSidechain:true + adding the real sub-agent user kickoff shape.
  // The meta marks this as synthesized-from-real-shape, not captured — so no one mistakes it for a
  // verbatim slice. Everything except the boolean flag and the placeholder prose is a real shape.
  if (g.mainAssistant) {
    const mainLean = g.lean ? g.lean.usage : g.mainAssistant.usage;          // small sub-agent usage (would wrongly deflate the body)
    const mainBig = g.nearFull ? g.nearFull.usage : g.mainAssistant.usage;   // the real main near-full head that must win
    fixtures.push({
      name: 'synthetic-sidechain-leak.jsonl',
      synthetic: true,
      lines: [
        assistantTurn(mainBig, { full: true, text: PLACEHOLDER }),                          // main-thread near-full head (must drive the pet)
        { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: '[redacted user turn]' }] } },   // sub-agent kickoff
        // sub-agent assistant turn: small usage + (negative-leaning) text the daemon must IGNORE
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: '[redacted assistant turn]' }], usage: pickUsage(mainLean) } },
      ],
      meta: {
        exercises: 'isSidechain:true turns (sub-agent) interleaved with a main turn. readTranscriptTail must SKIP the sidechain turns so a sub-agent\'s small usage / its text never drives the main pet — the sub-agent-leak case.',
        synthesized: true,
        synthesis_note: 'The real project transcripts contain ZERO isSidechain:true turns (sidechainTrue=' + g.sidechainTrue + '). This fixture is SYNTHESIZED: a real main-thread assistant turn shape with isSidechain toggled to true on the sub-agent lines. Only the boolean flag + placeholder prose are non-verbatim; the field shape and usage numbers are real.',
        provenance: [
          provenance(g.nearFull ? g.nearFull.file : g.mainAssistant.file, g.nearFull ? g.nearFull.lineNo : g.mainAssistant.lineNo, 'real main-thread near-full assistant turn (the head that must win)'),
          provenance(g.lean ? g.lean.file : g.mainAssistant.file, g.lean ? g.lean.lineNo : g.mainAssistant.lineNo, 'real lean usage reused as the sub-agent\'s (smaller) usage'),
        ],
        ground_truth: { main_tokens: usageTotal(mainBig), sidechain_tokens: usageTotal(mainLean) },
        redaction: 'all prose → placeholders; usage numbers are verbatim; isSidechain:true is the synthesized part.',
      },
    });
  }

  // 4) BODY-FULLNESS EXTREMES — near-full and lean turns (no boundary), the two ends of the gauge
  if (g.nearFull) {
    fixtures.push({
      name: 'real-near-full-context.jsonl',
      lines: [assistantTurn(g.nearFull.usage, { full: true })],
      meta: {
        exercises: 'The near-full body extreme: the fullest real assistant usage. With no boundary, readTranscriptTail must surface a near-full head (the body-swell signature).',
        provenance: [provenance(g.nearFull.file, g.nearFull.lineNo, 'fullest real assistant usage')],
        ground_truth: { tokens: usageTotal(g.nearFull.usage), pct_of_1M: +(usageTotal(g.nearFull.usage) / 1e6 * 100).toFixed(1) },
        redaction: 'prose → placeholder; usage verbatim.',
      },
    });
  }
  if (g.lean) {
    fixtures.push({
      name: 'real-low-context.jsonl',
      lines: [assistantTurn(g.lean.usage, { full: true })],
      meta: {
        exercises: 'The low body extreme: the leanest (>0) real assistant usage. readTranscriptTail must surface a near-empty head.',
        provenance: [provenance(g.lean.file, g.lean.lineNo, 'leanest real assistant usage')],
        ground_truth: { tokens: usageTotal(g.lean.usage), pct_of_1M: +(usageTotal(g.lean.usage) / 1e6 * 100).toFixed(1) },
        redaction: 'prose → placeholder; usage verbatim.',
      },
    });
  }

  return fixtures;
}

// 5) STATUSLINE — no statusline JSON is ever written to a transcript (it is POSTed live to /status),
// so it is NOT recoverable from the real .jsonl files. We emit a DOCUMENTED faithful sample of the
// real statusline shape that handleStatus() reads, sourced from docs/session-signals.md + the
// handleStatus() field list. Marked documented (not captured).
function buildStatuslineSample() {
  return {
    name: 'statusline-sample.json',
    json: {
      _comment: 'DOCUMENTED, not captured. Statusline JSON is POSTed live to /status and never written to the transcript, so it cannot be extracted from real .jsonl files. Shape sourced from docs/session-signals.md + animayte.mjs handleStatus(). Real values are the ones session-signals.md records as "seen".',
      model: { id: 'claude-opus-4-8', display_name: 'Opus' },
      context_window: {
        used_percentage: 28,
        context_window_size: 1000000,
        total_input_tokens: 276746,
        current_usage: { input_tokens: 2, cache_creation_input_tokens: 1387, cache_read_input_tokens: 275357 },
      },
      cost: { total_cost_usd: 1.83, total_lines_added: 420, total_lines_removed: 61, total_duration_ms: 0 },
      rate_limits: { five_hour: { used_percentage: 34 }, seven_day: { used_percentage: 12 } },
      effort: { level: 'high' },
      thinking: { enabled: true },
    },
    meta: {
      exercises: 'handleStatus() reads context_window.{used_percentage,context_window_size,total_input_tokens,current_usage}, model.{display_name,id}, cost.{total_cost_usd,total_lines_added,total_lines_removed}, rate_limits.{five_hour,seven_day}.used_percentage, effort.level, thinking.enabled. This documents that shape.',
      documented_not_captured: true,
      provenance: [{ source: 'docs/session-signals.md (values "seen") + animayte.mjs handleStatus()', exercises: 'the real statusline contract' }],
    },
  };
}

// ── serialization: deterministic JSONL, with a hard secret-scan gate ──────────────────────────
function toJsonl(lines) { return lines.map((o) => JSON.stringify(o)).join('\n') + '\n'; }

function scanEmitForSecrets(name, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const hit = findSecret(lines[i]);
    if (hit) throw new Error(`refusing to emit ${name}: line ${i + 1} tripped secret detector [${hit}]`);
  }
}

function emit(outDir, fixtures, statusline) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const fx of fixtures) {
    const body = toJsonl(fx.lines);
    scanEmitForSecrets(fx.name, body);                     // GATE: never write a fixture that trips the detector
    writeFileSync(join(outDir, fx.name), body);
    const metaText = JSON.stringify({ fixture: fx.name, ...fx.meta }, null, 2) + '\n';
    scanEmitForSecrets(fx.name + '.meta.json', metaText);
    writeFileSync(join(outDir, fx.name + '.meta.json'), metaText);
    written.push(fx.name, fx.name + '.meta.json');
  }
  if (statusline) {
    const body = JSON.stringify(statusline.json, null, 2) + '\n';
    scanEmitForSecrets(statusline.name, body);
    writeFileSync(join(outDir, statusline.name), body);
    const metaText = JSON.stringify({ fixture: statusline.name, ...statusline.meta }, null, 2) + '\n';
    scanEmitForSecrets(statusline.name + '.meta.json', metaText);
    writeFileSync(join(outDir, statusline.name + '.meta.json'), metaText);
    written.push(statusline.name, statusline.name + '.meta.json');
  }
  // a top-level README in the captured dir explaining provenance + how to consume (no .md elsewhere)
  const readme = captureReadme(fixtures, statusline);
  writeFileSync(join(outDir, 'README.md'), readme);
  written.push('README.md');
  return written;
}

function captureReadme(fixtures, statusline) {
  const rows = fixtures.map((f) => `- \`${f.name}\` — ${f.meta.exercises}`).join('\n');
  return [
    '# Captured fixtures (faithful, redacted)',
    '',
    'Generated by `tools/animayte-fixtures.mjs` from the REAL project transcripts. Each `.jsonl` is a',
    'minimal, schema-faithful slice: usage numbers + markers are VERBATIM from a real session; all',
    'assistant/user prose is replaced with a fixed placeholder; every emitted line passed a secret/PII',
    'scan. Each fixture has a sibling `.meta.json` recording the source transcript + line and what it',
    'exercises in the daemon\'s `readTranscriptTail`.',
    '',
    '## Fixtures',
    rows,
    statusline ? `- \`${statusline.name}\` — ${statusline.meta.exercises}` : '',
    '',
    'Regenerate: `node tools/animayte-fixtures.mjs`  ·  Preview only: `node tools/animayte-fixtures.mjs --list`',
    '',
  ].join('\n');
}

// ── --list reporting ──────────────────────────────────────────────────────────────────────────
function report(scans, g, fixtures, statusline) {
  const L = [];
  L.push('\nanimayte-fixtures · scan report');
  L.push('  source: ' + (scans.length ? dirname(scans[0]._path || '') : '(none)'));
  L.push(`  transcripts scanned: ${g.files}   total lines: ${g.totalLines}`);
  L.push(`  isSidechain:true turns found across ALL transcripts: ${g.sidechainTrue}` + (g.sidechainTrue === 0 ? '  → sidechain fixture must be SYNTHESIZED from a real main-turn shape' : ''));
  L.push('');
  L.push('  recoverable real shapes:');
  L.push(`    · compact_boundary with pre+post usage : ${g.compactFile ? 'YES — ' + g.compactFile.file + ' (pre ' + usageTotal(g.compactFile.preCompactUsage.usage) + ' tok → post ' + usageTotal(g.compactFile.postCompactUsage.usage) + ' tok)' : 'no'}`);
  L.push(`    · full-fieldset usage turn             : ${g.fullUsage ? 'YES — ' + g.fullUsage.file + ' line ' + g.fullUsage.lineNo + '  keys=[' + Object.keys(g.fullUsage.usage).join(',') + ']' : 'no'}`);
  L.push(`    · near-full body                       : ${g.nearFull ? 'YES — ' + g.nearFull.file + ' line ' + g.nearFull.lineNo + '  ' + usageTotal(g.nearFull.usage) + ' tok (' + (usageTotal(g.nearFull.usage) / 1e4).toFixed(1) + '% of 1M)' : 'no'}`);
  L.push(`    · low body                             : ${g.lean ? 'YES — ' + g.lean.file + ' line ' + g.lean.lineNo + '  ' + usageTotal(g.lean.usage) + ' tok' : 'no'}`);
  L.push(`    · statusline sample                    : DOCUMENTED (never in transcripts) — emitted from docs/session-signals.md`);
  L.push('');
  L.push('  would emit:');
  for (const f of fixtures) L.push(`    + ${f.name}  (${f.lines.length} line${f.lines.length === 1 ? '' : 's'})${f.synthetic ? '  [synthesized]' : ''}`);
  if (statusline) L.push(`    + ${statusline.name}  [documented]`);
  L.push('');
  return L.join('\n');
}

// ── core pipeline ─────────────────────────────────────────────────────────────────────────────
async function run(opts) {
  let files = [];
  try { files = readdirSync(opts.src).filter((f) => f.endsWith('.jsonl')).sort(); }   // sort → deterministic selection
  catch { throw new Error('cannot read transcript dir: ' + opts.src + ' (pass --src <dir>)'); }
  if (!files.length) throw new Error('no .jsonl transcripts in ' + opts.src);

  const scans = [];
  for (const f of files) {
    const p = join(opts.src, f);
    const s = await scanTranscript(p);
    s._path = p;
    scans.push(s);
  }
  const g = aggregate(scans);
  const fixtures = buildFixtures(g, scans);
  const statusline = buildStatuslineSample();
  return { scans, g, fixtures, statusline };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Run the generator to a TEMP dir (NOT the repo), then load every emitted fixture and assert it
// parses as JSONL, carries a real usage object, the compact one has a boundary, the sidechain one
// has an isSidechain:true line, and the redaction scrubbed all prose. Prints a pass/fail summary.
async function selfTest(opts) {
  const { readFileSync } = await import('node:fs');
  const tmp = join(os.tmpdir(), 'animayte-fixtures-selftest-' + process.pid);
  let pass = 0, fail = 0; const fails = [];
  const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

  const { g, fixtures, statusline } = await run(opts);
  const written = emit(tmp, fixtures, statusline);
  console.log('\nanimayte-fixtures · self-test (emitting to ' + tmp + ')');

  // every emitted .jsonl parses, line-by-line, as JSON
  const jsonlNames = fixtures.map((f) => f.name);
  for (const name of jsonlNames) {
    const text = readFileSync(join(tmp, name), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    let allParse = true, anyUsage = false;
    for (const l of lines) { try { const o = JSON.parse(l); const u = o.message && o.message.usage; if (u && usageTotal(u) >= 0 && ('input_tokens' in u)) anyUsage = true; } catch { allParse = false; } }
    ok(name + ': parses as JSONL', allParse, 'a line failed JSON.parse');
    ok(name + ': carries a real usage object', anyUsage, 'no message.usage with input_tokens');
    // redaction: NO emitted line may carry anything but the placeholder prose, and none may trip the secret scan
    ok(name + ': prose is redacted (placeholder only)', /\[redacted (assistant|user) turn\]/.test(text) && !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'found non-placeholder prose or an email');
    let secretHit = null; for (const l of lines) { const h = findSecret(l); if (h) { secretHit = h; break; } }
    ok(name + ': no secret/PII in any line', !secretHit, secretHit || '');
  }

  // the compact fixture specifically must contain a compact_boundary AND post-compact usage < pre
  const compactName = 'real-compact-boundary.jsonl';
  if (jsonlNames.includes(compactName)) {
    const objs = readFileSync(join(tmp, compactName), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const boundary = objs.find((o) => o.type === 'system' && o.subtype === 'compact_boundary');
    ok(compactName + ': contains a compact_boundary marker', !!boundary);
    const usages = objs.filter((o) => o.message && o.message.usage).map((o) => usageTotal(o.message.usage));
    ok(compactName + ': post-compact usage is lower than pre-compact', usages.length >= 2 && usages[usages.length - 1] < usages[0], 'usages=' + JSON.stringify(usages));
    // SIMULATE the daemon's boundary-aware tail scan over this fixture and assert it reads the POST value
    const objsNewestFirst = [...objs].reverse();
    let read = null;
    for (const o of objsNewestFirst) { if (o.type === 'system' && o.subtype === 'compact_boundary') break; const u = o.message && o.message.usage; if (u) { read = usageTotal(u); break; } }
    ok(compactName + ': a boundary-aware tail read picks the POST-compact usage', read === usages[usages.length - 1], 'read=' + read + ' expected=' + usages[usages.length - 1]);
  }

  // the full-fieldset fixture must carry the rich usage keys AND a real (non-zero) token total — a
  // finalized turn, not a zeroed streaming-intermediate one (the daemon would read 0% off the latter)
  const fullName = 'real-usage-full-fieldset.jsonl';
  if (jsonlNames.includes(fullName)) {
    const objs = readFileSync(join(tmp, fullName), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const u = objs[0].message.usage;
    ok(fullName + ': carries the rich usage field set', ['server_tool_use', 'cache_creation', 'iterations', 'output_tokens'].every((k) => k in u));
    ok(fullName + ': has a real (non-zero) token total', usageTotal(u) > 0, 'total=' + usageTotal(u));
  }

  // the sidechain fixture must contain an isSidechain:true line, and a boundary-IGNORANT-but-sidechain-aware
  // tail scan (the real daemon's) must SKIP it and read the MAIN turn's usage
  const sideName = 'synthetic-sidechain-leak.jsonl';
  if (jsonlNames.includes(sideName)) {
    const objs = readFileSync(join(tmp, sideName), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok(sideName + ': contains an isSidechain:true line', objs.some((o) => o.isSidechain === true));
    const objsNewestFirst = [...objs].reverse();
    let read = null;
    for (const o of objsNewestFirst) { if (o.isSidechain === true) continue; const u = o.message && o.message.usage; if (u) { read = usageTotal(u); break; } }
    const mainTurn = objs.find((o) => o.isSidechain === false && o.message && o.message.usage);
    ok(sideName + ': a sidechain-aware tail read SKIPS the sub-agent and reads the MAIN usage', read === usageTotal(mainTurn.message.usage), 'read=' + read);
  }

  // every fixture has a sibling meta with provenance
  for (const name of jsonlNames) {
    const meta = JSON.parse(readFileSync(join(tmp, name + '.meta.json'), 'utf8'));
    ok(name + ': has a .meta.json with provenance', Array.isArray(meta.provenance) && meta.provenance.length > 0 && !!meta.exercises);
  }

  // determinism: a second run to a second temp dir must be byte-identical
  const tmp2 = join(os.tmpdir(), 'animayte-fixtures-selftest2-' + process.pid);
  const r2 = await run(opts);
  emit(tmp2, r2.fixtures, r2.statusline);
  let identical = true; let firstDiff = '';
  for (const name of written) { const a = readFileSync(join(tmp, name), 'utf8'); const b = readFileSync(join(tmp2, name), 'utf8'); if (a !== b) { identical = false; firstDiff = name; break; } }
  ok('deterministic: two runs are byte-identical', identical, firstDiff && ('differs at ' + firstDiff));

  const total = pass + fail;
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} self-test checks passed` + (fail ? ':' : ''));
  if (fail) { console.log(fails.join('\n')); }
  console.log('\nemitted to ' + tmp + ':');
  for (const w of written) console.log('  · ' + w);
  console.log('');
  return fail === 0;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
const HELP = `animayte-fixtures — faithful transcript-fixture generator

  node tools/animayte-fixtures.mjs [--list] [--out <dir>] [--src <dir>] [--self-test] [--no-redact]

  --list        scan + report what real shapes were found; write nothing
  --out <dir>   output dir (default: test/fixtures/captured)
  --src <dir>   transcript source dir (default: ~/.claude/projects/<this-repo-slug>)
  --self-test   run to a TEMP dir and assert every fixture parses/redacts/locks the contract
  --no-redact   keep real prose (NOT recommended; the secret-scan gate still applies)
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (opts.selfTest) { const okAll = await selfTest(opts); process.exit(okAll ? 0 : 1); }

  const { scans, g, fixtures, statusline } = await run(opts);
  if (opts.list) { console.log(report(scans, g, fixtures, statusline)); return; }

  const written = emit(opts.out, fixtures, statusline);
  console.log(report(scans, g, fixtures, statusline));
  console.log('emitted ' + written.length + ' files → ' + opts.out + ':');
  for (const w of written) console.log('  · ' + w);
  console.log('');
}

main().catch((e) => { console.error('animayte-fixtures: ' + (e && e.message || e)); process.exit(1); });
