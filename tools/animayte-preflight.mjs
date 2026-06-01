#!/usr/bin/env node
/*
 * animayte-preflight — the single "is this releasable?" gate (Node 18+, ZERO deps).
 *
 *   node tools/animayte-preflight.mjs                 # full release-readiness check
 *   node tools/animayte-preflight.mjs --skip-tests    # fast manifest-only (no test suite)
 *   node tools/animayte-preflight.mjs --json          # machine-readable report (CI)
 *   node tools/animayte-preflight.mjs --fix-hints     # print the exact remedy per ✗/⚠
 *
 * WHY THIS EXISTS
 *   animayte is a Claude Code PLUGIN shipped via a marketplace. There is no single gate
 *   today that answers "can I push this to the community with confidence?". A green test
 *   suite proves the runtime works; it does NOT prove the *plugin* is shippable — a
 *   missing manifest field, a stray dependency, a version-pin footgun, or a hooks.json
 *   that drifted from the daemon all ship a broken plugin to real users. This tool runs
 *   every release-readiness check in one pass and prints a ✓/⚠/✗ checklist with an
 *   overall PASS/FAIL exit code.
 *
 * WHAT IT CHECKS (each is a "gate" object: id, title, status, detail, fix)
 *   TESTS     — `node test/run.mjs`, all suites green  (skippable with --skip-tests)
 *   ZERO-DEP  — package.json declares no dependencies of any kind
 *   SYNTAX    — `node --check` over every shipped *.mjs
 *   MANIFEST  — .claude-plugin/plugin.json + marketplace.json vs the CC plugin schema;
 *               hooks/hooks.json has the 9 expected events; every commands/*.md exists
 *   CONTRACT  — tools/animayte-lint.mjs (daemon↔renderer↔manifest); else an inline check
 *   DOCS      — README/INSTALL reference port 4321; docs/ARCHITECTURE.md exists
 *   VERSION   — read-only: report the pinned version + the version-pin footgun warning
 *
 * Status levels: 'pass' (✓) · 'warn' (⚠, recommended-but-missing, does NOT fail) ·
 * 'fail' (✗, a real release blocker). Overall PASS iff zero 'fail' gates. Warnings never
 * change the exit code — they are the prioritized "should fix before a public release" list.
 *
 * Zero dependencies — Node builtins only; runs identically on macOS / Windows / Linux.
 * It is READ-ONLY: it never touches git, the live pet (:4321), or ~/.claude — the test
 * suite it shells out to is the same headless suite CI runs.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── tiny helpers ────────────────────────────────────────────────────────────────────────────
const PASS = 'pass', WARN = 'warn', FAIL = 'fail';
const read = (p) => readFileSync(p, 'utf8');
const relRoot = (p) => relative(ROOT, p).split(sep).join('/');
/** Parse JSON, returning { value } or { error } — never throws (a malformed manifest is a finding). */
function parseJsonFile(p) {
  if (!existsSync(p)) return { error: 'file not found' };
  let txt;
  try { txt = read(p); } catch (e) { return { error: 'unreadable: ' + e.message }; }
  try { return { value: JSON.parse(txt) }; } catch (e) { return { error: 'invalid JSON: ' + e.message }; }
}
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// The 9 Claude Code lifecycle hook events animayte wires (docs/ARCHITECTURE.md §10).
export const EXPECTED_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStop',
  'Notification', 'Stop', 'PreCompact', 'SessionEnd',
];

// ════════════════════════════════════════════════════════════════════════════════════════════
//  MANIFEST VALIDATION  (pure function, exported so it can be unit-tested in isolation)
// ════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Validate a parsed Claude-Code plugin.json against the known plugin schema
 * (https://code.claude.com/docs/en/plugins-reference#plugin-manifest-schema).
 * Returns { errors:[…], warnings:[…] } — `errors` are release blockers, `warnings` are
 * recommended-but-missing fields + the version-pin footgun. Pure: no I/O, no throwing.
 *
 *   hard-required (loader): name  — the ONLY field `claude plugin validate` rejects on.
 *   release-required      : description — the loader allows its absence, but a public
 *                           marketplace plugin without one ships a blank blurb. We BLOCK it.
 *   recommended           : license, repository, homepage, author
 *   footgun               : an explicit `version` means pushed commits never reach
 *                           already-installed users until it's bumped — CC caches by version.
 */
export function validatePluginManifest(manifest) {
  const errors = [], warnings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['plugin.json is not a JSON object'], warnings };
  }
  // name — the only field the loader hard-requires
  if (!isNonEmptyString(manifest.name)) errors.push('missing required field: "name" (a non-empty string) — the loader rejects a plugin without it');
  else if (/\s/.test(manifest.name) || manifest.name !== manifest.name.toLowerCase()) {
    warnings.push(`"name" ("${manifest.name}") should be kebab-case with no spaces (lowercase, "-") — it is public-facing in \`/plugin install name@marketplace\``);
  }
  // description — loader-optional, but required for a publishable plugin (the marketplace blurb)
  if (!isNonEmptyString(manifest.description)) errors.push('missing "description" — technically loader-optional, but a public plugin needs one (it is the blurb users see). Add a one-line description.');

  // recommended
  if (!isNonEmptyString(manifest.license)) warnings.push('missing recommended field: "license" (an SPDX id, e.g. "MIT") — users want to know the terms');
  if (!hasRepository(manifest)) warnings.push('missing recommended field: "repository" (a string URL or { "url": … }) — links the plugin to its source');
  if (!isNonEmptyString(manifest.homepage)) warnings.push('missing recommended field: "homepage" — a landing/README URL shown in the marketplace');
  if (!hasAuthor(manifest)) warnings.push('missing recommended field: "author" (a string or { "name": … })');

  // the version-pin footgun
  if ('version' in manifest) {
    if (!isNonEmptyString(manifest.version)) {
      errors.push('"version" is present but not a non-empty string — remove it or set a valid semver like "0.1.0"');
    } else {
      warnings.push(
        `VERSION-PIN FOOTGUN: plugin.json pins "version": "${manifest.version}". Claude Code caches an installed plugin by version, so commits you push will NOT reach already-installed users until you BUMP this. Bump it on every user-facing release (or drop "version" to always track the latest commit).`
      );
    }
  }
  return { errors, warnings };
}

/**
 * Validate a parsed marketplace.json against the known schema
 * (https://code.claude.com/docs/en/plugin-marketplaces).
 * Required (loader): name, owner ({name}), plugins[] (non-empty). Each plugin entry needs a
 * name + source (a string like "./", or a source object). Recommended: a description (the
 * top-level field, or metadata.description for back-compat). Pure: no I/O, no throwing.
 */
export function validateMarketplaceManifest(manifest) {
  const errors = [], warnings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { errors: ['marketplace.json is not a JSON object'], warnings };
  }
  if (!isNonEmptyString(manifest.name)) errors.push('missing required field: "name" (kebab-case marketplace id)');
  // owner is REQUIRED by the schema (object with a "name"); a bare string is tolerated by us
  if (!hasOwner(manifest)) errors.push('missing required field: "owner" — { "name": "…", "email"?: "…" }');
  if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) {
    errors.push('"plugins" must be a non-empty array of plugin entries');
  } else {
    manifest.plugins.forEach((p, i) => {
      if (!p || typeof p !== 'object') { errors.push(`plugins[${i}] is not an object`); return; }
      if (!isNonEmptyString(p.name)) errors.push(`plugins[${i}] missing "name"`);
      // source may be a string ("./", "owner/repo") OR a { source: … } object
      const srcOk = isNonEmptyString(p.source) || (p.source && typeof p.source === 'object' && isNonEmptyString(p.source.source));
      if (!srcOk) errors.push(`plugins[${i}] missing "source" (a string like "./" for an in-repo plugin, or a source object)`);
    });
  }
  // description: top-level is the documented field; metadata.description is accepted for back-compat
  const hasDesc = isNonEmptyString(manifest.description) || (manifest.metadata && isNonEmptyString(manifest.metadata.description));
  if (!hasDesc) warnings.push('missing recommended field: "description" — the one-line marketplace blurb (top-level, or metadata.description)');
  return { errors, warnings };
}

function hasRepository(m) {
  return isNonEmptyString(m.repository) || (m.repository && typeof m.repository === 'object' && isNonEmptyString(m.repository.url));
}
function hasAuthor(m) {
  return isNonEmptyString(m.author) || (m.author && typeof m.author === 'object' && isNonEmptyString(m.author.name));
}
function hasOwner(m) {
  return isNonEmptyString(m.owner) || (m.owner && typeof m.owner === 'object' && isNonEmptyString(m.owner.name));
}

/**
 * Validate hooks/hooks.json: it must define the 9 expected lifecycle events, each carrying
 * at least one command hook. Returns { errors, warnings, found:[…], missing:[…], extra:[…] }.
 */
export function validateHooks(manifest) {
  const errors = [], warnings = [];
  if (!manifest || typeof manifest !== 'object') return { errors: ['hooks.json is not a JSON object'], warnings, found: [], missing: EXPECTED_HOOK_EVENTS, extra: [] };
  const hooks = manifest.hooks;
  if (!hooks || typeof hooks !== 'object') return { errors: ['hooks.json has no top-level "hooks" object'], warnings, found: [], missing: EXPECTED_HOOK_EVENTS, extra: [] };
  const found = Object.keys(hooks);
  const missing = EXPECTED_HOOK_EVENTS.filter((e) => !found.includes(e));
  const extra = found.filter((e) => !EXPECTED_HOOK_EVENTS.includes(e));
  if (missing.length) errors.push(`hooks.json is missing ${missing.length} expected event(s): ${missing.join(', ')}`);
  // each present event should carry at least one runnable command hook
  for (const ev of EXPECTED_HOOK_EVENTS) {
    if (!hooks[ev]) continue;
    const groups = hooks[ev];
    const cmds = Array.isArray(groups)
      ? groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : [])).filter((h) => h && h.type === 'command' && isNonEmptyString(h.command))
      : [];
    if (cmds.length === 0) errors.push(`hooks.json event "${ev}" has no runnable command hook`);
  }
  if (extra.length) warnings.push(`hooks.json defines event(s) not in the expected set (harmless if intentional): ${extra.join(', ')}`);
  return { errors, warnings, found, missing, extra };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  THE GATES
// ════════════════════════════════════════════════════════════════════════════════════════════
function gate(id, title, status, detail = '', fix = '') { return { id, title, status, detail, fix }; }

// ── TESTS ─────────────────────────────────────────────────────────────────────────────────
function gateTests({ skip }) {
  if (skip) return gate('tests', 'TESTS — node test/run.mjs', WARN, 'skipped (--skip-tests)', 'drop --skip-tests to run the full suite before release');
  const runner = join(ROOT, 'test', 'run.mjs');
  if (!existsSync(runner)) return gate('tests', 'TESTS — node test/run.mjs', FAIL, 'test/run.mjs not found', 'the test runner is missing');
  const r = spawnSync(process.execPath, [runner], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  // run.mjs ends with "❌ N suite(s) failed." or "✅ all suites passed."
  const failLine = out.split('\n').reverse().find((l) => /suite\(s\) failed/.test(l));
  if (r.error) return gate('tests', 'TESTS — node test/run.mjs', FAIL, `runner error: ${r.error.message}`, 'investigate the runner');
  if (r.status === 0) {
    const passLine = out.split('\n').reverse().find((l) => /all suites passed/.test(l)) || 'all suites passed';
    return gate('tests', 'TESTS — node test/run.mjs', PASS, passLine.replace(/[✅]/g, '').trim() || 'all suites passed');
  }
  const failures = summarizeTestFailures(out);
  return gate('tests', 'TESTS — node test/run.mjs', FAIL,
    (failLine ? failLine.replace(/[❌]/g, '').trim() : `runner exited ${r.status}`) + (failures ? `\n${failures}` : ''),
    'run `node test/run.mjs` and fix the failing suite(s) before releasing');
}
// pull a compact list of failing-looking lines so the user doesn't have to re-run to see what broke
function summarizeTestFailures(out) {
  const lines = out.split('\n');
  const hits = lines.filter((l) => /\b(FAIL|not ok|AssertionError|✗|Error:|✖)\b/.test(l) && !/0 failed|✓/.test(l)).slice(0, 12);
  return hits.length ? hits.map((l) => '      ' + l.trim()).join('\n') : '';
}

// ── ZERO-DEP ─────────────────────────────────────────────────────────────────────────────
function gateZeroDep() {
  const { value: pkg, error } = parseJsonFile(join(ROOT, 'package.json'));
  if (error) return gate('zero-dep', 'ZERO-DEP — package.json has no dependencies', FAIL, `package.json ${error}`, 'fix package.json so it parses');
  const buckets = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const offenders = buckets.flatMap((b) => Object.keys(pkg[b] || {}).map((d) => `${b}/${d}`));
  if (offenders.length) {
    return gate('zero-dep', 'ZERO-DEP — package.json has no dependencies', FAIL,
      `declares ${offenders.length}: ${offenders.join(', ')}`,
      'animayte must stay zero-dependency (Node builtins + curl). Remove these or make an explicit project decision.');
  }
  return gate('zero-dep', 'ZERO-DEP — package.json has no dependencies', PASS, 'no dependencies / devDependencies / optional / peer');
}

// ── SYNTAX ───────────────────────────────────────────────────────────────────────────────
const SYNTAX_SKIP_DIRS = new Set(['node_modules', '.git']);
function walkMjs(dir, out = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!SYNTAX_SKIP_DIRS.has(e.name)) walkMjs(full, out); }
    else if (e.isFile() && e.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}
function gateSyntax() {
  const files = walkMjs(ROOT).sort();
  if (!files.length) return gate('syntax', 'SYNTAX — node --check every *.mjs', FAIL, 'no *.mjs files found', 'that cannot be right');
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push({ file: relRoot(f), err: (r.stderr || r.stdout || '').trim().split('\n')[0] });
  }
  if (bad.length) {
    return gate('syntax', 'SYNTAX — node --check every *.mjs', FAIL,
      `${bad.length}/${files.length} fail to parse:\n` + bad.map((b) => `      ${b.file}: ${b.err}`).join('\n'),
      'fix the syntax error(s) above');
  }
  return gate('syntax', 'SYNTAX — node --check every *.mjs', PASS, `all ${files.length} *.mjs parse on ${process.platform} / Node ${process.version}`);
}

// ── PLUGIN MANIFEST ───────────────────────────────────────────────────────────────────────
function gatesManifest() {
  const gates = [];

  // plugin.json
  const pj = parseJsonFile(join(ROOT, '.claude-plugin', 'plugin.json'));
  if (pj.error) {
    gates.push(gate('manifest-plugin', 'MANIFEST — .claude-plugin/plugin.json', FAIL, pj.error, 'create/fix .claude-plugin/plugin.json'));
  } else {
    const { errors, warnings } = validatePluginManifest(pj.value);
    gates.push(gate('manifest-plugin', 'MANIFEST — plugin.json schema',
      errors.length ? FAIL : (warnings.length ? WARN : PASS),
      [...errors, ...warnings].map((m) => '      • ' + m).join('\n') || 'name + description present; recommended fields set',
      errors.length ? 'add the missing required field(s) above' : (warnings.length ? 'address the recommended field(s)/footgun above' : '')));
  }

  // marketplace.json
  const mp = parseJsonFile(join(ROOT, '.claude-plugin', 'marketplace.json'));
  if (mp.error) {
    gates.push(gate('manifest-marketplace', 'MANIFEST — .claude-plugin/marketplace.json', FAIL, mp.error, 'create/fix .claude-plugin/marketplace.json'));
  } else {
    const { errors, warnings } = validateMarketplaceManifest(mp.value);
    gates.push(gate('manifest-marketplace', 'MANIFEST — marketplace.json schema',
      errors.length ? FAIL : (warnings.length ? WARN : PASS),
      [...errors, ...warnings].map((m) => '      • ' + m).join('\n') || 'name + plugins[] present; each plugin has name+source',
      errors.length ? 'fix the marketplace.json error(s) above' : ''));
  }

  // version drift between plugin.json and the marketplace entry (a real release footgun).
  // The marketplace version may sit top-level or under metadata; plugin.json wins at load time.
  if (!pj.error && !mp.error) {
    const pv = pj.value.version;
    const mv = (mp.value && (mp.value.version || (mp.value.metadata && mp.value.metadata.version))) || undefined;
    if (isNonEmptyString(pv) && isNonEmptyString(mv) && pv !== mv) {
      gates.push(gate('manifest-version-sync', 'MANIFEST — plugin/marketplace version agree', WARN,
        `plugin.json "${pv}" ≠ marketplace.json "${mv}" (plugin.json wins at install; the marketplace value is cosmetic but should match)`,
        'set both to the same version so the marketplace listing matches what actually installs'));
    }
  }

  // hooks/hooks.json — the 9 events, each with a runnable command
  const hk = parseJsonFile(join(ROOT, 'hooks', 'hooks.json'));
  if (hk.error) {
    gates.push(gate('manifest-hooks', 'MANIFEST — hooks/hooks.json (9 events)', FAIL, hk.error, 'create/fix hooks/hooks.json'));
  } else {
    const { errors, warnings, found } = validateHooks(hk.value);
    gates.push(gate('manifest-hooks', 'MANIFEST — hooks/hooks.json (9 events)',
      errors.length ? FAIL : (warnings.length ? WARN : PASS),
      (errors.length || warnings.length)
        ? [...errors, ...warnings].map((m) => '      • ' + m).join('\n')
        : `all ${EXPECTED_HOOK_EVENTS.length} expected events present, each with a command (${found.length} total)`,
      errors.length ? 'add the missing hook event(s)/command(s) above' : ''));
  }

  // commands/*.md referenced exist (auto-discovered from the commands/ dir)
  gates.push(gateCommands());

  return gates;
}

function gateCommands() {
  const dir = join(ROOT, 'commands');
  if (!existsSync(dir)) return gate('manifest-commands', 'MANIFEST — commands/*.md present', FAIL, 'commands/ directory not found', 'add a commands/ directory with at least one slash-command .md');
  let mds; try { mds = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (e) { return gate('manifest-commands', 'MANIFEST — commands/*.md present', FAIL, 'unreadable commands/: ' + e.message, 'check the commands/ directory'); }
  if (!mds.length) return gate('manifest-commands', 'MANIFEST — commands/*.md present', FAIL, 'no *.md command files in commands/', 'add at least one slash-command .md');
  // each must be a readable file with frontmatter (a description: line) — the bare minimum CC needs
  const noFrontmatter = [];
  for (const f of mds) {
    let txt = ''; try { txt = read(join(dir, f)); } catch { txt = ''; }
    if (!/^---[\s\S]*?description\s*:/m.test(txt)) noFrontmatter.push(f);
  }
  if (noFrontmatter.length) {
    return gate('manifest-commands', 'MANIFEST — commands/*.md present', WARN,
      `command(s) without a description frontmatter: ${noFrontmatter.join(', ')}`,
      'add `---\\ndescription: …\\n---` frontmatter so the command shows a help string');
  }
  return gate('manifest-commands', 'MANIFEST — commands/*.md present', PASS, `${mds.length} command file(s): ${mds.join(', ')}`);
}

// ── CONTRACT (daemon ↔ renderer ↔ manifest) ─────────────────────────────────────────────────
function gateContract() {
  const lintPath = join(ROOT, 'tools', 'animayte-lint.mjs');
  if (existsSync(lintPath)) {
    const r = spawnSync(process.execPath, [lintPath, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    let parsed = null; try { parsed = JSON.parse(r.stdout || '{}'); } catch { /* fall through */ }
    if (parsed && typeof parsed.ok === 'boolean') {
      if (parsed.ok) return gate('contract', 'CONTRACT — daemon↔renderer↔manifest (animayte-lint)', PASS,
        `${(parsed.checks || []).length} contract checks passed`);
      const failed = (parsed.checks || []).filter((c) => !c.ok);
      return gate('contract', 'CONTRACT — daemon↔renderer↔manifest (animayte-lint)', FAIL,
        failed.map((c) => `      ✗ ${c.title}${c.detail ? ' — ' + c.detail : ''}`).join('\n') || 'lint reported a contract violation',
        'run `node tools/animayte-lint.mjs` — a broken chain is a SILENT no-op (the pet stops reacting)');
    }
    // lint ran but emitted unparseable output → fall back to exit code
    return gate('contract', 'CONTRACT — daemon↔renderer↔manifest (animayte-lint)', r.status === 0 ? PASS : FAIL,
      r.status === 0 ? 'animayte-lint exited 0' : `animayte-lint exited ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`,
      r.status === 0 ? '' : 'run `node tools/animayte-lint.mjs` for detail');
  }
  // inline fallback: react names the daemon emits ⊆ the manifest's reactions
  return inlineContractCheck();
}

function inlineContractCheck() {
  const uniq = (a) => [...new Set(a)].sort();
  const matchAll = (s, re) => [...s.matchAll(re)].map((m) => m[1]);
  let events, daemon, manifestTxt;
  try {
    daemon = read(join(ROOT, 'animayte.mjs'));
    events = read(join(ROOT, 'lib', 'anim', 'events.mjs'));
    manifestTxt = read(join(ROOT, 'grid', 'manifest.mjs'));
  } catch (e) {
    return gate('contract', 'CONTRACT — react names ⊆ manifest (inline)', FAIL, 'could not read sources: ' + e.message, 'ensure animayte.mjs, lib/anim/events.mjs, grid/manifest.mjs exist');
  }
  const reactNames = uniq([
    ...matchAll(events, /event:\s*'([A-Za-z]+)'/g),
    ...matchAll(daemon, /cmd:\s*'react',\s*name:\s*'([A-Za-z]+)'/g),
    ...matchAll(daemon, /REACTION_FOR_ITEM\s*=\s*\{([^}]*)\}/g).flatMap((blk) => matchAll(blk, /'([A-Za-z]+)'/g)),
  ]);
  // pull the keys of MANIFEST.reactions by a tolerant brace scan
  const reMatch = manifestTxt.match(/reactions\s*:\s*\{/);
  const manifestReacts = new Set();
  if (reMatch) {
    let i = reMatch.index + reMatch[0].length, depth = 1, body = '';
    for (; i < manifestTxt.length && depth > 0; i++) { const ch = manifestTxt[i]; if (ch === '{') depth++; else if (ch === '}') depth--; if (depth > 0) body += ch; }
    for (const k of matchAll(body, /(?:^|[\s,{])([A-Za-z][A-Za-z0-9]*)\s*:/g)) manifestReacts.add(k);
  }
  const missing = reactNames.filter((n) => !manifestReacts.has(n));
  if (!reactNames.length) return gate('contract', 'CONTRACT — react names ⊆ manifest (inline)', WARN, 'could not extract any daemon react names (parser may need an update)', 'verify the contract manually');
  if (missing.length) return gate('contract', 'CONTRACT — react names ⊆ manifest (inline)', FAIL,
    `manifest is missing clip(s) for: ${missing.join(', ')}`,
    'add the missing name(s) to grid/manifest.mjs MANIFEST.reactions — otherwise the pet silently ignores them');
  return gate('contract', 'CONTRACT — react names ⊆ manifest (inline)', PASS, `all ${reactNames.length} daemon react names exist in the manifest`);
}

// ── DOCS ─────────────────────────────────────────────────────────────────────────────────
function gateDocs() {
  const issues = [], notes = [];
  // docs/ARCHITECTURE.md exists
  if (!existsSync(join(ROOT, 'docs', 'ARCHITECTURE.md'))) issues.push('docs/ARCHITECTURE.md is missing');
  else notes.push('docs/ARCHITECTURE.md present');
  // README + INSTALL reference the right port (4321)
  for (const cand of [['README.md', join(ROOT, 'README.md')], ['docs/INSTALL.md', join(ROOT, 'docs', 'INSTALL.md')], ['INSTALL.md', join(ROOT, 'INSTALL.md')]]) {
    const [label, p] = cand;
    if (!existsSync(p)) continue; // only check docs that exist
    let txt = ''; try { txt = read(p); } catch { /* ignore */ }
    if (!/\b4321\b/.test(txt)) issues.push(`${label} does not mention the daemon port 4321`);
    else notes.push(`${label} references :4321`);
  }
  if (!existsSync(join(ROOT, 'README.md'))) issues.push('README.md is missing');
  if (issues.length) return gate('docs', 'DOCS — README/INSTALL port + ARCHITECTURE.md', WARN, issues.map((m) => '      • ' + m).join('\n'), 'fix the docs note(s) above (port references + the architecture doc)');
  return gate('docs', 'DOCS — README/INSTALL port + ARCHITECTURE.md', PASS, notes.join('; '));
}

// ── VERSION / GIT (read-only, informational) ────────────────────────────────────────────────
function gateVersion() {
  const pj = parseJsonFile(join(ROOT, '.claude-plugin', 'plugin.json'));
  const v = pj.value && pj.value.version;
  if (pj.error) return gate('version', 'VERSION — pinned version (read-only)', WARN, 'plugin.json unreadable', '');
  if (!isNonEmptyString(v)) {
    return gate('version', 'VERSION — pinned version (read-only)', PASS, 'plugin.json has no pinned version → installs always track the latest commit (no bump needed)');
  }
  return gate('version', 'VERSION — pinned version (read-only)', WARN,
    `pinned at "${v}". Pushed commits reach installed users ONLY after this is bumped.`,
    `before publishing a user-facing change, bump "version" (e.g. ${suggestBump(v)}) in plugin.json (and marketplace.json metadata)`);
}
function suggestBump(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return 'a higher semver';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATION
// ════════════════════════════════════════════════════════════════════════════════════════════
export function preflight({ skipTests = false } = {}) {
  const gates = [];
  gates.push(gateTests({ skip: skipTests }));
  gates.push(gateZeroDep());
  gates.push(gateSyntax());
  gates.push(...gatesManifest());
  gates.push(gateContract());
  gates.push(gateDocs());
  gates.push(gateVersion());
  const fails = gates.filter((g) => g.status === FAIL).length;
  const warns = gates.filter((g) => g.status === WARN).length;
  return { ok: fails === 0, fails, warns, gates };
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────
function render(report, { fixHints }) {
  const C = process.stdout.isTTY && !process.env.NO_COLOR;
  const col = (n, s) => (C ? `\x1b[${n}m${s}\x1b[0m` : s);
  const g = (s) => col('32', s), r = (s) => col('31', s), y = (s) => col('33', s), dim = (s) => col('2', s), bold = (s) => col('1', s);
  const mark = (st) => st === PASS ? g('✓') : st === WARN ? y('⚠') : r('✗');
  const out = ['', bold('· animayte release preflight') + dim('  — can this plugin ship?'), ''];
  for (const gt of report.gates) {
    out.push(`  ${mark(gt.status)} ${gt.title}`);
    if (gt.detail) for (const line of String(gt.detail).split('\n')) out.push(dim(line.startsWith('      ') ? line : '      ' + line));
    if (fixHints && gt.status !== PASS && gt.fix) out.push((gt.status === FAIL ? r : y)(`      ↳ fix: ${gt.fix}`));
  }
  out.push('');
  const total = report.gates.length, passed = report.gates.filter((x) => x.status === PASS).length;
  const summary = `${passed}/${total} gates passed` + (report.warns ? `, ${report.warns} warning(s)` : '') + (report.fails ? `, ${report.fails} blocker(s)` : '');
  out.push(report.ok
    ? g(`✅  PASS — ${summary}` + (report.warns ? '  (warnings are non-blocking but worth fixing before a public release)' : '  — ready to ship'))
    : r(`❌  FAIL — ${summary}  — fix the ✗ blocker(s) above before releasing`));
  if (!fixHints && (report.fails || report.warns)) out.push(dim('    (re-run with --fix-hints for the exact remedy per gate)'));
  out.push('');
  return out.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────
const HELP = `animayte-preflight — the single release-readiness gate for the animayte plugin

USAGE
  node tools/animayte-preflight.mjs [--skip-tests] [--json] [--fix-hints]

FLAGS
  --skip-tests   skip \`node test/run.mjs\` (fast manifest-only check)
  --json         emit a machine-readable report (CI)
  --fix-hints    print the exact remedy under each ✗/⚠ gate
  -h, --help     this help

EXIT CODE
  0  PASS — zero blocking (✗) gates   ·   1  FAIL — at least one blocker
  (⚠ warnings never change the exit code; they are the prioritized "fix before public release" list)`;

function parseArgs(argv) {
  const a = { json: false, skipTests: false, fixHints: false };
  for (const t of argv) {
    if (t === '--json') a.json = true;
    else if (t === '--skip-tests') a.skipTests = true;
    else if (t === '--fix-hints') a.fixHints = true;
    else if (t === '-h' || t === '--help') a.help = true;
    else a.error = `unknown argument: ${t}`;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (args.error) { console.error(args.error + '\n\n' + HELP); return 2; }
  const report = preflight({ skipTests: args.skipTests });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report, { fixHints: args.fixHints }));
  return report.ok ? 0 : 1;
}

// run only as a CLI, never on import (so the self-test can import validate* cleanly)
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { process.exit(main()); } catch (e) { console.error(e); process.exit(1); }
}
