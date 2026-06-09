#!/usr/bin/env python3
"""compliance-canary UserPromptSubmit hook.

Detects per-skill drift symptoms in recent assistant messages and injects
a corrective <system-reminder> on the next user turn. Complement to
skill-pulse: pulse re-anchors unconditionally; canary intervenes only
when symptoms appear.

Per-skill probes are declared in `<.claude/skills>/<name>/drift_probes.json`:

  [
    {"kind": "forbidden_regex", "pattern": "(?i)\\b(certainly|absolutely)\\b",
     "id": "filler", "severity": "warn"},
    {"kind": "word_count_per_message", "threshold": 80, "window": 3,
     "id": "creep"},
    {"kind": "claim_without_evidence",
     "claim_pattern": "(?i)\\b(done|fixed|passes)\\b",
     "verify_tools": ["Bash"],
     "verify_keywords": ["test", "pytest", "make", "build", "check"]}
  ]

Anti-spam: each probe's last-fire turn is tracked; same probe won't
re-fire within COOLDOWN_TURNS of its last trigger.

Contract: always exit 0. A failing UserPromptSubmit hook would stall
the user.
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


COOLDOWN_TURNS_DEFAULT = 3
MSG_WINDOW_DEFAULT = 3            # number of recent assistant messages to scan
TRANSCRIPT_LINE_CAP = 400         # max trailing lines read from transcript
MAX_PROBES_TRIGGERED = 4          # cap pulse payload
GC_AGE_SECONDS = 7 * 24 * 3600
GC_SCAN_MAX = 500

# Strip fenced + inline code from assistant text before running detectors —
# otherwise a literal string like `print("Certainly!")` triggers caveman's
# filler regex. Detectors should fire on the model's *prose*, not on code
# the model is quoting.
_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?```")
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def strip_code(text: str) -> str:
    text = _CODE_BLOCK_RE.sub(" ", text)
    text = _INLINE_CODE_RE.sub(" ", text)
    return text


def log_err(msg: str) -> None:
    ts = time.strftime("%FT%TZ", time.gmtime())
    sys.stderr.write(f"{ts} compliance-canary: {msg}\n")


def state_dir() -> Path:
    override = os.environ.get("COMPLIANCE_CANARY_STATE_DIR")
    if override:
        return Path(override)
    # Anchor to CLAUDE_PROJECT_DIR — process cwd isn't stable across hook
    # invocations, and a cwd-relative path silently fragments per-session
    # state across directories the agent has cd'd into.
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    base = Path(project) if project else Path.cwd()
    return base / ".brainer" / "compliance-canary"


def state_path(session_id: str) -> Path:
    # 16-hex SHA prefix: collision-safe even when distinct sessions share the
    # same 8-char id prefix (previous bug — overwrote each other's state).
    sid = session_id or "unknown"
    sid_hash = hashlib.sha256(sid.encode("utf-8", errors="replace")).hexdigest()[:16]
    return state_dir() / f"{sid_hash}.json"


def skills_root() -> Path:
    override = os.environ.get("COMPLIANCE_CANARY_SKILLS_ROOT")
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


# -------------------------- probe discovery --------------------------------

def discover_probes(root: Path) -> list[dict]:
    """Walk .claude/skills/*/drift_probes.json. Each probe dict gets
    `_skill` and `_probe_id` fields injected for later display + suppression."""
    if not root.is_dir():
        return []
    out: list[dict] = []
    try:
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            probes_file = entry / "drift_probes.json"
            if not probes_file.is_file():
                continue
            try:
                data = json.loads(probes_file.read_text(encoding="utf-8"))
            except Exception as e:
                log_err(f"probes-parse-fail path={probes_file} err={e!r}")
                continue
            if not isinstance(data, list):
                log_err(f"probes-not-list path={probes_file}")
                continue
            for i, probe in enumerate(data):
                if not isinstance(probe, dict):
                    continue
                pid = probe.get("id") or probe.get("kind", f"p{i}")
                probe["_skill"] = entry.name
                probe["_probe_id"] = f"{entry.name}:{pid}"
                out.append(probe)
    except OSError as e:
        log_err(f"discover-fail root={root} err={e!r}")
    return out


# -------------------------- transcript reading ------------------------------

def read_transcript_tail(path: str, cap: int = TRANSCRIPT_LINE_CAP) -> list[dict]:
    """Return up to `cap` most-recent parseable JSONL events from the transcript."""
    if not path:
        return []
    p = Path(path)
    if not p.is_file():
        return []
    try:
        with open(p, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        log_err(f"transcript-read-fail path={path} err={e!r}")
        return []
    events: list[dict] = []
    for line in lines[-cap:]:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def recent_assistant_messages(events: list[dict], n: int) -> list[dict]:
    """Return up to n most-recent assistant text-content messages, oldest-first.
    Each: {"text": "...", "uuid": "...", "timestamp": "..."}."""
    out: list[dict] = []
    for e in reversed(events):
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        content = msg.get("content") or []
        if not isinstance(content, list):
            continue
        text_chunks = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if not text_chunks:
            continue
        joined = "\n".join(text_chunks)
        out.append({
            "text": strip_code(joined),
            "raw_text": joined,
            "uuid": e.get("uuid", ""),
            "timestamp": e.get("timestamp", ""),
        })
        if len(out) >= n:
            break
    out.reverse()
    return out


def recent_tool_uses(events: list[dict], n: int = 10) -> list[dict]:
    """Return up to n most-recent tool_use blocks, oldest-first.
    Each: {"name": "Bash", "input": {...}}."""
    out: list[dict] = []
    for e in reversed(events):
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        for b in (msg.get("content") or [])[::-1]:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                out.append({"name": b.get("name", ""), "input": b.get("input") or {}})
                if len(out) >= n:
                    break
        if len(out) >= n:
            break
    out.reverse()
    return out


# -------------------------- detectors --------------------------------------

def detect_forbidden_regex(probe: dict, messages: list[dict], _tool_uses) -> dict | None:
    pat_str = probe.get("pattern")
    if not pat_str:
        return None
    try:
        pat = re.compile(pat_str)
    except re.error as e:
        log_err(f"bad-regex probe={probe.get('_probe_id')} err={e!r}")
        return None
    for m in messages:
        match = pat.search(m["text"])
        if match:
            snippet = m["text"]
            i = max(0, match.start() - 20)
            j = min(len(snippet), match.end() + 20)
            return {
                "evidence": f"...{snippet[i:j]}...".replace("\n", " "),
                "matched": match.group(0),
            }
    return None


def detect_word_count_per_message(probe: dict, messages: list[dict], _tool_uses) -> dict | None:
    if not messages:
        return None
    threshold = float(probe.get("threshold", 80))
    window = min(int(probe.get("window", MSG_WINDOW_DEFAULT)), len(messages))
    recent = messages[-window:]
    counts = [len(m["text"].split()) for m in recent]
    avg = sum(counts) / len(counts)
    if avg > threshold:
        return {
            "avg_words": round(avg, 1),
            "threshold": threshold,
            "window": window,
            "counts": counts,
        }
    return None


def detect_claim_without_evidence(probe: dict, messages: list[dict], tool_uses: list[dict]) -> dict | None:
    if not messages:
        return None
    last_text = messages[-1]["text"]
    claim_pat_str = probe.get("claim_pattern", r"(?i)\b(done|fixed|complete|passes|verified|ready|working)\b")
    try:
        claim_pat = re.compile(claim_pat_str)
    except re.error as e:
        log_err(f"bad-claim-regex probe={probe.get('_probe_id')} err={e!r}")
        return None
    claim_match = claim_pat.search(last_text)
    if not claim_match:
        return None
    verify_tools = set(probe.get("verify_tools", ["Bash"]))
    verify_keywords = [kw.lower() for kw in probe.get(
        "verify_keywords",
        ["test", "pytest", "make", "build", "check", "lint", "curl", "verify"],
    )]
    try:
        lookback = int(probe.get("lookback_tool_uses", 5))
    except (TypeError, ValueError):
        log_err(f"bad-lookback probe={probe.get('_probe_id')} value={probe.get('lookback_tool_uses')!r}")
        lookback = 5
    for tu in tool_uses[-lookback:]:
        if tu["name"] not in verify_tools:
            continue
        haystack_parts = []
        if tu["name"] == "Bash":
            haystack_parts.append(str(tu["input"].get("command", "")))
        else:
            haystack_parts.append(json.dumps(tu["input"]))
        haystack = " ".join(haystack_parts).lower()
        if any(kw in haystack for kw in verify_keywords):
            return None  # evidence found
    return {
        "claim": claim_match.group(0),
        "snippet": last_text[max(0, claim_match.start() - 20): claim_match.end() + 40].replace("\n", " "),
        "lookback": lookback,
    }


DETECTORS = {
    "forbidden_regex": detect_forbidden_regex,
    "word_count_per_message": detect_word_count_per_message,
    "claim_without_evidence": detect_claim_without_evidence,
}


def run_probes(
    probes: list[dict],
    messages: list[dict],
    tool_uses: list[dict],
    suppressed: set[str],
) -> list[dict]:
    """Returns list of fired probes (each dict has _skill, _probe_id, _result)."""
    fired: list[dict] = []
    for probe in probes:
        kind = probe.get("kind")
        if kind not in DETECTORS:
            continue
        if probe["_probe_id"] in suppressed:
            continue
        try:
            result = DETECTORS[kind](probe, messages, tool_uses)
        except Exception as e:
            log_err(f"detector-fail probe={probe['_probe_id']} err={e!r}")
            continue
        if result:
            probe["_result"] = result
            fired.append(probe)
            if len(fired) >= MAX_PROBES_TRIGGERED:
                break
    return fired


# -------------------------- output ------------------------------------------

def format_one_probe(probe: dict) -> str:
    skill = probe["_skill"]
    kind = probe.get("kind", "?")
    r = probe.get("_result", {})
    msg = probe.get("message")  # optional human-readable override
    if msg:
        return f"- {skill} [{kind}]: {msg}"
    if kind == "forbidden_regex":
        return f"- {skill} [forbidden_regex]: matched {r.get('matched','?')!r} — recent text: {r.get('evidence','')}"
    if kind == "word_count_per_message":
        return (
            f"- {skill} [word_count_per_message]: avg {r.get('avg_words')} words/msg "
            f"over last {r.get('window')} > threshold {r.get('threshold')}"
        )
    if kind == "claim_without_evidence":
        return (
            f"- {skill} [claim_without_evidence]: claim {r.get('claim')!r} appears "
            f"without a verification tool call in last {r.get('lookback')} tool_uses"
        )
    return f"- {skill} [{kind}]: triggered"


def build_corrective(fired: list[dict], turn: int) -> str:
    lines = [
        "<system-reminder>",
        f"compliance-canary (turn {turn}): drift signals detected in your recent output. "
        f"Re-read each active rule and correct your next reply before continuing.",
    ]
    for probe in fired:
        lines.append(format_one_probe(probe))
    lines.append("</system-reminder>")
    return "\n".join(lines)


# -------------------------- main --------------------------------------------

def main() -> int:
    if os.environ.get("COMPLIANCE_CANARY_DISABLED") == "1":
        return 0

    cooldown = COOLDOWN_TURNS_DEFAULT
    try:
        cooldown = max(0, int(os.environ.get("COMPLIANCE_CANARY_COOLDOWN", COOLDOWN_TURNS_DEFAULT)))
    except ValueError:
        pass

    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as e:
        log_err(f"json-decode-fail: {e}")
        return 0

    session_id = payload.get("session_id") or "unknown"
    transcript_path = payload.get("transcript_path", "")

    path = state_path(session_id)
    is_new_session = not path.exists()

    with state_lock(path):
        state = load_state(path)
        turn = int(state.get("turn_count", 0)) + 1
        state["turn_count"] = turn
        state["last_seen_iso"] = time.strftime("%FT%TZ", time.gmtime())
        if is_new_session:
            state["session_started_iso"] = state["last_seen_iso"]
        # Persist counter early — if any later step errors, we still progress
        save_state(path, state)

    if is_new_session:
        gc_old_state(path.parent, time.time())

    probes = discover_probes(skills_root())
    if not probes:
        return 0

    events = read_transcript_tail(transcript_path)
    if not events:
        return 0

    messages = recent_assistant_messages(events, MSG_WINDOW_DEFAULT)
    if not messages:
        return 0
    tool_uses = recent_tool_uses(events, n=10)

    # Build suppression set from probe_history
    history = state.get("probe_history", [])
    suppressed = {
        h["probe_id"] for h in history
        if isinstance(h, dict)
        and turn - int(h.get("fired_at_turn", 0)) < cooldown
    }

    fired = run_probes(probes, messages, tool_uses, suppressed)
    if not fired:
        return 0

    # Persist new fire entries
    with state_lock(path):
        state = load_state(path)
        history = state.get("probe_history", [])
        for probe in fired:
            history.append({"probe_id": probe["_probe_id"], "fired_at_turn": turn})
        # bound history size
        state["probe_history"] = history[-50:]
        save_state(path, state)

    sys.stdout.write(build_corrective(fired, turn))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
