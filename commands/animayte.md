---
description: Summon the animayte pet — a cute slime that floats on your screen and reacts to this session
allowed-tools: Bash(bash:*), Bash(chmod:*)
---

Bring the animayte desktop pet to life, then tell the user it is now floating on
their screen (drag to move; right-click to dismiss). Run exactly:

```bash
chmod +x "${CLAUDE_PLUGIN_ROOT}/bin/animayte" 2>/dev/null; "${CLAUDE_PLUGIN_ROOT}/bin/animayte" start
```

The launcher picks the best renderer automatically (native macOS window, else
Python, else browser). First native run compiles once (a few seconds). If it
reports it couldn't open a window, tell the user the browser pet is at
http://127.0.0.1:4321.

Do not start any long-running process yourself — the launcher backgrounds
everything and returns immediately.
