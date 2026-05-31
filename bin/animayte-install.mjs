#!/usr/bin/env node
/*
 * animayte — global install / uninstall / doctor for Claude Code.
 *
 * Wires (and cleanly removes) animayte's forwarding hooks + statusline in the user's
 * GLOBAL Claude Code settings (~/.claude/settings.json), so the pet reacts to sessions
 * in *any* project — not just this repo. The project-level .claude/settings.json only
 * covers sessions launched inside the animayte folder; this is the everywhere install.
 *
 * Design goals (Route 3 — "the plumbing"):
 *   · idempotent  — run install twice → identical file, never duplicate hooks
 *   · reversible  — uninstall removes exactly animayte's entries, nothing of the user's
 *   · backup-safe — every mutation writes a timestamped .bak first
 *
 * The translation/render logic lives elsewhere; this file is pure settings plumbing.
 * The pure functions (applyInstall / applyUninstall) take settings-in → settings-out so
 * test/install.test.mjs can round-trip them without touching the real settings file.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4321;

// Every hook command we install carries this sentinel so uninstall can find exactly
// our entries. It sits after `|| true` as a shell comment — harmless when the hook runs.
const MARKER = '#animayte';

// The 9 lifecycle events animayte forwards. PreToolUse/PostToolUse fire for every tool,
// so they take a `matcher:'*'` (mirrors hooks/hooks.json + .claude/settings.json).
export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStop', 'Notification', 'Stop', 'PreCompact', 'SessionEnd',
];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// ---- the canonical animayte settings contributions ----
export function hookCommand(port = DEFAULT_PORT) {
  // fire-and-forget: a 0.4s cap + `|| true` means a down/slow daemon never stalls Claude Code.
  return `curl -s -m 0.4 -X POST http://127.0.0.1:${port}/event -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true ${MARKER}`;
}
export function statuslineCommand(repoRoot = REPO_ROOT) {
  // global install → absolute path (no $CLAUDE_PROJECT_DIR outside the repo).
  return `node "${join(repoRoot, 'bin', 'animayte-statusline.mjs')}"`;
}

// ---- recognizers (so we only ever touch what we wrote) ----
const isAnimayteHookCmd = (c) => typeof c === 'string' && c.includes(MARKER);
const isAnimayteStatuslineCmd = (c) => typeof c === 'string' && /animayte-statusline\.mjs/.test(c);
const isAnimayteHookGroup = (g) =>
  g && Array.isArray(g.hooks) && g.hooks.some((h) => h && isAnimayteHookCmd(h.command));

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

/**
 * applyInstall(settings, opts) → { settings, warnings }
 * Pure: returns a NEW settings object with animayte's hooks + statusline merged in.
 * Idempotent: drops any pre-existing animayte entries before re-adding, so re-running
 * never duplicates. Never clobbers the user's own hooks or a non-animayte statusLine.
 */
export function applyInstall(settings, { port = DEFAULT_PORT, repoRoot = REPO_ROOT } = {}) {
  const s = clone(settings) || {};
  const warnings = [];
  s.hooks = s.hooks && typeof s.hooks === 'object' && !Array.isArray(s.hooks) ? s.hooks : {};

  const cmd = hookCommand(port);
  for (const ev of HOOK_EVENTS) {
    const entry = MATCHER_EVENTS.has(ev)
      ? { matcher: '*', hooks: [{ type: 'command', command: cmd }] }
      : { hooks: [{ type: 'command', command: cmd }] };
    const arr = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    const kept = arr.filter((g) => !isAnimayteHookGroup(g)); // refresh: remove our old entry, keep the user's
    kept.push(entry); // additive: our forwarder runs alongside whatever else the user has
    s.hooks[ev] = kept;
  }

  // statusLine: claim only an empty slot or one already ours — never overwrite the user's.
  const slCmd = s.statusLine && typeof s.statusLine === 'object' ? s.statusLine.command : null;
  if (!s.statusLine || isAnimayteStatuslineCmd(slCmd)) {
    s.statusLine = { type: 'command', command: statuslineCommand(repoRoot), padding: 0 };
  } else {
    warnings.push(
      `Kept your existing statusLine (animayte did not overwrite it). ` +
      `To use animayte's instead, set statusLine.command to:\n    ${statuslineCommand(repoRoot)}`,
    );
  }
  return { settings: s, warnings };
}

/**
 * applyUninstall(settings) → { settings, changed }
 * Pure: removes exactly animayte's hook groups + statusLine, prunes empties, and leaves
 * everything else byte-for-byte. install→uninstall round-trips back to the original.
 */
export function applyUninstall(settings) {
  const s = clone(settings) || {};
  let changed = false;
  if (s.hooks && typeof s.hooks === 'object' && !Array.isArray(s.hooks)) {
    for (const ev of Object.keys(s.hooks)) {
      if (!Array.isArray(s.hooks[ev])) continue;
      const kept = s.hooks[ev].filter((g) => !isAnimayteHookGroup(g));
      if (kept.length !== s.hooks[ev].length) changed = true;
      if (kept.length) s.hooks[ev] = kept;
      else delete s.hooks[ev]; // event existed only for us → remove the key entirely
    }
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
  }
  if (s.statusLine && isAnimayteStatuslineCmd(s.statusLine.command)) {
    delete s.statusLine;
    changed = true;
  }
  return { settings: s, changed };
}

// ---- file I/O wrappers (the CLI uses these; the test uses both) ----
export function settingsPath() {
  return process.env.ANIMAYTE_SETTINGS || join(homedir(), '.claude', 'settings.json');
}
export async function readSettings(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
}
async function backupSettings(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let bak = `${path}.animayte-${stamp}.bak`;
  for (let n = 1; existsSync(bak); n++) bak = `${path}.animayte-${stamp}-${n}.bak`;
  await copyFile(path, bak);
  return bak;
}
const writeSettings = (path, obj) => writeFile(path, JSON.stringify(obj, null, 2) + '\n');

export async function installToFile(path, opts = {}) {
  const before = await readSettings(path);
  const backup = await backupSettings(path);
  const { settings, warnings } = applyInstall(before, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeSettings(path, settings);
  return { path, backup, warnings, settings };
}
export async function uninstallFromFile(path) {
  const before = await readSettings(path);
  const backup = await backupSettings(path);
  const { settings, changed } = applyUninstall(before);
  if (existsSync(path) || changed) {
    await mkdir(dirname(path), { recursive: true });
    await writeSettings(path, settings);
  }
  return { path, backup, settings, changed };
}

// ---- doctor: diagnose the common "why is the pet quiet?" failures ----
function probeHealth(port, timeoutMs = 900) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}
// pull the port baked into an installed animayte hook command (so we can spot a mismatch)
function installedHookPort(settings) {
  const groups = Object.values(settings.hooks || {}).flat();
  for (const g of groups) {
    if (!isAnimayteHookGroup(g)) continue;
    const m = String(g.hooks.find((h) => isAnimayteHookCmd(h.command)).command).match(/:(\d+)\/event/);
    if (m) return Number(m[1]);
  }
  return null;
}

export async function doctor({ port = Number(process.env.ANIMAYTE_PORT) || DEFAULT_PORT } = {}) {
  const path = settingsPath();
  const projectSettings = join(REPO_ROOT, '.claude', 'settings.json');
  const lines = [];
  let problems = 0;
  const ok = (label, detail = '') => lines.push(`  ✓ ${label}${detail ? '  — ' + detail : ''}`);
  const bad = (label, hint) => { problems++; lines.push(`  ✗ ${label}${hint ? '\n      → ' + hint : ''}`); };
  const info = (label) => lines.push(`  · ${label}`);

  // 1) global install state
  const global = await readSettings(path);
  const globalHookPort = installedHookPort(global);
  const hasGlobalHooks = globalHookPort != null;
  const hasGlobalStatus = !!(global.statusLine && isAnimayteStatuslineCmd(global.statusLine.command));
  const project = existsSync(projectSettings) ? await readSettings(projectSettings) : {};
  const hasProjectHooks = installedHookPort(project) != null;
  const pluginEnabled = !!(global.enabledPlugins && Object.keys(global.enabledPlugins).some((k) => /^animayte(@|$)/.test(k)));

  if (hasGlobalHooks) ok('hooks installed globally', `port ${globalHookPort} · ${path}`);
  else if (pluginEnabled) ok('hooks via the animayte plugin', 'enabled in ~/.claude/settings.json');
  else if (hasProjectHooks) info(`hooks are project-only (${projectSettings}) — pet reacts only inside this repo. Run "bin/animayte install" for everywhere.`);
  else bad('no animayte hooks found', 'run  bin/animayte install');

  if (pluginEnabled && hasGlobalHooks)
    info('both the plugin AND a global install are active — events may fire twice. Pick one (uninstall, or disable the plugin).');

  if (hasGlobalStatus) ok('statusline installed globally');
  else if (global.statusLine) info('a non-animayte statusLine is set globally — animayte left it alone (cost/effort feed off, the pet still reacts to hooks).');
  else info('no global statusline — install adds it (feeds context%/cost/effort).');

  // 2) daemon reachable?
  const health = await probeHealth(port);
  if (health && health.ok) {
    ok('daemon is up', `http://127.0.0.1:${port}`);
    const st = health.state || {};
    // 3) is a live session actually driving it? (lastEventAt = last REAL hook/statusline,
    //    not state.updated which ticks at boot — a fresh idle daemon must not read as "live")
    const ageMs = st.lastEventAt ? Date.now() - st.lastEventAt : Infinity;
    if (Number.isFinite(ageMs) && ageMs < 5 * 60_000) {
      const bits = [];
      if (st.model) bits.push(st.model);
      if (typeof st.ctxPct === 'number') bits.push(`ctx ${st.ctxPct}%`);
      if (st.mood) bits.push(`mood ${st.mood}`);
      ok('a live session is driving the pet', `${bits.join(' · ') || 'recent activity'} (${Math.round(ageMs / 1000)}s ago)`);
    } else {
      info('daemon up but no recent session events — start a Claude Code session (with hooks installed) to see it react.');
    }
    if (globalHookPort != null && globalHookPort !== port)
      bad(`port mismatch`, `hooks POST to :${globalHookPort} but the daemon is on :${port}. Re-run  ANIMAYTE_PORT=${port} bin/animayte install  (or start the daemon on :${globalHookPort}).`);
  } else {
    bad('daemon is not reachable', `start it with  bin/animayte start  (or  npm start). Checked http://127.0.0.1:${port}/health.`);
  }

  const header = problems === 0 ? '🩺 animayte doctor — all clear' : `🩺 animayte doctor — ${problems} issue${problems > 1 ? 's' : ''} found`;
  console.log('\n' + header + '\n' + lines.join('\n') + '\n');
  return problems;
}

// ---- CLI ----
async function main(argv) {
  const cmd = argv[2];
  const port = Number(process.env.ANIMAYTE_PORT) || DEFAULT_PORT;
  const path = settingsPath();
  if (cmd === 'install') {
    const r = await installToFile(path, { port });
    console.log(`\n🐣 animayte installed globally → ${r.path}`);
    console.log(`   · ${HOOK_EVENTS.length} hooks forward to http://127.0.0.1:${port}/event`);
    console.log(`   · statusline: ${r.settings.statusLine && isAnimayteStatuslineCmd(r.settings.statusLine.command) ? 'on' : 'left as-is'}`);
    if (r.backup) console.log(`   · backup: ${r.backup}`);
    for (const w of r.warnings) console.log(`   ⚠ ${w}`);
    console.log(`\n   Restart Claude Code (any project) for it to load, then  bin/animayte start.\n`);
    return 0;
  }
  if (cmd === 'uninstall') {
    const r = await uninstallFromFile(path);
    console.log(`\n🧹 animayte uninstalled from ${r.path}${r.changed ? '' : ' (nothing to remove)'}`);
    if (r.backup) console.log(`   · backup: ${r.backup}`);
    console.log(`   Restart Claude Code for the change to take effect.\n`);
    return 0;
  }
  if (cmd === 'doctor') return (await doctor({ port })) === 0 ? 0 : 1;
  console.error('usage: animayte-install.mjs [install|uninstall|doctor]');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((code) => process.exit(code)).catch((e) => {
    console.error('animayte install error:', (e && e.message) || e);
    process.exit(1);
  });
}
