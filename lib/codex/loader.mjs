/*
 * animayte · codex/loader — resolve Codex pet PACKS (Node side; mirrors lib/anim/loader.mjs).
 *
 * A Codex pet is a folder: pets/<name>/pet.json (the minimal { id, displayName,
 * description, spritesheetPath } contract) + the spritesheet atlas. This loads and
 * validates one with the same friendly-error discipline as the animayte loader, and
 * also reads the atlas PNG header (when present) to confirm the 8×9 / 1536×1872 grid.
 *
 *   isCodexPack('pixel-coder')   → true   (a pet.json that is Codex-shaped)
 *   loadCodexPack('pixel-coder') → { id, dir, manifest, sheetPath }
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute, sep } from 'node:path';
import { readPngHeader } from '../anim/png.mjs';
import { isCodexManifest, validateCodexManifest, validateAtlasDims } from './format.mjs';
import { DEFAULT_PETS_DIR } from '../anim/loader.mjs';

function resolveDir(nameOrDir, petsDir) {
  const looksLikePath = isAbsolute(nameOrDir) || nameOrDir.includes('/') || nameOrDir.includes(sep);
  return looksLikePath ? nameOrDir : join(petsDir, nameOrDir);
}

/** isCodexPack(nameOrDir) — true if the dir holds a Codex-shaped pet.json. Never throws. */
export function isCodexPack(nameOrDir, { petsDir = DEFAULT_PETS_DIR } = {}) {
  try {
    const mp = join(resolveDir(nameOrDir, petsDir), 'pet.json');
    if (!existsSync(mp)) return false;
    return isCodexManifest(JSON.parse(readFileSync(mp, 'utf8')));
  } catch { return false; }
}

/**
 * loadCodexPack(nameOrDir, { petsDir }) — read + validate a Codex pack. Throws a clear
 * Error for: missing pet.json, invalid JSON, schema violations, a missing spritesheet,
 * or (for a PNG sheet) non-conformant atlas dimensions.
 */
export function loadCodexPack(nameOrDir, { petsDir = DEFAULT_PETS_DIR } = {}) {
  const dir = resolveDir(nameOrDir, petsDir);
  const manifestPath = join(dir, 'pet.json');
  if (!existsSync(manifestPath)) throw new Error(`codex pet pack not found: no pet.json at ${dir}`);

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch (e) { throw new Error(`invalid JSON in ${manifestPath}: ${e.message}`); }

  const errs = validateCodexManifest(manifest);
  if (errs.length) throw new Error(`invalid codex pet "${manifest && manifest.id || dir}":\n  - ${errs.join('\n  - ')}`);

  const sheetPath = join(dir, manifest.spritesheetPath);
  if (!existsSync(sheetPath)) throw new Error(`codex pet "${manifest.id}" declares spritesheetPath "${manifest.spritesheetPath}" but ${sheetPath} is missing`);

  // PNG header is cheap to read + lets us enforce the grid up front; WebP we trust the
  // browser to decode (the runtime warns on a bad grid at load time either way).
  if (/\.png$/i.test(manifest.spritesheetPath)) {
    const head = readPngHeader(readFileSync(sheetPath));
    if (head.sig) {
      const dimErrs = validateAtlasDims(head.width, head.height);
      if (dimErrs.length) throw new Error(`codex pet "${manifest.id}": ${dimErrs.join('; ')}`);
    }
  }

  return { id: manifest.id, dir, manifestPath, manifest, sheetPath };
}
