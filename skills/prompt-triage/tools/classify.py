#!/usr/bin/env python3
"""Fast task classifier for agents-triage hook.

Two-tier classifier:
  1. Regex fast-path (<5ms): pattern-match common simple tasks.
  2. Ollama fallback (<1500ms): local qwen3:8b one-shot classifier on uncertain.

Output (stdout, JSON one-line):
  {"tier": "simple|medium|hard|unknown",
   "agent": "wiki-note|quick-fix|research-lite|local-ollama|triage|none",
   "model": "haiku|sonnet|opus|local:<model>",
   "confidence": 0.0-1.0,
   "reason": "<short>",
   "lean_context": ["paths or globs to load"]}

Called by UserPromptSubmit hook; stdout is injected into CC context.
"""
from __future__ import annotations
import json, os, re, sys, urllib.request


def _extract_json_obj(text: str) -> dict | None:
    """Robust JSON-object extraction from possibly-noisy LLM output.

    M5 fix: the previous slice `text[text.find("{"): text.rfind("}")+1]` was
    fooled by stray braces in explanations like `the result is {tier:simple}` —
    the slice grabbed prose around the JSON. Now:
      1. Try a strict parse of the whole response first (fast path).
      2. Otherwise scan for the OUTERMOST balanced `{...}` block by tracking
         brace depth, ignoring braces inside double-quoted strings.
    Returns the parsed dict or None.
    """
    if not text:
        return None
    text = text.strip()
    # Fast path: whole response is JSON
    if text.startswith("{") and text.endswith("}"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    # Slow path: scan for outermost balanced object
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start >= 0:
                candidate = text[start:i + 1]
                try:
                    obj = json.loads(candidate)
                    if isinstance(obj, dict):
                        return obj
                except Exception:
                    start = -1  # keep scanning for a later balanced block
    return None

# Regex fast-path rules. Order matters — first match wins.
# Each rule: (pattern, tier, agent, model, confidence, reason, context_globs)
RULES = [
    # Wiki admin: add/append/note to wiki — IMPERATIVE form at start of prompt only.
    # The previous looser regex matched "write me a comprehensive markdown audit",
    # routing serious work to haiku. Now requires imperative-at-start AND a short prompt
    # (real wiki notes are short — "add a note to wiki that X").
    (r"^\s*(?:add|append|note|log|record)\b.{0,60}\b(?:wiki|markdown|kb|knowledge base)\b",
     "simple", "wiki-note", "haiku", 0.75, "imperative wiki add/edit pattern",
     ["**/*.md", "index.md"]),
    # One-line fix / quick edit / typo
    (r"\b(?:fix|correct|patch)\b\s+(?:this|the)?\s*(?:typo|import|syntax|linter?|one(?:-|\s)liner?)\b",
     "simple", "quick-fix", "haiku", 0.85, "one-liner fix",
     []),
    # Short factual question (no filesystem)
    (r"^\s*(?:what is|who is|when (?:was|is|did)|where (?:is|was)|define|meaning of)\b",
     "simple", "research-lite", "haiku", 0.85, "factual lookup", []),
    # Summarize this file / path / log / etc.
    # M2 fix: was `local:gemma4:26b` — gemma4 is not a published Ollama tag and
    # `ollama show gemma4:26b` returns "model not found" on our setup. qwen3:8b
    # is the project's default small local model (used by `local-ollama` rule
    # below) and handles summarization fine. If a future op wants gemma3, they
    # should explicitly pin a real published tag (e.g., `gemma3:27b`).
    (r"\b(?:summari[sz]e|tldr|abstract|condense|rewrite)\b",
     "simple", "local-ollama", "local:qwen3:8b", 0.8, "summarization -- local model fine",
     []),
    # Research: find repos, survey literature
    (r"\b(?:research|survey|find repos?|investigate|literature)\b",
     "medium", "research-lite", "sonnet", 0.8, "research-lite task", []),
    # Install / setup / configure
    (r"\b(?:install|setup|configure|add\s+hook|register\s+mcp)\b",
     "simple", "quick-fix", "haiku", 0.75, "setup task", []),
    # Complex signals — multi-file refactor, architecture, design
    (r"\b(?:refactor|architect|design|redesign|implement.{0,20}system|multi[-\s]?file|across)\b",
     "hard", "none", "opus", 0.9, "complex task -- opus appropriate", []),
    # Commit/push — mechanical
    (r"^\s*(?:commit|push|git (?:add|commit|push|stash))\b",
     "simple", "quick-fix", "haiku", 0.9, "git mechanical", []),
    # Explicit local/free/cheap hint
    (r"\b(?:cheap|local|free|no api|ollama)\b",
     "simple", "local-ollama", "local:qwen3:8b", 0.8, "explicit local hint", []),
    # Long-context local hint (no dedicated subagent yet; fall through to opus,
    # which the user can manually route to a local long-context model if needed).
    # Previous rule emitted agent="turboquant-local" but no such agent ships;
    # the dispatch failed silently. Treat as 'hard' so triage stays out of the way.
    (r"\b(?:long[-\s]?context|turboquant|kv[-\s]?cache|35b|70b|128k)\b",
     "hard", "none", "opus", 0.6,
     "long-ctx hint -- no local agent available, defer to main model",
     []),
]


def regex_classify(prompt: str) -> dict | None:
    for pat, tier, agent, model, conf, reason, ctx in RULES:
        if re.search(pat, prompt, re.IGNORECASE):
            return {
                "tier": tier, "agent": agent, "model": model,
                "confidence": conf, "reason": reason,
                "lean_context": ctx,
            }
    return None


# Anti-pattern phrases that should never route to haiku via the fast regex path —
# regardless of which rule matched, if any of these appear, force LLM classification.
# These signal "complex / long / careful work" — exactly what cheap models botch.
COMPLEX_HINTS = re.compile(
    r"\b(?:comprehensive|deep|in[-\s]?depth|thorough|architect|design|"
    r"refactor|audit|analyze|investigate|debug|trace|root[-\s]?cause|"
    r"review|critique|production|critical|migrate|"
    r"multi[-\s]?file|across|system|integration)\b",
    re.I,
)


def _looks_complex(prompt: str) -> bool:
    """Heuristic guard: long prompts or prompts containing complex-work phrases
    should never be regex-routed to the cheapest tier."""
    if len(prompt) > 800:
        return True
    if COMPLEX_HINTS.search(prompt):
        return True
    return False


def _smart_truncate(prompt: str, budget: int = 2000) -> str:
    """Head + tail truncation. Long stack-trace dumps end with an imperative
    ("fix this"); naive head-only truncation drops the actual task. Take the
    first 60% from the head and the last 40% from the tail."""
    if len(prompt) <= budget:
        return prompt
    head_len = int(budget * 0.6)
    tail_len = budget - head_len - len("\n...[truncated]...\n")
    return prompt[:head_len] + "\n...[truncated]...\n" + prompt[-tail_len:]


OLLAMA_URL = "http://127.0.0.1:11434/api/generate"

LLM_PROMPT = """Classify this user task for an LLM agent. Output ONLY one-line JSON:
{"tier":"simple|medium|hard","agent":"wiki-note|quick-fix|research-lite|local-ollama|none","model":"haiku|sonnet|opus|local:qwen3:8b","confidence":0-1,"reason":"<15 words"}

Rules:
- simple = single file edit, add note, one-line fix, factual question, summarize
- medium = multi-step but bounded (research a topic, refactor one file, write one script)
- hard = multi-file, architecture, design, novel reasoning
- agent="none" means fall through to main model (opus)
- Prefer lowest capable tier. Haiku ~$0.25/M-tok input; sonnet ~$3; opus ~$15.
- If task mentions "simple", "quick", "tiny" — bias simple.
- If task starts with imperative verb (add/fix/summarize/commit) — usually simple.

TASK: {task}
JSON:"""


def ollama_classify(prompt: str, model: str = "qwen3:8b", timeout: int = 2) -> dict | None:
    # Head + tail (was: head only at 800) — long stack-trace prompts ended
    # with the actual imperative; we used to drop it. 2000 chars ≈ 500 tokens.
    full = LLM_PROMPT.replace("{task}", _smart_truncate(prompt, 2000))
    if "qwen3" in model:
        full += " /no_think"
    data = json.dumps({
        "model": model, "prompt": full, "stream": False, "think": False,
        "options": {"num_predict": 80, "temperature": 0.0, "seed": 42},
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=data,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read()).get("response", "")
    except Exception:
        return None
    obj = _extract_json_obj(resp)
    if obj is None:
        return None
    obj.setdefault("lean_context", [])
    return obj


def classify(prompt: str, use_ollama_fallback: bool = True) -> dict:
    fast = regex_classify(prompt)
    # If the prompt contains complex-work hints (audit / refactor / architect /
    # comprehensive / etc), force LLM classification regardless of regex hit.
    # Cheap regex routing on complex prompts was sending high-stakes work to haiku.
    if fast and _looks_complex(prompt):
        fast["confidence"] = min(fast["confidence"], 0.6)
        fast["reason"] = f"{fast['reason']} (downgraded: complex-work hints)"
    if fast and fast["confidence"] >= 0.8:
        fast["source"] = "regex"
        return fast
    if use_ollama_fallback:
        llm = ollama_classify(prompt)
        if llm:
            llm["source"] = "ollama"
            llm.setdefault("lean_context", [])
            return llm
    if fast:
        fast["source"] = "regex-low-conf"
        return fast
    # Default: unknown → let opus handle
    return {"tier": "unknown", "agent": "none", "model": "opus",
            "confidence": 0.0, "reason": "no classifier signal",
            "lean_context": [], "source": "default"}


# Bypass-flag detector. L3 fix: previously `/opus` matched anywhere, including
# command paths like `git log /opus/file.md`. Now we anchor:
#   - "NO TRIAGE" / "NO-TRIAGE" / "NO_TRIAGE" can appear anywhere (it's distinctive enough)
#   - `/opus` must be at the start of the prompt (after optional whitespace) OR
#     be a slash-command-style token sitting on its own (word-boundary on both
#     sides — `/opus` followed by whitespace/EOL, not a path segment).
_NO_TRIAGE_RE = re.compile(r"\bNO[ _-]?TRIAGE\b", re.I)
_SLASH_OPUS_RE = re.compile(r"(?:^|\s)/opus(?=\s|$)")


def is_bypass(prompt: str) -> bool:
    if not prompt:
        return False
    if _NO_TRIAGE_RE.search(prompt):
        return True
    if _SLASH_OPUS_RE.search(prompt):
        return True
    return False


def _read_prompt_from_stdin() -> str:
    """Parse the CC UserPromptSubmit hook stdin payload. Tolerant of empty /
    malformed input — the hook must not crash on a weird payload."""
    raw = sys.stdin.read()
    if not raw:
        return ""
    try:
        d = json.loads(raw)
    except Exception:
        return ""
    if not isinstance(d, dict):
        return ""
    return d.get("prompt") or d.get("user_prompt") or ""


def emit_context(prompt: str, use_ollama_fallback: bool = True) -> str:
    """H1 fix: produce the exact directive block hook.sh used to assemble — but
    inside the same Python process that parsed stdin and ran the classifier.
    Eliminates 3 of the 4 python3 spawns per UserPromptSubmit.

    Returns the directive string (possibly empty — caller should print as-is
    without a trailing newline injection). Empty string means "emit nothing"
    which causes the hook to inject no context.
    """
    if not prompt or is_bypass(prompt):
        return ""
    result = classify(prompt, use_ollama_fallback=use_ollama_fallback)
    # If main-model required (tier=hard or agent=none), emit nothing — preserves
    # the prior hook.sh behavior of early-exiting on these classifications.
    if result.get("tier") == "hard" or result.get("agent") == "none":
        return ""
    cls_json = json.dumps(result)
    # Keep this block byte-for-byte compatible with the prior hook.sh heredoc
    # so downstream prompts / training data don't drift.
    return (
        "⚡ [agents-triage] Task classified:\n"
        f"{cls_json}\n"
        "\n"
        "**Strong recommendation:** dispatch this task via the `Task` tool "
        "using the suggested subagent + model, then return its result. Do NOT "
        "engage deep-thinking or load full context yourself. The subagent will "
        "load only what it needs.\n"
        "\n"
        "If classification seems wrong, user can re-send with \"NO TRIAGE\" to bypass."
    )


def main():
    no_ollama = os.environ.get("AGENTS_TRIAGE_NO_OLLAMA") == "1"
    # --emit-context mode is the one invoked by hook.sh: it reads the hook
    # stdin payload, runs the bypass check, classifies, and prints the final
    # context block (or nothing). One process, end-to-end.
    if len(sys.argv) > 1 and sys.argv[1] == "--emit-context":
        prompt = _read_prompt_from_stdin()
        block = emit_context(prompt, use_ollama_fallback=not no_ollama)
        if block:
            print(block)
        return
    # Legacy / direct CLI mode: emit raw classifier JSON.
    if len(sys.argv) > 1:
        prompt = " ".join(sys.argv[1:])
    else:
        # Direct stdin mode (used by tests / manual invocation): treat the
        # entire stdin as the prompt text, OR parse it as a JSON hook payload.
        raw = sys.stdin.read()
        try:
            data = json.loads(raw)
            prompt = data.get("prompt") or data.get("user_prompt") or ""
        except Exception:
            prompt = raw
    out = classify(prompt, use_ollama_fallback=not no_ollama)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
