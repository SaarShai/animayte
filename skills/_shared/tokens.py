from __future__ import annotations

from math import ceil


def estimate_tokens(text: str) -> int:
    """Cheap model-agnostic token estimate.

    Uses a conservative char/4 heuristic plus newline overhead. Good enough for
    threshold triggers where exact provider tokenization is unavailable.
    """
    if not text:
        return 0
    return max(1, ceil(len(text) / 4) + text.count("\n"))


def trim_to_tokens(text: str, limit: int) -> str:
    if estimate_tokens(text) <= limit:
        return text
    lines = text.splitlines()
    kept: list[str] = []
    for line in lines:
        candidate = "\n".join([*kept, line, "...[trimmed]..."])
        if estimate_tokens(candidate) > limit:
            break
        kept.append(line)
    return "\n".join([*kept, "...[trimmed]..."]) + "\n"

