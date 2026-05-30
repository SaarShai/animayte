#!/usr/bin/env node
/* animayte test runner — runs every suite, exits non-zero if any fail.  node test/run.mjs */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['expressions.test.mjs', 'integration.test.mjs'];
let failed = 0;
for (const s of suites) {
  const r = spawnSync('node', [join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n❌ ${failed} suite(s) failed.` : '\n✅ all suites passed.');
process.exit(failed ? 1 : 0);
