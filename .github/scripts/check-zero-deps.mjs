#!/usr/bin/env node
/*
 * Zero-dependency TRIPWIRE (CI gate).
 *   node .github/scripts/check-zero-deps.mjs
 *
 * animayte ships with ZERO runtime/dev dependencies on purpose (it's a no-install
 * Claude Code plugin: Node builtins + curl only). This fails the build the moment
 * a `dependencies` or `devDependencies` entry sneaks into package.json, so the
 * "install-anywhere, nothing to npm-install" guarantee can never silently rot.
 *
 * Node builtins only; runs identically on macOS / Windows / Linux. Exit 1 on any dep.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgPath = join(ROOT, 'package.json');

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  console.error('✗ could not read/parse package.json at ' + pkgPath + '\n  ' + err.message);
  process.exit(1);
}

const deps = Object.keys(pkg.dependencies || {});
const devDeps = Object.keys(pkg.devDependencies || {});
const optDeps = Object.keys(pkg.optionalDependencies || {});
const peerDeps = Object.keys(pkg.peerDependencies || {});
const offenders = [
  ...deps.map((d) => 'dependencies/' + d),
  ...devDeps.map((d) => 'devDependencies/' + d),
  ...optDeps.map((d) => 'optionalDependencies/' + d),
  ...peerDeps.map((d) => 'peerDependencies/' + d),
];

if (offenders.length) {
  console.error('✗ ZERO-DEP TRIPWIRE FAILED — package.json declares ' + offenders.length + ' dependency(ies):');
  for (const o of offenders) console.error('    ' + o);
  console.error('\n  animayte must stay zero-dependency (Node builtins + curl only).');
  console.error('  If a dep is truly unavoidable, this gate (and the project vision) needs an explicit decision.');
  process.exit(1);
}

console.log('✓ zero-dependency tripwire passed — no dependencies / devDependencies / optional / peer.');
