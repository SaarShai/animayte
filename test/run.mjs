#!/usr/bin/env node
/* animayte test runner — runs every suite, exits non-zero if any fail.  node test/run.mjs */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['anim.test.mjs', 'conformance.mjs', 'docs.test.mjs', 'codex.test.mjs', 'expressions.test.mjs', 'position.test.mjs', 'detection-sim.test.mjs', 'appraise.test.mjs', 'integration.test.mjs', 'install.test.mjs', 'install-messy.test.mjs', 'reconnect.test.mjs', 'plugin.test.mjs', 'stress.test.mjs', 'compact.test.mjs', 'sidechain.test.mjs', 'contract.test.mjs', 'dispatch.test.mjs', 'sse.test.mjs', 'transport.test.mjs', 'reactivity.test.mjs', 'daemon-safety.test.mjs', 'adopt.test.mjs', 'gallery.test.mjs', 'replay.test.mjs', 'e2e.test.mjs'];
let failed = 0;
for (const s of suites) {
  const r = spawnSync('node', [join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n❌ ${failed} suite(s) failed.` : '\n✅ all suites passed.');
process.exit(failed ? 1 : 0);
