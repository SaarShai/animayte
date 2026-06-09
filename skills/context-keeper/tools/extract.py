#!/usr/bin/env python3
"""context-keeper: extract structured state from Claude Code transcript before compaction.

Reads transcript JSONL, emits markdown memory page. Regex pass plus local LLM pass.

Schema (stable — pre-registered):
  - files_touched    paths appearing in tool_use blocks (Read/Write/Edit/Bash)
  - files_created    from Write tool
  - commands_run     from Bash tool
  - errors_seen      exact stderr/exception strings
  - numbers          measured/claimed numeric facts
  - urls             external references
  - user_goals       lines from user messages starting with imperative verbs
  - failed_attempts  blocks near "fail/error/bug/wrong/doesn't work"
  - pending_todos    unchecked items from TodoWrite (if present)

Usage:
  python3 extract.py <transcript.jsonl> [--out path.md] [--llm qwen3:8b]
"""
import argparse, json, os, re, sys, time, urllib.request
from collections import defaultdict
from pathlib import Path

PATH_RE = re.compile(r"(?<![\w\-])(?:~|\.{0,2})/[\w\-./]+\.(?:py|js|ts|tsx|jsx|rs|md|txt|json|yaml|yml|toml|sh|go|rb|java|c|cpp|h|hpp|css|html|sql|mjs|cjs|ini|conf)")
URL_RE = re.compile(r"https?://[^\s)\]'\"]+")
NUM_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:%|ms|s|x|tokens?|tok|GB|MB|KB|B|bytes?|lines?|items?|calls?)\b", re.I)
ERROR_RE = re.compile(r"(?:Error|Exception|Traceback|fail(?:ed|ure)?|SIGKILL|exit code [1-9]|stderr)[^\n]{3,200}", re.I)
IMPERATIVE_RE = re.compile(r"^(?:build|make|create|fix|find|implement|add|run|test|check|set up|design|write|measure|eval|compare|explain|research|install|deploy)\b", re.I)


def iter_events(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try: yield json.loads(line)
            except: continue


def extract_text(content):
    """Content can be str, list of blocks, or dict. Return flattened text."""
    if isinstance(content, str): return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict):
                if "text" in b: parts.append(b["text"])
                elif b.get("type") == "tool_use":
                    parts.append(f"TOOL:{b.get('name','?')} INPUT:{json.dumps(b.get('input',{}))[:500]}")
                elif b.get("type") == "tool_result":
                    c = b.get("content", "")
                    if isinstance(c, list):
                        parts.extend([x.get("text","") for x in c if isinstance(x, dict)])
                    else:
                        parts.append(str(c)[:2000])
            else:
                parts.append(str(b))
        return "\n".join(parts)
    if isinstance(content, dict):
        return extract_text(content.get("content", ""))
    return str(content)


def regex_extract(events):
    """Fast regex pass over all text. Returns dict of {item: confidence_score}.

    Confidence heuristics:
      - files_created (from Write tool success): 0.95
      - commands_run (from Bash tool_use): 0.9
      - errors_seen (exact string in tool_result): 0.85
      - files_touched (regex path match): 0.7
      - user_goals (imperative match): 0.8
      - numbers (NUM_RE): 0.6
      - urls: 0.95
      - failed_attempts (fuzzy): 0.5
    """
    out = defaultdict(list)
    seen = defaultdict(set)
    confidence = defaultdict(dict)  # item_key -> {value: score}

    KEY_CONF = {
        "files_created": 0.95, "files_touched": 0.70, "commands_run": 0.90,
        "errors_seen": 0.85, "user_goals": 0.80, "numbers": 0.60,
        "urls": 0.95, "failed_attempts": 0.50,
    }

    def add(key, val, limit=50):
        if val in seen[key] or len(seen[key]) >= limit: return
        seen[key].add(val); out[key].append(val)
        confidence[key][val] = KEY_CONF.get(key, 0.5)

    user_goals = []
    last_user_idx = -1

    for i, ev in enumerate(events):
        t = ev.get("type", "")
        # Claude Code format: content lives in ev["message"]["content"] (Anthropic API shape)
        msg = ev.get("message") or {}
        content = msg.get("content") if isinstance(msg, dict) else ev.get("content")
        text = extract_text(content if content is not None else ev.get("content", ""))

        if t == "user":
            last_user_idx = i
            # Claude Code stores tool_results with type="user" — skip those, they aren't user-typed input.
            is_tool_result = isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            )
            if not is_tool_result:
                for sent in re.split(r"[.!?\n]", text):
                    s = sent.strip()
                    if (
                        15 <= len(s) < 200
                        and len(s.split()) >= 4
                        and IMPERATIVE_RE.match(s)
                        and "/" not in s.split()[0]
                    ):
                        add("user_goals", s, limit=30)
                        break

        # File paths
        for m in PATH_RE.findall(text):
            if len(m) > 5 and len(m) < 200 and not m.startswith("//") and "." in m[-10:]:
                add("files_touched", m, limit=100)

        # URLs
        for u in URL_RE.findall(text):
            if len(u) < 300: add("urls", u)

        # Numbers
        for n in NUM_RE.findall(text):
            add("numbers", n.strip(), limit=80)

        # Errors (assistant or tool_result)
        if t in ("assistant", "user"):
            for e in ERROR_RE.findall(text):
                s = e.strip().rstrip(".")
                if len(s) > 10: add("errors_seen", s[:200], limit=30)

        # Bash commands: extract from tool_use blocks
        if "TOOL:Bash" in text:
            for m in re.finditer(r'TOOL:Bash INPUT:\{[^}]*"command"\s*:\s*"([^"]{5,300})"', text):
                cmd = m.group(1).replace('\\"', '"').replace('\\n', '; ')
                add("commands_run", cmd, limit=40)

        # Written files from Write tool
        if "TOOL:Write" in text:
            for m in re.finditer(r'TOOL:Write INPUT:\{[^}]*"file_path"\s*:\s*"([^"]+)"', text):
                add("files_created", m.group(1))

        # Failed attempts: sentences near failure words
        for m in re.finditer(r"[^.!?\n]{10,150}(?:didn't work|doesn't work|not work|broke|broken|bug|wrong|mismatch|incompat)[^.!?\n]{0,150}", text, re.I):
            add("failed_attempts", m.group(0).strip()[:200], limit=20)

    result = dict(out)
    result["_confidence"] = {k: dict(v) for k, v in confidence.items()}
    return result


def llm_extract(events, model="qwen3:8b"):
    """Local LLM pass: ask a model to extract decisions + failed-attempts with rationale."""
    # Take last ~50 turns of readable text (cap at ~8K tokens input)
    text_blobs = []
    for ev in events[-100:]:
        t = ev.get("type", "")
        if t in ("user", "assistant"):
            msg = ev.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else ev.get("content")
            txt = extract_text(content if content is not None else "")
            if txt: text_blobs.append(f"[{t}] {txt[:2000]}")
    blob = "\n\n".join(text_blobs)[-20000:]

    prompt = f"""Extract from this session transcript. Output ONLY JSON on one line with keys:
"decisions" (list of {{"what":..., "why":...}}),
"failed_attempts" (list of {{"tried":..., "why_failed":...}}),
"next_steps" (list of short strings).
Keep each field under 200 chars. Max 8 items per list.

TRANSCRIPT:
{blob}

JSON:"""

    data = json.dumps({
        "model": model, "prompt": prompt, "stream": False,
        "think": False,
        "options": {"num_predict": 1500, "temperature": 0.0},
    }).encode()
    req = urllib.request.Request("http://127.0.0.1:11434/api/generate",
                                  data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read())
        raw = out.get("response", "")
        start = raw.find("{"); end = raw.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(raw[start:end])
    except Exception as e:
        return {"_error": str(e)}
    return {}


def render_markdown(regex_out, llm_out, session_id, transcript_path):
    lines = [
        "---",
        "type: session-memory",
        f"session_id: {session_id}",
        f"transcript: {transcript_path}",
        f"saved: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        "tags: [session, pre-compact]",
        "---",
        "",
        f"# Session memory — {session_id[:8]}",
        "",
    ]

    conf_map = regex_out.get("_confidence", {})

    def section(title, items, fmt=lambda x, c: f"- {x}" + (f"  `{c:.2f}`" if c < 0.9 else ""),
                 section_key=None):
        if not items: return
        lines.append(f"## {title}")
        kc = conf_map.get(section_key or "", {}) if section_key else {}
        for it in items:
            c = kc.get(it, 1.0)
            lines.append(fmt(it, c))
        lines.append("")

    section("User goals", regex_out.get("user_goals", []), section_key="user_goals")

    if llm_out and not llm_out.get("_error"):
        dec = llm_out.get("decisions", [])
        if dec:
            lines.append("## Decisions")
            for d in dec:
                lines.append(f"- **{d.get('what','?')}** — {d.get('why','')}")
            lines.append("")
        fa = llm_out.get("failed_attempts", [])
        if fa:
            lines.append("## Failed attempts (avoid repeating)")
            for f in fa:
                lines.append(f"- tried **{f.get('tried','?')}** — failed: {f.get('why_failed','')}")
            lines.append("")
        ns = llm_out.get("next_steps", [])
        if ns:
            lines.append("## Next steps")
            for n in ns: lines.append(f"- {n}")
            lines.append("")

    section("Files created", regex_out.get("files_created", []), section_key="files_created")
    section("Files touched", regex_out.get("files_touched", [])[:40], section_key="files_touched")
    section("Commands run", regex_out.get("commands_run", []),
            fmt=lambda x, c: f"- `{x}`" + (f"  `{c:.2f}`" if c < 0.9 else ""),
            section_key="commands_run")
    section("Errors seen", regex_out.get("errors_seen", []), section_key="errors_seen")
    section("Key numbers", regex_out.get("numbers", []), section_key="numbers")
    section("URLs", regex_out.get("urls", []), section_key="urls")
    if regex_out.get("failed_attempts") and not (llm_out and llm_out.get("failed_attempts")):
        section("Failure signals (regex)", regex_out.get("failed_attempts", []))

    return "\n".join(lines)


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _parse_frontmatter(text):
    """Minimal `key: value` frontmatter parser (zero deps, matches the rest of
    the catalog's simple-scalar style)."""
    m = _FM_RE.match(text)
    if not m:
        return {}
    out = {}
    for raw in m.group(1).splitlines():
        s = raw.strip()
        if not s or s.startswith("#") or ":" not in raw:
            continue
        k, _, v = raw.partition(":")
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        out[k] = v
    return out


def skills_dir():
    """Locate the project's skills dir. Prefer CLAUDE_PROJECT_DIR /
    TOKEN_ECONOMY_ROOT, fall back to cwd; check the installed `.claude/skills`
    symlink dir first, then the canonical `skills/`."""
    bases = [os.environ.get("CLAUDE_PROJECT_DIR"), os.environ.get("TOKEN_ECONOMY_ROOT"), str(Path.cwd())]
    for base in bases:
        if not base:
            continue
        for sub in (".claude/skills", "skills"):
            d = Path(base) / sub
            if d.is_dir():
                return d
    return None


def active_output_styles(root):
    """Skills whose frontmatter sets `output_style: true`. Returns [(name, rule)]
    where rule is the `pulse_reminder` (fallback: first sentence of description).
    These define the session's emitted-prose style; PreCompact would otherwise
    drop them, so we surface them in the compaction pointer to survive the
    summary. Generic over any output-style skill (e.g. caveman-ultra)."""
    if not root or not root.is_dir():
        return []
    out, seen = [], set()
    try:
        for entry in sorted(root.iterdir()):
            sm = entry / "SKILL.md"
            if not sm.is_file():
                continue
            try:
                fm = _parse_frontmatter(sm.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            if str(fm.get("output_style", "")).strip().lower() != "true":
                continue
            name = fm.get("name") or entry.name
            if name in seen:
                continue
            seen.add(name)
            rule = (fm.get("pulse_reminder") or fm.get("description", "").split(". ")[0]).strip()
            out.append((name, rule))
    except OSError:
        pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("transcript")
    ap.add_argument("--out", default=None)
    ap.add_argument("--llm", default=None, help="Ollama model for extraction (e.g. qwen3:8b)")
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--pointer-only", action="store_true", help="print terse pointer to stdout for hook use")
    args = ap.parse_args()

    events = list(iter_events(args.transcript))
    sid = args.session_id or Path(args.transcript).stem

    regex_out = regex_extract(events)
    llm_out = llm_extract(events, args.llm) if args.llm else {}

    md = render_markdown(regex_out, llm_out, sid, args.transcript)

    repo_root = Path(os.environ.get("TOKEN_ECONOMY_ROOT", Path.cwd()))
    out_path = Path(args.out) if args.out else repo_root / ".brainer" / "sessions" / f"{time.strftime('%Y-%m-%d-%H%M', time.gmtime())}-{sid[:8]}.md"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(md, encoding="utf-8")

    # Terse pointer for PreCompact hook: gets injected into compaction context
    n_files = len(regex_out.get("files_touched", []))
    n_cmds = len(regex_out.get("commands_run", []))
    n_errs = len(regex_out.get("errors_seen", []))
    goals = regex_out.get("user_goals", [])[:3]
    # Active output styles (e.g. caveman-ultra) define emitted-prose rules that
    # PreCompact would otherwise drop — surface them FIRST and verbatim so the
    # summarizer carries them into post-compaction context.
    styles = active_output_styles(skills_dir())
    style_block = ""
    if styles:
        sl = ["[context-keeper] ACTIVE OUTPUT STYLE — keep applying verbatim to every reply after compaction:"]
        for name, rule in styles:
            sl.append(f"  • {name}: {rule}")
        style_block = "\n".join(sl) + "\n"

    pointer = (
        style_block
        + f"[context-keeper] structured memory saved → {out_path}\n"
        f"  {n_files} files touched, {n_cmds} commands run, {n_errs} errors logged\n"
        + (f"  goals: {'; '.join(goals)}\n" if goals else "")
        + f"  READ this file post-compact if prior context needed."
    )
    print(pointer)
    if not args.pointer_only:
        print(f"\n--- full memory ({len(md)} chars) ---\n{md}", file=sys.stderr)


if __name__ == "__main__":
    main()
