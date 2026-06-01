/*
 * animayte · SSE supervisor — keeps the overlay's EventSource alive across daemon restarts and
 * WKWebView's "stuck in CONNECTING" bug (WebKit does not reliably fire onerror or auto-reconnect
 * after a drop/suspend — see Chromium #303919, Yaffle/EventSource #88/#24). The daemon helps by
 * sending a real `data:{"cmd":"ping"}` every 20s; this client treats ANY error or any gap longer
 * than `beatMs` as "reconnect now", tearing down and re-creating the EventSource itself rather than
 * trusting the browser.
 *
 * Every dependency (EventSource, the timers, now) is INJECTED, so the reconnect / backoff /
 * watchdog logic is unit-testable with a fake clock and a fake EventSource (test/sse.test.mjs) —
 * no browser required. The DOM-only bits (visibilitychange) stay in the host page and just call
 * open() when the page becomes visible and the stream isn't live.
 *
 * Locked behaviour:
 *   · reconnect on ANY error (not just readyState===CLOSED)
 *   · heartbeat watchdog: no bytes for beatMs ⇒ force reconnect (catches a half-open stream)
 *   · never leak a second live stream (close the old before opening a new)
 *   · exponential backoff, capped; reset to floor on a successful open
 *   · a single clock JUMP (WKWebView timer suspend/resume) causes ONE reconnect, not a flood
 */
export function createSseSupervisor(opts) {
  const {
    url,
    EventSource,                 // constructor (window.EventSource in the browser)
    onMessage,                   // (event) => void   — raw SSE message event
    onOpen,                      // ()      => void   — became live
    onDown,                      // (everLive:boolean) => void — went to reconnecting/waiting
    setTimeout: sT = globalThis.setTimeout,
    clearTimeout: cT = globalThis.clearTimeout,
    beatMs = 45000,
    backoffStart = 1000,
    backoffMax = 10000,
    backoffFactor = 1.7,
  } = opts;

  let es = null, backoff = backoffStart, timer = 0, beat = 0, everLive = false, closed = false;

  const schedule = () => { cT(timer); timer = sT(open, backoff); backoff = Math.min(backoff * backoffFactor, backoffMax); };
  // (re)arm the heartbeat watchdog; any byte (incl. the daemon's ping) calls this to stay alive
  const kick = () => { cT(beat); beat = sT(() => { try { if (es) es.close(); } catch (_) {} open(); }, beatMs); };

  function open() {
    if (closed) return;
    cT(timer);
    if (es) { try { es.close(); } catch (_) {} es = null; }    // never leak a second live stream
    try { es = new EventSource(url); } catch (_) { schedule(); return; }
    kick();
    es.onopen = () => { everLive = true; backoff = backoffStart; kick(); if (onOpen) onOpen(); };
    es.onmessage = (e) => { kick(); if (onMessage) onMessage(e); };
    es.onerror = () => {
      if (onDown) onDown(everLive);
      // take over reconnection on ANY error — WKWebView can sit in CONNECTING forever otherwise.
      try { if (es) es.close(); } catch (_) {}
      schedule();
    };
  }

  return {
    open,
    close() { closed = true; cT(timer); cT(beat); if (es) { try { es.close(); } catch (_) {} es = null; } },
    isLive: () => !!es && es.readyState === 1,
    current: () => es,            // test/visibility affordance
    everLive: () => everLive,
  };
}
