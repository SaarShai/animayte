# animayte — animation / pixel / expression framework research (2026-05-30)

Synthesis of a 3-track parallel research sweep. Goal: adopt **out-of-the-box open-source**
tools for pixel graphics, animation, and facial expressions instead of hand-rolling.

## Decisions (TL;DR)

| Layer | Choice | Why |
|---|---|---|
| **Render/animation engine** | **PixiJS v8** (MIT, ~125 kB gzip) | CDN/ESM, **no build step**; first-class `AnimatedSprite`, `ParticleContainer`, crisp pixel scaling. The genre standard. |
| **Discrete emotions** | **Spritesheet rows** (one row per mood) | Idiomatic for pixel pets (vscode-pets, Codex Pets, hatch-pet). No dedicated lib needed. |
| **Continuous "context → body"** | **Sprite scale/squash** via the engine | True mesh-morphing doesn't exist for pixel art; smooth scaling is the right pixel idiom. |
| **Asset FORMAT** | **hatch-pet / Petdex** (8×9 grid, 192×208 px cells) | Format-compatibility → free distribution + 2,700-pet ecosystem. |
| **Starter ART** | **CC0** creature (rvros slime / Kenney) | Zero licensing risk, looks pro immediately, on-direction with the current blob. |
| **v2 upgrade path** | **Rive** (vector, true morphing) | Only way to *smoothly deform* the body; MIT runtime but ~$9/mo to export. Stand-out-from-pixel move. |

## Engine comparison

- **PixiJS v8** — MIT, 47k★, ~125 kB, WebGL+WebGPU. `AnimatedSprite`, `ParticleContainer`, `scaleMode:'nearest'` + `roundPixels`. No-build via `https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.min.mjs`. **★ pick.**
- **Excalibur.js** — BSD-2, ~200 kB. Single `pixelArt:true` flag, GPU particles. Smaller community. Solid #2.
- **Phaser 3/4** — MIT, ~274 kB. Great `pixelArt:true` but a full game engine = dead weight for a 6-sprite overlay.
- **kaplay** — MIT, ~110 kB. Lovely API but pixel-crispness is CSS-only and particles are basic.
- **LittleJS** (~7 kB) / **Kontra** (~3 kB) — tiny but low-level/Canvas-only; more hand-coding.

## Expression / emotion runtimes

- **Pixel + discrete moods** → spritesheet frame-swap (PixiJS `AnimatedSprite`). Author in **Aseprite** ($20) or **Pixelorama** (free/MIT).
- **Continuous parametric (0..1 → morphology)** → **Rive** (state-machine Number inputs / 1D blend; MIT runtime, $9/mo export) or **Live2D** (richest params but proprietary + heavy rigging + stalled Pixi wrapper). Both are **vector**, not pixel.
- **dotLottie** (MIT) — numeric-input timeline scrub; vector only. **Spine** — disqualified (per-user runtime license).
- Reality: no pixel-art library does smooth float-driven mesh deformation. For pixel we scale the sprite; for true morphing we'd go vector (Rive) in v2.

## Asset sources (license-checked)

| Source | License | States | Note |
|---|---|---|---|
| **rvros Animated Pixel Slime** (itch.io) | **CC0** | idle/move/attack/hurt/die | Best zero-friction drop-in; front-facing blue slime. |
| **Kenney** creature packs (kenney.nl) | **CC0** | mostly static | Clean tiles; animate via scale/squash. |
| **Calciumtrice Animated Slime** (OpenGameArt) | CC-BY 3.0 | idle/gesture/walk/attack/death | Cute, 4 colors; **needs attribution**. |
| **Petdex** (2,700+ pets, public API/manifest) | ⚠️ **undeclared / fan-art** | 9 coding states | Use the **format**, not the pets. Many are copyrighted-IP fan-art. |
| CraftPix / LPC / Mana Seed | ❌ | — | CraftPix bans redistribution; LPC is top-down + copyleft; Mana Seed is paid. |

**hatch-pet/Petdex state rows (0–8):** idle, running-right, running-left, waving, jumping, failed, waiting, running(working), review. We'll map session signals onto these (+ scale for context, + orbiting birds for sub-agents).

## Key links
- PixiJS: https://github.com/pixijs/pixijs · https://pixijs.com
- Rive web: https://rive.app/docs/runtimes/web/web-js · https://github.com/rive-app/rive-wasm
- hatch-pet skill: https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md
- Petdex: https://github.com/crafter-station/petdex · https://petdex.crafter.run/api/manifest
- CC0 slime: https://rvros.itch.io/pixel-art-animated-slime · Kenney: https://kenney.nl/assets
- Calciumtrice (CC-BY): https://opengameart.org/content/animated-slime
- Aseprite: https://www.aseprite.org · Pixelorama: https://orama-interactive.itch.io/pixelorama
