#!/usr/bin/env node
/*
 * animayte — DISPATCH test (Route 3 / "the plumbing").
 *   node test/dispatch.test.mjs
 *
 * The renderer half of "does the pet react": grid/dispatch.mjs maps each daemon SSE command to a
 * pet control method. Every other suite proves the DAEMON broadcasts the right cmd; this proves the
 * cmd actually lands on the right method with the right args. Driven with a mock pet that records
 * calls — no browser, no canvas — so a vocabulary regression fails here loudly.
 */
import { applyCommand } from '../grid/dispatch.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

// a mock pet that records every method call as [name, ...args]; every property is a function so
// `if (pet.applySpec)` is truthy (matches the real runtime, which DOES expose applySpec)
function mockPet() {
  const calls = [];
  const pet = new Proxy({}, { get: (_t, k) => (...args) => { calls.push([k, ...args]); } });
  return { pet, calls };
}
const last = (calls) => calls[calls.length - 1];

console.log('\n· dispatch — every daemon cmd routes to the right pet method');

// one assertion per command in the daemon's vocabulary
const cases = [
  [{ cmd: 'wake' },                       'wake'],
  [{ cmd: 'hatch' },                      'wake'],
  [{ cmd: 'reset' },                      'reset'],
  [{ cmd: 'resetEgg' },                   'reset'],
  [{ cmd: 'mood', value: 'excited' },     'setMood', 'excited'],
  [{ cmd: 'fullness', value: 0.42 },      'setFullness', 0.42],
  [{ cmd: 'addBird', label: 'helper 1' }, 'addBird', 'helper 1'],
  [{ cmd: 'removeBird' },                 'removeBird'],
  [{ cmd: 'clearBirds' },                 'clearBirds'],
  [{ cmd: 'relief' },                     'relief'],
  [{ cmd: 'react', name: 'Running' },     'reactByName', 'Running'],
  [{ cmd: 'endReact' },                   'toIdle'],
  [{ cmd: 'sleep' },                      'sleep'],
  [{ cmd: 'express', spec: { expression: 'happy' } }, 'applySpec', { expression: 'happy' }],
];
for (const [msg, method, arg] of cases) {
  const { pet, calls } = mockPet();
  const ret = applyCommand(pet, msg, { say: () => {} });
  const c = last(calls);
  const argOk = arg === undefined ? true : JSON.stringify(c && c[1]) === JSON.stringify(arg);
  ok(`cmd '${msg.cmd}' → pet.${method}(${arg !== undefined ? JSON.stringify(arg) : ''})`, ret === true && c && c[0] === method && argOk,
     'got ' + JSON.stringify(c));
}

// 'say' routes to the injected say() (DOM concern), NOT to a pet method
{
  let saidText = null, saidMs = null;
  const { pet, calls } = mockPet();
  const ret = applyCommand(pet, { cmd: 'say', text: 'hi there', ms: 1200 }, { say: (t, ms) => { saidText = t; saidMs = ms; } });
  ok("cmd 'say' calls the injected say(text, ms) and touches no pet method", ret === true && saidText === 'hi there' && saidMs === 1200 && calls.length === 0);
}

// intentionally-ignored / unknown commands are safe no-ops (return false, touch nothing)
for (const msg of [{ cmd: 'ping' }, { cmd: 'moodLevel', value: 0.5 }, { cmd: 'totallyUnknown' }]) {
  const { pet, calls } = mockPet();
  const ret = applyCommand(pet, msg, { say: () => {} });
  ok(`cmd '${msg.cmd}' is a safe no-op (ignored)`, ret === false && calls.length === 0);
}

// robustness: garbage input must never throw
{
  let threw = false;
  try {
    applyCommand(null, { cmd: 'mood', value: 'x' });
    applyCommand({}, null);
    applyCommand({}, { nope: 1 });
    applyCommand({}, { cmd: 42 });
    const { pet } = mockPet(); applyCommand(pet, { cmd: 'say', text: 'x' });   // no say() injected
  } catch { threw = true; }
  ok('garbage / missing-dep input never throws', threw === false);
}

// express with a runtime that lacks applySpec → graceful no-op (the legacy renderer case)
{
  const calls = [];
  const petNoSpec = { wake: () => calls.push('wake') };   // no applySpec
  const ret = applyCommand(petNoSpec, { cmd: 'express', spec: {} }, {});
  ok("cmd 'express' is a no-op when the runtime lacks applySpec", ret === false && calls.length === 0);
}

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} dispatch checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
