#!/usr/bin/env node
/*
 * Cross-OS syntax LINT (CI gate) — `node --check` over every shipped *.mjs.
 *   node .github/scripts/check-syntax.mjs
 *
 * Cheap, dependency-free, and runs on every OS in the matrix. Catches the class of
 * bug that a single-platform dev never sees: a syntax slip that parses for you but
 * trips a different Node, or a file that's never imported by the test suite and so
 * is otherwise unproven. `node --check` parses without executing, so it's safe to
 * point at the whole tree (daemon, hooks scripts, grid, lib, tools, tests).
 *
 * Pure Node walker (no `find` / `xargs` / glob) so behaviour is identical on
 * Windows PowerShell, macOS zsh, and Linux bash. Exit 1 if ANY file fails to parse.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT).sort();
if (files.length === 0) {
  console.error('✗ no *.mjs files found under ' + ROOT + ' — that cannot be right.');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error('✗ ' + rel + '\n' + (r.stderr || r.stdout || '  (no diagnostic output)').trimEnd());
  }
}

if (failed) {
  console.error('\n✗ node --check FAILED — ' + failed + ' of ' + files.length + ' *.mjs file(s) have syntax errors.');
  process.exit(1);
}

console.log('✓ node --check passed — all ' + files.length + ' *.mjs files parse on ' + process.platform + ' / Node ' + process.version + '.');
