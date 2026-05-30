#!/usr/bin/env node
/*
 * animayte · simulate — replay realistic Claude Code sessions through the engine and
 * log the resulting pet state timeline (§9.5). A living regression fixture + demo:
 *
 *   node tools/simulate.mjs            → print every canned session's timeline
 *   node tools/simulate.mjs happy      → just the happy-path session
 *
 * It feeds canned hook-event streams through the SHARED classifier (lib/anim/events)
 * and the state machine (the same logic the daemon + web runtime use), so "what would
 * the pet do across a whole session" is deterministic, readable, and assertable —
 * no Saar, no screen required. The daemon owns the live wiring; this owns the intent.
 */
import { buildSlimeManifest } from '../lib/anim/manifest.mjs';
import { classifyTool } from '../lib/anim/events.mjs';
import { createStateMachine as makeSM } from '../lib/anim/state-machine.mjs';

// ── canned sessions: [{ ev, gap(ms), mood?, error? }] ───────────────────────
const SESSIONS = {
  happy: [
    { ev: 'SessionStart', gap: 600 },
    { ev: 'UserPromptSubmit', gap: 400 },
    { ev: 'PreToolUse', tool: 'Read', gap: 900 },
    { ev: 'PostToolUse', gap: 300 },
    { ev: 'PreToolUse', tool: 'Edit', gap: 1200 },
    { ev: 'PostToolUse', gap: 300 },
    { ev: 'PreToolUse', tool: 'Bash', input: { command: 'npm test' }, gap: 1500 },
    { ev: 'PostToolUse', gap: 300 },
    { ev: 'PreToolUse', tool: 'Bash', input: { command: 'git commit -m "fix"' }, gap: 700 },
    { ev: 'PostToolUse', gap: 300 },
    { ev: 'Stop', mood: 'happy', gap: 1200 },
  ],
  bughunt: [
    { ev: 'SessionStart', gap: 500 },
    { ev: 'UserPromptSubmit', gap: 400 },
    { ev: 'PreToolUse', tool: 'Grep', input: { pattern: 'TODO' }, gap: 800 },
    { ev: 'PostToolUse', gap: 250 },
    { ev: 'PreToolUse', tool: 'Read', gap: 700 },
    { ev: 'PostToolUse', gap: 250 },
    { ev: 'PreToolUse', tool: 'Bash', input: { command: 'npm test' }, gap: 1200 },
    { ev: 'PostToolUse', error: true, gap: 400 },           // tests fail → sad, then recover
    { ev: 'PreToolUse', tool: 'Edit', gap: 1100 },
    { ev: 'PostToolUse', gap: 250 },
    { ev: 'PreToolUse', tool: 'Bash', input: { command: 'npm test' }, gap: 1200 },
    { ev: 'PostToolUse', gap: 300 },
    { ev: 'Stop', mood: 'excited', gap: 1500 },
  ],
  subagents: [
    { ev: 'SessionStart', gap: 500 },
    { ev: 'UserPromptSubmit', gap: 400 },
    { ev: 'PreToolUse', tool: 'Task', input: { description: 'search docs' }, gap: 500 },
    { ev: 'PreToolUse', tool: 'Task', input: { description: 'write tests' }, gap: 500 },
    { ev: 'SubagentStop', gap: 800 },
    { ev: 'SubagentStop', gap: 600 },
    { ev: 'Stop', mood: 'happy', gap: 1200 },
  ],
};

const MOOD_EXPR = { happy: 'happy', excited: 'excited', sad: 'sad', oops: 'oops', thinking: 'thinking', neutral: 'neutral' };

// Map ONE hook event to a state-machine action, mirroring the daemon's intent.
function applyHook(sm, manifest, step, world) {
  const reactions = manifest.reactions || {};
  switch (step.ev) {
    case 'SessionStart': sm.reset(); world.birds = 0; sm.setIdleExpression('happy'); return { note: 'greet' };
    case 'UserPromptSubmit': sm.setIdleExpression('thinking'); sm.release(); return { note: 'listening' };
    case 'PreToolUse': {
      if (step.tool === 'Task' || step.tool === 'Agent') { world.birds = Math.min(5, world.birds + 1); return { note: 'bird+ (' + world.birds + ')' }; }
      const g = classifyTool(step.tool, step.input);
      if (g && reactions[g.event]) { sm.react({ ...reactions[g.event], name: g.event }); return { note: 'tool:' + g.event }; }
      sm.setIdleExpression('thinking'); return { note: 'thinking' };
    }
    case 'PostToolUse':
      sm.release();
      if (step.error) { sm.react({ clip: 'react', expression: 'sad', priority: 5, return: 'idle' }); return { note: 'error→sad' }; }
      sm.setIdleExpression('thinking'); return { note: 'tool done' };
    case 'SubagentStop': world.birds = Math.max(0, world.birds - 1); return { note: 'bird- (' + world.birds + ')' };
    case 'Stop': { const e = MOOD_EXPR[step.mood] || 'neutral'; if (['happy', 'excited'].includes(step.mood)) sm.react({ clip: 'react', expression: e, priority: step.mood === 'excited' ? 6 : 4, return: 'idle' }); else sm.setIdleExpression(e); return { note: 'stop:' + (step.mood || 'idle') }; }
    case 'PreCompact': sm.react({ clip: 'react', expression: 'happy', priority: 6, return: 'idle' }); return { note: 'compact relief' };
    case 'SessionEnd': sm.setIdleExpression('sleepy'); return { note: 'sleep' };
    default: return { note: step.ev };
  }
}

function replaySession(steps, { manifest = buildSlimeManifest(), rng } = {}) {
  const sm = makeSM(manifest, { rng: rng || (() => 0.5), secondaryEveryMs: 100000 }); // mute secondaries for a clean timeline
  const world = { birds: 0 };
  const timeline = [];
  let t = 0;
  for (const step of steps) {
    const { note } = applyHook(sm, manifest, step, world);
    const c = sm.current();
    timeline.push({ t, event: step.ev + (step.tool ? `(${step.tool})` : ''), action: note, kind: c.kind, clip: c.clip, expression: c.expression, prop: c.prop, birds: world.birds });
    const gap = step.gap || 300;
    sm.tick(gap);
    t += gap;
  }
  // settle: tick a long quiet gap and record the resting state
  sm.tick(1200);
  const end = sm.current();
  timeline.push({ t: t + 1200, event: '(quiet)', action: 'settle', kind: end.kind, clip: end.clip, expression: end.expression, prop: end.prop, birds: world.birds });
  return timeline;
}

function summarize(timeline) {
  const reacted = timeline.filter((e) => e.kind === 'reaction').length;
  const endsIdle = timeline[timeline.length - 1].kind !== 'reaction'; // not stuck mid-reaction
  return { steps: timeline.length, reactions: reacted, endsIdle };
}

export { replaySession, SESSIONS, summarize };

// ── CLI ──
import { fileURLToPath, pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const which = process.argv[2];
  const names = which && SESSIONS[which] ? [which] : Object.keys(SESSIONS);
  for (const name of names) {
    const tl = replaySession(SESSIONS[name]);
    console.log(`\n══ session: ${name} ${'═'.repeat(40 - name.length)}`);
    for (const e of tl) console.log(`  +${String(e.t).padStart(5)}ms  ${e.event.padEnd(22)} → ${e.kind.padEnd(9)} ${String(e.clip).padEnd(11)} face=${String(e.expression).padEnd(9)} prop=${String(e.prop || '-').padEnd(9)} birds=${e.birds}  (${e.action})`);
    console.log('  summary:', JSON.stringify(summarize(tl)));
  }
  console.log('');
}
