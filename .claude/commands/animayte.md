---
description: Summon the animayte pet — a cute slime that floats on your screen and reacts to this session
allowed-tools: Bash(bash:*), Bash(chmod:*)
---

Bring the animayte desktop pet to life, then tell the user it is floating on their
screen (drag to move; right-click to dismiss). Run exactly:

```bash
chmod +x "$CLAUDE_PROJECT_DIR/bin/animayte" 2>/dev/null; "$CLAUDE_PROJECT_DIR/bin/animayte" start
```

The launcher picks the best renderer automatically (native macOS window, else
Python, else browser). First native run compiles once (a few seconds). If it
can't open a window, tell the user the browser pet is at http://127.0.0.1:4321.
The launcher backgrounds everything — do not run a long-running process yourself.
