# Vendored: PixiJS

`pixi.mjs` is **PixiJS v8.18.1** (`pixi.js` npm package, `dist/pixi.min.mjs`), vendored so animayte
runs offline/local with no build step.

- **License:** MIT (Copyright © PixiJS contributors).
- **Source:** https://github.com/pixijs/pixijs · https://www.npmjs.com/package/pixi.js
- **Update:** `npm pack pixi.js@latest`, then copy `package/dist/pixi.min.mjs` here as `pixi.mjs`.

PixiJS is the GPU 2D renderer behind `lib/pixi/runtime.mjs` (the code-first engine that replaces the
Canvas2D draw loop while reusing the whole animayte engine — state machine, manifest, contract).
