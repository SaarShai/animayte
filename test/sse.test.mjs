#!/usr/bin/env node
/*
 * animayte — SSE SUPERVISOR test (Route 3 / "the plumbing").
 *   node test/sse.test.mjs
 *
 * The overlay can only react to the session if it stays connected. The reconnect/backoff/watchdog
 * logic in grid/sse.mjs is the client half of the reconnect story (reconnect.test.mjs covers the
 * server half) and was previously UNTESTABLE because it lived inline in the HTML. It is now a
 * dependency-injected module, so this drives it with a FAKE CLOCK and a FAKE EventSource — no
 * browser — to lock the behaviours that recent live bugs turned on:
 *   · reconnect on ANY error (WKWebView sits in CONNECTING forever otherwise)
 *   · heartbeat watchdog forces a reconnect on a silent / half-open stream
 *   · a single clock JUMP (WKWebView suspends timers, then resumes) ⇒ ONE reconnect, not a flood
 *   · never leak a second live stream; backoff grows then caps; close() really stops everything
 */
import { createSseSupervisor } from '../grid/sse.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push('  ✗ ' + name + (extra ? '  → ' + extra : '')); } };

// ── a controllable virtual clock: timers fire in order as we advance() ───────────────────────
function makeClock() {
  let now = 0, seq = 1; const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    // normal time passing: fire timers in scheduled order; a timer rescheduled during a fire is
    // honoured only if its new deadline still falls within this window (matches real setTimeout)
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.at)) next = { id, ...t };
        if (!next) break;
        timers.delete(next.id); now = next.at; next.fn();
      }
      now = target;
    },
    // OS timer SUSPEND/RESUME (WKWebView occluded): time leaps forward while callbacks are frozen;
    // on resume, each timer that was ALREADY pending and is now overdue fires once. Timers scheduled
    // DURING the resume burst are future work (the reconnect's stream will open in real time) and do
    // NOT fire again here — this is what proves "one jump ⇒ one reconnect, not a flood".
    jump(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) if (timers.has(id)) { timers.delete(id); t.fn(); }
    },
    pending: () => timers.size,
  };
}
// ── a fake EventSource we can open / message / error on command ───────────────────────────────
function makeESFactory() {
  const created = [];
  class FakeES {
    constructor(url) { this.url = url; this.readyState = 0; this.onopen = this.onmessage = this.onerror = null; this.closed = false; created.push(this); }
    close() { this.closed = true; this.readyState = 2; }
    _open() { this.readyState = 1; this.onopen && this.onopen(); }
    _msg(data) { this.onmessage && this.onmessage({ data }); }
    _err() { this.onerror && this.onerror(); }
  }
  return { FakeES, created };
}
const mk = (over = {}) => {
  const clock = makeClock(); const { FakeES, created } = makeESFactory();
  let opens = 0, downs = 0, msgs = 0;
  const sup = createSseSupervisor({
    url: '/events', EventSource: FakeES,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onOpen: () => opens++, onDown: () => downs++, onMessage: () => msgs++,
    beatMs: 1000, backoffStart: 100, backoffMax: 800, backoffFactor: 2, ...over,
  });
  return { clock, created, sup, stats: () => ({ opens, downs, msgs }) };
};

console.log('\n· sse supervisor — reconnect on any error, watchdog, jump-safe, no leaks');

// 1) open() creates exactly one stream to the right url
{ const { created, sup } = mk(); sup.open();
  ok('open() creates one EventSource for /events', created.length === 1 && created[0].url === '/events'); }

// 2) onopen → live + onOpen fired
{ const { created, sup, stats } = mk(); sup.open(); created[0]._open();
  ok('onopen marks the stream live + fires onOpen', sup.isLive() === true && stats().opens === 1); }

// 3) reconnect on ANY error (not just CLOSED): error → after backoff a NEW stream opens
{ const { clock, created, sup, stats } = mk(); sup.open(); created[0]._open(); created[0]._err();
  ok('onerror fires onDown', stats().downs === 1);
  ok('onerror closed the old stream', created[0].closed === true);
  clock.advance(100);   // backoffStart
  ok('reconnect on any error opens a new stream after backoff', created.length === 2); }

// 4) heartbeat watchdog: a silent stream (no bytes for beatMs) forces a reconnect
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  clock.advance(1000);  // beatMs of silence
  ok('watchdog reconnects a half-open / silent stream', created.length === 2 && created[0].closed === true); }

// 5) a message resets the watchdog (the daemon ping keeps it alive)
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  clock.advance(900); created[0]._msg('{"cmd":"ping"}'); clock.advance(900);   // 1800 total, but <1000 since the ping
  ok('a message resets the watchdog (no premature reconnect)', created.length === 1);
  clock.advance(200);                                                          // now >beatMs since the ping
  ok('watchdog still fires once the gap exceeds beatMs', created.length === 2); }

// 6) WKWebView timer suspend → a big clock JUMP causes exactly ONE reconnect, not a flood
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  clock.jump(300000);   // ~5 min suspended then resumed (the pending watchdog fires once)
  ok('a 5-minute clock jump triggers exactly ONE reconnect', created.length === 2, 'created=' + created.length); }

// 7) backoff grows between successive failures (100ms → 200ms)
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  created[0]._err(); clock.advance(100);          // 1st retry after backoffStart=100 → #2
  created[1]._err();                               // 2nd failure: next backoff is 200ms
  clock.advance(100);                              // only 100ms — not enough now
  ok('backoff grew (100ms no longer reconnects after the 2nd failure)', created.length === 2);
  clock.advance(100);                              // 200ms total since the 2nd failure → #3
  ok('reconnect fires once the grown backoff elapses', created.length === 3); }

// 8) onopen resets backoff to the floor
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  created[0]._err(); clock.advance(100); created[1]._open();   // live again → backoff resets
  created[1]._err(); clock.advance(100);                       // floor backoff (100) should reconnect
  ok('a successful open resets backoff to the floor', created.length === 3); }

// 9) close() stops the world: no reconnect on later error or timer
{ const { clock, created, sup } = mk(); sup.open(); created[0]._open();
  sup.close();
  ok('close() closed the live stream', created[0].closed === true);
  created[0]._err(); clock.advance(100000);
  ok('after close(), an error/timer never reconnects', created.length === 1);
  ok('after close(), no timers are left armed (no leaked watchdog/backoff)', clock.pending() === 0, 'pending=' + clock.pending()); }

// 10) construction-time EventSource throw is handled (schedule, don't crash)
{ const clock = makeClock(); let n = 0;
  const Boom = function () { n++; throw new Error('no ctor'); };
  const sup = createSseSupervisor({ url: '/events', EventSource: Boom, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, beatMs: 1000, backoffStart: 100 });
  let threw = false; try { sup.open(); } catch { threw = true; }
  ok('a throwing EventSource ctor is caught (schedules a retry, no crash)', threw === false && n === 1);
  clock.advance(100);
  ok('it retries construction after backoff', n === 2); }

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} sse-supervisor checks passed` + (fail ? ':' : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
