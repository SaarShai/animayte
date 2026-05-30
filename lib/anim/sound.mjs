/*
 * animayte · sound — OPTIONAL chiptune SFX infra (C5), SILENT BY DEFAULT.
 *
 * Pure synth + WAV encoder (Node built-ins only) + an event→tone map. The compiler
 * (tools/make-sounds.mjs) bakes placeholder sfxr-style blips to assets/sfx/*.wav; the
 * web runtime plays them ONLY when sound is explicitly enabled in config (C7). The
 * actual cuteness of the blips is a Saar taste call (§11) — this is just the plumbing.
 */

// event/mood → a little tone (cute, short, on a chiptune budget). Pitch-by-mood is
// applied at playback (playbackRate), so one buffer can serve a family of feelings.
export const SOUND_MAP = {
  greet: { wave: 'square', freq: 523, dur: 0.16 },
  happy: { wave: 'square', freq: 660, dur: 0.12 },
  excited: { wave: 'square', freq: 880, dur: 0.20 },
  thinking: { wave: 'triangle', freq: 440, dur: 0.05 },
  oops: { wave: 'square', freq: 330, dur: 0.10 },
  sad: { wave: 'triangle', freq: 220, dur: 0.22 },
  relief: { wave: 'saw', freq: 300, dur: 0.30 },
  prop: { wave: 'square', freq: 740, dur: 0.05 },
  bird: { wave: 'triangle', freq: 990, dur: 0.07 },
};

export const soundFor = (key) => SOUND_MAP[key] || null;
export const SOUND_KEYS = Object.keys(SOUND_MAP);

/** Render a single tone → Float32Array in [-1,1] with a short decay envelope. */
export function renderTone({ wave = 'square', freq = 440, dur = 0.12, sampleRate = 22050, vol = 0.5 } = {}) {
  const n = Math.max(1, Math.floor(dur * sampleRate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const ph = (t * freq) % 1;
    let v;
    if (wave === 'square') v = ph < 0.5 ? 1 : -1;
    else if (wave === 'triangle') v = 4 * Math.abs(ph - 0.5) - 1;
    else if (wave === 'saw') v = 2 * ph - 1;
    else v = Math.sin(2 * Math.PI * t * freq);
    const env = Math.max(0, 1 - i / n);          // linear decay → a soft "blip"
    out[i] = v * env * vol;
  }
  return out;
}

/** Encode mono Float32 samples → a 16-bit PCM WAV Buffer (valid RIFF/WAVE). */
export function encodeWav(samples, sampleRate = 22050) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(1, 22);                                                    // mono
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);                          // block align, bits
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7FFF), 44 + i * 2);
  }
  return buf;
}

/** Read a WAV header (for tests / validation). */
export function readWavHeader(buf) {
  return {
    riff: buf.toString('ascii', 0, 4) === 'RIFF',
    wave: buf.toString('ascii', 8, 12) === 'WAVE',
    fmt: buf.toString('ascii', 12, 16) === 'fmt ',
    data: buf.toString('ascii', 36, 40) === 'data',
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bitsPerSample: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
  };
}
