/*
 * animayte · config — tiny persisted settings (C7): chosen pet, personality, sound
 * on/off + volume, remembered window position. Lives OUTSIDE the Google-Drive-synced
 * ~/Documents (default ~/.config/animayte/config.json; override with $ANIMAYTE_CONFIG).
 * Bad/missing config → safe defaults (never throws). Env vars still win at runtime.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG = {
  pet: 'slime',
  personality: 'adaptive',
  sound: false,           // sound ships OFF (C5 infra is silent unless explicitly enabled)
  volume: 0.6,
  position: null,         // { x, y } remembered floating-window position
  perProjectPet: false,   // stretch: a different pet per project (not wired yet)
};

export function configPath() {
  return process.env.ANIMAYTE_CONFIG || join(homedir(), '.config', 'animayte', 'config.json');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Coerce arbitrary input into a complete, valid config (every bad field → its default). */
export function sanitize(raw) {
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    pet: typeof c.pet === 'string' && c.pet ? c.pet : DEFAULT_CONFIG.pet,
    personality: typeof c.personality === 'string' && c.personality ? c.personality : DEFAULT_CONFIG.personality,
    sound: typeof c.sound === 'boolean' ? c.sound : DEFAULT_CONFIG.sound,
    volume: isNum(c.volume) ? Math.max(0, Math.min(1, c.volume)) : DEFAULT_CONFIG.volume,
    position: (c.position && isNum(c.position.x) && isNum(c.position.y)) ? { x: c.position.x, y: c.position.y } : null,
    perProjectPet: typeof c.perProjectPet === 'boolean' ? c.perProjectPet : DEFAULT_CONFIG.perProjectPet,
  };
}

export function loadConfig(path = configPath()) {
  try { if (existsSync(path)) return sanitize(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* fall through to defaults */ }
  return { ...DEFAULT_CONFIG };
}

/** Merge a partial patch over the current config and persist it. Returns the saved config. */
export function saveConfig(patch = {}, path = configPath()) {
  const merged = sanitize({ ...loadConfig(path), ...patch });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}
