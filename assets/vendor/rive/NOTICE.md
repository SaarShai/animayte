# Vendored: Rive web runtime

`rive.js` + `rive.wasm` are **`@rive-app/canvas` v2.37.8**, vendored here so animayte runs
offline/local (no CDN at runtime), consistent with the project's local-first stance.

- **License:** MIT (Copyright © Rive). The Rive *runtimes* are unconditional MIT — no royalty,
  per-seat, or revenue trigger. (The Rive *editor*, used to author `.riv` files, is a separate
  proprietary SaaS — see `docs/engine-research.md`.)
- **Source:** https://github.com/rive-app/rive-runtime · https://www.npmjs.com/package/@rive-app/canvas
- **Update:** `npm pack @rive-app/canvas@latest`, then copy `package/rive.js` + `package/rive.wasm` here.

`sample.riv` is Rive's public demo file (https://cdn.rive.app/animations/vehicles.riv), used by
`rive-lab.html` only to prove the runtime loads/renders — it is **not** an animayte pet.
