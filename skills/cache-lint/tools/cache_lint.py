#!/usr/bin/env python3
"""cache-lint — audit a Claude Code project for prompt-cache hygiene.

Checks against Anthropic's six prompt-cache rules:
  1. stable ordering above breakpoints
  2. no dynamic content above breakpoints
  3. tool definition stability
  4. model switching busts cache
  5. breakpoint sizing
  6. fork safety (no prefix mutation by terminal hooks)

Lineage: ussumant/cache-audit (52★).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

Severity = Literal["OK", "WARN", "FAIL"]


@dataclass
class Finding:
    rule: int
    severity: Severity
    title: str
    file: str = ""
    line: int = 0
    detail: str = ""


@dataclass
class Report:
    root: str
    targets: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    summary: dict[str, int] = field(default_factory=dict)

    def add(self, f: Finding) -> None:
        self.findings.append(f)

    def finalize(self) -> None:
        self.summary = {
            "OK_rules": 0,
            "WARN": sum(1 for f in self.findings if f.severity == "WARN"),
            "FAIL": sum(1 for f in self.findings if f.severity == "FAIL"),
        }


# --- Discovery ------------------------------------------------------------

PREFIX_FILES = ("CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules")
# JSON sources of hook / settings config
SETTINGS_GLOBS = (
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/*.json",
    ".claude-plugin/*.json",
    "hooks/hooks.json",          # plugin-root layout
    "**/hooks.json",             # nested plugin layout (depth-limited via skip dirs)
    "plugins/*/hooks/hooks.json",
)
SKILL_GLOB = "skills/*/SKILL.md"
PLUGIN_PREFIX_GLOBS = (
    "**/CLAUDE.md",              # nested project memory
    ".claude/agents/*.md",
    ".claude/commands/*.md",
    "commands/*.md",
)
# Directories to skip during recursive globs (otherwise node_modules etc. explode runtime)
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"}


def _safe_glob(root: Path, pattern: str) -> list[Path]:
    """root.glob(pattern) but pruning SKIP_DIRS — required because ** descends everywhere."""
    out: list[Path] = []
    for p in root.glob(pattern):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        out.append(p)
    return out


def discover(root: Path) -> list[Path]:
    out: set[Path] = set()
    for name in PREFIX_FILES:
        p = root / name
        if p.exists():
            out.add(p.resolve())
    for pat in SETTINGS_GLOBS:
        out.update(p.resolve() for p in _safe_glob(root, pat))
    for pat in PLUGIN_PREFIX_GLOBS:
        out.update(p.resolve() for p in _safe_glob(root, pat))
    out.update(p.resolve() for p in _safe_glob(root, SKILL_GLOB))
    return sorted(out)


# --- Rule 2: dynamic content above breakpoints ----------------------------

DYNAMIC_PATTERNS = [
    (re.compile(r"\$\([^)]*\)"), "shell substitution ($(…))"),
    # NB: legacy backtick substitution (`date`, `whoami`, …) is intentionally
    # NOT checked. In Markdown prose, `text` is inline-code typography; there
    # is no syntactic way to distinguish it from POSIX command substitution.
    # Modern bash uses $(…); flagging backticks generates too many false
    # positives in skill / CLAUDE.md docs to be worth the coverage.
    (re.compile(r"\{\{\s*env\.", re.I), "env-dependent template ({{env.X}})"),
    # Braced env interpolation: ${VAR}. The UNBRACED $VAR form is intentionally
    # NOT checked — it false-positives on prose ($500, $variable, $camelCase)
    # and on real docs ($PATH, $PWD). Braces are an unambiguous interpolation
    # signal, so this stays precision-safe (0 FPs on exp13's negatives).
    (re.compile(r"\$\{[^}]+\}"), "braced env interpolation (${VAR})"),
    # Generic Jinja control/expression tags beyond the {{env.X}} form above:
    # {{ … }} expressions and {% … %} statements (now(), loops, includes) all
    # render per-invocation and bust the cache. Inline-code/backtick suppression
    # keeps documented examples (`{{env.X}}`) from firing.
    (re.compile(r"\{\{.*?\}\}|\{%.*?%\}"), "jinja template tag ({{…}}/{%…%})"),
    (re.compile(r"\b(?:datetime\.now|time\.time|Date\.now|new Date\(\))\b"), "wall-clock call"),
    (re.compile(r"\$RANDOM|os\.urandom|secrets\.token"), "RNG call"),
    (re.compile(r"^\s*timestamp\s*[:=]", re.I | re.M), "timestamp field"),
    # session/uuid-shaped token. Must start with `(?:session|sid|trace|req|run)`
    # so we don't false-flag git commit refs (`abc-1234567890`), container ids,
    # or lockfile hashes that share the `<word>-<hex>` shape.
    (re.compile(r"\b(?:session|sid|trace|req|run|conv)[A-Za-z0-9]{0,12}-[a-f0-9]{8,}\b", re.I), "session/uuid-shaped token"),
    # NB: `hostname` (backticked) is intentionally NOT checked — same
    # Markdown-typography ambiguity as command-substitution. The bare env-var
    # and Python-call forms are unambiguous.
    (re.compile(r"\$HOSTNAME\b|socket\.gethostname"), "hostname injection"),
]


MAX_FINDINGS_PER_RULE_PER_FILE = 5  # cap to keep reports readable + bound DoS


def check_dynamic_content(report: Report, files: list[Path]) -> None:
    for p in files:
        if p.suffix == ".json":
            continue  # JSON settings are checked separately
        try:
            text = p.read_text(errors="ignore")
        except Exception:
            continue
        # Cache once instead of on every match — the per-match splitlines() was
        # O(file) × O(matches), giving an effective O(n²) on adversarial input.
        lines = text.splitlines()
        # Pre-compute fence positions once per file (O(n) instead of per-match scan)
        fences = [m.start() for m in re.finditer(r"```", text)]
        emitted = 0
        suppressed = 0
        for rx, label in DYNAMIC_PATTERNS:
            for m in rx.finditer(text):
                # Hard cap — report 5 instances per (rule, file), summarise the rest.
                if emitted >= MAX_FINDINGS_PER_RULE_PER_FILE:
                    suppressed += 1
                    continue
                line = text.count("\n", 0, m.start()) + 1
                if _inside_inline_code(text, m.start()):
                    continue  # typography; skip
                in_fence = _inside_fence_fast(fences, m.start())
                sev: Severity = "WARN" if in_fence else "FAIL"
                report.add(Finding(
                    rule=2,
                    severity=sev,
                    title=f"dynamic content: {label}",
                    file=str(p),
                    line=line,
                    detail=lines[line - 1][:160] if line - 1 < len(lines) else "",
                ))
                emitted += 1
        if suppressed:
            report.add(Finding(
                rule=2, severity="WARN",
                title=f"+{suppressed} more dynamic-content matches suppressed (cap {MAX_FINDINGS_PER_RULE_PER_FILE})",
                file=str(p),
                detail="Fix the visible occurrences and re-run; the suppressed ones likely share the same root cause.",
            ))


def _inside_fence_fast(fence_positions: list[int], pos: int) -> bool:
    """O(log n) variant using pre-computed fence positions."""
    import bisect
    return bisect.bisect_right(fence_positions, pos) % 2 == 1


def _inside_inline_code(text: str, pos: int) -> bool:
    """True if pos sits inside `…` inline code (single backticks, not triple).

    Algorithm: scan the line; mask out triple-backtick fences first; then count
    single-backtick positions before pos on the same line — odd = inside.
    """
    line_start = text.rfind("\n", 0, pos) + 1
    line_end = text.find("\n", pos)
    if line_end == -1:
        line_end = len(text)
    # Single line — mask any triple-backtick run, then count solo ticks before pos.
    line = text[line_start:line_end]
    rel_pos = pos - line_start
    # Replace triple-backtick (or longer) runs with spaces so they don't count.
    masked = re.sub(r"`{3,}", lambda m: " " * len(m.group(0)), line)
    ticks_before = sum(1 for i, c in enumerate(masked) if c == "`" and i < rel_pos)
    return ticks_before % 2 == 1


# --- Rule 5: breakpoint sizing --------------------------------------------

TOKEN_ESTIMATE = 4  # rough chars/token


SIZING_TINY = 1024     # tokens (≈ matches docs: "< 1K")
SIZING_LARGE = 4096    # tokens (≈ matches docs: "> 4K")


def check_sizing(report: Report, root: Path) -> None:
    for name in PREFIX_FILES:
        p = root / name
        if not p.exists():
            continue
        n_bytes = p.stat().st_size
        n_tokens_est = n_bytes // TOKEN_ESTIMATE
        if n_tokens_est < SIZING_TINY and n_bytes > 0:
            report.add(Finding(
                rule=5, severity="WARN",
                title=f"{name} is tiny ({n_tokens_est} token est) — cache slot likely wasted",
                file=str(p),
                detail=f"Consider inlining into another prefix file or accepting no caching here.",
            ))
        elif n_tokens_est > SIZING_LARGE:
            report.add(Finding(
                rule=5, severity="WARN",
                title=f"{name} is large ({n_tokens_est} token est) — long cache rebuild on changes",
                file=str(p),
                detail="Split stable rules from volatile content; keep volatile below breakpoint.",
            ))


# --- Rule 4: model switching ---------------------------------------------

# Only match an actual `"model": "..."` JSON key — the previous bare
# `"haiku"|"sonnet"|"opus"` alternation false-flagged any string anywhere in a
# settings file (descriptions, comments, tool-use prose) that happened to
# include a model name.
MODEL_FIELDS = re.compile(r'"(?:model|model_id|defaultModel)"\s*:\s*"([^"]+)"', re.I)


def check_model_switching(report: Report, files: list[Path]) -> None:
    seen_models: dict[str, list[str]] = {}
    for p in files:
        if p.suffix != ".json":
            continue
        try:
            text = p.read_text(errors="ignore")
        except Exception:
            continue
        for m in MODEL_FIELDS.finditer(text):
            model = (m.group(1) or "").lower()
            if not model:
                continue
            seen_models.setdefault(model, []).append(str(p))
    distinct = {k for k in seen_models if k}
    if len(distinct) >= 2:
        report.add(Finding(
            rule=4, severity="WARN",
            title=f"multiple models referenced in settings: {sorted(distinct)}",
            detail=(
                "Each model has its own cache namespace. If routing is on the hot path "
                "(every-prompt hooks), expect cache misses on the model swap. "
                "OK if the swap is rare or routed through a separate subagent."
            ),
        ))


# --- Rule 6: fork safety --------------------------------------------------

# Terminal hooks plus the per-prompt path — UserPromptSubmit hooks that mutate the
# prefix bust the cache for the *current* session even before any fork.
HOT_PATH_HOOKS = ("Stop", "SessionEnd", "SubagentStop", "UserPromptSubmit")
PREFIX_FILE_RE = re.compile(r"\b(?:CLAUDE\.md|AGENTS\.md|GEMINI\.md|settings\.json)\b")
# A *real* write requires a write verb AND a prefix file name nearby.
# Catches shell redirects (`>>`, `>`), Python `open(..., "w"|"a")`, sed -i, etc.
# Plain `grep CLAUDE.md` or `cat CLAUDE.md` no longer false-positives.
INLINE_WRITE_RE = re.compile(
    r"(?:>>?\s*|tee\s+(?:-a\s+)?|sed\s+-i|"
    r"open\([^)]*['\"]\s*[wa]['\"]|"
    r"\.(?:write_text|write|append_text|writeFileSync|appendFileSync))"
)
# Detect a hook command that invokes an executable script we can read.
# Two shapes:
#   1. interpreter + script    — `python foo.py`, `node bar.mjs`, `bash baz.sh`,
#      `npx tsx foo.ts`, `ts-node foo.ts`, `uv run x.py`, `deno run foo.ts`, etc.
#   2. direct script invocation — `./script.sh`, `/abs/path/x.py`, `./run.mjs`
SCRIPT_INVOKE_RE = re.compile(
    r"\b(?:python3?|node|bash|sh|deno(?:\s+run)?|bun|npx\s+tsx|ts-node|tsx|uv\s+run|pnpm\s+(?:dlx|exec))"
    r"\s+([^\s'\"&|;]+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash))"
    r"|(?<![\w-])((?:\./|/)[^\s'\"&|;]+\.(?:py|js|mjs|cjs|ts|tsx|sh|bash))(?=\s|$)"
)


def _script_writes_prefix(script_path: Path) -> tuple[bool, str]:
    """Open the script and look for a prefix-file write.

    Two passes:
      1. Same-line: a single line containing both the prefix-file name AND a
         write verb (catches one-liners like `echo done >> CLAUDE.md` or
         `Path('CLAUDE.md').write_text(...)`).
      2. Cross-line: the prefix-file name appears AND a write verb appears
         anywhere in the file (catches the common pattern
         `p = Path('CLAUDE.md'); p.write_text(...)`).

    Returns evidence citing the line where the prefix file is mentioned.
    Read-only references (`grep CLAUDE.md`, `cat AGENTS.md`) only match if
    a write verb is also present somewhere — the false-positive shape we
    actually care about.
    """
    try:
        text = script_path.read_text(errors="ignore")
    except Exception:
        return False, ""
    # Pass 1 — same-line (highest confidence)
    for i, line in enumerate(text.splitlines(), start=1):
        if PREFIX_FILE_RE.search(line) and INLINE_WRITE_RE.search(line):
            return True, f"{script_path}:{i}: {line.strip()[:140]}"
    # Pass 2 — whole-file: both patterns must occur
    if PREFIX_FILE_RE.search(text) and INLINE_WRITE_RE.search(text):
        # cite the prefix-file line as the anchor
        for i, line in enumerate(text.splitlines(), start=1):
            if PREFIX_FILE_RE.search(line):
                return True, f"{script_path}:{i}: {line.strip()[:140]} (write verb elsewhere in file)"
    return False, ""


def _resolve_script(token: str, json_path: Path) -> Path | None:
    """Resolve a script reference (e.g. 'scripts/foo.py') relative to the json file."""
    p = Path(token)
    candidates = [
        p if p.is_absolute() else json_path.parent / p,
        json_path.parent.parent / p,           # plugin-root/hooks/ → plugin-root/scripts
        Path.cwd() / p,
    ]
    for c in candidates:
        if c.exists() and c.is_file():
            return c
    return None


def check_fork_safety(report: Report, files: list[Path]) -> None:
    for p in files:
        if p.suffix != ".json":
            continue
        try:
            data = json.loads(p.read_text(errors="ignore"))
        except Exception:
            continue
        hooks = data.get("hooks", {})
        if not isinstance(hooks, dict):
            continue
        for event, handlers in hooks.items():
            if event not in HOT_PATH_HOOKS:
                continue
            blob = json.dumps(handlers)
            # Direct mention in the JSON: only FAIL when a prefix-file name AND
            # a write verb both appear. Read-only commands (`grep`, `cat`) are
            # not cache-busts and must not be reported.
            if PREFIX_FILE_RE.search(blob) and INLINE_WRITE_RE.search(blob):
                report.add(Finding(
                    rule=6, severity="FAIL",
                    title=f"{event} hook appears to write to a prefix file (inline command)",
                    file=str(p),
                    detail=(
                        "Hot-path hooks must not mutate prefix files; that busts the cache "
                        "for the current session and any fork. Queue the write for "
                        "SessionStart instead, or write to a sidecar."
                    ),
                ))
            # Script-following: open invoked scripts and grep for prefix writes.
            # group(1) = interpreter+script form; group(2) = direct ./ or /abs path.
            for script_match in SCRIPT_INVOKE_RE.finditer(blob):
                token = script_match.group(1) or script_match.group(2)
                if not token:
                    continue
                script = _resolve_script(token, p)
                if not script:
                    continue
                writes, evidence = _script_writes_prefix(script)
                if writes:
                    report.add(Finding(
                        rule=6, severity="FAIL",
                        title=f"{event} hook invokes a script that writes to a prefix file",
                        file=str(script),
                        detail=(
                            f"Referenced by {p}. Evidence: {evidence}. "
                            "Cache-busts the hot path. Move the write to SessionStart or a sidecar."
                        ),
                    ))


# --- Rule 1 & 3: ordering / tool stability via fingerprint ---------------

FINGERPRINT_NAME = ".cache-lint-fingerprint.json"


def _is_claude_code_project(root: Path) -> bool:
    """Heuristic: does the directory look like a Claude Code / agent project?

    Used to refuse to write the fingerprint into arbitrary paths the user
    passed via --root. Running `cache-lint audit /etc` should not leave a
    fingerprint file in /etc.
    """
    markers = [
        root / "CLAUDE.md",
        root / "AGENTS.md",
        root / "GEMINI.md",
        root / ".claude",
        root / ".claude-plugin",
        root / "skills",
    ]
    return any(m.exists() for m in markers)


def compute_fingerprint(root: Path) -> dict[str, str]:
    fp: dict[str, str] = {}
    for p in (root.glob(SKILL_GLOB)):
        try:
            text = p.read_text(errors="ignore")
        except Exception:
            continue
        # description-only hash; body changes don't affect cache key
        m = re.search(r"^description:\s*(.+)$", text, re.M)
        desc = (m.group(1) if m else "").strip()
        fp[str(p.relative_to(root))] = hashlib.sha256(desc.encode("utf-8")).hexdigest()[:12]
    for name in PREFIX_FILES:
        p = root / name
        if not p.exists():
            continue
        # ordering hash = sequence of heading lines
        try:
            text = p.read_text(errors="ignore")
        except Exception:
            continue
        headings = [ln for ln in text.splitlines() if ln.startswith("#")]
        fp[name + ":order"] = hashlib.sha256("\n".join(headings).encode("utf-8")).hexdigest()[:12]
    return fp


def check_ordering_and_tools(report: Report, root: Path) -> None:
    # Refuse to write fingerprint into directories that don't look like
    # Claude Code projects — protects against `cache-lint audit /etc` leaving
    # a stray fingerprint file there.
    if not _is_claude_code_project(root):
        report.add(Finding(
            rule=1, severity="WARN",
            title=f"{root} doesn't look like a Claude Code project; skipping rule 1/3 fingerprint",
            detail="Expected one of: CLAUDE.md, AGENTS.md, GEMINI.md, .claude/, .claude-plugin/, skills/",
        ))
        return
    fp_path = root / FINGERPRINT_NAME
    new_fp = compute_fingerprint(root)
    if not fp_path.exists():
        # First run — write the baseline. If the directory is read-only (CI
        # checkouts often are), surface that loudly: silently swallowing the
        # write means rules 1 + 3 silently report "initialized" forever and
        # never detect a real drift.
        try:
            fp_path.write_text(json.dumps(new_fp, indent=2, sort_keys=True))
        except OSError as e:
            report.add(Finding(
                rule=1, severity="WARN",
                title=f"could not persist {FINGERPRINT_NAME} baseline ({e})",
                detail="Rules 1 and 3 require a writable project root. Re-run from a writable checkout, or run as a user with write access.",
            ))
            return
        report.add(Finding(
            rule=1, severity="OK",
            title="ordering/tool fingerprint initialized (no prior baseline)",
            detail=f"Wrote {FINGERPRINT_NAME}; next run will compare against it.",
        ))
        return
    try:
        old_fp = json.loads(fp_path.read_text())
    except Exception:
        old_fp = {}

    changed_orders = [k for k in new_fp if k.endswith(":order") and old_fp.get(k) != new_fp.get(k) and k in old_fp]
    if changed_orders:
        report.add(Finding(
            rule=1, severity="WARN",
            title=f"prefix-file heading order changed since last audit: {changed_orders}",
            detail="Reordering busts the cache for every session that depended on the prior order.",
        ))

    changed_skills = [
        k for k in new_fp
        if not k.endswith(":order") and k in old_fp and old_fp[k] != new_fp[k]
    ]
    if changed_skills:
        report.add(Finding(
            rule=3, severity="WARN",
            title=f"{len(changed_skills)} skill description(s) changed since last audit",
            detail="Each description change re-keys the cache for any prompt that loaded that skill.",
        ))

    # Update baseline. Surface write failures (read-only checkout) so the next
    # run doesn't silently use stale comparison data.
    try:
        fp_path.write_text(json.dumps(new_fp, indent=2, sort_keys=True))
    except OSError as e:
        report.add(Finding(
            rule=1, severity="WARN",
            title=f"could not update {FINGERPRINT_NAME} ({e})",
            detail="Future runs will compare against the previous (now-stale) baseline until the file is writable.",
        ))


# --- Driver ---------------------------------------------------------------

def audit(root: Path, rule_filter: int | None = None) -> Report:
    files = discover(root)
    report = Report(root=str(root), targets=[str(p) for p in files])
    if not files:
        report.add(Finding(rule=0, severity="WARN", title="no Claude Code prefix files found", file=str(root)))
        report.finalize()
        return report
    if rule_filter in (None, 2):
        check_dynamic_content(report, files)
    if rule_filter in (None, 5):
        check_sizing(report, root)
    if rule_filter in (None, 4):
        check_model_switching(report, files)
    if rule_filter in (None, 6):
        check_fork_safety(report, files)
    if rule_filter in (None, 1, 3):
        check_ordering_and_tools(report, root)
    report.finalize()
    return report


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="cache-lint")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("audit")
    a.add_argument("root", nargs="?", default=".")
    a.add_argument("--json", action="store_true")
    a.add_argument("--rule", type=int, choices=[1, 2, 3, 4, 5, 6])
    a.add_argument("--list-targets", action="store_true")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    if not root.exists():
        print(f"error: not found: {root}", file=sys.stderr)
        return 3

    if args.list_targets:
        for f in discover(root):
            print(f)
        return 0

    report = audit(root, rule_filter=args.rule)

    if args.json:
        out = {
            "root": report.root,
            "summary": report.summary,
            "findings": [asdict(f) for f in report.findings],
        }
        print(json.dumps(out, indent=2))
    else:
        print(f"cache-lint: {root}")
        if not report.findings:
            print("  OK — no findings")
        for f in report.findings:
            anchor = f"  [{f.severity}] rule {f.rule}: {f.title}"
            print(anchor)
            if f.file:
                loc = f"{f.file}:{f.line}" if f.line else f.file
                print(f"      at {loc}")
            if f.detail:
                print(f"      → {f.detail}")
        print(f"summary: {report.summary['FAIL']} fail · {report.summary['WARN']} warn")

    if report.summary["FAIL"] > 0:
        return 2
    if report.summary["WARN"] > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
