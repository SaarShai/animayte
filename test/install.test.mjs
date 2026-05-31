#!/usr/bin/env node
/*
 * animayte — INSTALL ROUND-TRIP test (Route 3 / "the plumbing").
 *   node test/install.test.mjs
 *
 * Proves the global installer is idempotent, reversible, and backup-safe — operating
 * only on throwaway settings files in os.tmpdir(), never the user's real ~/.claude.
 *
 *   install        → animayte's 9 hooks + statusline merged in, user's settings untouched
 *   install twice  → identical file (no duplicate hooks)
 *   uninstall      → file returns to byte-identical to the pre-install original
 *   backup         → a .bak of the prior file is written before every mutation
 *   statusLine     → a user's own statusLine is never clobbered
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyInstall, applyUninstall, installToFile, uninstallFromFile,
  HOOK_EVENTS, hookCommand, statuslineCommand,
} from '../bin/animayte-install.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } };
const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, JSON.stringify(a) === JSON.stringify(b));

const dir = mkdtempSync(join(tmpdir(), 'animayte-install-'));
const isAnimayte = (g) => g && g.hooks && g.hooks.some((h) => h.command && h.command.includes('#animayte'));
const animayteGroups = (s) => Object.values(s.hooks || {}).flat().filter(isAnimayte);

console.log('\n· pure applyInstall / applyUninstall — idempotent + reversible');
{
  // a realistic user settings: their own PreToolUse hook + an unrelated key, no statusLine
  const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
  const original = { hooks: { PreToolUse: [userGroup] }, theme: 'dark', enabledPlugins: { x: true } };

  const once = applyInstall(original, { port: 4321, repoRoot: '/repo' }).settings;
  ok('original is not mutated', JSON.stringify(original.hooks.PreToolUse) === JSON.stringify([userGroup]));
  eq('all 9 events wired', HOOK_EVENTS.every((e) => Array.isArray(once.hooks[e])), true);
  eq("user's PreToolUse hook preserved (first)", once.hooks.PreToolUse[0], userGroup);
  eq('PreToolUse now has user + animayte (2 groups)', once.hooks.PreToolUse.length, 2);
  ok('PreToolUse animayte group carries matcher:*', once.hooks.PreToolUse[1].matcher === '*');
  ok('SessionStart animayte group has no matcher', !('matcher' in once.hooks.SessionStart[0]));
  eq('exactly 9 animayte hook groups total', animayteGroups(once).length, 9);
  ok('statusLine set to animayte (was empty)', once.statusLine && once.statusLine.command === statuslineCommand('/repo'));
  eq('unrelated keys preserved', once.theme, 'dark');

  const twice = applyInstall(once, { port: 4321, repoRoot: '/repo' }).settings;
  eq('install is idempotent (still 9 animayte groups, no dupes)', animayteGroups(twice).length, 9);
  eq('install twice === install once', twice, once);

  const back = applyUninstall(twice).settings;
  eq('uninstall restores the exact original', back, original);
}

console.log('· a user statusLine is never clobbered');
{
  const original = { statusLine: { type: 'command', command: 'my-own-prompt.sh' } };
  const r = applyInstall(original, { repoRoot: '/repo' });
  eq('user statusLine left intact', r.settings.statusLine.command, 'my-own-prompt.sh');
  ok('a warning is surfaced', r.warnings.length > 0);
  eq('uninstall leaves the user statusLine alone', applyUninstall(r.settings).settings.statusLine.command, 'my-own-prompt.sh');
}

console.log('· empty / missing settings');
{
  const r = applyInstall(undefined, { repoRoot: '/repo' }).settings;
  eq('install onto nothing wires 9 events', HOOK_EVENTS.every((e) => r.hooks[e].length === 1), true);
  eq('uninstall an all-animayte file → clean empty object', applyUninstall(r).settings, {});
}

console.log('· file round-trip — backup-safe + reversible on disk');
{
  const path = join(dir, 'settings.json');
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] }, theme: 'light' };
  const originalText = JSON.stringify(original, null, 2) + '\n';
  writeFileSync(path, originalText);

  const ins = await installToFile(path, { port: 4321, repoRoot: '/repo' });
  ok('install created a backup', ins.backup && existsSync(ins.backup));
  eq('backup is byte-identical to the pre-install file', readFileSync(ins.backup, 'utf8'), originalText);
  const afterInstall = JSON.parse(readFileSync(path, 'utf8'));
  eq("user's Stop hook still present", afterInstall.hooks.Stop[0].hooks[0].command, 'echo bye');
  eq('9 animayte groups on disk', animayteGroups(afterInstall).length, 9);

  // idempotent on disk
  await installToFile(path, { port: 4321, repoRoot: '/repo' });
  eq('still 9 animayte groups after a second install', animayteGroups(JSON.parse(readFileSync(path, 'utf8'))).length, 9);

  const un = await uninstallFromFile(path);
  ok('uninstall created a backup', un.backup && existsSync(un.backup));
  eq('file restored byte-for-byte to the original', readFileSync(path, 'utf8'), originalText);

  const backups = readdirSync(dir).filter((f) => f.includes('.animayte-') && f.endsWith('.bak'));
  ok('every mutation left a timestamped backup', backups.length >= 2);
}

console.log('· statusline-only mode (plugin already wires the hooks → no double-fire)');
{
  // a user who already has the plugin + a stale animayte global hook from a prior full install
  const original = applyInstall({ enabledPlugins: { 'animayte@animayte': true } }, { repoRoot: '/repo' }).settings;
  ok('pre-state has animayte hooks', animayteGroups(original).length === 9);
  const slOnly = applyInstall(original, { repoRoot: '/repo', hooks: false }).settings;
  eq('statusline-only removes ALL animayte hook groups', animayteGroups(slOnly).length, 0);
  ok('statusline-only still sets the statusline', slOnly.statusLine && slOnly.statusLine.command === statuslineCommand('/repo'));
  ok('statusline-only preserves enabledPlugins', slOnly.enabledPlugins['animayte@animayte'] === true);
  const userKept = applyInstall({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo u' }] }] } }, { repoRoot: '/repo', hooks: false }).settings;
  eq("statusline-only leaves the user's own hooks intact", userKept.hooks.PreToolUse[0].hooks[0].command, 'echo u');
}

console.log('· a custom port is baked into the hook commands');
{
  const r = applyInstall({}, { port: 4399, repoRoot: '/repo' }).settings;
  ok('hook command targets the chosen port', r.hooks.SessionStart[0].hooks[0].command.includes(':4399/event'));
  eq('hookCommand() matches what install writes', r.hooks.SessionStart[0].hooks[0].command, hookCommand(4399));
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} install checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
