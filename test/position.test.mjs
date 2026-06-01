#!/usr/bin/env node
/*
 * animayte — native pet WINDOW-POSITION recovery contract (pure, fast, no server).
 *   node test/position.test.mjs
 *
 * The Dijon native pet persists its window origin to ~/.animayte/dijonpos.json on every
 * drag and reloads it verbatim on launch. A saved origin that is off-screen — dragged off,
 * or from a monitor layout that no longer exists — reopened the window completely invisible
 * with NO in-app way to recover (real incident: {"x":-62,"y":-218} on a 1728×1117 display
 * put the whole 210×280 window below the Dock-excluded visibleFrame).
 *
 * This is a static SOURCE contract (same pattern as expressions.test.mjs reading the Swift):
 * loadSavedOrigin() MUST validate the parsed origin against the visible screens before
 * returning it, so an off-screen value falls back to defaultOrigin instead of vanishing.
 * There is no AppKit runtime in node, so we assert the guard is wired in — red without the fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(`  ✗ ${name}`); } }

const src = readFileSync(join(ROOT, 'desktop/dijon-pet.swift'), 'utf8');

console.log('\nNative pet — off-screen position recovery');

// 1. There is an on-screen validation that consults EVERY screen's *visible* frame
//    (visibleFrame, not frame — so a window stranded behind the Dock/menu bar is rejected).
ok('validates against NSScreen.screens', /NSScreen\.screens/.test(src));
ok('uses visibleFrame (Dock/menu-bar aware), not raw frame', /\.visibleFrame/.test(src));
ok('tests window overlap via rect intersection', /\.intersection\(/.test(src));
ok('bounds rect uses the real window size (winW × winH), not just the point',
   /NSRect\([^)]*winW[^)]*winH/.test(src));
ok('requires a minimum visible extent (a positive on-screen threshold)',
   /let\s+minVisible[^\n]*=\s*\d+/.test(src) && />=\s*minVisible/.test(src));

// 2. loadSavedOrigin() must GUARD on that validation between parsing and returning —
//    i.e. an off-screen origin returns nil so the caller uses defaultOrigin.
const body = (src.match(/func loadSavedOrigin\(\)\s*->\s*NSPoint\?\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
ok('loadSavedOrigin() parses x/y from the saved JSON', /o\["x"\][\s\S]*o\["y"\]/.test(body));
ok('loadSavedOrigin() guards the parsed origin against the screen check',
   /guard[\s\S]*OnScreen[\s\S]*else\s*\{\s*return nil/.test(body) ||
   /guard[\s\S]*visibleFrame[\s\S]*else\s*\{\s*return nil/.test(body));
const parseIdx = body.indexOf('o["y"]');
const checkIdx = Math.max(body.indexOf('OnScreen'), body.indexOf('visibleFrame'));
ok('the guard sits AFTER the JSON parse (validates the real saved value)',
   parseIdx !== -1 && checkIdx > parseIdx);

// 3. The fallback path is intact: caller still has a defaultOrigin to land on.
ok('caller falls back to defaultOrigin when loadSavedOrigin() returns nil',
   /loadSavedOrigin\(\)\s*\?\?\s*defaultOrigin/.test(src));

const total = pass + fail;
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass}/${total} checks passed` + (fail ? `, ${fail} FAILED:` : ''));
if (fail) { console.log(fails.join('\n')); process.exit(1); }
console.log('');
