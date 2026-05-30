#!/usr/bin/env node
/*
 * animayte — DOC LINT (C8). Every repo path and `npm run …` command referenced in the
 * docs must actually exist, so the docs can't rot as files move. Scans README.md,
 * CONTRIBUTING.md, and docs/*.md.  node test/docs.test.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name); } };

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {};

const docFiles = ['README.md', 'CONTRIBUTING.md', ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f)]
  .filter((f) => existsSync(join(ROOT, f)));

// dir-prefixed repo paths with an extension (placeholders like pets/<name>/ won't match —
// '<' is outside the class and there's no extension to anchor on)
// negative lookbehind on `/` + letters so URL path segments (…claude.com/docs/en/x.md) aren't matched as repo paths
const PATH_RE = /(?<![/A-Za-z0-9.])(?:lib|tools|test|pets|assets|personalities|desktop|docs|bin|hooks|commands)\/[A-Za-z0-9_\-./]+\.[a-z]{2,5}\b/g;
const ROOT_FILE_RE = /\b(?:animayte\.(?:mjs|html)|package\.json|tester\.html)\b/g;
const NPM_RE = /npm (?:run ([a-z][a-z:-]*)|(test|start))\b/g;

console.log('\nDoc lint — every referenced file + command exists\n');

let pathsChecked = 0, cmdsChecked = 0;
for (const doc of docFiles) {
  const src = readFileSync(join(ROOT, doc), 'utf8');
  const paths = new Set([...(src.match(PATH_RE) || []), ...(src.match(ROOT_FILE_RE) || [])]);
  for (const p of paths) {
    pathsChecked++;
    ok(`${doc} → ${p} exists`, existsSync(join(ROOT, p)));
  }
  for (const m of src.matchAll(NPM_RE)) {
    const name = m[1] || m[2];
    cmdsChecked++;
    ok(`${doc} → \`npm ${m[1] ? 'run ' + name : name}\` is a real script`, name in scripts);
  }
}

console.log(`  · checked ${pathsChecked} file references + ${cmdsChecked} npm commands across ${docFiles.length} docs`);

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} doc-lint checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
