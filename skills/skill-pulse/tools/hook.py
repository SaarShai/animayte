#!/usr/bin/env python3
"""skill-pulse UserPromptSubmit hook.

Periodically re-injects active skill rules to fight instruction drift.
Empirically grounded in arXiv 2510.07777 ("Drift No More?"), which shows
timed reminder injections drop KL divergence 6.45-11.81% and improve
judge scores 16-27% on long-horizon agent tasks.

Mechanism:
  - Tracks turn count per session in .brainer/skill-pulse/<sid>.json
  - Every SKILL_PULSE_EVERY user prompts (default 4, paper-calibrated),
    emits a <system-reminder> on stdout listing active skill rules.
  - UserPromptSubmit stdout-prepends to next model turn (verified docs).

Activation:
  - A skill participates ONLY if its SKILL.md frontmatter has a
    `pulse_reminder:` field (curated), OR if SKILL_PULSE_SKILLS allowlists
    it explicitly (falls back to first sentence of `description`).

Contract: always exit 0. A failing UserPromptSubmit hook would block
the user's prompt.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import sys
import time
from contextlib import contextmanager
from pathlib import Path


CADENCE_DEFAULT = 4              # paper-tested at turns 4 + 7 of 10-turn convos
CADENCE_FLOOR = 2
GC_AGE_SECONDS = 7 * 24 * 3600
GC_SCAN_MAX = 500
MAX_SKILLS_IN_PULSE = 8          # cap payload size


def log_err(msg: str) -> None:
    ts = time.strftime("%FT%TZ", time.gmtime())
    sys.stderr.write(f"{ts} skill-pulse: {msg}\n")


def state_dir() -> Path:
    override = os.environ.get("SKILL_PULSE_STATE_DIR")
    if override:
        return Path(override)
    # Anchor to CLAUDE_PROJECT_DIR — process cwd isn't stable across hook calls
    # (the agent can `cd` mid-session), and a cwd-relative path silently
    # fragments per-session state across directories.
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    base = Path(project) if project else Path.cwd()
    return base / ".brainer" / "skill-pulse"


def state_path(session_id: str) -> Path:
    # SHA-256 truncated to 16 hex chars: ~2^64 namespace, collision-safe even
    # across long-lived multi-project setups. Previous 8-char raw prefix could
    # collide for sessions whose ids shared a prefix.
    sid = session_id or "unknown"
    sid_hash = hashlib.sha256(sid.encode("utf-8", errors="replace")).hexdigest()[:16]
    return state_dir() / f"{sid_hash}.json"


def skills_root() -> Path:
    override = os.environ.get("SKILL_PULSE_SKILLS_ROOT")
    if override:
        return Path(override)
    return Path(".claude/skills")


@contextmanager
def state_lock(path: Path):
    lock_path = path.with_suffix(path.suffix + ".lock")
    fh = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(lock_path, "a+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        except (OSError, AttributeError) as e:
            log_err(f"lock-skip path={lock_path} err={e!r}")
        yield
    except Exception as e:
        log_err(f"lock-open-fail path={lock_path} err={e!r}")
        yield
    finally:
        if fh is not None:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            fh.close()


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as e:
        log_err(f"state-read-fail path={path} err={e!r}")
        return {}


def save_state(path: Path, state: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    except Exception as e:
        log_err(f"state-write-fail path={path} err={e!r}")


def gc_old_state(dir_path: Path, now: float) -> int:
    if not dir_path.is_dir():
        return 0
    removed = 0
    try:
        with os.scandir(dir_path) as it:
            for i, entry in enumerate(it):
                if i >= GC_SCAN_MAX:
                    break
                if not entry.is_file():
                    continue
                if not (entry.name.endswith(".json") or entry.name.endswith(".json.lock")):
                    continue
                try:
                    if now - entry.stat().st_mtime > GC_AGE_SECONDS:
                        os.unlink(entry.path)
                        removed += 1
                except OSError:
                    pass
    except OSError as e:
        log_err(f"gc-scandir-fail dir={dir_path} err={e!r}")
    return removed


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter(text: str) -> dict:
    """Minimal YAML-ish frontmatter parser. Handles `key: value` and
    `key: "quoted value"`. Not full YAML — but the SKILL.md files in this
    catalog stick to simple scalars, so we keep zero dependencies."""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    out = {}
    for raw in m.group(1).splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        if ":" not in raw:
            continue
        key, _, val = raw.partition(":")
        key = key.strip()
        val = val.strip()
        # strip matching surrounding quotes
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        out[key] = val
    return out


def first_sentence(text: str) -> str:
    if not text:
        return ""
    # Split on `. ` so we don't break decimals or "e.g."
    parts = re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)
    return parts[0].rstrip(".") if parts else text.strip()


def discover_skills(root: Path, allowlist: set[str]) -> list[tuple[str, str]]:
    """Return [(name, one-line reminder), ...] for skills that should be in
    the pulse. A skill is included iff:
      - its frontmatter has `pulse_reminder:`, OR
      - it's named in the allowlist (then we fall back to first sentence of description)
    Dedupes by `name:` field.
    """
    if not root.is_dir():
        return []
    seen_names: set[str] = set()
    out: list[tuple[str, str]] = []
    try:
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.is_file():
                continue
            try:
                text = skill_md.read_text(encoding="utf-8", errors="replace")
            except OSError as e:
                log_err(f"skill-read-fail path={skill_md} err={e!r}")
                continue
            fm = parse_frontmatter(text)
            name = fm.get("name") or entry.name
            if name in seen_names:
                continue
            pulse_reminder = fm.get("pulse_reminder")
            if pulse_reminder:
                out.append((name, pulse_reminder))
                seen_names.add(name)
                continue
            if name in allowlist:
                desc = fm.get("description", "")
                hint = first_sentence(desc)
                if hint:
                    out.append((name, hint))
                    seen_names.add(name)
    except OSError as e:
        log_err(f"discover-fail root={root} err={e!r}")
    return out[:MAX_SKILLS_IN_PULSE]


def build_pulse(skills: list[tuple[str, str]], turn: int) -> str:
    if not skills:
        return ""
    lines = [
        "<system-reminder>",
        f"skill-pulse (turn {turn}): the following skills remain active. "
        f"Drift correction — re-read each rule and check your most recent reply against it.",
    ]
    for name, reminder in skills:
        lines.append(f"- {name}: {reminder}")
    lines.append("</system-reminder>")
    return "\n".join(lines)


def main() -> int:
    if os.environ.get("SKILL_PULSE_DISABLED") == "1":
        return 0

    cadence = CADENCE_DEFAULT
    try:
        cadence = max(CADENCE_FLOOR, int(os.environ.get("SKILL_PULSE_EVERY", CADENCE_DEFAULT)))
    except ValueError:
        pass

    allowlist_raw = os.environ.get("SKILL_PULSE_SKILLS", "")
    allowlist = {s.strip() for s in allowlist_raw.split(",") if s.strip()}

    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        log_err(f"json-decode-fail: {e}")
        return 0

    session_id = payload.get("session_id") or "unknown"
    path = state_path(session_id)
    is_new_session = not path.exists()

    with state_lock(path):
        state = load_state(path)
        turn = int(state.get("turn_count", 0)) + 1
        state["turn_count"] = turn
        state["last_seen_iso"] = time.strftime("%FT%TZ", time.gmtime())
        if is_new_session:
            state["session_started_iso"] = state["last_seen_iso"]
        save_state(path, state)

    if is_new_session:
        gc_old_state(path.parent, time.time())

    # Pulse only on multiples of `cadence`, never on turn 1 (cold start).
    if turn < cadence or turn % cadence != 0:
        return 0

    skills = discover_skills(skills_root(), allowlist)
    pulse = build_pulse(skills, turn)
    if pulse:
        sys.stdout.write(pulse)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
