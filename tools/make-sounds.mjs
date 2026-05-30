#!/usr/bin/env node
/*
 * animayte sound generator — bakes placeholder chiptune blips to assets/sfx/*.wav.
 * Zero-dep (Node built-ins). Sound ships OFF; these are silent until enabled in config.
 *   node tools/make-sounds.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUND_MAP, renderTone, encodeWav } from '../lib/anim/sound.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'sfx');
mkdirSync(OUT, { recursive: true });

let total = 0;
for (const [key, spec] of Object.entries(SOUND_MAP)) {
  const wav = encodeWav(renderTone(spec));
  writeFileSync(join(OUT, `${key}.wav`), wav);
  total += wav.length;
}
console.log(`sfx → ${Object.keys(SOUND_MAP).length} blips in assets/sfx/ (${total} bytes total) — silent until enabled`);
