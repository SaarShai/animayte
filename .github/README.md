# Continuous integration

animayte is a **zero-dependency, install-anywhere** Claude Code plugin. A recent class of
bug was **cross-platform** (hooks silently failing on Windows), and there was **no CI**. The
vision: every change proven green on **macOS / Windows / Linux** before merge.

## `workflows/test.yml`

Runs on every push to `main`, every pull request, and on manual dispatch.

- **Matrix:** `{ubuntu, macos, windows}-latest` × Node `{18, 20, lts/*}` = **9 jobs**, `fail-fast: false`
  (one platform breaking still shows you the others).
- **`concurrency`** cancels superseded in-flight runs per ref (except on `main`).
- **`permissions: contents: read`** — least privilege.
- **Steps** (in order):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` — **no cache** (the project ships no lockfile; there's nothing to cache).
  3. **Zero-dependency tripwire** (`scripts/check-zero-deps.mjs`) — fails if `package.json` ever
     declares a runtime/dev/optional/peer dependency. Keeps the no-install guarantee honest.
  4. **Syntax lint** (`scripts/check-syntax.mjs`) — `node --check` over **every** shipped `*.mjs`
     on that OS. Cheap, dep-free, and catches syntax slips that one Node/OS tolerates and another
     rejects — including files the test suite never imports.
  5. **`node test/run.mjs`** — the full suite (the hand-rolled runner exits non-zero on any failure).

Both helper scripts are **Node-builtins-only** and walk the tree with a pure-Node directory
walker (no `find` / `xargs` / glob), so they behave identically on PowerShell, zsh, and bash.

## ⚠️ Required companion change: gate `e2e.test.mjs` for bare Windows runners

`test/e2e.test.mjs` spawns **`sh -c`** and runs the **real `curl`** hook command from
`hooks/hooks.json`. A bare `windows-latest` runner often has **no POSIX `sh` on PATH**, so the
suite would fail spuriously there. The fix is for **e2e to self-gate**: skip *loudly* (with a
logged reason, exit 0) when `sh`/`curl` aren't available — the workflow itself never hides real
failures.

This CI cannot ship that change (e2e is a shared file other work touches). **Apply this by hand**
to `test/e2e.test.mjs`:

1. Add `spawnSync` to the existing `node:child_process` import (currently line ~22):

   ```js
   import { spawn, spawnSync } from 'node:child_process';
   ```

2. Insert this gate right **after** the imports / before the first daemon spawn (before the
   `const SID = ...` / `const port = await freePort()` lines, ~line 112):

   ```js
   // ── PORTABILITY GATE ──────────────────────────────────────────────────────────────────────
   // This suite spawns `sh -c` and runs the REAL curl hook command. A bare windows-latest CI
   // runner often has no POSIX sh on PATH — skip LOUDLY there rather than fail spuriously.
   const hasBin = (bin, args) => { try { return spawnSync(bin, args, { stdio: 'ignore' }).status === 0; } catch { return false; } };
   if (!hasBin('sh', ['-c', 'exit 0']) || !hasBin('curl', ['--version'])) {
     console.log('\n· e2e SKIPPED — needs a POSIX sh + curl on PATH (absent on this host: ' + process.platform + ').');
     process.exit(0);
   }
   ```

That's it — on Linux/macOS (and Windows runners that *do* expose `sh`+`curl`) e2e runs in full;
elsewhere it skips with a visible reason instead of a red X.

> Note for `test/run.mjs`: no change is required for portability — it already uses
> `spawnSync('node', [join(here, s)], …)` with `path.join`, which is cross-platform. (It does
> assume `node` is on PATH, which is guaranteed after `actions/setup-node`.)
