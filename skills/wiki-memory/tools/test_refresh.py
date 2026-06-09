"""Tests for GRAFT 1 (overlap dedup-at-write) and GRAFT 2 (audit-refs
code-grounded staleness), the two mechanics ported from EveryInc
compound-engineering onto this wiki's substrate.

Run:
  python3 -m pytest skills/wiki-memory/tools/test_refresh.py -s -v
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from wiki import WikiStore, extract_refs, content_tokens, jaccard  # noqa: E402


def _v2(title: str, body: str = "", tags: list[str] | None = None, verified: str | None = None,
        ptype: str = "fact", links: list[str] | None = None, protected: bool = False) -> str:
    fm = [
        "schema_version: 2", f"title: {title}", f"type: {ptype}", "domain: project",
        "tier: semantic", "confidence: 0.8", "created: 2026-01-01", "updated: 2026-01-01",
        f"verified: {verified or '2026-01-01'}", "sources: [x]", "supersedes: []",
        "superseded-by:", "contradicts: []",
        "tags: [" + ", ".join(tags or []) + "]",
    ]
    if protected:
        fm.append("protected: true")
    link_str = " ".join(f"[[{l}]]" for l in (links or []))
    return "---\n" + "\n".join(fm) + "\n---\n\n# " + title + "\n\n" + body + "\n" + link_str + "\n"


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _seed(root: Path) -> WikiStore:
    store = WikiStore(root)
    store.init()
    _write(root / "L2_facts/auth-token-storage.md", _v2(
        "Auth token storage",
        "Session tokens persisted in `src/auth/token_store.py`. We chose Redis "
        "because the prior cookie approach leaked across tabs.",
        tags=["auth", "tokens", "redis"], links=["session-model"],
    ))
    _write(root / "L2_facts/session-model.md", _v2(
        "Session model",
        "The session lifecycle lives in `src/auth/session.py`.",
        tags=["auth", "session"], links=["auth-token-storage"],
    ))
    _write(root / "L2_facts/payments-webhook.md", _v2(
        "Payments webhook idempotency",
        "Stripe webhook handler in `src/payments/webhook.py` dedups by event id.",
        tags=["payments", "stripe"],
    ))
    store.index()
    return store


# ---- GRAFT 1: overlap -------------------------------------------------------

def test_overlap_high_on_near_duplicate(tmp_path):
    store = _seed(tmp_path / "wiki")
    res = store.overlap(
        title="Auth token storage in Redis",
        body="Session tokens are stored in `src/auth/token_store.py` using Redis "
             "because the cookie approach leaked across tabs.",
        tags=["auth", "tokens", "redis"],
    )
    assert res["overlap"] == "high", res
    assert res["recommended_action"] == "update-existing"
    assert res["best_match"]["id"] == "L2_facts/auth-token-storage"
    assert {"subject", "tags", "content", "refs"} <= set(res["best_match"]["matched"])


def test_overlap_low_on_unrelated(tmp_path):
    store = _seed(tmp_path / "wiki")
    res = store.overlap(
        title="GraphQL schema versioning policy",
        body="We version the GraphQL schema in `src/graphql/registry.ts` with a "
             "deprecation window.",
        tags=["graphql", "api"],
    )
    assert res["overlap"] == "low", res
    assert res["recommended_action"] == "create"


def test_overlap_moderate_same_area_different_angle(tmp_path):
    store = _seed(tmp_path / "wiki")
    res = store.overlap(
        title="Auth session expiry handling",
        body="Idle sessions expire after 30m; logic in a new module.",
        tags=["auth", "session"],
    )
    assert res["overlap"] in {"moderate", "low"}, res
    # shares the auth/session area but not refs/content depth → not a dup
    assert res["recommended_action"] != "update-existing"


def test_overlap_ignores_superseded(tmp_path):
    root = tmp_path / "wiki"
    store = _seed(root)
    # mark the canonical page superseded; it must not be offered as a match
    p = root / "L2_facts/auth-token-storage.md"
    p.write_text(p.read_text().replace("superseded-by:", "superseded-by: [[newer]]"), encoding="utf-8")
    store._invalidate_caches()
    store.index()
    res = store.overlap(
        title="Auth token storage in Redis",
        body="Tokens in `src/auth/token_store.py`.",
        tags=["auth", "tokens"],
    )
    ids = [c["id"] for c in res["candidates"]]
    assert "L2_facts/auth-token-storage" not in ids


# ---- GRAFT 2: audit-refs ----------------------------------------------------

def test_audit_refs_flags_missing_paths(tmp_path):
    code = tmp_path / "repo"
    (code / "src/auth").mkdir(parents=True)
    (code / "src/auth/session.py").write_text("# exists\n")
    # token_store.py and payments/webhook.py deliberately absent
    store = _seed(code / "wiki")
    res = store.audit_refs(code_root=code)
    drifted = {d["id"]: d for d in res["drifted"]}
    assert "L2_facts/auth-token-storage" in drifted
    assert "src/auth/token_store.py" in drifted["L2_facts/auth-token-storage"]["missing_refs"]
    # session-model's only ref exists → not drifted
    assert "L2_facts/session-model" not in drifted
    # payments page fully drifted
    assert drifted["L2_facts/payments-webhook"]["signal"] == "all-refs-gone"


def test_audit_refs_marks_protected(tmp_path):
    code = tmp_path / "repo"
    code.mkdir()
    root = code / "wiki"
    store = WikiStore(root)
    store.init()
    _write(root / "L3_sops/recover.md", _v2(
        "Recovery SOP", "Run `scripts/gone.sh` to recover.", ptype="sop", tags=["ops"]))
    store.index()
    res = store.audit_refs(code_root=code)
    drifted = {d["id"]: d for d in res["drifted"]}
    assert drifted["L3_sops/recover"]["protected"] is True


# ---- GRAFT 3: discoverability ----------------------------------------------

def test_discoverability_pass(tmp_path):
    code = tmp_path / "repo"
    (code / "wiki").mkdir(parents=True)
    store = WikiStore(code / "wiki")
    store.init()
    (code / "CLAUDE.md").write_text(
        "# Project\nSee `wiki/L1_index.md` and run `wiki.py search` to retrieve past decisions.\n")
    res = store.discoverability("CLAUDE.md")
    assert res["exists"] and res["pass"] is True
    assert res["suggested_snippet"] is None


def test_discoverability_fail_emits_snippet(tmp_path):
    code = tmp_path / "repo"
    (code / "wiki").mkdir(parents=True)
    store = WikiStore(code / "wiki")
    store.init()
    (code / "AGENTS.md").write_text("# Project\nRun the tests with pytest.\n")
    res = store.discoverability("AGENTS.md")
    assert res["exists"] and res["pass"] is False
    assert "wiki/" in res["suggested_snippet"]


def test_discoverability_skips_missing_file(tmp_path):
    store = WikiStore(tmp_path / "wiki")
    store.init()
    res = store.discoverability("NOPE.md")
    assert res["exists"] is False and res["pass"] is None


# ---- helpers ----------------------------------------------------------------

def test_extract_refs_skips_urls_and_prose():
    refs = extract_refs("see `src/a/b.py` and https://x.com/y/z.html and `just text` "
                        "plus bare path/to/file.ts, end.")
    assert "src/a/b.py" in refs
    assert "path/to/file.ts" in refs
    assert not any(r.startswith("http") for r in refs)
    assert "just text" not in refs


def test_jaccard_and_content_tokens():
    a = content_tokens("Redis token storage leaked across tabs")
    b = content_tokens("Redis token storage in cookies")
    assert jaccard(a, b) > 0
    assert jaccard(a, set()) == 0.0
