#!/usr/bin/env python3
"""PreCompact hook entry. Reads Claude Code JSON payload from stdin, runs extract.py,
forwards the terse pointer to stdout (which Claude Code prepends to the compaction prompt).

Contract: always exit 0. Compaction must not be blocked by a hook failure.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def log_err(msg: str) -> None:
    ts = time.strftime("%FT%TZ", time.gmtime())
    sys.stderr.write(f"{ts} context-keeper: {msg}\n")


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        log_err("empty-payload")
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        log_err(f"json-decode-error: {e}")
        return 0

    tp = payload.get("transcript_path", "")
    sid = payload.get("session_id", "")
    trigger = payload.get("trigger", "auto")

    if not tp or not Path(tp).is_file():
        log_err(f"missing-transcript path={tp!r}")
        return 0

    extract_py = Path(__file__).parent / "extract.py"
    if not extract_py.is_file():
        log_err(f"extract.py-missing at={extract_py}")
        return 0

    env = os.environ.copy()
    env.setdefault("TOKEN_ECONOMY_ROOT", str(Path(__file__).resolve().parents[3]))

    try:
        subprocess.run(
            [sys.executable, str(extract_py), tp, "--pointer-only", "--session-id", sid or "unknown"],
            timeout=30,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired:
        log_err(f"extract-timeout sid={sid} trigger={trigger}")
    except Exception as e:  # never crash the host
        log_err(f"extract-error: {e!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
