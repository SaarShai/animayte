#!/usr/bin/env node
/*
 * Generate pets/<name>/pet.json from the source of truth (lib/expressions.mjs via
 * lib/anim/manifest.mjs#buildSlimeManifest). Validates before writing so we never
 * emit a malformed pack. Run:  node tools/build-manifest.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSlimeManifest, validateManifest } from '../lib/anim/manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function emit(name, manifest) {
  const errs = validateManifest(manifest);
  if (errs.length) {
    console.error(`✗ ${name} manifest is invalid:\n  - ${errs.join('\n  - ')}`);
    process.exit(1);
  }
  const dir = join(ROOT, 'pets', name);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'pet.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  const clips = Object.keys(manifest.clips).length;
  const exprs = Object.keys(manifest.expressions).length;
  console.log(`pet.json   ${name}  →  ${exprs} expressions, ${clips} clips, ${Object.keys(manifest.palettes).length} palettes`);
}

emit('slime', buildSlimeManifest());
console.log('done → pets/');
