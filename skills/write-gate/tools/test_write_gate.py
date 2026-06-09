#!/usr/bin/env python3
"""Smoke tests for write_gate.py — runnable standalone with no pytest dep."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from write_gate import DEFAULT_THRESHOLD, decide, score_text  # noqa: E402


def assert_passes(text: str, kind: str = "fact", msg: str = "") -> None:
    s = score_text(text, kind)
    ok, verdict = decide(s, kind, DEFAULT_THRESHOLD, require_why=True)
    assert ok, f"expected pass: {msg}\n  text={text!r}\n  verdict={verdict}\n  score={s.total:.2f}"


def assert_rejects(text: str, kind: str = "fact", msg: str = "") -> None:
    s = score_text(text, kind)
    ok, verdict = decide(s, kind, DEFAULT_THRESHOLD, require_why=True)
    assert not ok, f"expected reject: {msg}\n  text={text!r}\n  verdict={verdict}\n  score={s.total:.2f}"


def test_decisions_need_why() -> None:
    # Decision without why-clause → reject even if score is high
    txt = "We chose pgvector over Qdrant. We rejected Pinecone. Decision: pgvector."
    assert_rejects(txt, "decision", "decision without why-clause")

    # Same decision with why-clause → pass
    txt2 = "We chose pgvector over Qdrant because dev parity matters, so that local == prod."
    assert_passes(txt2, "decision", "decision with why-clause")


def test_filler_recap_rejected() -> None:
    # Filler-only text scores below threshold
    txt = "Basically what we did was some things. In summary, stuff happened. To recap, we did it."
    assert_rejects(txt, "fact", "pure filler")


def test_error_lesson_passes() -> None:
    txt = (
        "Bug: deploy failed because PG_URL was unset in production env.\n"
        "Fix: added to vault and reloaded systemd unit.\n"
        "Root cause: env was set in .envrc which doesn't apply to systemd.\n"
    )
    assert_passes(txt, "error", "concrete failure with fix")


def test_architecture_with_code() -> None:
    txt = (
        "The ingestion service runs on Fly.io and calls the embedding worker at /embed.\n"
        "```python\nresult = embed(chunk)\n```\n"
        "Latency: 120ms p50, 450ms p99."
    )
    assert_passes(txt, "fact", "arch + code + numbers")


def test_speculation_drops_score() -> None:
    # Mild signal, but speculation drags it under
    txt = "Maybe we should probably use Redis. I think it could maybe work."
    assert_rejects(txt, "fact", "speculation-only")


def test_entity_cap() -> None:
    # Many repeated entities — cap should prevent overshoot from this alone
    txt = "Foo Foo Foo Bar Bar Bar Baz Baz Baz Qux Qux Qux Quux Quux Quux"
    s = score_text(txt, "fact")
    assert s.features.get("entity_overlap", 0) <= 1.5 + 1e-9, "entity_overlap not capped"


def test_why_clause_inside_fence_does_not_satisfy_gate() -> None:
    """REGRESSION: a `# because reasons` comment inside ``` ``` used to bypass
    the decision gate. Why-clause must come from prose, not code."""
    txt = (
        "We chose pgvector over Qdrant.\n"
        "```python\n# because reasons\nx = 1\n```\n"
    )
    s = score_text(txt, "decision")
    assert not s.has_why, "why-clause inside fence must not count"
    ok, _ = decide(s, "decision", DEFAULT_THRESHOLD, require_why=True)
    assert not ok, "reasonless decision must reject even with fenced 'because'"

    # Prose 'because' still works
    txt2 = "We chose pgvector over Qdrant because dev parity matters."
    s2 = score_text(txt2, "decision")
    assert s2.has_why
    ok2, _ = decide(s2, "decision", DEFAULT_THRESHOLD, require_why=True)
    assert ok2


def test_since_no_longer_satisfies_why_clause() -> None:
    """REGRESSION: 'since' is overwhelmingly temporal and was bypassing the gate."""
    # Temporal 'since' — should NOT be a why-clause
    txt = "We chose pgvector over Qdrant. Tracked since yesterday."
    s = score_text(txt, "decision")
    assert not s.has_why, "'since' alone should no longer count as a why-clause"


def test_entity_overlap_is_fast_on_large_input() -> None:
    """REGRESSION: list.count-per-element was O(n²); used to take seconds on 20k tokens."""
    import time
    txt = ("Foo Bar Baz " * 8000)  # 24000 tokens
    t0 = time.time()
    s = score_text(txt, "fact")
    elapsed = time.time() - t0
    assert elapsed < 1.0, f"score_text took {elapsed:.2f}s on 24k tokens (was O(n²))"
    assert s.features.get("entity_overlap", 0) <= 1.5 + 1e-9


def test_passes_with_concrete_signal() -> None:
    # Realistic durable fact: describes WHAT a system is (arch) AND gives numbers.
    # Metrics alone (without arch context) intentionally fall below threshold.
    txt = (
        "The pgvector index lives in PostgreSQL and is 320MB.\n"
        "Reads are 12ms p50 against the new schema. Migration ran in 14s.\n"
    )
    assert_passes(txt, "fact", "arch + numbers (representative durable fact)")


def test_metrics_only_below_threshold() -> None:
    # Metric-only logs ARE intentionally below threshold — they're log entries,
    # not durable facts. Capturing this as a positive assertion.
    txt = "Run took 14s. Index is 320MB. Reads are 12ms p50."
    assert_rejects(txt, "fact", "metric-only is not a durable fact")


def main() -> int:
    tests = [
        test_decisions_need_why,
        test_filler_recap_rejected,
        test_error_lesson_passes,
        test_architecture_with_code,
        test_speculation_drops_score,
        test_entity_cap,
        test_passes_with_concrete_signal,
        test_metrics_only_below_threshold,
        test_why_clause_inside_fence_does_not_satisfy_gate,
        test_since_no_longer_satisfies_why_clause,
        test_entity_overlap_is_fast_on_large_input,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  ok  {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {t.__name__}: {e}")
    if failed:
        print(f"\n{failed}/{len(tests)} failed")
        return 1
    print(f"\nall {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
