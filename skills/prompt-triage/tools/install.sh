#!/usr/bin/env bash
# prompt-triage installer. Project-local only.

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
    DRY_RUN=1
    shift
fi
if [ "${1:-}" != "" ] && [ "${1:-}" != "--project" ]; then
    echo "prompt-triage installs project-locally only. Use --project, --dry-run, or no flag." >&2
    exit 2
fi

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC="$(cd "$TOOLS_DIR/.." && pwd)"
REPO="$(cd "$TOOLS_DIR/../../.." && pwd)"

SKILL_DIR="$REPO/.claude/skills"
AGENT_DIR="$REPO/.claude/agents"
SETTINGS="$REPO/.claude/settings.json"
# Repo-relative hook path — matches the convention used by every other
# hook-shipping skill (compliance-canary, context-keeper,
# skill-pulse). An absolute machine-local path breaks if the repo moves
# or if .claude/settings.json is committed and shared across machines.
HOOK_CMD="bash ./.claude/skills/prompt-triage/tools/hook.sh"
AGENTS=(wiki-note quick-fix local-ollama research-lite kaggle-feeder)

merge_settings() {
  python3 - "$SETTINGS" "$HOOK_CMD" <<'PY'
import json
import sys
from pathlib import Path

settings_path = Path(sys.argv[1])
hook_cmd = sys.argv[2]
settings_path.parent.mkdir(parents=True, exist_ok=True)
if settings_path.exists():
    try:
        data = json.loads(settings_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        data = {}
else:
    data = {}

hooks = data.setdefault("hooks", {})
rules = hooks.setdefault("UserPromptSubmit", [])
target = {"matcher": "*", "hooks": [{"type": "command", "command": hook_cmd}]}
for rule in rules:
    if rule.get("matcher") != "*":
        continue
    existing = rule.get("hooks", [])
    if any(item.get("type") == "command" and item.get("command") == hook_cmd for item in existing):
        break
else:
    rules.append(target)

settings_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

if [ "$DRY_RUN" = "1" ]; then
    echo "[1/3] dry-run: would symlink skill → $SKILL_DIR/prompt-triage"
    echo "[2/3] dry-run: would copy agent definitions → $AGENT_DIR/"
    printf '  - %s\n' "${AGENTS[@]}"
    echo "[3/3] dry-run: would update $SETTINGS with UserPromptSubmit -> $HOOK_CMD"
    exit 0
fi

mkdir -p "$SKILL_DIR" "$AGENT_DIR"

echo "[1/3] symlinking skill → $SKILL_DIR/prompt-triage"
ln -sfn "$SKILL_SRC" "$SKILL_DIR/prompt-triage"

echo "[2/3] copying agent definitions → $AGENT_DIR/"
for a in "${AGENTS[@]}"; do
    cp -f "$TOOLS_DIR/agents/$a.md" "$AGENT_DIR/$a.md"
done

chmod +x "$TOOLS_DIR/hook.sh" "$TOOLS_DIR/classify.py"

echo "[3/3] hook wiring ($SETTINGS)"
merge_settings

cat <<EOF
Installed prompt-triage into repo-local .claude.

Override per-prompt: include "NO TRIAGE" anywhere in your message.

Env:
  AGENTS_TRIAGE_NO_OLLAMA=1     disable Ollama fallback (regex-only)

Test the classifier:
  python3 $TOOLS_DIR/classify.py "add a note to the wiki about X"
EOF
