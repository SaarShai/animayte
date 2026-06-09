#!/usr/bin/env python3
"""write-gate — content-quality gate for persistent memory.

Scores candidate text on signal features (decisions / errors / architecture / code /
numbers / entity overlap) and rejects reasonless decisions (no because… / so that… /
to avoid…). Sits in front of any persistent write (wiki-memory, CLAUDE.md, etc).

Sources:
  - ogham-mcp/ogham-mcp (signal-score lifecycle, 91.8% QA on LongMemEval)
  - codenamev/claude_memory (why-clause enforcement, 100% on 100-case FEVER set)

Usage:
  write_gate.py score --kind {fact,decision,convention,error,sop} [--text … | --file … | <stdin>]
  write_gate.py gate  --kind … [--text/--file/<stdin>]              # exit 0 pass, 1 reject
  write_gate.py explain --kind … [--text/--file/<stdin>]             # human-readable breakdown
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path


# --- Config ---------------------------------------------------------------

DEFAULT_THRESHOLD = 3.0
DEFAULT_WEIGHTS = {
    "decision": 2.0,
    "error": 2.0,
    "architecture": 1.5,
    "code_block": 1.0,
    "numbers": 1.0,
    "why_clause": 1.0,         # reward reasoned thinking; calibrated on adversarial set
    "procedure": 2.0,           # numbered/bulleted ordered steps — high-signal SOP signature
    "entity_overlap": 0.5,      # per repeated capitalized identifier, capped at 1.5
    "filler": -1.5,
    "speculation": -1.5,
}
ENTITY_CAP = 1.5

DECISION_MARKERS = (
    "we decided", "we chose", "chose ", " over ", "going with", "rejected ",
    "we picked", "we'll use", "we will use", "we're using", "we are using",
    "settled on", "decision:", "adopted ", "switched to", "moved to",
    "migrated to", "deprecated in favor", "selected ", "opted for",
)
ERROR_MARKERS = (
    # literal log / stacktrace signal
    "failed because", "fix:", "bug:", "broke when", "regression:",
    "fixed by", "root cause", "panic", "traceback",
    "error:", "crashes when", "throws when", "hangs on", "leaks",
    # natural-language failure-lesson phrasings. A failure lesson written in prose
    # ("X fails with Y", "caused repeated failures", "the fix is Z") is exactly what
    # wiki-memory's "non-trivial failure lesson" trigger is meant to capture — the
    # gate must credit it, not only literal stacktraces. Added 2026-06-06 after
    # exp1_compounding surfaced that prose failure lessons were gate-rejected
    # (memory−cold lift +0.0 on the failure source); re-validated against the exp3
    # write_gate labeled corpus to confirm precision (zero false-keeps) held.
    "fails with", "fails when", "failed with", "failed when", "failing",
    "the fix", "regression", "rate-limit", "rate limit", "times out",
    "timed out", "timeout", "incident", "deadlock", "out of memory",
    "non-zero exit", "exit status", "stack trace", "rejected with",
)
ARCH_MARKERS = (
    "runs on", "calls ", "depends on", "talks to", "writes to",
    "reads from", "stored in", "served by", "lives in", "deployed to",
    "implemented in", "implemented as", "backed by", "powered by",
    "uses ", "via ", "produces ", "consumes ", "subscribed to",
    "publishes to", "exposes ", "exports ",
)
FILLER_PHRASES = (
    "in summary", "to recap", "as i mentioned", "basically what we did",
    "long story short", "tl;dr", "anyway,",
)
SPECULATION_PHRASES = (
    " might ", " maybe ", " probably ", "i think ", "seems like",
    " could maybe", " perhaps ", " possibly ",
)
# NB: "since" is intentionally absent — it's overwhelmingly temporal in
# practice ("tracked since yesterday") and was bypassing the gate as a
# pseudo-causal token. Authors who genuinely mean causal "since" can write
# "in order to" or "because" — both are clearer anyway.
WHY_CLAUSES = (
    "because", "so that", "to avoid", "in order to",
    "due to", "in favor of", "rather than", "the reason",
)
CODE_FENCE_PAIR_RE = re.compile(r"```.*?```", re.DOTALL)

NUMBER_RE = re.compile(
    r"\b\d+(?:\.\d+)?\s?(?:%|ms|s|x|ops|qps|rps|MB|GB|KB|TB|tokens?|loc|lines?|"
    r"events?/s(?:ec)?|req/s(?:ec)?|/min|/hour|/day|sec|min|hour|day|"
    r"users?|rows?|docs?|requests?)\b", re.I)
CODE_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+\-]*\n", re.M)
# Inline code (`foo`) is weaker signal than fences but still indicates concrete
# technical content. Triple-backticks are handled separately.
INLINE_CODE_RE = re.compile(r"(?<!`)`[^`\n]{2,60}`(?!`)")
ENTITY_RE = re.compile(r"\b(?:[A-Z][a-zA-Z0-9_]{2,}|/[A-Za-z0-9_./-]+|[a-z_][a-z0-9_]*\.(?:py|ts|js|tsx|go|rs|md))\b")


@dataclass
class Score:
    total: float = 0.0
    features: dict[str, float] = field(default_factory=dict)
    has_why: bool = False
    reasons: list[str] = field(default_factory=list)


# --- Scoring --------------------------------------------------------------

def _count_any(text_lc: str, needles: tuple[str, ...]) -> int:
    return sum(1 for n in needles if n in text_lc)


def score_text(text: str, kind: str, weights: dict[str, float] | None = None) -> Score:
    weights = weights or DEFAULT_WEIGHTS
    text_lc = text.lower()
    s = Score()

    # Decision (heavily weighted)
    n_dec = _count_any(text_lc, DECISION_MARKERS)
    if n_dec:
        v = weights["decision"] * min(n_dec, 2)  # cap influence
        s.features["decision"] = v
        s.total += v
        s.reasons.append(f"decision markers ×{n_dec}")

    # Error / failure
    n_err = _count_any(text_lc, ERROR_MARKERS)
    if n_err:
        v = weights["error"] * min(n_err, 2)
        s.features["error"] = v
        s.total += v
        s.reasons.append(f"error/failure markers ×{n_err}")

    # Architecture
    n_arch = _count_any(text_lc, ARCH_MARKERS)
    if n_arch:
        v = weights["architecture"] * min(n_arch, 2)
        s.features["architecture"] = v
        s.total += v
        s.reasons.append(f"architecture markers ×{n_arch}")

    # Code blocks — fenced is full weight; inline backticks are half weight,
    # capped (otherwise a doc heavy in `monospace` identifiers floods the signal).
    n_code = len(CODE_FENCE_RE.findall(text))
    if n_code:
        v = weights["code_block"] * min(n_code, 2)
        s.features["code_block"] = v
        s.total += v
        s.reasons.append(f"code fences ×{n_code}")
    else:
        n_inline = len(INLINE_CODE_RE.findall(text))
        if n_inline >= 2:
            # half weight, max contribution = code_block weight
            v = min(weights["code_block"] * 0.5 * min(n_inline, 4), weights["code_block"])
            s.features["inline_code"] = v
            s.total += v
            s.reasons.append(f"inline code ×{n_inline}")

    # Concrete numbers
    n_num = len(NUMBER_RE.findall(text))
    if n_num:
        v = weights["numbers"] * min(n_num, 2)
        s.features["numbers"] = v
        s.total += v
        s.reasons.append(f"measurements ×{n_num}")

    # Entity overlap (repeated capitalized identifiers / paths / module names).
    # Counter is O(n); the previous list.count-per-element was O(n²) and
    # could be DoS'd by adversarial Markdown with 20k tokens.
    entities = ENTITY_RE.findall(text)
    counts = Counter(entities)
    repeated = sum(1 for e, n in counts.items() if n >= 2)
    if repeated:
        raw = weights["entity_overlap"] * repeated
        v = min(raw, ENTITY_CAP)
        s.features["entity_overlap"] = v
        s.total += v
        s.reasons.append(f"repeated entities ×{repeated} (capped at {ENTITY_CAP})")

    # Filler (negative)
    n_fill = _count_any(text_lc, FILLER_PHRASES)
    if n_fill:
        v = weights["filler"] * n_fill
        s.features["filler"] = v
        s.total += v
        s.reasons.append(f"filler phrases ×{n_fill}")

    # Speculation (negative)
    n_spec = _count_any(text_lc, SPECULATION_PHRASES)
    if n_spec:
        v = weights["speculation"] * n_spec
        s.features["speculation"] = v
        s.total += v
        s.reasons.append(f"speculation phrases ×{n_spec}")

    # Numbered / bulleted procedure (SOP signature: "1. ... 2. ... 3. ...")
    # Requires at least 2 ordered steps on their own lines.
    procedure_steps = len(re.findall(r"^\s*(?:\d+\.|[-*])\s+\S", text, re.M))
    if procedure_steps >= 2:
        v = weights["procedure"]
        s.features["procedure"] = v
        s.total += v
        s.reasons.append(f"procedure steps ×{procedure_steps}")

    # Why-clause detection (required for decisions / conventions; also adds signal).
    # Strip fenced code blocks first so a `# because reasons` comment inside ``` ```
    # can't satisfy the gate. The check is on prose, not code.
    prose_lc = CODE_FENCE_PAIR_RE.sub(" ", text).lower()
    s.has_why = any(w in prose_lc for w in WHY_CLAUSES)
    if s.has_why:
        v = weights["why_clause"]
        s.features["why_clause"] = v
        s.total += v
        s.reasons.append("why-clause present")

    return s


# --- Decision -------------------------------------------------------------

def decide(score: Score, kind: str, threshold: float, require_why: bool) -> tuple[bool, str]:
    """Return (passed, reason)."""
    if kind in ("decision", "convention") and require_why and not score.has_why:
        return False, "REJECTED: decision/convention missing a why-clause (need 'because…', 'so that…', 'to avoid…', etc)"
    if score.total < threshold:
        return False, f"REJECTED: signal score {score.total:.2f} < threshold {threshold:.2f}"
    return True, f"PASSED: signal score {score.total:.2f} ≥ threshold {threshold:.2f}"


# --- Config loading -------------------------------------------------------

def load_config() -> tuple[float, bool, dict[str, float]]:
    """Look for wiki/write_gate_config.yaml in cwd or env WIKI_ROOT."""
    threshold = DEFAULT_THRESHOLD
    require_why = True
    weights = dict(DEFAULT_WEIGHTS)

    candidates = []
    if "WIKI_ROOT" in os.environ:
        candidates.append(Path(os.environ["WIKI_ROOT"]) / "write_gate_config.yaml")
    candidates.append(Path.cwd() / "wiki" / "write_gate_config.yaml")

    for p in candidates:
        if not p.exists():
            continue
        try:
            import yaml  # type: ignore
            cfg = yaml.safe_load(p.read_text()) or {}
        except ImportError:
            # Minimal fallback parser — SCALAR top-level keys only.
            # Nested keys (e.g. `weights:` with indented children) are silently
            # skipped, NOT mis-parsed as strings. Loud about it.
            print(
                f"write-gate: PyYAML not installed; nested config (e.g. weights:) "
                f"in {p} will be ignored. `pip install pyyaml` for full support.",
                file=sys.stderr,
            )
            cfg = {}
            for line in p.read_text().splitlines():
                line = line.split("#", 1)[0].rstrip()
                if not line or ":" not in line:
                    continue
                if line[0] in (" ", "\t"):
                    continue  # belongs to a nested key
                k, _, v = line.partition(":")
                v = v.strip()
                if not v or v.startswith(("[", "{", "|", ">")):
                    continue
                cfg[k.strip()] = v
        if "threshold" in cfg:
            try:
                threshold = float(cfg["threshold"])
            except (TypeError, ValueError):
                pass
        if "require_why_for_decisions" in cfg:
            require_why = bool(cfg["require_why_for_decisions"])
        # Only consult weights if it's a real dict — fallback parser skips it.
        raw_weights = cfg.get("weights")
        if isinstance(raw_weights, dict):
            for k, v in raw_weights.items():
                try:
                    weights[k] = float(v)
                except (TypeError, ValueError):
                    pass
        break  # first hit wins
    return threshold, require_why, weights


# --- CLI ------------------------------------------------------------------

def _read_input(args: argparse.Namespace) -> str:
    if args.text:
        return args.text
    if args.file:
        try:
            # tolerant of non-UTF-8 inputs (binary, latin-1, etc) so we never
            # crash the gate on a weird file — we just score what we can read
            return Path(args.file).read_text(errors="replace")
        except (OSError, IsADirectoryError) as e:
            print(f"error: cannot read {args.file}: {e}", file=sys.stderr)
            sys.exit(2)
    if not sys.stdin.isatty():
        return sys.stdin.read()
    print("error: no input. Pass --text, --file, or pipe via stdin.", file=sys.stderr)
    sys.exit(2)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="write-gate", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name in ("score", "gate", "explain"):
        p = sub.add_parser(name)
        p.add_argument("--kind", default="fact",
                       choices=["fact", "decision", "convention", "error", "sop"])
        p.add_argument("--text")
        p.add_argument("--file")
        p.add_argument("--threshold", type=float)
        p.add_argument("--json", action="store_true", help="emit machine-readable JSON")

    args = ap.parse_args(argv)
    text = _read_input(args)
    if not text.strip():
        print("error: empty input", file=sys.stderr)
        return 2

    threshold, require_why, weights = load_config()
    if args.threshold is not None:
        threshold = args.threshold

    s = score_text(text, args.kind, weights)
    passed, verdict = decide(s, args.kind, threshold, require_why)

    if args.json:
        out = {
            "passed": passed,
            "score": round(s.total, 3),
            "threshold": threshold,
            "kind": args.kind,
            "has_why": s.has_why,
            "features": {k: round(v, 3) for k, v in s.features.items()},
            "verdict": verdict,
            "reasons": s.reasons,
        }
        print(json.dumps(out, indent=2))
        return 0 if passed else 1

    if args.cmd == "score":
        print(f"score: {s.total:.2f}  threshold: {threshold:.2f}  kind: {args.kind}  why_clause: {s.has_why}")
        return 0
    if args.cmd == "gate":
        return 0 if passed else 1
    # explain
    print(verdict)
    print(f"  total: {s.total:.2f}  threshold: {threshold:.2f}  kind: {args.kind}")
    print(f"  why_clause present: {s.has_why}")
    if s.reasons:
        print("  features:")
        for r in s.reasons:
            print(f"    - {r}")
    else:
        print("  features: (none)")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
