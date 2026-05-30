#!/usr/bin/env node
/*
 * animayte — quick expression tester (CLI).
 *   node test/try.mjs "🎉 it works!"
 *   node test/try.mjs            # interactive: type lines, see the expression
 *
 * Uses the REAL detection code (lib/expressions.mjs) — what you see here is
 * exactly what the pet does.
 */
import { detectExpression, EXPRESSIONS } from '../lib/expressions.mjs';
import { createInterface } from 'node:readline';

function show(text) {
  const r = detectExpression(text);
  if (!r) { console.log(`   🫥  (no expression)   — neutral / nothing to react to`); return; }
  const ex = EXPRESSIONS.find((e) => e.id === r.id);
  console.log(`   ${r.apple}  ${r.id.toUpperCase().padEnd(9)} — ${ex.meaning}`);
  console.log(`      why: ${r.reason}`);
}

const arg = process.argv.slice(2).join(' ').trim();
if (arg) { show(arg); process.exit(0); }

console.log('\nanimayte expression tester — type a line as the agent might write it, press enter.');
console.log('(try:  🎉 it works!   ·   sorry, my mistake   ·   the build failed   ·   ctrl-c to quit)\n');
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'agent says ▸ ' });
rl.prompt();
rl.on('line', (line) => { if (line.trim()) show(line); console.log(''); rl.prompt(); });
rl.on('close', () => console.log('bye 👋'));
