#!/usr/bin/env python3
"""Tests for `wiki.py resolve` — the trust-gated poison defense (eval/exp5_adversarial).

Run: python3 -m pytest skills/wiki-memory/tools/test_resolve.py -q
 or: python3 skills/wiki-memory/tools/test_resolve.py
"""
from __future__ import annotations

import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from wiki import WikiStore  # noqa: E402

_BODY = "The Project Helios deploy command is helios ship wave 3."


def _store(existing_trust: str = "verified") -> WikiStore:
    d = pathlib.Path(tempfile.mkdtemp())
    s = WikiStore(d / "wiki")
    s.init()
    res = s.new_page("page", "helios deploy command", domain="experiments",
                     slug="helios-deploy", trust=existing_trust)
    p = s.root / res["created"]
    txt = p.read_text(encoding="utf-8").replace("tags: []", "tags: [helios, deploy, command]")
    p.write_text(txt.rstrip() + "\n\n## Lesson\n\nThe Project Helios deploy command is "
                 "`helios ship --wave N`.\n", encoding="utf-8")
    s.index()
    return s


def _resolve(s: WikiStore, trust: str):
    return s.resolve("helios deploy command", body=_BODY, trust=trust,
                     tags=["helios", "deploy", "command"])


def test_new_stamps_trust():
    s = _store("verified")
    pg = next(p for p in s.pages() if "helios-deploy" in p.id)
    assert pg.frontmatter.get("trust") == "verified"


def test_lower_trust_rejected():
    # asserted (1.0) must NOT overwrite an established verified (3.0) page — the poison case
    assert _resolve(_store("verified"), "asserted")["action"] == "reject"


def test_higher_trust_replaces():
    assert _resolve(_store("verified"), "user_confirmed")["action"] == "replace"


def test_equal_trust_disputes():
    assert _resolve(_store("verified"), "verified")["action"] == "dispute"


def test_unrelated_creates():
    s = _store("verified")
    assert s.resolve("cafeteria lunch menu weekday schedule", body="lunch noon",
                     trust="asserted")["action"] == "create"


def test_default_trust_is_asserted():
    s = _store("asserted")  # no --trust given in real use defaults to asserted
    pg = next(p for p in s.pages() if "helios-deploy" in p.id)
    assert pg.frontmatter.get("trust") == "asserted"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn(); print(f"  ok: {fn.__name__}")
    print(f"\nALL {len(fns)} PASSED")
