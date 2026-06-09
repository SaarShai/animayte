#!/usr/bin/env bash
# Brainer skill-set installer.
# Symlinks skills/ into the per-host loader path. Idempotent.
# Usage:
#   ./install.sh                           # all detected hosts + graphify
#   ./install.sh --host claude-code        # one host
#   ./install.sh --host claude-code,codex  # comma-separated
#   ./install.sh --no-graphify             # skip graphify auto-install
#   ./install.sh --dry-run                 # show what would happen
#   SKILLS_DIR=skills.new ./install.sh     # alternate canonical dir (Phase A/B)
#
# Graphify is the external code-graph tool paired with `index-first` and
# `wiki-memory` (see skills/index-first/EVAL.md for the measured numbers).
# By default this installer pip-installs it; pass --no-graphify to opt out.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="${SKILLS_DIR:-skills}"
SRC="$REPO_ROOT/$SKILLS_DIR"

HOSTS_REQUESTED=""
DRY_RUN=0
INSTALL_GRAPHIFY=1

while (( "$#" )); do
  case "$1" in
    --host) HOSTS_REQUESTED="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-graphify) INSTALL_GRAPHIFY=0; shift ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ ! -d "$SRC" ]; then
  echo "skills dir not found: $SRC" >&2
  echo "set SKILLS_DIR or run from repo root." >&2
  exit 2
fi

[ -z "$HOSTS_REQUESTED" ] && HOSTS_REQUESTED="claude-code,codex,cursor,gemini"

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "DRY: $*"; else eval "$@"; fi
}

link() {
  local target="$1" linkname="$2"
  # Write a RELATIVE symlink so the repo stays portable across checkouts/
  # machines (an absolute target like /Users/you/proj/skills/x breaks on any
  # other clone). target is an absolute path under the repo; express it
  # relative to the link's own directory. Falls back to absolute only if
  # python3 is unavailable.
  local rel
  rel=$(python3 -c "import os,sys;print(os.path.relpath(sys.argv[1].rstrip('/'), os.path.dirname(sys.argv[2])))" "$target" "$linkname" 2>/dev/null) || rel="$target"
  if [ -L "$linkname" ] && [ "$(readlink "$linkname")" = "$rel" ]; then
    echo "    [skip] $linkname (already linked)"
    return 0
  fi
  if [ -e "$linkname" ] && [ ! -L "$linkname" ]; then
    echo "    [warn] $linkname exists and is not a symlink — leaving it" >&2
    return 0
  fi
  run "ln -sfn '$rel' '$linkname'"
  echo "    [link] $linkname → $rel"
}

# --- Resident skills catalog ---------------------------------------------
# Skill bodies are lazy-loaded on trigger, which means a freshly booted (or
# post-compaction) agent doesn't know a model-invokable skill (say `wiki-memory`) even exists —
# so it can't recognize the trigger. We fix this by compiling a 1-line-per-
# skill catalog and injecting it between sentinels into each host's
# always-resident doc (CLAUDE.md / AGENTS.md / GEMINI.md / cursor rule).
# Slash-triggered skills (disable-model-invocation: true) get their own
# section so the agent knows to dispatch on the literal token.

CATALOG_START='<!-- brainer:skills-catalog:start -->'
CATALOG_END='<!-- brainer:skills-catalog:end -->'

# Strip trigger-boilerplate prefix sentences from a description, return the
# first remaining sentence.
short_desc() {
  printf '%s' "$1" \
    | sed -E 's/^Fires [^.]*\. *//; s/^Do NOT fire[^.]*\. *//' \
    | awk -F'\\. ' '{print $1}'
}

# Extract a single frontmatter field value from a SKILL.md.
skill_field() {
  local file="$1" field="$2"
  awk -v field="$field" '
    /^---$/ { c++; if (c==2) exit; next }
    c==1 {
      key=$0
      sub(/:.*/, "", key)
      if (key == field) {
        val=$0
        sub(/^[^:]+: */, "", val)
        print val
        exit
      }
    }
  ' "$file"
}

skill_is_slash_only() {
  local file="$1"
  grep -q '^disable-model-invocation: *true' "$file"
}

# Opt-in skills (frontmatter `auto-install: false`) are still symlinked and
# listed in the resident catalog, but their per-skill tools/install.sh is NOT
# run by a bare ./install.sh — so they never auto-wire a hook or pull a heavy
# dependency. Enable one explicitly with: bash skills/<name>/tools/install.sh
# Rationale: only measured-win or cheap load-bearing skills belong on the
# default install path (see eval/FINDINGS.md).
# skill-pulse + compliance-canary are now DEFAULT-ON (auto-install: true, set
# 2026-06-09): they are the output-style drift defense — skill-pulse re-anchors
# active skill rules every N turns, compliance-canary catches symptomatic drift
# — that keeps caveman-ultra (and any pulse_reminder/drift_probes skill) from
# decaying over a long session. Turn off per-project via env without uninstall:
# SKILL_PULSE_DISABLED=1 / COMPLIANCE_CANARY_DISABLED=1.
# NOTE: per-skill installers MERGE into .claude/settings.json (append-only).
# A bare ./install.sh now AUTO-PRUNES hooks whose script is GONE (a skill that
# was cut — see prune_dead_hooks below), so removed skills fully self-heal. But
# a hook whose script still exists is kept: to fully DISABLE a default-on hook,
# drop its entry from .claude/settings.json by hand — the prune won't touch a
# live script.
skill_is_optin() {
  local file="$1"
  grep -q '^auto-install: *false' "$file"
}

render_skills_catalog() {
  printf '%s\n' "$CATALOG_START"
  cat <<'HEADER'
## Repo-local trigger skills (resident at boot)

Skill bodies under `skills/<name>/` lazy-load on trigger. The names + 1-line
descriptions below are kept in this resident doc so a freshly booted (or
post-compaction) agent still knows what's available — so a model-invokable
trigger (e.g. `wiki-memory` for "have we done X") is recognised on sight
rather than re-derived from scratch.

### Slash-triggered (user types literally; model cannot auto-invoke)

These are literal text tokens you recognise yourself — NOT host-registered
commands. When the user's message starts with one of these tokens, load
`skills/<name>/SKILL.md` and follow it yourself, even if this host has no such
command installed (e.g. Codex, Antigravity) or shows an "unknown command"
error. Treat the rest of the message as the task. Don't improvise a hand-rolled
equivalent:

HEADER
  local any_slash=0
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    local sm="$skill/SKILL.md"
    [ -f "$sm" ] || continue
    if skill_is_slash_only "$sm"; then
      any_slash=1
      local desc; desc=$(skill_field "$sm" description)
      printf -- '- `/%s` — %s\n' "$name" "$(short_desc "$desc")"
    fi
  done
  [ "$any_slash" = "0" ] && echo "_(none currently)_"
  cat <<'MID'

### Model-invokable (host fires on matching context)

You don't need to dispatch these manually — but knowing they exist helps you
notice when context matches one (e.g. `wiki-memory` for "have we done X").

MID
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    local sm="$skill/SKILL.md"
    [ -f "$sm" ] || continue
    if ! skill_is_slash_only "$sm"; then
      local desc; desc=$(skill_field "$sm" description)
      printf -- '- `%s` — %s\n' "$name" "$(short_desc "$desc")"
    fi
  done
  # Discoverability (GRAFT 3): a curated memory store only compounds if a fresh
  # or plugin-less agent knows it exists, how to query it, and when. Surface it
  # in the resident doc — but only when this repo has actually adopted a wiki,
  # so downstream adopters without one aren't nagged.
  if [ -d "$REPO_ROOT/wiki" ]; then
    cat <<'STORE'

### Durable memory store (`wiki/`)

This repo carries a curated knowledge store at `wiki/` — the *why/decision/
failure-lesson* layer (rationale, trade-offs, incidents, procedures), distinct
from auto-extracted code structure. Relevant when the task references past work,
prior decisions, or "have we done X". Query it before re-deriving: read
`wiki/L1_index.md` first, then `python3 skills/wiki-memory/tools/wiki.py search "<q>"`
→ `timeline` → `fetch`. Maintained by `wiki-memory` (write) and `wiki-refresh`
(reconcile vs code).
STORE
  fi
  cat <<'FOOT'

_Auto-generated by `./install.sh` — do not hand-edit between sentinels._
FOOT
  printf '%s\n' "$CATALOG_END"
}

# Inject (or refresh) the catalog block into a markdown file. Idempotent.
inject_catalog_into_doc() {
  local target="$1"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    DRY: inject skills catalog into $target"
    return 0
  fi
  local block_tmp; block_tmp=$(mktemp)
  render_skills_catalog > "$block_tmp"

  if [ ! -f "$target" ]; then
    {
      printf '# Brainer\n\n'
      printf 'Skills catalog: see [`%s/SKILLS_INDEX.md`](%s/SKILLS_INDEX.md).\n\n' "$SKILLS_DIR" "$SKILLS_DIR"
      printf 'Each skill loads on its own trigger; full bodies are not in the boot context. Run `./install.sh` to wire skills into the current host.\n\n'
      cat "$block_tmp"
    } > "$target"
    echo "    [write] $target (created with catalog)"
    rm -f "$block_tmp"
    return 0
  fi

  if grep -q 'brainer:skills-catalog:start' "$target"; then
    local out; out=$(mktemp)
    awk -v blockfile="$block_tmp" -v start="$CATALOG_START" -v end="$CATALOG_END" '
      index($0, start) {
        while ((getline line < blockfile) > 0) print line
        close(blockfile)
        skip = 1
        next
      }
      index($0, end) {
        if (skip) { skip = 0; next }
      }
      !skip { print }
    ' "$target" > "$out"
    mv "$out" "$target"
    echo "    [update] $target (catalog refreshed)"
  else
    printf '\n' >> "$target"
    cat "$block_tmp" >> "$target"
    printf '\n' >> "$target"
    echo "    [append] $target (catalog appended)"
  fi
  rm -f "$block_tmp"
}

# Remove symlinks in a host skills dir whose target no longer exists — i.e.
# skills deleted from the catalog. Idempotent and safe: only ever removes
# BROKEN symlinks (never real files or live links), so a re-install self-heals
# after a skill is cut instead of stranding a dangling link (and, for hooks
# wired off it, a dead hook command).
prune_stale_skill_links() {
  local dir="$1"; [ -d "$dir" ] || return 0
  local l
  # Portable broken-symlink detection: -L (is a symlink) AND ! -e (target does
  # not resolve). NOT `find -xtype l` — that is a GNU extension and silently
  # errors out on BSD/macOS find, which would make this prune a no-op.
  for l in "$dir"/*; do
    if [ -L "$l" ] && [ ! -e "$l" ]; then
      if [ "$DRY_RUN" = "1" ]; then echo "DRY: prune stale link $l"
      else rm -f "$l"; echo "    [prune] $(basename "$l") (removed from catalog)"; fi
    fi
  done
}

# Remove hook entries from a settings.json whose command script no longer
# exists — i.e. hooks left behind by a cut skill (e.g. a PreToolUse hook whose
# loop-breaker/tools/hook.sh was deleted). The settings.json counterpart of the
# symlink prune, so a re-install self-heals the hooks side too. Only removes
# hooks whose script is GONE; a hook for a still-present skill (incl. an opt-in
# you enabled) is untouched. Safe + idempotent.
# SCOPED + CONSERVATIVE: only ever considers Brainer-managed hooks (script path
# under `.claude/skills/`). App hooks (any other path) are NEVER touched. And a
# path it can't positively resolve — an unexpanded $VAR or ~ — is always kept,
# never pruned: prune must prove a hook is a removed Brainer skill before
# deleting it, or it would silently eat a live app hook like a $CLAUDE_PROJECT_DIR
# Stop gate.
prune_dead_hooks() {
  local settings="$1" root="$2"
  [ -f "$settings" ] || return 0
  DRY_RUN="$DRY_RUN" python3 - "$settings" "$root" <<'PY' 2>/dev/null
import json, os, shlex, sys
settings, root = sys.argv[1], sys.argv[2]
dry = os.environ.get("DRY_RUN") == "1"
try:
    d = json.load(open(settings))
except Exception:
    sys.exit(0)
hooks = d.get("hooks", {})
removed = []
for event in list(hooks.keys()):
    new_groups = []
    for g in hooks[event]:
        kept = []
        for h in g.get("hooks", []):
            cmd = h.get("command", "")
            script = next((t for t in shlex.split(cmd) if t.endswith((".sh", ".py"))), None)
            # Only Brainer-managed hooks are prune candidates, and only when the
            # path is concrete (no unexpanded $VAR/~). Everything else is kept.
            managed = (script is not None and ".claude/skills/" in script
                       and "$" not in script and "~" not in script)
            if not managed or os.path.exists(os.path.join(root, script)):
                kept.append(h)
            else:
                removed.append(cmd)
        if kept:
            g["hooks"] = kept
            new_groups.append(g)
    if new_groups:
        hooks[event] = new_groups
    else:
        del hooks[event]
if removed and not dry:
    d["hooks"] = hooks
    json.dump(d, open(settings, "w"), indent=2)
    open(settings, "a").write("\n")
for cmd in removed:
    print("    [prune-hook] %s%s (skill removed)" % ("DRY: " if dry else "", cmd))
PY
}

# Output-style skills (frontmatter `output_style: true`) inject their rule at
# SessionStart so terse/style guidance is set from turn 1. That injection must
# fire in EVERY project where Brainer is installed and NOWHERE else, so — unlike
# every other hook here — it lives as a GUARDED hook in the user-global
# ~/.claude/settings.json, guarded on the per-project marker
# `.claude/skills/<skill>`. This is the ONLY place install.sh writes user-global
# (not repo-local) config. Idempotent + convergent: reads the canonical injected
# text from each skill's session_start.md, rebuilds the guarded command, and
# converges any prior copy in place (upgrading an old unguarded/global hook to
# the guarded form). Skills with output_style but no session_start.md are
# skipped; a non-JSON global settings file is left untouched with a warning.
ensure_global_output_style_hooks() {
  local gsettings="$HOME/.claude/settings.json"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    DRY: ensure guarded SessionStart output-style hook(s) in $gsettings"
    return 0
  fi
  GS="$gsettings" python3 - "$SRC" <<'PY'
import json, os, shlex, sys
from pathlib import Path

src = Path(sys.argv[1])
gpath = Path(os.environ["GS"])

def frontmatter(text):
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    out = {}
    for line in text[3:end].splitlines():
        s = line.strip()
        if not s or s.startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k] = v
    return out

styles = []
for d in sorted(src.iterdir()):
    sm, ss = d / "SKILL.md", d / "session_start.md"
    if not sm.is_file() or not ss.is_file():
        continue
    fm = frontmatter(sm.read_text(encoding="utf-8", errors="replace"))
    if str(fm.get("output_style", "")).strip().lower() != "true":
        continue
    styles.append((fm.get("name") or d.name, ss.read_text(encoding="utf-8").strip()))

if not styles:
    sys.exit(0)

if gpath.exists():
    try:
        data = json.loads(gpath.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("    [warn] %s not valid JSON — leaving global hooks untouched" % gpath)
        sys.exit(0)
else:
    data = {}

before = json.dumps(data, sort_keys=True)
ss_rules = data.setdefault("hooks", {}).setdefault("SessionStart", [])

for name, text in styles:
    marker = ".claude/skills/%s" % name
    payload = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}
    echo_arg = shlex.quote(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    command = 'p="${CLAUDE_PROJECT_DIR:-$PWD}"; if [ -e "$p/%s" ]; then echo %s; fi' % (marker, echo_arg)
    existing = [h for g in ss_rules for h in g.get("hooks", []) if marker in h.get("command", "")]
    if existing:
        for h in existing:               # converge in place (no-op if identical)
            h["type"], h["command"] = "command", command
    else:
        ss_rules.append({"hooks": [{"type": "command", "command": command,
                                    "statusMessage": "Applying %s output style" % name}]})

if json.dumps(data, sort_keys=True) == before:
    print("    [skip] global output-style hook(s) already current")
    sys.exit(0)
gpath.parent.mkdir(parents=True, exist_ok=True)
gpath.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("    [global] ensured guarded SessionStart hook(s): %s" % ", ".join(n for n, _ in styles))
PY
}

install_claude_code() {
  echo "[claude-code]"
  run "mkdir -p '$REPO_ROOT/.claude/skills'"
  prune_stale_skill_links "$REPO_ROOT/.claude/skills"
  prune_dead_hooks "$REPO_ROOT/.claude/settings.json" "$REPO_ROOT"
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    link "$skill" "$REPO_ROOT/.claude/skills/$name"
  done
  inject_catalog_into_doc "$REPO_ROOT/CLAUDE.md"
  ensure_global_output_style_hooks
}

install_codex() {
  echo "[codex]"
  run "mkdir -p '$REPO_ROOT/.codex/skills'"
  prune_stale_skill_links "$REPO_ROOT/.codex/skills"
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    link "$skill" "$REPO_ROOT/.codex/skills/$name"
  done
  inject_catalog_into_doc "$REPO_ROOT/AGENTS.md"
}

install_cursor() {
  echo "[cursor]"
  run "mkdir -p '$REPO_ROOT/.cursor/skills' '$REPO_ROOT/.cursor/rules'"
  prune_stale_skill_links "$REPO_ROOT/.cursor/skills"
  # Prune orphan rule files for skills removed from the catalog.
  for mdc in "$REPO_ROOT"/.cursor/rules/*.mdc; do
    [ -e "$mdc" ] || continue
    local base; base=$(basename "$mdc" .mdc)
    [ "$base" = "_brainer-catalog" ] && continue
    if [ ! -d "$SRC/$base" ]; then
      if [ "$DRY_RUN" = "1" ]; then echo "DRY: prune orphan $mdc"
      else rm -f "$mdc"; echo "    [prune] ${base}.mdc (removed from catalog)"; fi
    fi
  done
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    link "$skill" "$REPO_ROOT/.cursor/skills/$name"
    local mdc="$REPO_ROOT/.cursor/rules/${name}.mdc"
    if [ "$DRY_RUN" = "1" ]; then
      echo "DRY: write $mdc"
    else
      local desc
      desc=$(grep -m1 '^description:' "$skill/SKILL.md" | sed 's/^description: *//')
      cat > "$mdc" <<MDC
---
description: $desc
globs: ["**/*"]
alwaysApply: false
---

@$SKILLS_DIR/$name/SKILL.md
MDC
      echo "    [write] $mdc"
    fi
  done
  # Always-apply catalog rule — keeps slash-triggers visible in Cursor's
  # resident context even though individual skill .mdc files are alwaysApply:false.
  local catalog_mdc="$REPO_ROOT/.cursor/rules/_brainer-catalog.mdc"
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY: write $catalog_mdc"
  else
    local body_tmp; body_tmp=$(mktemp)
    render_skills_catalog > "$body_tmp"
    {
      printf -- '---\n'
      printf -- 'description: Brainer repo-local skills catalog — slash-trigger awareness.\n'
      printf -- 'globs: ["**/*"]\n'
      printf -- 'alwaysApply: true\n'
      printf -- '---\n\n'
      cat "$body_tmp"
    } > "$catalog_mdc"
    rm -f "$body_tmp"
    echo "    [write] $catalog_mdc"
  fi
}

install_gemini() {
  echo "[gemini]"
  run "mkdir -p '$REPO_ROOT/.gemini/skills'"
  prune_stale_skill_links "$REPO_ROOT/.gemini/skills"
  for skill in "$SRC"/*/; do
    name=$(basename "$skill")
    [ "$name" = "_shared" ] && continue
    link "$skill" "$REPO_ROOT/.gemini/skills/$name"
  done
  local settings="$REPO_ROOT/.gemini/settings.json"
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY: ensure $settings has skills path"
  elif [ ! -f "$settings" ]; then
    cat > "$settings" <<'JSON'
{
  "skills": {
    "dirs": [".gemini/skills"]
  }
}
JSON
    echo "    [write] $settings"
  fi
  inject_catalog_into_doc "$REPO_ROOT/GEMINI.md"
}

IFS=',' read -ra HOST_LIST <<< "$HOSTS_REQUESTED"
for h in "${HOST_LIST[@]}"; do
  case "$h" in
    claude-code) install_claude_code ;;
    codex)       install_codex ;;
    cursor)      install_cursor ;;
    gemini)      install_gemini ;;
    *) echo "unknown host: $h (claude-code|codex|cursor|gemini)" >&2; exit 2 ;;
  esac
done

# Per-skill tools/install.sh — for skills with Python/MCP deps (best-effort).
echo
echo "[skill-tools] running per-skill installers (Python deps, MCP servers)"
for tool_installer in "$SRC"/*/tools/install.sh; do
  [ -f "$tool_installer" ] || continue
  skill_name="$(basename "$(dirname "$(dirname "$tool_installer")")")"
  skill_md="$(dirname "$(dirname "$tool_installer")")/SKILL.md"
  if [ -f "$skill_md" ] && skill_is_optin "$skill_md"; then
    echo "  → $skill_name [skip] opt-in (auto-install: false) — enable with: bash $tool_installer"
    continue
  fi
  echo "  → $skill_name"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    DRY: bash $tool_installer"
  else
    # Tolerate per-skill installer failures (e.g. stale paths in other skills)
    # so a broken sibling never aborts the whole install.
    { bash "$tool_installer" 2>&1 | sed 's/^/    /'; } || echo "    [warn] $skill_name installer exited nonzero — see above"
  fi
done

install_graphify() {
  # Best-effort install of the `graphify` CLI. Paired by default with
  # `index-first` and `wiki-memory` per the recommended stack (see README.md).
  # Skip with --no-graphify.
  #
  # We install from our maintained fork's combined-patches branch rather than
  # PyPI. Published `graphifyy` 0.8.17 ships four bugs that affect our skill
  # flow (affected/benchmark schema crash, cluster-only silent refusal, update
  # leaving stale nodes, explain truncating connections with no expansion
  # flag). Each bug has a single-purpose PR open upstream; until merged, our
  # fork carries all four fixes layered onto v8. See skills/index-first/EVAL.md
  # for the bug list and measured impact. When upstream catches up, flip
  # GRAPHIFY_SOURCE back to the PyPI name `graphifyy` and drop the fork pin.
  local GRAPHIFY_SOURCE="git+https://github.com/SaarShai/graphify@token-economy-patches"
  echo
  echo "[graphify] external code-graph tool (fork pin: SaarShai/graphify@token-economy-patches)"

  if command -v graphify >/dev/null 2>&1; then
    local ver
    ver=$(graphify --help 2>&1 | head -1 || true)
    echo "  [skip] graphify already on PATH ($ver)"
    echo "         to upgrade to the patched fork, run:"
    echo "           pipx install --force '$GRAPHIFY_SOURCE'"
    return 0
  fi

  # Try pipx first — cleanest for a CLI install.
  if command -v pipx >/dev/null 2>&1; then
    echo "  installing via pipx..."
    run "pipx install '$GRAPHIFY_SOURCE'"
    return 0
  fi

  # Fall back to a python3.10+ -m pip install --user. graphifyy needs ≥3.10.
  local py=""
  for cand in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$cand" >/dev/null 2>&1; then py="$cand"; break; fi
  done
  if [ -z "$py" ]; then
    echo "  [warn] no python3.10+ on PATH and no pipx — graphify not installed."
    echo "         install pipx (recommended) or python3.10+, then run:"
    echo "           pipx install '$GRAPHIFY_SOURCE'"
    return 0
  fi

  echo "  no pipx found; installing via $py -m pip install --user..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "DRY: $py -m pip install --user '$GRAPHIFY_SOURCE'"
  else
    # Tolerate failures (--break-system-packages may be needed on some
    # Debian/Ubuntu setups; we don't want to assume that)
    if ! "$py" -m pip install --user "$GRAPHIFY_SOURCE" 2>&1 | sed 's/^/    /'; then
      echo "  [warn] graphify install failed via pip --user."
      echo "         try: pipx install '$GRAPHIFY_SOURCE'"
      return 0
    fi
  fi
}

if [ "$INSTALL_GRAPHIFY" = "1" ]; then
  install_graphify
else
  echo
  echo "[graphify] skipped (--no-graphify)"
fi

# Root shim docs are created (or refreshed) by each install_<host> via
# inject_catalog_into_doc. We additionally ensure all three exist so a host
# the user hasn't explicitly installed today still finds a usable doc the
# next time it boots — the docs are cheap and idempotent.
echo
echo "[root] ensure resident-context docs exist for all hosts"
for f in CLAUDE.md AGENTS.md GEMINI.md; do
  inject_catalog_into_doc "$REPO_ROOT/$f"
done

echo
echo "done. host(s): $HOSTS_REQUESTED"
