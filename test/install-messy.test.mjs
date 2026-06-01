#!/usr/bin/env node
/*
 * animayte — INSTALL on MESSY real-world configs (Route 3 / "the plumbing").
 *   node test/install-messy.test.mjs
 *
 * The happy-path round-trip is covered by install.test.mjs. This locks the two P0 failure modes an
 * actual user hits — both of which previously ended with a SILENTLY DEAD pet + a false "installed":
 *   · a settings.json that's a JSON array / scalar / null (corrupted or hand-migrated) — install used
 *     to write back byte-identical (JSON.stringify drops named keys off an array), skip the backup,
 *     and still print success while wiring nothing.
 *   · a DISABLED animayte plugin (enabledPlugins: {"animayte@…": false}) read as enabled — install
 *     then gave statusline-only (no hooks) and doctor falsely reported "hooks via the plugin".
 * Operates only on throwaway files in os.tmpdir(); never touches the real ~/.claude.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyInstall, applyUninstall, installToFile, doctor, HOOK_EVENTS } from '../bin/animayte-install.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };
const dir = mkdtempSync(join(tmpdir(), 'animayte-messy-'));
const animayteGroups = (s) => Object.values((s && s.hooks) || {}).flat().filter((g) => g && g.hooks && g.hooks.some((h) => h.command && h.command.includes('#animayte')));

console.log('\n· install on messy configs — array/scalar settings + a disabled plugin');

// 1) non-object top-level settings → coerced to a valid object with all 9 hooks + a warning
for (const bad of [[{ foo: 1 }], 42, 'nope', null, true]) {
  const r = applyInstall(bad, { repoRoot: '/repo' });
  ok(`applyInstall(${JSON.stringify(bad)}) yields a valid object with ${HOOK_EVENTS.length} hooks`,
     r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings) && animayteGroups(r.settings).length === HOOK_EVENTS.length);
  if (bad !== null) ok(`applyInstall(${JSON.stringify(bad)}) surfaces a warning`, Array.isArray(r.warnings) && r.warnings.length >= 1);
}
// applyUninstall must not choke on an array either
{ let threw = false; try { applyUninstall([1, 2, 3]); } catch { threw = true; } ok('applyUninstall tolerates a non-object settings', !threw); }

// 2) installToFile on an ARRAY file → writes a backup + the disk becomes a valid wired object
{
  const p = join(dir, 'array-settings.json');
  writeFileSync(p, '[{"foo":1}]');
  await installToFile(p, { port: 4321, repoRoot: '/repo' });
  const after = JSON.parse(readFileSync(p, 'utf8'));
  ok('installToFile turns an array file into a valid object', !Array.isArray(after) && typeof after === 'object');
  ok('installToFile actually wires the 9 hooks (pet would react)', animayteGroups(after).length === HOOK_EVENTS.length);
  ok('installToFile wrote a backup of the original (not a silent no-op)', readdirSync(dir).some((f) => f.startsWith('array-settings.json') && f.includes('.bak')));
}

// 3) a DISABLED plugin must NOT read as enabled — doctor must not claim "via the plugin"
{
  const p = join(dir, 'disabled-plugin.json');
  writeFileSync(p, JSON.stringify({ enabledPlugins: { 'animayte@animayte': false } }));
  const saved = process.env.ANIMAYTE_SETTINGS; process.env.ANIMAYTE_SETTINGS = p;
  const out = []; const orig = console.log; console.log = (...a) => out.push(a.join(' '));
  try { await doctor({ port: 59998 }); } finally { console.log = orig; if (saved === undefined) delete process.env.ANIMAYTE_SETTINGS; else process.env.ANIMAYTE_SETTINGS = saved; }
  const text = out.join('\n');
  ok('doctor does NOT falsely claim "hooks via the animayte plugin" when it is disabled', !/hooks via the animayte plugin/.test(text), text.split('\n').find((l) => /plugin|hooks/i.test(l)) || '');
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} install-messy checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
