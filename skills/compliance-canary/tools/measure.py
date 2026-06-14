#!/usr/bin/env python3
"""compliance-canary offline analyzer.

Runs the same drift probes used by the live hook against one or more
transcript JSONL files. No state writes, no side effects, no env vars
required. Useful for:

  - Baselining drift in past sessions before installing the hook
  - Tuning thresholds against your actual session distributions
  - Validating a new probe before adding it to a skill's drift_probes.json

Usage:
  python3 measure.py PATH/TO/transcript.jsonl
  python3 measure.py ~/.claude/projects/<proj>/*.jsonl --summary
  python3 measure.py transcripts/*.jsonl --probes-root /path/to/.claude/skills

Output: per-file probe-trigger counts and (optionally) the matched snippets.
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from hook import (  # type: ignore  # noqa: E402
    DETECTORS,
    MSG_WINDOW_DEFAULT,
    discover_probes,
    read_transcript_tail,
    recent_assistant_messages,
    recent_tool_errors,
    recent_tool_uses,
    trajectory_stats,
)


def default_probes_root() -> Path:
    repo = HERE.parent.parent.parent
    candidates = [
        Path(".claude/skills"),
        repo / "skills",
        repo / ".claude/skills",
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return Path(".claude/skills")


def analyze_one(path: Path, probes: list[dict], window: int) -> dict:
    events = read_transcript_tail(str(path), cap=10_000)
    # Mirror the live hook (hook.py:649-659): fetch enough messages for the
    # LARGEST declared word_count window — not one global `window`. Without this,
    # a probe declaring window:5 was scored against only the default 3 messages
    # (the detector then clamps to len(messages)), a silent false-negative for
    # the exact calibration this offline analyzer exists to verify. The CLI
    # --window value acts as a floor.
    WORD_COUNT_WINDOW_CAP = 50
    max_window = max(
        [window]
        + [
            min(int(p.get("window", MSG_WINDOW_DEFAULT)), WORD_COUNT_WINDOW_CAP)
            for p in probes
            if p.get("kind") == "word_count_per_message"
            and str(p.get("window", MSG_WINDOW_DEFAULT)).lstrip("-").isdigit()
        ]
    )
    messages = recent_assistant_messages(events, max_window)
    tool_uses = recent_tool_uses(events, n=20)
    # Match the live hook's full detector signature: without tool_errors and
    # traj_stats, the trajectory_drift / repeated_tool_error detectors always
    # report 0 fires — a silent false-negative for the exact calibration this
    # tool exists for. user_correction still can't fire offline (no synthetic
    # user prompt in a transcript) — that's expected, user_prompt="" here.
    tool_errors = recent_tool_errors(events)
    traj = trajectory_stats(events)
    fires: list[dict] = []
    for probe in probes:
        kind = probe.get("kind")
        if kind not in DETECTORS:
            continue
        try:
            result = DETECTORS[kind](probe, messages, tool_uses, tool_errors,
                                     user_prompt="", traj_stats=traj)
        except Exception as e:
            result = None
            sys.stderr.write(f"  ! detector error probe={probe.get('_probe_id')} err={e!r}\n")
        if result:
            fires.append({"probe": probe, "result": result})
    return {
        "path": str(path),
        "n_events": len(events),
        "n_assistant_messages": len(messages),
        "n_tool_uses": len(tool_uses),
        "n_fires": len(fires),
        "fires": fires,
    }


def fmt_fire(fire: dict) -> str:
    p = fire["probe"]
    r = fire["result"]
    pid = p.get("_probe_id", "?")
    if p["kind"] == "forbidden_regex":
        return f"  ! {pid} — matched {r.get('matched')!r} | evidence: {r.get('evidence')}"
    if p["kind"] == "word_count_per_message":
        return (f"  ! {pid} — avg {r.get('avg_words')} words/msg "
                f"over window {r.get('window')} > threshold {r.get('threshold')}")
    if p["kind"] == "claim_without_evidence":
        return f"  ! {pid} — claim {r.get('claim')!r} in: {r.get('snippet')}"
    return f"  ! {pid} — {r}"


def main():
    ap = argparse.ArgumentParser(description="compliance-canary offline analyzer")
    ap.add_argument("paths", nargs="+", help="Transcript JSONL files or glob patterns")
    ap.add_argument("--probes-root", default=None,
                    help="Path to .claude/skills (auto-detected by default)")
    ap.add_argument("--window", type=int, default=MSG_WINDOW_DEFAULT,
                    help=f"Number of recent assistant messages to scan (default {MSG_WINDOW_DEFAULT})")
    ap.add_argument("--summary", action="store_true",
                    help="Per-file totals only, no individual fire details")
    ap.add_argument("--json", action="store_true",
                    help="Machine-readable JSON output")
    args = ap.parse_args()

    probes_root = Path(args.probes_root) if args.probes_root else default_probes_root()
    probes = discover_probes(probes_root)
    if not probes:
        sys.stderr.write(f"no probes discovered under {probes_root}\n")
        return 2

    files: list[Path] = []
    for raw in args.paths:
        if any(c in raw for c in "*?["):
            files.extend(Path(p) for p in glob.glob(raw))
        else:
            files.append(Path(raw))
    if not files:
        sys.stderr.write("no files matched\n")
        return 2

    results = []
    for f in files:
        if not f.is_file():
            sys.stderr.write(f"skip (not a file): {f}\n")
            continue
        results.append(analyze_one(f, probes, args.window))

    if args.json:
        for r in results:
            r["fires"] = [
                {"probe_id": fire["probe"].get("_probe_id"),
                 "kind": fire["probe"].get("kind"),
                 "result": fire["result"]}
                for fire in r["fires"]
            ]
        print(json.dumps(results, indent=2, default=str))
        return 0

    total_fires = 0
    for r in results:
        total_fires += r["n_fires"]
        print(f"\n{r['path']}")
        print(f"  events: {r['n_events']}  assistant_msgs: {r['n_assistant_messages']}  "
              f"tool_uses: {r['n_tool_uses']}  fires: {r['n_fires']}")
        if not args.summary:
            for fire in r["fires"]:
                print(fmt_fire(fire))
    print()
    print(f"Summary: {len(results)} file(s), {total_fires} probe fire(s), "
          f"{len(probes)} probe(s) loaded from {probes_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
