"""Tests for the lint hygiene additions: stale-with-age, hub gravity-well,
broader scope via extra_roots.

Run:
  /Users/za/Documents/Master\ Screenery\ 3.5/.venv/bin/python -m pytest \
    .brainer/skills/wiki-memory/tools/test_lint_hygiene.py -s -v
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from wiki import WikiStore  # noqa: E402


def _page(title: str, verified: str | None = None, links: list[str] | None = None, body: str = "") -> str:
    fm = [f"title: {title}"]
    if verified:
        fm.append(f"verified: {verified}")
    fm_str = "---\n" + "\n".join(fm) + "\n---\n"
    link_str = ", ".join(f"[[{l}]]" for l in (links or []))
    return f"{fm_str}\n# {title}\n\n{body}\n{link_str}\n"


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _seed_wiki(root: Path) -> None:
    fresh = date.today().isoformat()
    long_stale = (date.today() - timedelta(days=400)).isoformat()
    # Minimal scaffold the lint touches.
    _write(root / "index.md", "# Wiki Index\n")
    _write(root / "log.md", "# Wiki Log\n")
    _write(root / "schema.md", "# Schema\n")
    _write(root / "L0_rules.md", "# L0\n")
    _write(root / "L1_index.md", "# L1\n")
    # Material pages.
    _write(root / "L2_facts/a.md", _page("A", verified=fresh, links=["b", "c", "stale", "nonexistent1", "nonexistent2", "nonexistent3"]))
    _write(root / "L2_facts/b.md", _page("B", verified=fresh, links=["a"]))
    _write(root / "L2_facts/c.md", _page("C", verified=fresh, links=["a"]))
    _write(root / "L2_facts/stale.md", _page("Stale Fact", verified=long_stale, links=["a"]))
    _write(root / "L2_facts/d.md", _page("Duplicate", verified=fresh))
    _write(root / "L2_facts/e.md", _page("Duplicate", verified=fresh))
    # Hub + 21 ring leaves to push hub past --hub-threshold 20.
    _write(root / "concepts/hub.md", _page("Hub", verified=fresh))
    n_ring = 21
    for i in range(1, n_ring + 1):
        nxt = (i % n_ring) + 1
        _write(root / f"concepts/ring_{i:02d}.md", _page(
            f"Ring {i}", verified=fresh, links=["hub", f"ring_{nxt:02d}"]
        ))


def test_lint_finds_stale_duplicate_hub(tmp_path):
    _seed_wiki(tmp_path)
    store = WikiStore(tmp_path)
    result = store.lint_pages(stale_days=90, hub_threshold=20)

    print("\nLINT SUMMARY:", {k: (len(v) if isinstance(v, list) else v) for k, v in result.items()})

    # Dead links: 3 (nonexistent1/2/3 from a.md)
    broken_targets = sorted(b["to"] for b in result["broken_links"])
    assert broken_targets == ["nonexistent1", "nonexistent2", "nonexistent3"], result["broken_links"]

    # Orphans: d and e (no inbound). They're under L2_facts, not in support_dirs.
    orphan_names = {Path(o).name for o in result["orphans"]}
    assert {"d", "e"} <= orphan_names, result["orphans"]

    # Stale: exactly 1 (stale.md, ~400 days).
    assert len(result["stale_verified"]) == 1, result["stale_verified"]
    s = result["stale_verified"][0]
    assert s["page"].endswith("stale"), s
    assert s["age_days"] >= 400, s

    # Duplicate titles: "Duplicate" group across d.md/e.md.
    titles = [d["title"] for d in result["duplicate_titles"]]
    assert "Duplicate" in titles, result["duplicate_titles"]

    # Hubs: hub.md with 21 inbound.
    hub_pages = [(h["page"], h["inbound"]) for h in result["hubs"]]
    assert any(p.endswith("hub") and c == 21 for p, c in hub_pages), result["hubs"]


def test_lint_extra_roots_picks_up_outside_tree(tmp_path):
    wiki = tmp_path / "wiki"
    outside = tmp_path / "concepts"
    _write(wiki / "index.md", "# Index\n")
    _write(wiki / "log.md", "# Log\n")
    _write(wiki / "schema.md", "# Schema\n")
    _write(wiki / "L0_rules.md", "# L0\n")
    _write(wiki / "L1_index.md", "# L1\n")
    _write(wiki / "L2_facts/k.md", _page("K", verified=date.today().isoformat(), links=["concepts/orphan-out"]))
    # 'concepts/' lives outside the wiki, but we scan it via extra_roots.
    _write(outside / "orphan-out.md", _page("OrphanOut", verified=date.today().isoformat()))

    store = WikiStore(wiki)
    # Without extra_roots, k.md's link to concepts/orphan-out is dead.
    r1 = store.lint_pages()
    assert any("orphan-out" in b["to"] for b in r1["broken_links"]), r1["broken_links"]
    # With extra_roots, link resolves and orphan-out shows up as a real page.
    r2 = store.lint_pages(extra_roots=[outside])
    print("\nWITH EXTRA ROOTS:", {k: (len(v) if isinstance(v, list) else v) for k, v in r2.items()})
    assert not any("orphan-out" in b["to"] for b in r2["broken_links"]), r2["broken_links"]


def _v2_page(title: str, slug: str, verified: str, contradicts: list[str] | None = None, links: list[str] | None = None) -> str:
    contradicts_yaml = "[" + ", ".join(f"[[{c}]]" for c in (contradicts or [])) + "]"
    fm = (
        "---\n"
        "schema_version: 2\n"
        f"title: {title}\n"
        "type: fact\n"
        "domain: test\n"
        "tier: semantic\n"
        "confidence: 0.8\n"
        f"created: {verified}\n"
        f"updated: {verified}\n"
        f"verified: {verified}\n"
        "sources: [\"unit-test\"]\n"
        "supersedes: []\n"
        "superseded-by:\n"
        f"contradicts: {contradicts_yaml}\n"
        "tags: []\n"
        "---\n"
    )
    link_str = ", ".join(f"[[{l}]]" for l in (links or []))
    return f"{fm}\n# {title}\n\nBody.\n{link_str}\n"


def test_contradicts_flagged_and_reverse_required(tmp_path):
    fresh = date.today().isoformat()
    _write(tmp_path / "index.md", "# Index\n")
    _write(tmp_path / "log.md", "# Log\n")
    _write(tmp_path / "schema.md", "# Schema\n")
    _write(tmp_path / "L0_rules.md", "# L0\n")
    _write(tmp_path / "L1_index.md", "# L1\n")
    # A contradicts B; B does NOT contradict A back.
    _write(tmp_path / "L2_facts/a.md", _v2_page("A", "a", fresh, contradicts=["L2_facts/b"], links=["b"]))
    _write(tmp_path / "L2_facts/b.md", _v2_page("B", "b", fresh, links=["a"]))
    store = WikiStore(tmp_path)
    r = store.lint_pages(strict=True)
    codes = [w["code"] for w in r["warnings"]]
    assert "contradiction" in codes, r["warnings"]
    assert "contradiction_missing_reverse" in codes, r["warnings"]


def test_contradicts_broken_target_errors(tmp_path):
    fresh = date.today().isoformat()
    _write(tmp_path / "index.md", "# Index\n")
    _write(tmp_path / "log.md", "# Log\n")
    _write(tmp_path / "schema.md", "# Schema\n")
    _write(tmp_path / "L0_rules.md", "# L0\n")
    _write(tmp_path / "L1_index.md", "# L1\n")
    _write(tmp_path / "L2_facts/a.md", _v2_page("A", "a", fresh, contradicts=["L2_facts/ghost"], links=["index"]))
    store = WikiStore(tmp_path)
    r = store.lint_pages(strict=True)
    codes = [e["code"] for e in r["errors"]]
    assert "broken_contradiction" in codes, r["errors"]


def test_contradicts_symmetric_pair_no_reverse_warning(tmp_path):
    fresh = date.today().isoformat()
    _write(tmp_path / "index.md", "# Index\n")
    _write(tmp_path / "log.md", "# Log\n")
    _write(tmp_path / "schema.md", "# Schema\n")
    _write(tmp_path / "L0_rules.md", "# L0\n")
    _write(tmp_path / "L1_index.md", "# L1\n")
    _write(tmp_path / "L2_facts/a.md", _v2_page("A", "a", fresh, contradicts=["L2_facts/b"], links=["b"]))
    _write(tmp_path / "L2_facts/b.md", _v2_page("B", "b", fresh, contradicts=["L2_facts/a"], links=["a"]))
    store = WikiStore(tmp_path)
    r = store.lint_pages(strict=True)
    codes = [w["code"] for w in r["warnings"]]
    assert "contradiction" in codes, r["warnings"]
    assert "contradiction_missing_reverse" not in codes, r["warnings"]


def test_lint_no_false_positives_on_clean_wiki(tmp_path):
    fresh = date.today().isoformat()
    _write(tmp_path / "index.md", "# Index\n")
    _write(tmp_path / "log.md", "# Log\n")
    _write(tmp_path / "schema.md", "# Schema\n")
    _write(tmp_path / "L0_rules.md", "# L0\n")
    _write(tmp_path / "L1_index.md", "# L1\n")
    _write(tmp_path / "L2_facts/x.md", _page("X", verified=fresh, links=["y"]))
    _write(tmp_path / "L2_facts/y.md", _page("Y", verified=fresh, links=["x"]))
    store = WikiStore(tmp_path)
    r = store.lint_pages(stale_days=90, hub_threshold=20)
    assert r["broken_links"] == [], r["broken_links"]
    assert r["stale_verified"] == [], r["stale_verified"]
    assert r["duplicate_titles"] == [], r["duplicate_titles"]
    assert r["hubs"] == [], r["hubs"]
    # x and y link each other so neither is orphan.
    orphan_names = {Path(o).name for o in r["orphans"]}
    assert "x" not in orphan_names and "y" not in orphan_names, r["orphans"]


if __name__ == "__main__":
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        test_lint_finds_stale_duplicate_hub(Path(td))
    with tempfile.TemporaryDirectory() as td:
        test_lint_extra_roots_picks_up_outside_tree(Path(td))
    with tempfile.TemporaryDirectory() as td:
        test_lint_no_false_positives_on_clean_wiki(Path(td))
    with tempfile.TemporaryDirectory() as td:
        test_contradicts_flagged_and_reverse_required(Path(td))
    with tempfile.TemporaryDirectory() as td:
        test_contradicts_broken_target_errors(Path(td))
    with tempfile.TemporaryDirectory() as td:
        test_contradicts_symmetric_pair_no_reverse_warning(Path(td))
    print("ok")
