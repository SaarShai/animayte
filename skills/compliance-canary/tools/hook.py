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
     "id": "creep",
     "warrant_pattern": r"(?i)\b(explain|elaborate|detail|in[ -]?depth|deep[ -]?dive|walk me through|comprehensive|thorough(ly)?|step[ -]by[ -]step|summar(y|ize|ise)|overview|report|break ?down|compare|pros and cons|brainstorm|think (of|about|through)|tell me (what|how|why|about|everything)|list( me)? (\d|at least|the|all|every)|\d+ (ways|ideas|options|reasons|examples|things)|why (does|do|is|are|did))\b"},
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
    # Setup (mkdir/open/flock) is best-effort: on failure we log and proceed
    # lockless rather than blocking the user's prompt. This is a SEPARATE try
    # from the yield — a body exception must propagate cleanly, not be caught
    # here (which would double-yield and corrupt the generator protocol,
    # raising RuntimeError and breaking the always-exit-0 contract).
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(lock_path, "a+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        except (OSError, AttributeError) as e:
            log_err(f"lock-skip path={lock_path} err={e!r}")
    except Exception as e:
        log_err(f"lock-open-fail path={lock_path} err={e!r}")
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass
            fh = None
    try:
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
    """Return up to `cap` most-recent parseable JSONL events from the transcript.

    TWIN: context-keeper/tools/extract.py:iter_events shares the same
    malformed-line guard — keep both in sync. (This copy byte-tails + caps for a
    hot per-prompt path; the twin streams the whole file for a cold PreCompact.)"""
    if not path:
        return []
    p = Path(path)
    if not p.is_file():
        return []
    # Byte-tail read (codex round-3): readlines() loaded the WHOLE transcript
    # on every hook fire — O(file) memory on a hot path. Seek to the last
    # TAIL_BYTES instead; transcripts only grow, the cap only needs the tail.
    TAIL_BYTES = 8_000_000
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            if size > TAIL_BYTES:
                f.seek(size - TAIL_BYTES)
                f.readline()  # drop the partial line at the seek point
            raw = f.read().decode("utf-8", errors="replace")
    except OSError as e:
        log_err(f"transcript-read-fail path={path} err={e!r}")
        return []
    events: list[dict] = []
    for line in raw.splitlines()[-cap:]:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Parseable-but-malformed guard (codex round-3): a line like `123` or
        # {"message": "bad"} crashed detectors via .get() on non-dicts —
        # violating the always-exit-0 contract. Normalize here, once.
        if not isinstance(obj, dict):
            continue
        if "message" in obj and not isinstance(obj["message"], dict):
            obj["message"] = {}
        events.append(obj)
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


def _tool_result_text(content) -> str:
    """tool_result content is a string OR a list of blocks ({type:text,...});
    stringifying the list literal makes regexes brittle (codex review
    2026-06-12) — join the text fields instead."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                parts.append(str(c.get("text") or c.get("content") or ""))
            else:
                parts.append(str(c))
        return " ".join(p for p in parts if p)
    return str(content or "")


def recent_tool_errors(events: list[dict], n: int = 30) -> list[str]:
    """Return up to n most-recent is_error tool_result texts, oldest-first.
    Tool errors live in user-type events (content blocks {type: tool_result,
    is_error: true}) — invisible to the assistant-message detectors above."""
    out: list[str] = []
    for e in reversed(events):
        if e.get("type") != "user":
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for b in content[::-1]:
            if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                out.append(_tool_result_text(b.get("content"))[:400])
                if len(out) >= n:
                    break
        if len(out) >= n:
            break
    out.reverse()
    return out


# -------------------------- detectors --------------------------------------

def detect_forbidden_regex(probe: dict, messages: list[dict], _tool_uses, _tool_errors=None, user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
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


def detect_word_count_per_message(probe: dict, messages: list[dict], _tool_uses, _tool_errors=None, user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
    if not messages:
        return None
    threshold = float(probe.get("threshold", 80))
    # Clamp window to [1, len(messages)]: window=0 would make messages[-0:] the
    # WHOLE list (a silent off-by-everything), and a negative window is nonsense.
    window = max(1, min(int(probe.get("window", MSG_WINDOW_DEFAULT)), len(messages)))
    recent = messages[-window:]
    counts = [len(m["text"].split()) for m in recent]
    avg = sum(counts) / len(counts)
    if avg > threshold:
        # Request-warranted length: this warning governs the NEXT reply
        # ("tighten next reply"), so suppress it when the imminent prompt
        # explicitly asks for detail/depth/enumeration. caveman-ultra's own spec
        # is "keep replies short UNLESS detail is requested" — without this the
        # probe nags against a reply the skill itself permits (an explicit
        # "explain"/"summarize"/"think of N ways" turn). Opt-in per probe via
        # `warrant_pattern`; absent → always fires (prior behavior).
        warrant = probe.get("warrant_pattern")
        if warrant and user_prompt:
            try:
                if re.search(warrant, user_prompt):
                    return None
            except re.error as e:
                log_err(f"bad-warrant-regex probe={probe.get('_probe_id')} err={e!r}")
        return {
            "avg_words": round(avg, 1),
            "threshold": threshold,
            "window": window,
            "counts": counts,
        }
    return None


def detect_claim_without_evidence(probe: dict, messages: list[dict], tool_uses: list[dict], _tool_errors=None, user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
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
    # Word-boundary match, not plain substring: short keywords (ls, cat, wc, rg)
    # otherwise match inside unrelated words (results, category, rebuild), so an
    # incidental Bash command falsely counts as verification and the done-claim
    # warning is wrongly suppressed.
    verify_re = None
    if verify_keywords:
        verify_re = re.compile(r"\b(" + "|".join(re.escape(k) for k in verify_keywords) + r")\b")
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
        if verify_re is not None and verify_re.search(haystack):
            return None  # evidence found
    return {
        "claim": claim_match.group(0),
        "snippet": last_text[max(0, claim_match.start() - 20): claim_match.end() + 40].replace("\n", " "),
        "lookback": lookback,
    }


def detect_repeated_tool_error(probe: dict, _messages, _tool_uses, tool_errors=None, user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
    """Fire when the same tool-error signature recurs in the recent window.
    Transcript mining (2026-06-12) found one signature — 'File has not been
    read yet' — accounted for 15 of 18 tool errors across 5 sessions; the
    native harness error corrects each instance but nothing breaks the habit
    within a session. Generic: any drift_probes.json can declare a pattern."""
    if not tool_errors:
        return None
    pat_str = probe.get("pattern")
    if not pat_str:
        return None
    try:
        pat = re.compile(pat_str)
    except re.error as e:
        log_err(f"bad-regex probe={probe.get('_probe_id')} err={e!r}")
        return None
    min_count = int(probe.get("min_count", 2))
    hits = [t for t in tool_errors if pat.search(t)]
    if len(hits) >= min_count:
        return {
            "count": len(hits),
            "min_count": min_count,
            "example": hits[-1][:120].replace("\n", " "),
        }
    return None


def trajectory_stats(events: list[dict]) -> dict:
    """Tool-call vs tool-error counts over the SAME transcript tail, so a
    rate is well-defined (recent_tool_uses/errors use different caps).
    Adopted from HTC-style trajectory calibration (arXiv 2601.15778) in the
    cheapest form that pays: process-level error rate, no model, no training."""
    calls = errs = 0
    for e in events:
        msg = e.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if e.get("type") == "assistant" and b.get("type") == "tool_use":
                calls += 1
            elif e.get("type") == "user" and b.get("type") == "tool_result" and b.get("is_error"):
                errs += 1
    return {"tool_calls": calls, "tool_errors": errs}


def detect_trajectory_drift(probe: dict, _messages, _tool_uses, _tool_errors=None,
                            user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
    """Fire when the session's tool-error RATE crosses a threshold — catches
    error-loop drift that per-signature probes (repeated_tool_error) miss
    when each retry fails differently. min_tool_calls guards cold starts."""
    if not traj_stats:
        return None
    calls = traj_stats.get("tool_calls", 0)
    errs = traj_stats.get("tool_errors", 0)
    min_calls = int(probe.get("min_tool_calls", 8))
    max_rate = float(probe.get("max_error_rate", 0.25))
    if calls < min_calls:
        return None
    rate = errs / calls
    if rate >= max_rate:
        return {"tool_calls": calls, "tool_errors": errs,
                "rate": round(rate, 3), "threshold": max_rate}
    return None


DETECTORS = {
    "forbidden_regex": detect_forbidden_regex,
    "word_count_per_message": detect_word_count_per_message,
    "claim_without_evidence": detect_claim_without_evidence,
    "repeated_tool_error": detect_repeated_tool_error,
    "trajectory_drift": detect_trajectory_drift,
}


def detect_user_correction(probe: dict, _messages, _tool_uses, _tool_errors=None,
                           user_prompt: str = "", traj_stats: dict | None = None) -> dict | None:
    """Fire when the user's CURRENT prompt is a correction ("no, use X",
    "that's wrong", "I said ..."). Closes the correction-capture gap
    (lineage: BayramAnnakov/claude-reflect, flagged in INSPIRATION.md):
    corrections are the highest-value learning source (exp1: feedback lift
    +0.667, the largest of the three) but the harvest reflex is prose-only —
    this makes the trigger mechanical, at the exact turn the correction lands."""
    if not user_prompt:
        return None
    pat_str = probe.get("pattern")
    if not pat_str:
        return None
    try:
        pat = re.compile(pat_str)
    except re.error as e:
        log_err(f"bad-regex probe={probe.get('_probe_id')} err={e!r}")
        return None
    m = pat.search(user_prompt)
    if m:
        return {"matched": m.group(0),
                "snippet": user_prompt[max(0, m.start() - 10): m.end() + 50].replace("\n", " ")}
    return None


DETECTORS["user_correction"] = detect_user_correction


def run_probes(
    probes: list[dict],
    messages: list[dict],
    tool_uses: list[dict],
    suppressed: set[str],
    tool_errors: list[str] | None = None,
    user_prompt: str = "",
    traj_stats: dict | None = None,
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
            result = DETECTORS[kind](probe, messages, tool_uses, tool_errors, user_prompt=user_prompt, traj_stats=traj_stats)
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

    # Fetch enough messages for the LARGEST declared word_count window — and
    # never early-return on empty: tool_use-only turns (the norm during error
    # loops) have no assistant TEXT, but that's exactly when the non-text
    # detectors (trajectory_drift, repeated_tool_error, user_correction) must
    # still run. The text detectors already no-op on []. (probes are discovered
    # above, so reading their windows here is safe.)
    WORD_COUNT_WINDOW_CAP = 50
    max_window = max(
        [MSG_WINDOW_DEFAULT]
        + [
            min(int(p.get("window", MSG_WINDOW_DEFAULT)), WORD_COUNT_WINDOW_CAP)
            for p in probes
            if p.get("kind") == "word_count_per_message"
            and str(p.get("window", MSG_WINDOW_DEFAULT)).lstrip("-").isdigit()
        ]
    )
    messages = recent_assistant_messages(events, max_window) or []
    tool_uses = recent_tool_uses(events, n=10)
    tool_errors = recent_tool_errors(events)

    # Build suppression set from probe_history
    history = state.get("probe_history", [])
    suppressed = {
        h["probe_id"] for h in history
        if isinstance(h, dict)
        and turn - int(h.get("fired_at_turn", 0)) < cooldown
    }

    fired = run_probes(probes, messages, tool_uses, suppressed, tool_errors,
                       user_prompt=str(payload.get("prompt") or ""),
                       traj_stats=trajectory_stats(events))
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
