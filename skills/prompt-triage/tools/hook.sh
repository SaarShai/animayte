#!/bin/bash
# agents-triage UserPromptSubmit hook.
#
# stdin:  {session_id, transcript_path, prompt, ...}  (from Claude Code)
# stdout: a directive block that gets injected into the main model's context.
#         Strong nudge to delegate via Task tool to a cheaper subagent/model.
#
# Opus sees the directive + user prompt. Ideal path: opus emits a Task() call
# with the suggested args and does NO deep reasoning. Actual task runs on the
# lesser subagent's context budget.
#
# Override: user types "NO TRIAGE" anywhere in prompt, or "/opus" as a
# standalone token (start of prompt or whitespace-delimited; never inside a
# path like /opus/file.md) → hook exits silently.
#
# H1 fix (2026-05): was 4 separate python3 spawns per prompt (~120-320ms
# cold-start tax on macOS, paid on every Enter press). Now one process:
# classify.py --emit-context reads stdin, runs bypass + classification, and
# prints the final directive block (or nothing).

# No `set -e`: a UserPromptSubmit hook MUST exit 0 (a non-zero exit breaks the
# host's prompt). Under `set -e` an unresolvable `cd` below (hook dir renamed
# between scheduling and execution) would abort with exit 1 before the guards
# could catch it. Matches the other three wrappers (canary/skill-pulse/ck).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
CLASSIFIER="$HERE/classify.py"

# Skill not installed properly → exit clean, never break the host hook.
[ -f "$CLASSIFIER" ] || exit 0

# One python invocation: parses stdin payload, checks bypass flags,
# classifies, emits the directive block (or stays silent).
# stderr is suppressed so a transient classifier crash never bubbles into the
# user's prompt context — the hook's contract is "never break the prompt".
python3 "$CLASSIFIER" --emit-context 2>/dev/null || true

exit 0
