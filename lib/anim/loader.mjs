/*
 * animayte · loader — resolve pet PACKS (a pet = a folder: pets/<name>/pet.json [+ sheet]).
 *
 * This is the infrastructure that makes the library reusable across pet designs
 * (G3): drop a folder in pets/, get a pet. The daemon/renderers pick a pack via the
 * ANIMAYTE_PET env (default "slime"). Validation reuses the manifest schema, so a
 * malformed pack fails loudly with the same friendly errors.
 *
 *   listPacks()              → ['bean', 'slime']           (dirs containing pet.json)
 *   loadPack('slime')        → { name, dir, manifest, sheetPath }
 *   resolvePetName(env)      → env.ANIMAYTE_PET || 'slime'
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, isAbsolute, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { assertManifest } from './manifest.mjs';

export const DEFAULT_PETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pets');

/** Pack directory names under petsDir that contain a pet.json (sorted). */
export function listPacks(petsDir = DEFAULT_PETS_DIR) {
  let entries;
  try { entries = readdirSync(petsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(petsDir, e.name, 'pet.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * loadPack(nameOrDir, { petsDir }) — read + validate a pack.
 * Accepts a bare pack name (resolved under petsDir) or a path. Throws a clear
 * Error for: missing pet.json, invalid JSON, schema violations, or a declared
 * `sheet` file that doesn't exist.
 */
export function loadPack(nameOrDir, { petsDir = DEFAULT_PETS_DIR } = {}) {
  const looksLikePath = isAbsolute(nameOrDir) || nameOrDir.includes('/') || nameOrDir.includes(sep);
  const dir = looksLikePath ? nameOrDir : join(petsDir, nameOrDir);
  const manifestPath = join(dir, 'pet.json');
  if (!existsSync(manifestPath)) throw new Error(`pet pack not found: no pet.json at ${dir}`);

  let raw;
  try { raw = readFileSync(manifestPath, 'utf8'); } catch (e) { throw new Error(`cannot read ${manifestPath}: ${e.message}`); }
  let manifest;
  try { manifest = JSON.parse(raw); } catch (e) { throw new Error(`invalid JSON in ${manifestPath}: ${e.message}`); }

  assertManifest(manifest, `pet pack "${basename(dir)}"`);

  let sheetPath = null;
  if (manifest.sheet) {
    const sp = join(dir, manifest.sheet);
    if (!existsSync(sp)) throw new Error(`pet pack "${manifest.name}" declares sheet "${manifest.sheet}" but ${sp} is missing`);
    sheetPath = sp;
  }
  return { name: manifest.name, dir, manifestPath, manifest, sheetPath };
}

/** Which pet to show — env override, default slime. */
export function resolvePetName(env = process.env) {
  return (env && env.ANIMAYTE_PET) || 'slime';
}
