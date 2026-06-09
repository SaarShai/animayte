from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import date
from math import ceil
from pathlib import Path
from typing import Any


WIKI_DIRS = ("raw", "concepts", "patterns", "projects", "people", "queries", "L2_facts", "L3_sops", "L4_archive")
SKIP_PARTS = {".git", ".brainer", ".claude", "__pycache__", ".pytest_cache"}
# H8 fix: hard cap on file sizes read into memory. Stops a runaway/corrupt
# manifest or log from blowing the host's memory. 10MB is plenty for any
# real-world wiki log or import manifest.
MAX_MANIFEST_BYTES = 10 * 1024 * 1024
MAX_LOG_BYTES = 10 * 1024 * 1024
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")

# Provenance trust tiers (mirror of skills/wiki-memory/tools/provenance.py). A page's
# optional `trust:` frontmatter (default "asserted") gates conflict resolution in the
# `resolve` verb: on a same-subject collision, the higher-trust fact wins. This is the
# poison defense from eval/exp5_adversarial — the write-gate scores form/signal, not
# truth, so a confident-wrong lesson passes it; trust resolution is the layer that stops
# a low-trust assertion from overwriting an established higher-trust fact.
TRUST_TIERS = {"asserted": 1.0, "corroborated": 2.0, "verified": 3.0, "user_confirmed": 4.0}
DEFAULT_TRUST = "asserted"
V2_REQUIRED = ("title", "type", "domain", "tier", "confidence", "created", "updated", "verified", "sources", "supersedes", "superseded-by", "tags")
V2_TYPES = {"entity", "summary", "decision", "source-summary", "procedure", "concept", "pattern", "project", "query", "fact", "sop", "raw", "person", "handoff"}
V2_TIERS = {"working", "episodic", "semantic", "procedural"}


DEFAULT_SCHEMA = """# Brainer Wiki Schema

Purpose: a repo-local markdown LLM wiki for durable agent memory in the current target project.

## Layers
- `raw/`: immutable sources. Never rewrite.
- `concepts/`, `patterns/`, `projects/`, `people/`, `queries/`: synthesized target-project pages.
- `index.md`: compact catalog. Read first.
- `log.md`: append-only operation timeline.
- `L0_rules.md`: stable rules loaded at startup.
- `L1_index.md`: compact pointer index loaded at startup.
- `L2_facts/`: verified durable facts.
- `L3_sops/`: solved-task playbooks.
- `L4_archive/`: cold session archives.

## Frontmatter v2 for new pages
```yaml
---
schema_version: 2
title: Example
type: entity|summary|decision|source-summary|procedure|concept|pattern|project|query|fact|sop|raw|person|handoff
domain: framework|tools|patterns|experiments|project
tier: working|episodic|semantic|procedural
confidence: 0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
verified: YYYY-MM-DD
sources: []
supersedes: []
superseded-by:
contradicts: []
tags: []
---
```

`contradicts:` is optional. Use `[[other-page]]` entries to flag two pages that make incompatible claims about the same subject. Lint surfaces these so an agent resolves them rather than retrieving both as truth.

Legacy v1 pages remain readable. Strict lint emits migration warnings for v1 pages and enforces v2 fields on v2/template-generated pages.

## Workflows
- Ingest: source -> `raw/` note -> update synthesized pages -> backlinks -> `index.md`/`log.md`.
- Query: search -> timeline -> fetch only relevant pages -> cite paths -> file answer in `queries/` when it will be reused.
- Lint: stale claims, orphan pages, broken links, contradictions, supersession candidates.
- Crystallize: successful verified work -> `L3_sops/` and durable lessons.

## Imported Wiki Completeness
- Imported projects must be self-contained in this working folder.
- Treat any previous project wiki as source evidence only; adapt its useful information into repo-local pages.
- `index.md` and `L1_index.md` must point to local wiki pages and local commands only.
- After import, agents must not use home-directory rules, external wikis, or source-wiki paths for project facts.
- Validate imported projects with `./te wiki import-audit --manifest raw/<date>-import-manifest.md`.
"""


@dataclass
class Page:
    id: str
    path: Path
    title: str
    type: str
    tags: list[str]
    preview: str
    body: str
    links: list[str]
    frontmatter: dict[str, str]


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    return slug or "note"


def page_id(root: Path, path: Path) -> str:
    return path.relative_to(root).with_suffix("").as_posix()


_FRONTMATTER_OPEN_RE = re.compile(r"^﻿?---\r?\n")
_FRONTMATTER_CLOSE_RE = re.compile(r"\r?\n---\r?\n")


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Parse YAML frontmatter robustly.

    Tolerates: UTF-8 BOM prefix, CRLF line endings, quoted scalars, simple
    block-list values (`tags:\n  - foo\n  - bar`).

    Returns (fields, body). Empty dict if no frontmatter found.
    NB: this is a heuristic parser; install PyYAML for full spec compliance.
    """
    m = _FRONTMATTER_OPEN_RE.match(text)
    if not m:
        return {}, text
    fm_start = m.end()
    close = _FRONTMATTER_CLOSE_RE.search(text, fm_start)
    if close is None:
        return {}, text
    raw = text[fm_start:close.start()]
    body = text[close.end():]
    fm: dict[str, str] = {}
    current_key: str | None = None
    current_list: list[str] | None = None

    def _flush_list() -> None:
        nonlocal current_key, current_list
        if current_key is not None and current_list is not None:
            fm[current_key] = "[" + ", ".join(current_list) + "]"
        current_key = None
        current_list = None

    for line in raw.splitlines():
        stripped = line.rstrip()
        if not stripped:
            _flush_list()
            continue
        # List continuation: `  - value`
        if current_key is not None and current_list is not None and re.match(r"^\s+-\s+", line):
            item = line.lstrip()[1:].strip().strip("\"'")
            current_list.append(item)
            continue
        # End of list (un-indented line)
        if current_list is not None and not line.startswith((" ", "\t")):
            _flush_list()
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            # Strip matching outer quotes only — `"foo'` stays `"foo'`
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            if value == "":
                # Open a list — next indented lines populate it
                current_key = key
                current_list = []
            else:
                fm[key] = value
    _flush_list()
    return fm, body


def parse_tags(value: str) -> list[str]:
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        return [x.strip().strip("\"'") for x in value[1:-1].split(",") if x.strip()]
    if not value:
        return []
    return [value]


def strip_fenced_code(text: str) -> str:
    """Remove ```...``` blocks line-by-line.

    M1 fix: the old regex `\\`\\`\\`.*?\\`\\`\\`` (DOTALL) doesn't track nesting
    or unbalanced fences — a file with an odd number of ``` lines treated
    content inside what should be a fence as plain text, so wikilinks inside
    a code block leaked into the index.

    Walk line-by-line, toggle "in fence" on any line starting with ``` (after
    optional whitespace). On unbalanced fences (odd count), conservatively
    treat trailing content from the last opener as still-in-fence and drop it
    — better to miss a legit wikilink than index a documentation example.
    """
    out: list[str] = []
    in_fence = False
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue  # drop the fence line itself
        if not in_fence:
            out.append(line)
    return "".join(out)


def normalize_wikilink(inner: str) -> str:
    target = inner.strip().split("|", 1)[0].split("#", 1)[0].strip()
    return target.rstrip("\\").removesuffix(".md")


def is_v2_page(fm: dict[str, str]) -> bool:
    return fm.get("schema_version") == "2" or all(key in fm for key in ("title", "domain", "tier", "sources"))


def confidence_value(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        legacy = {"low": 0.25, "med": 0.6, "medium": 0.6, "high": 0.9}
        return legacy.get(str(value).strip().lower())


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, ceil(len(text) / 4) + text.count("\n"))


def query_tokens(query: str) -> list[str]:
    stop = {"the", "and", "for", "with", "into", "from", "that", "this", "when", "what", "need", "needs", "task"}
    tokens = []
    for token in re.findall(r"[A-Za-z0-9_/-]+", query.lower()):
        if len(token) > 1 and token not in stop:
            tokens.append(token)
    return tokens


def listish_has_value(value: str) -> bool:
    clean = str(value or "").strip()
    return bool(clean and clean not in {"[]", "null", "None"})


_CONTENT_STOP = {
    "the", "and", "for", "with", "into", "from", "that", "this", "when", "what",
    "are", "was", "were", "has", "have", "had", "not", "but", "you", "your",
    "all", "any", "can", "use", "used", "via", "per", "its", "our", "out", "now",
    "see", "one", "two", "how", "why", "who", "they", "them", "then", "than",
}


def content_tokens(text: str) -> set[str]:
    """Lowercased content words (>=4 chars, minus stopwords) for Jaccard overlap.

    Code fences are stripped first so two pages aren't judged "overlapping"
    just because they both quote the same boilerplate snippet — referenced
    code identity is its own dimension (see extract_refs).
    """
    body = strip_fenced_code(text)
    toks = set()
    for tok in re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", body.lower()):
        if tok not in _CONTENT_STOP:
            toks.add(tok)
    return toks


_REF_RE = re.compile(r"`([^`\n]+)`|(?<![\w@/.-])([\w.-]+(?:/[\w.-]+)+\.[A-Za-z][\w]{0,5})")


def extract_refs(text: str) -> set[str]:
    """Referenced code paths from a page body.

    Two sources: backticked spans that look like a path (contain `/` and a dot
    extension), and bare path-like tokens (`src/foo/bar.py`). Skips URLs and
    home/absolute paths outside the repo — those aren't repo refs to audit.
    """
    refs: set[str] = set()
    for backticked, bare in _REF_RE.findall(text):
        cand = (backticked or bare).strip()
        if not cand:
            continue
        if cand.startswith(("http://", "https://", "~", "/")):
            continue
        if "/" not in cand or "." not in cand.rsplit("/", 1)[-1]:
            continue
        # Drop trailing punctuation a markdown sentence may have glued on.
        cand = cand.rstrip(").,:;")
        if re.fullmatch(r"[\w./-]+", cand):
            refs.add(cand)
    return refs


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / len(a | b) if inter else 0.0


def render_template(text: str, values: dict[str, str]) -> str:
    """Substitute `{{key}}` placeholders in one pass.

    L2 fix: sequential `.replace()` re-scanned the text once per key, so a
    title value containing `{{date}}` got substituted in the second pass.
    Single-pass regex with a dict-lookup callback closes the hole.
    """
    pattern = re.compile(r"\{\{(\w+)\}\}")
    def repl(m: re.Match) -> str:
        key = m.group(1)
        # Leave unknown placeholders untouched (consistent with old behavior
        # where missing keys produced no substitution).
        return values.get(key, m.group(0))
    return pattern.sub(repl, text)


class WikiStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.state_dir = self.root / ".brainer"
        self.db_path = self.state_dir / "wiki.sqlite3"
        # H2 fix: per-instance caches. iter_markdown / read_page / _rank_pages
        # previously walked + re-read every file on each call. A single
        # context() with max_pages=5 hit each file 6-17x. Now: each markdown
        # file is read at most once per instance lifetime; re-read only when
        # mtime advances. _rank_cache memoizes _rank_pages within one search.
        self._page_cache: dict[Path, tuple[float, Page]] = {}
        self._iter_cache: list[Path] | None = None
        self._rank_cache: dict[str, list[tuple[Page, float, list[str]]]] = {}

    def _invalidate_caches(self) -> None:
        """Call after any write that creates/modifies pages."""
        self._page_cache.clear()
        self._iter_cache = None
        self._rank_cache.clear()

    def init(self) -> dict[str, Any]:
        self.root.mkdir(parents=True, exist_ok=True)
        for name in WIKI_DIRS:
            (self.root / name).mkdir(parents=True, exist_ok=True)
        created = []
        seeds = {
            "index.md": "# Wiki Index\n\nCompact catalog. Update after material wiki changes.\n",
            "log.md": "# Wiki Log\n\n",
            "schema.md": DEFAULT_SCHEMA,
            "L0_rules.md": "# L0 Rules\n\n- Caveman Ultra by default.\n- Retrieve before reasoning about stored facts.\n",
            "L1_index.md": "# L1 Index\n\nRun `python3 wiki.py index` to rebuild pointers.\n",
        }
        for rel, content in seeds.items():
            path = self.root / rel
            if not path.exists():
                path.write_text(content, encoding="utf-8")
                created.append(rel)
        # Copy bundled templates into <wiki_root>/templates/ so `wiki.py new`
        # works in a fresh project without relying on the install layout.
        bundled_templates = Path(__file__).resolve().parents[1] / "templates"
        if bundled_templates.exists():
            target_templates = self.root / "templates"
            target_templates.mkdir(exist_ok=True)
            for src in sorted(bundled_templates.glob("*.template.md")):
                dst = target_templates / src.name
                if not dst.exists():
                    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
                    created.append(f"templates/{src.name}")
        self.state_dir.mkdir(exist_ok=True)
        return {"wiki_root": str(self.root), "created": created}

    def iter_markdown(self) -> list[Path]:
        # H2 fix: memoize the listing — many callers (search, context, timeline)
        # hit this multiple times per request.
        if self._iter_cache is not None:
            return self._iter_cache
        files = []
        root_resolved = self.root.resolve()
        for path in self.root.rglob("*.md"):
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            # H4 fix: rglob follows symlinks by default. A symlink resolving
            # outside self.root made page_id raise ValueError in relative_to.
            # Skip anything that doesn't actually live under the wiki root.
            try:
                resolved = path.resolve()
                resolved.relative_to(root_resolved)
            except (OSError, ValueError):
                continue
            files.append(path)
        self._iter_cache = sorted(files)
        return self._iter_cache

    def read_page(self, path: Path) -> Page:
        # H2 fix: cache parsed pages keyed by path with mtime invalidation.
        # Hot paths (search, context, timeline) called pages()/read_page
        # repeatedly per request, re-reading + re-parsing every markdown file.
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        cached = self._page_cache.get(path)
        if cached is not None and cached[0] == mtime:
            return cached[1]
        text = path.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        title = ""
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        title = title or path.stem.replace("-", " ").replace("_", " ").title()
        preview = ""
        for line in body.splitlines():
            clean = line.strip()
            if clean and not clean.startswith("#"):
                preview = clean[:240]
                break
        links = [normalize_wikilink(x) for x in WIKILINK_RE.findall(strip_fenced_code(body))]
        page = Page(
            id=page_id(self.root, path),
            path=path,
            title=title,
            type=fm.get("type", ""),
            tags=parse_tags(fm.get("tags", "")),
            preview=preview,
            body=body,
            links=links,
            frontmatter=fm,
        )
        self._page_cache[path] = (mtime, page)
        return page

    def pages(self) -> list[Page]:
        return [self.read_page(path) for path in self.iter_markdown()]

    def index(self) -> dict[str, Any]:
        # New files may have appeared on disk since last call; bust the
        # iter_markdown listing so we see them. read_page cache stays — it
        # self-invalidates on mtime change.
        self._iter_cache = None
        self._rank_cache.clear()
        self.init()
        pages = self.pages()
        self.state_dir.mkdir(exist_ok=True)
        # H5 follow-on: two concurrent ingests both call index() and used to
        # race on DROP+CREATE TABLE (one sees the other's mid-flight table).
        # Use `CREATE TABLE IF NOT EXISTS` + `DELETE FROM` inside an immediate
        # transaction so each call rebuilds atomically without colliding.
        with sqlite3.connect(self.db_path, timeout=10) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, path TEXT, title TEXT, type TEXT, tags TEXT, preview TEXT, body TEXT, links TEXT, mtime REAL)"
            )
            conn.execute("DELETE FROM docs")
            fts_enabled = True
            try:
                conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id, title, body, tags)")
                conn.execute("DELETE FROM docs_fts")
            except sqlite3.OperationalError:
                fts_enabled = False
            for page in pages:
                tags = ",".join(page.tags)
                conn.execute(
                    "INSERT OR REPLACE INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        page.id,
                        page.path.relative_to(self.root).as_posix(),
                        page.title,
                        page.type,
                        tags,
                        page.preview,
                        page.body,
                        json.dumps(page.links),
                        page.path.stat().st_mtime,
                    ),
                )
                if fts_enabled:
                    conn.execute("INSERT INTO docs_fts VALUES (?, ?, ?, ?)", (page.id, page.title, page.body, tags))
        l1_lines = [
            "# L1 Index",
            "",
            "Compact pointers. Fetch details on demand.",
            "",
            "- start -> `start.md`",
            "- config -> `brainer.yaml`",
            "- model registry -> `models.yaml`",
            "- L0 rules -> `L0_rules.md`",
            "- schema -> `schema.md`",
            "- wiki catalog -> `index.md`",
            "- log -> `log.md`",
            "- raw sources -> `raw/` (search only; fetch after relevance)",
        ]
        priority = {
            "start",
        }
        bundled_framework_pages = {
            "AGENT_ONBOARDING",
            "HANDOFF",
            "HANDOFF_NEXT_AGENT",
            "README",
            "ROADMAP",
            "bench/README",
            "projects/compound-compression-pipeline/RESULTS",
            "projects/context-keeper/README",
            "projects/context-keeper/SKILL",
            "stable/AGENT_PROMPT",
            "stable/README",
        }
        l1_support_dirs = {
            "adapters",
            "bench",
            "concepts",
            "configs",
            "extensions",
            "hooks",
            "patterns",
            "people",
            "prompts",
            "skills",
            "stable",
            "templates",
        }
        ordered = sorted(pages, key=lambda p: (0 if p.id in priority else 1, p.id))
        seen_l1 = {
            "start",
            "config",
            "model registry",
            "L0 rules",
            "schema",
            "wiki catalog",
            "log",
            "raw sources",
            "L0_rules",
            "L1_index",
            "index",
            "AGENTS",
            "CLAUDE",
            "GEMINI",
        }
        for page in ordered:
            if len(l1_lines) >= 45:
                break
            if page.id in seen_l1:
                continue
            if page.id == "INSTALL":
                continue
            if page.id in bundled_framework_pages:
                continue
            parts = set(Path(page.id).parts)
            if parts & l1_support_dirs:
                continue
            if page.id.startswith("extensions/") and page.id != "extensions/README":
                continue
            if page.id.startswith("raw/"):
                continue
            if page.id in {"external-adapters"}:
                continue
            if page.id.endswith("/INSTALL") or "/agents/" in page.id or "/kaggle_results/" in page.id:
                continue
            tags = f" tags={','.join(page.tags)}" if page.tags else ""
            l1_lines.append(f"- {page.id} ({page.type or 'page'}{tags}) -> `{page.path.relative_to(self.root).as_posix()}`")
            seen_l1.add(page.id)
        (self.root / "L1_index.md").write_text("\n".join(l1_lines) + "\n", encoding="utf-8")
        # H2 fix: bump db mtime to be strictly newer than any .md we just
        # touched. Without this, L1_index.md (written above) shows up newer
        # than the DB and `_ensure_db` triggers a fresh re-index on every
        # search/context call — burning the cache we just populated.
        try:
            import os
            now = max(p.stat().st_mtime for p in self.iter_markdown()) + 1
            os.utime(self.db_path, (now, now))
        except OSError:
            pass
        return {"indexed": len(pages), "db": str(self.db_path), "fts5": fts_enabled}

    def _ensure_db(self) -> None:
        if not self.db_path.exists():
            self.index()
            return
        try:
            db_mtime = self.db_path.stat().st_mtime
            # iter_markdown is now cached; stat() per file once is fine here
            # because we run it at most once per Wiki-instance hot path.
            newest_md = max((path.stat().st_mtime for path in self.iter_markdown()), default=0)
        except OSError:
            newest_md = 0
            db_mtime = 0
        if newest_md > db_mtime:
            self.index()

    def search(self, query: str, k: int = 10) -> list[dict[str, Any]]:
        self._ensure_db()
        return [self._search_hit(page, score, reasons) for page, score, reasons in self._rank_pages(query)[:k]]

    def _search_hit(self, page: Page, score: float, reasons: list[str]) -> dict[str, Any]:
        return {
            "id": page.id,
            "path": page.path.relative_to(self.root).as_posix(),
            "title": page.title,
            "type": page.type,
            "tags": page.tags,
            "preview": page.preview,
            "score": round(score, 3),
            "reasons": reasons[:6],
            "superseded_by": page.frontmatter.get("superseded-by", ""),
        }

    def _rank_pages(self, query: str) -> list[tuple[Page, float, list[str]]]:
        # H2 fix: context() called this once and then called fetch+timeline per
        # loaded page (which calls pages() → re-walks the wiki). Memoize within
        # a single Wiki instance — the cache is invalidated whenever a write
        # touches state (new_page / ingest / index).
        cached = self._rank_cache.get(query)
        if cached is not None:
            return cached
        tokens = query_tokens(query)
        raw_requested = bool(re.search(r"\b(raw|source|archive|transcript|full)\b", query, re.IGNORECASE))
        pages = self.pages()
        incoming = self._incoming_counts(pages)
        ranked: list[tuple[Page, float, list[str]]] = []
        # H2 fix: stat-per-page in a hot loop. Pull mtimes once from the
        # already-cached page objects (path.stat in tight loop was 2 calls per
        # page per search — N stats per page over the whole context() flow).
        mtimes = {p.path: self._page_cache.get(p.path, (0.0, None))[0] for p in pages}
        newest_mtime = max(mtimes.values(), default=0)
        for page in pages:
            text = f"{page.title} {page.type} {' '.join(page.tags)} {page.path.as_posix()} {page.preview} {page.body}".lower()
            title_text = page.title.lower()
            tag_text = " ".join(page.tags).lower()
            path_text = page.path.relative_to(self.root).as_posix().lower()
            token_hits = [token for token in tokens if token in text]
            if not token_hits:
                continue
            score = float(len(token_hits))
            reasons = [f"matched:{','.join(token_hits[:5])}"]
            title_hits = [token for token in tokens if token in title_text]
            tag_hits = [token for token in tokens if token in tag_text]
            path_hits = [token for token in tokens if token in path_text]
            if title_hits:
                score += 3.0 + len(title_hits)
                reasons.append("title")
            if tag_hits:
                score += 2.0 + len(tag_hits)
                reasons.append("tags")
            if path_hits:
                score += 1.0
                reasons.append("path")
            tier_bonus = self._tier_weight(page)
            score += tier_bonus
            if tier_bonus:
                reasons.append(f"tier:{round(tier_bonus, 2)}")
            conf = confidence_value(page.frontmatter.get("confidence", ""))
            if conf is not None:
                score += conf
                reasons.append(f"confidence:{round(conf, 2)}")
            link_bonus = min(1.5, incoming.get(page.id, 0) * 0.25)
            if link_bonus:
                score += link_bonus
                reasons.append("backlinked")
            if newest_mtime:
                # H2 fix: re-use cached mtime (set by read_page) instead of a
                # fresh stat() per page per search.
                page_mtime = mtimes.get(page.path) or 0
                age_gap = max(0.0, newest_mtime - page_mtime)
                recency = max(0.0, 0.5 - (age_gap / (86400 * 60)))
                if recency:
                    score += recency
                    reasons.append("recent")
            if page.id.startswith("raw/") and not raw_requested:
                score -= 3.0
                reasons.append("raw-downranked")
            if listish_has_value(page.frontmatter.get("superseded-by", "")):
                score -= 5.0
                reasons.append("superseded")
            if score > 0:
                ranked.append((page, score, reasons))
        ranked.sort(key=lambda item: (-item[1], item[0].id))
        self._rank_cache[query] = ranked
        return ranked

    def _tier_weight(self, page: Page) -> float:
        if page.id.startswith("L2_facts/"):
            return 2.0
        if page.id.startswith("L3_sops/"):
            return 1.8
        if page.id.startswith(("concepts/", "patterns/", "projects/", "queries/")):
            return 1.0
        if page.id.startswith("people/"):
            return 0.5
        if page.id.startswith(("skills/", "prompts/")):
            return 0.35
        if page.id.startswith("raw/"):
            return -0.5
        return 0.0

    def _incoming_counts(self, pages: list[Page]) -> dict[str, int]:
        ids = {p.id for p in pages}
        stems = {Path(p.id).name: p.id for p in pages}
        incoming = {p.id: 0 for p in pages}
        for page in pages:
            for link in page.links:
                target = link.removesuffix(".md")
                if target in ids:
                    incoming[target] += 1
                elif Path(target).name in stems:
                    incoming[stems[Path(target).name]] += 1
        return incoming

    def context(self, task: str, max_pages: int = 5, max_tokens: int = 4000, k: int = 12) -> dict[str, Any]:
        """Plan and load a bounded, auditable context packet for a task."""
        self._ensure_db()
        raw_requested = bool(re.search(r"\b(raw|source|archive|transcript|full)\b", task, re.IGNORECASE))
        ranked = self._rank_pages(task)
        loaded: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        uncertain: list[dict[str, Any]] = []
        token_total = 0
        for page, score, reasons in ranked[: max(k, max_pages)]:
            hit = self._search_hit(page, score, reasons)
            page_tokens = estimate_tokens(page.body)
            superseded = listish_has_value(page.frontmatter.get("superseded-by", ""))
            if page.id.startswith("raw/") and not raw_requested:
                hit["decision"] = "rejected"
                hit["reason"] = "raw-requires-explicit-request"
                rejected.append(hit)
                continue
            if superseded:
                hit["decision"] = "rejected"
                hit["reason"] = "superseded"
                rejected.append(hit)
                continue
            if score >= 3.0 and len(loaded) < max_pages and token_total + page_tokens <= max_tokens:
                fetched = self.fetch(page.id)
                hit["decision"] = "loaded"
                hit["tokens"] = page_tokens
                hit["timeline"] = self.timeline(page.id)
                hit["content"] = fetched["content"]
                loaded.append(hit)
                token_total += page_tokens
            elif score >= 2.0:
                hit["decision"] = "uncertain"
                hit["tokens"] = page_tokens
                hit["reason"] = "budget-or-page-limit" if len(loaded) >= max_pages or token_total + page_tokens > max_tokens else "borderline-score"
                uncertain.append(hit)
            else:
                hit["decision"] = "rejected"
                hit["reason"] = "low-score"
                rejected.append(hit)
        return {
            "task": task,
            "max_pages": max_pages,
            "max_tokens": max_tokens,
            "token_estimate": token_total,
            "loaded": loaded,
            "fetch_plan": [item["id"] for item in loaded],
            "uncertain": uncertain[: max(0, k - len(loaded))],
            "rejected": rejected[:k],
            "citations": {
                "loaded": [item["path"] for item in loaded],
                "uncertain": [item["path"] for item in uncertain[: max(0, k - len(loaded))]],
                "rejected": [item["path"] for item in rejected[:k]],
            },
        }

    def fetch(self, item_id: str) -> dict[str, Any]:
        self._ensure_db()
        key = item_id.removesuffix(".md")
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM docs WHERE id = ? OR path = ?", (key, item_id)).fetchone()
        if not row:
            raise KeyError(f"wiki page not found: {item_id}")
        return {
            "id": row["id"],
            "path": row["path"],
            "title": row["title"],
            "type": row["type"],
            "tags": [x for x in str(row["tags"]).split(",") if x],
            "content": row["body"],
        }

    def timeline(self, item_id: str, window: int = 3) -> dict[str, Any]:
        page = self.fetch(item_id)
        pages = self.pages()
        target_id = page["id"]
        target_title = page["title"]
        backlinks = []
        neighbors = []
        same_dir = []
        for p in pages:
            if target_id in p.links or target_title in p.links:
                backlinks.append({"id": p.id, "title": p.title, "path": p.path.relative_to(self.root).as_posix()})
            if str(p.path.parent) == str((self.root / page["path"]).parent):
                same_dir.append(p)
        same_dir = sorted(same_dir, key=lambda p: p.path.as_posix())
        ids = [p.id for p in same_dir]
        if target_id in ids:
            idx = ids.index(target_id)
            for p in same_dir[max(0, idx - window) : idx + window + 1]:
                if p.id != target_id:
                    neighbors.append({"id": p.id, "title": p.title, "path": p.path.relative_to(self.root).as_posix()})
        log_hits = []
        log_path = self.root / "log.md"
        if log_path.exists():
            # H8 fix: was `read_text().splitlines()` — a runaway log file
            # blows memory. Stream line-by-line; cap total bytes consumed.
            try:
                size = log_path.stat().st_size
            except OSError:
                size = 0
            if size > MAX_LOG_BYTES:
                # Read only the tail of the log — that's what timeline shows
                # anyway (`log_hits[-10:]`).
                with log_path.open("rb") as fh:
                    fh.seek(size - MAX_LOG_BYTES)
                    raw = fh.read().decode("utf-8", errors="replace")
                stream = raw.splitlines()
            else:
                with log_path.open("r", encoding="utf-8", errors="replace") as fh:
                    stream = fh  # iter line-by-line
                    for line in stream:
                        line = line.rstrip("\n")
                        if target_id in line or target_title in line:
                            log_hits.append(line[:240])
                stream = []  # already consumed
            for line in stream:
                if target_id in line or target_title in line:
                    log_hits.append(line[:240])
        return {"id": target_id, "backlinks": backlinks[:20], "neighbors": neighbors[:20], "log": log_hits[-10:]}

    def lint(self) -> dict[str, Any]:
        return self.lint_pages(strict=False)

    def _read_extra_page(self, path: Path, scope_root: Path) -> Page:
        """Read a page whose id is relative to scope_root (not self.root).

        Used by lint_pages when called with extra_roots so concepts/, runbooks/,
        designs/*/ledger.md etc. can be hygiene-scanned alongside the wiki tree.
        """
        scope_root = scope_root.resolve()
        text = path.read_text(encoding="utf-8", errors="replace")
        fm, body = parse_frontmatter(text)
        title = ""
        for line in body.splitlines():
            if line.startswith("# "):
                title = line[2:].strip()
                break
        title = title or path.stem.replace("-", " ").replace("_", " ").title()
        preview = ""
        for line in body.splitlines():
            clean = line.strip()
            if clean and not clean.startswith("#"):
                preview = clean[:240]
                break
        links = [normalize_wikilink(x) for x in WIKILINK_RE.findall(strip_fenced_code(body))]
        try:
            rel = path.resolve().relative_to(scope_root).with_suffix("").as_posix()
        except ValueError:
            rel = path.stem
        prefix = scope_root.name or "scope"
        pid = f"{prefix}/{rel}" if rel else f"{prefix}/{path.stem}"
        return Page(
            id=pid,
            path=path,
            title=title,
            type=fm.get("type", ""),
            tags=parse_tags(fm.get("tags", "")),
            preview=preview,
            body=body,
            links=links,
            frontmatter=fm,
        )

    def _collect_extra_pages(self, extra_roots: list[str | Path]) -> list[Page]:
        out: list[Page] = []
        for er in extra_roots:
            er_path = Path(er).expanduser().resolve()
            if not er_path.exists():
                continue
            if er_path.is_file() and er_path.suffix == ".md":
                out.append(self._read_extra_page(er_path, er_path.parent))
                continue
            if er_path.is_dir():
                # Use the dir itself as the scope_root so ids are <dirname>/<rel>.
                for path in sorted(er_path.rglob("*.md")):
                    if any(part in SKIP_PARTS for part in path.parts):
                        continue
                    out.append(self._read_extra_page(path, er_path))
        return out

    def lint_pages(
        self,
        strict: bool = False,
        stale_days: int = 180,
        hub_threshold: int = 20,
        extra_roots: list[str | Path] | None = None,
    ) -> dict[str, Any]:
        pages = self.pages()
        if extra_roots:
            pages = pages + self._collect_extra_pages(extra_roots)
        ids = {p.id for p in pages}
        stems = {Path(p.id).name for p in pages}
        # First-occurrence wins for stem→id, so [[foo]] resolves to the most
        # canonical foo when stems collide. duplicate_titles surfaces collisions.
        stem_to_id: dict[str, str] = {}
        for p in pages:
            name = Path(p.id).name
            stem_to_id.setdefault(name, p.id)
        incoming: dict[str, int] = {p.id: 0 for p in pages}
        broken = []
        missing_frontmatter = []
        supersession = []
        stale_indexes = []
        duplicate_titles = []
        missing_provenance = []
        missing_backlinks = []
        errors = []
        warnings: list[dict[str, Any]] = []
        # Every strict-mode warning path below already gates on `if strict:`,
        # so a single binding is correct. The earlier `_NoOpWarnings` shim
        # silently swallowed 11 codes (duplicate_title / stale_index /
        # legacy_missing_frontmatter / missing_provenance / missing_backlinks /
        # supersession_missing_reverse / legacy_frontmatter_v1 / raw_type_not_raw /
        # orphan / stale_verified / hub_gravity_well) so `result["warnings"]`
        # only ever surfaced the two contradiction codes.
        warn: list[dict[str, Any]] = warnings
        title_seen: dict[str, str] = {}
        for p in pages:
            title_key = p.title.strip().lower()
            if title_key and title_key in title_seen and p.path.name not in {"index.md", "log.md", "L1_index.md"}:
                duplicate_titles.append({"title": p.title, "first": title_seen[title_key], "duplicate": p.id})
                if strict:
                    warn.append({"code": "duplicate_title", "title": p.title, "first": title_seen[title_key], "duplicate": p.id})
            elif title_key:
                title_seen[title_key] = p.id
        if strict:
            material_pages = [
                p
                for p in pages
                if p.path.name not in {"index.md", "log.md", "L0_rules.md", "L1_index.md"}
                and not p.id.startswith(("raw/m5-outputs-",))
                and p.path.is_relative_to(self.root)
                and not (set(p.path.relative_to(self.root).parts) & {"templates", "hooks", "configs", "adapters"})
            ]
            for rel in ("L1_index.md",):
                index_path = self.root / rel
                if index_path.exists() and material_pages:
                    newest = max(p.path.stat().st_mtime for p in material_pages)
                    if newest > index_path.stat().st_mtime + 1:
                        stale_indexes.append(rel)
                        warn.append({"code": "stale_index", "page": rel})
        for p in pages:
            rel_parts = set(p.path.relative_to(self.root).parts) if p.path.is_relative_to(self.root) else set()
            if strict and rel_parts & {"templates", "skills", "prompts", "hooks", "configs", "extensions", "adapters"}:
                continue
            if p.path.name not in {"index.md", "log.md", "schema.md", "L0_rules.md", "L1_index.md"} and not p.frontmatter:
                missing_frontmatter.append(p.id)
                if strict:
                    warn.append({"code": "legacy_missing_frontmatter", "page": p.id})
            if "supersedes" in p.frontmatter or "superseded-by" in p.frontmatter:
                supersession.append(p.id)
            if strict:
                contradicts_value = p.frontmatter.get("contradicts", "")
                for target in re.findall(r"\[\[([^\]]+)\]\]", contradicts_value):
                    target_id = target.removesuffix(".md")
                    candidate = next((page for page in pages if page.id == target_id or Path(page.id).name == Path(target_id).name), None)
                    if candidate is None:
                        continue
                    warnings.append({"code": "contradiction", "page": p.id, "target": candidate.id})
                    if p.id not in candidate.frontmatter.get("contradicts", ""):
                        warnings.append({"code": "contradiction_missing_reverse", "page": p.id, "target": candidate.id})
            if strict:
                if is_v2_page(p.frontmatter):
                    self._lint_v2_page(p, ids, stems, errors, warn)
                    if p.frontmatter.get("type") not in {"raw", "source-summary", "handoff"} and not listish_has_value(p.frontmatter.get("sources", "")):
                        missing_provenance.append(p.id)
                        warn.append({"code": "missing_provenance", "page": p.id})
                    if p.path.name not in {"index.md", "log.md", "schema.md", "L0_rules.md", "L1_index.md"} and not p.links:
                        missing_backlinks.append(p.id)
                        warn.append({"code": "missing_backlinks", "page": p.id})
                    superseded_by = p.frontmatter.get("superseded-by", "")
                    for target in re.findall(r"\[\[([^\]]+)\]\]", superseded_by):
                        target_id = target.removesuffix(".md")
                        candidate = next((page for page in pages if page.id == target_id or Path(page.id).name == Path(target_id).name), None)
                        if candidate and p.id not in candidate.frontmatter.get("supersedes", ""):
                            warn.append({"code": "supersession_missing_reverse", "page": p.id, "target": candidate.id})
                elif p.frontmatter and p.path.name not in {"index.md", "log.md", "schema.md", "L0_rules.md", "L1_index.md"}:
                    warn.append({"code": "legacy_frontmatter_v1", "page": p.id})
                if p.id.startswith("raw/") and p.frontmatter.get("type") not in {"raw", "source-summary"}:
                    warn.append({"code": "raw_type_not_raw", "page": p.id})
            for link in p.links:
                link_id = link.removesuffix(".md")
                if link_id in incoming:
                    incoming[link_id] += 1
                elif Path(link_id).name in stem_to_id:
                    # Stem-only wikilink (e.g. [[foo]] referring to L2_facts/foo).
                    # Resolve to the canonical id so inbound counts are accurate
                    # for orphan + hub detection.
                    incoming[stem_to_id[Path(link_id).name]] += 1
                elif link_id not in ids and Path(link_id).name not in stems:
                    broken.append({"from": p.id, "to": link})
                    if strict and is_v2_page(p.frontmatter):
                        errors.append({"code": "broken_link", "page": p.id, "target": link})
        exempt = {"index", "log", "schema", "L0_rules", "L1_index", "README", "start"}
        support_dirs = {"templates", "skills", "prompts", "hooks", "configs", "extensions", "adapters"}
        orphans = [
            pid
            for pid, count in incoming.items()
            if count == 0
            and Path(pid).name not in exempt
            and not pid.startswith("raw/")
            and not (set(Path(pid).parts) & support_dirs)
        ]
        if strict:
            for pid in orphans:
                page = next((p for p in pages if p.id == pid), None)
                if page and is_v2_page(page.frontmatter):
                    warn.append({"code": "orphan", "page": pid})

        # Always-on: stale `verified:` (was strict-only) with age in days.
        today = date.today()
        stale_verified = []
        for p in pages:
            value = p.frontmatter.get("verified", "").strip().strip("\"'")
            if not value:
                continue
            try:
                parsed = date.fromisoformat(value)
            except ValueError:
                continue
            age_days = (today - parsed).days
            if age_days > stale_days:
                stale_verified.append({
                    "page": p.id,
                    "verified": value,
                    "age_days": age_days,
                })
                if strict:
                    warn.append({"code": "stale_verified", "page": p.id, "verified": value, "age_days": age_days})

        # Always-on: gravity-well hub detection. A page with > hub_threshold
        # inbound links is a junk drawer; suggests splitting or cleanup.
        hubs = [
            {"page": pid, "inbound": count}
            for pid, count in sorted(incoming.items(), key=lambda kv: -kv[1])
            if count > hub_threshold
            and Path(pid).name not in {"index", "log", "L1_index", "schema", "L0_rules"}
        ]
        if strict:
            for h in hubs:
                warn.append({"code": "hub_gravity_well", "page": h["page"], "inbound": h["inbound"]})

        result = {
            "pages": len(pages),
            "missing_frontmatter": missing_frontmatter,
            "broken_links": broken,
            "orphans": orphans,
            "supersession_candidates": supersession,
            "stale_indexes": stale_indexes,
            "duplicate_titles": duplicate_titles,
            "missing_provenance": missing_provenance,
            "missing_backlinks": missing_backlinks,
            "stale_verified": stale_verified,
            "hubs": hubs,
        }
        if strict:
            result["strict"] = True
            result["errors"] = errors
            result["warnings"] = warnings
            result["ok"] = not errors
        return result

    def _lint_v2_page(self, page: Page, ids: set[str], stems: set[str], errors: list[dict[str, Any]], warnings: list[dict[str, Any]]) -> None:
        fm = page.frontmatter
        for key in V2_REQUIRED:
            if key not in fm:
                errors.append({"code": "missing_v2_field", "page": page.id, "field": key})
        if fm.get("type") and fm["type"] not in V2_TYPES:
            errors.append({"code": "invalid_type", "page": page.id, "value": fm["type"]})
        if fm.get("tier") and fm["tier"] not in V2_TIERS:
            errors.append({"code": "invalid_tier", "page": page.id, "value": fm["tier"]})
        conf = confidence_value(fm.get("confidence", ""))
        if conf is None or conf < 0.0 or conf > 1.0:
            errors.append({"code": "invalid_confidence", "page": page.id, "value": fm.get("confidence", "")})
        for key in ("created", "updated", "verified"):
            value = fm.get(key, "")
            if value:
                try:
                    date.fromisoformat(value)
                    # Stale-verified detection lives in lint_pages() (always-on,
                    # configurable threshold). _lint_v2_page only validates the
                    # date format here.
                except ValueError:
                    errors.append({"code": "invalid_date", "page": page.id, "field": key, "value": value})
        for key in ("supersedes", "superseded-by"):
            value = fm.get(key, "")
            for target in re.findall(r"\[\[([^\]]+)\]\]", value):
                target_id = target.removesuffix(".md")
                if target_id not in ids and Path(target_id).name not in stems:
                    errors.append({"code": "broken_supersession", "page": page.id, "target": target})
        contradicts_value = fm.get("contradicts", "")
        for target in re.findall(r"\[\[([^\]]+)\]\]", contradicts_value):
            target_id = target.removesuffix(".md")
            if target_id not in ids and Path(target_id).name not in stems:
                errors.append({"code": "broken_contradiction", "page": page.id, "target": target})

    def import_audit(self, manifest: str | Path) -> dict[str, Any]:
        manifest_path = Path(manifest).expanduser()
        if not manifest_path.is_absolute():
            manifest_path = self.root / manifest_path
        errors: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        rows: list[dict[str, str]] = []
        if not manifest_path.exists():
            errors.append({"code": "missing_manifest", "path": str(manifest_path)})
        else:
            rows = self._parse_import_manifest(manifest_path)
            if not rows:
                errors.append({"code": "manifest_has_no_coverage_rows", "path": manifest_path.relative_to(self.root).as_posix() if self._is_under_root(manifest_path) else str(manifest_path)})
        pages_by_id = {p.id: p for p in self.pages()}
        pages_by_path = {p.path.relative_to(self.root).as_posix(): p for p in pages_by_id.values() if self._is_under_root(p.path)}
        original_paths = []
        for idx, row in enumerate(rows, start=1):
            status = self._cell(row, "status").lower()
            original = self._cell(row, "original page/path", "original page", "original path", "source")
            if original:
                original_paths.append(original)
            target = self._cell(row, "target local page", "target", "local page")
            if status not in {"adapted", "archived", "discarded"}:
                errors.append({"code": "invalid_manifest_status", "row": idx, "status": status})
                continue
            if status == "discarded":
                if not self._cell(row, "rationale"):
                    errors.append({"code": "discarded_row_missing_rationale", "row": idx, "original": original})
                continue
            if not target:
                errors.append({"code": "missing_target_page", "row": idx, "original": original})
                continue
            normalized = self._normalize_manifest_target(target)
            page = pages_by_id.get(normalized.removesuffix(".md")) or pages_by_path.get(normalized if normalized.endswith(".md") else f"{normalized}.md")
            if page is None:
                errors.append({"code": "target_page_missing", "row": idx, "target": target, "normalized": normalized})
                continue
            if not is_v2_page(page.frontmatter):
                errors.append({"code": "target_page_not_v2", "row": idx, "target": page.id})
        errors.extend(self._audit_synthesized_pages(original_paths))
        errors.extend(self._audit_local_indexes())
        return {
            "ok": not errors,
            "manifest": str(manifest_path),
            "rows": len(rows),
            "errors": errors,
            "warnings": warnings,
        }

    def _parse_import_manifest(self, manifest_path: Path) -> list[dict[str, str]]:
        # H8 fix: was `read_text().splitlines()` with no size cap. A 5GB
        # manifest blows memory. Reject early above MAX_MANIFEST_BYTES; stream
        # line-by-line below it so we never hold the full text + the split copy.
        try:
            size = manifest_path.stat().st_size
        except OSError:
            size = 0
        if size > MAX_MANIFEST_BYTES:
            raise ValueError(
                f"manifest too large ({size} bytes > {MAX_MANIFEST_BYTES}); "
                f"split it into smaller manifests"
            )
        with manifest_path.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
        rows: list[dict[str, str]] = []
        header: list[str] | None = None
        for line in lines:
            stripped = line.strip()
            if not stripped.startswith("|") or not stripped.endswith("|"):
                continue
            cells = [cell.strip().strip("`") for cell in stripped.strip("|").split("|")]
            if cells and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells):
                continue
            normalized = [self._normalize_manifest_header(cell) for cell in cells]
            if header is None:
                if {"status", "rationale"}.issubset(set(normalized)) and any("original" in cell for cell in normalized) and any("target" in cell for cell in normalized):
                    header = normalized
                continue
            if len(cells) < len(header):
                cells.extend([""] * (len(header) - len(cells)))
            row = {key: value for key, value in zip(header, cells)}
            if any(value.strip() for value in row.values()):
                rows.append(row)
        return rows

    def _normalize_manifest_header(self, value: str) -> str:
        clean = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
        aliases = {
            "original page path": "original page/path",
            "original path": "original page/path",
            "original page": "original page/path",
            "target": "target local page",
            "local page": "target local page",
            "target page": "target local page",
        }
        return aliases.get(clean, clean)

    def _cell(self, row: dict[str, str], *names: str) -> str:
        for name in names:
            value = row.get(self._normalize_manifest_header(name), "")
            if value:
                return self._clean_manifest_cell(value)
        return ""

    def _clean_manifest_cell(self, value: str) -> str:
        clean = value.strip().strip("`")
        wiki_match = re.fullmatch(r"\[\[([^\]]+)\]\]", clean)
        if wiki_match:
            clean = wiki_match.group(1)
        if "|" in clean:
            clean = clean.split("|", 1)[0]
        return clean.strip().removesuffix(".md")

    def _normalize_manifest_target(self, target: str) -> str:
        clean = self._clean_manifest_cell(target)
        if clean.startswith("./"):
            clean = clean[2:]
        clean = clean.lstrip("/")
        return clean.removesuffix(".md")

    def _audit_synthesized_pages(self, original_paths: list[str]) -> list[dict[str, Any]]:
        errors: list[dict[str, Any]] = []
        source_paths = [path.strip().strip("`") for path in original_paths if self._looks_like_external_path(path)]
        for page in self.pages():
            if not page.id.startswith(("concepts/", "patterns/", "projects/", "people/", "queries/", "L2_facts/", "L3_sops/")):
                continue
            text = page.body.lower()
            for phrase in ("old wiki", "original wiki"):
                if phrase in text:
                    errors.append({"code": "forbidden_external_wiki_reference", "page": page.id, "phrase": phrase})
            blocked_rule = "~" + "/.claude/rules/common/llm-wiki.md"
            if blocked_rule.lower() in text:
                errors.append({"code": "forbidden_external_rule_reference", "page": page.id})
            for source_path in source_paths:
                if source_path and source_path.lower() in text:
                    errors.append({"code": "forbidden_source_path_reference", "page": page.id, "path": source_path})
        return errors

    def _audit_local_indexes(self) -> list[dict[str, Any]]:
        errors: list[dict[str, Any]] = []
        for rel in ("index.md", "L1_index.md"):
            path = self.root / rel
            if not path.exists():
                continue
            # L4 fix: was matching on raw text — false-positives on any
            # `/usr/bin/env` shebang or example path mentioned inside a fenced
            # code block. Strip fences first so the audit only checks prose.
            text = strip_fenced_code(path.read_text(encoding="utf-8", errors="replace"))
            for match in re.findall(r"(?<![\w.-])(?:~|/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_. -]+)+)", text):
                if match.startswith("/./") or match.startswith("//"):
                    continue
                errors.append({"code": "index_points_outside_workspace", "page": rel, "path": match})
        return errors

    def _looks_like_external_path(self, value: str) -> bool:
        clean = value.strip().strip("`")
        return clean.startswith("~") or clean.startswith("/") or bool(re.match(r"[A-Za-z]:\\", clean))

    def _is_under_root(self, path: Path) -> bool:
        try:
            path.resolve().relative_to(self.root)
            return True
        except ValueError:
            return False

    # GRAFT 1 — dedup at write. Score a candidate fact against existing pages
    # across five dimensions (subject / tags / content / refs / links) so the
    # writer can update-not-create when a near-duplicate already exists, instead
    # of letting duplicate pages drift apart and contradict each other later.
    # Lineage: EveryInc/compound-engineering-plugin (plugins/compound-engineering/
    # skills/ce-compound) overlap assessment, grafted onto this wiki's
    # typed-edge substrate.
    OVERLAP_DIMENSIONS = ("subject", "tags", "content", "refs", "links")

    def overlap(
        self,
        title: str,
        body: str = "",
        tags: list[str] | None = None,
        k: int = 5,
    ) -> dict[str, Any]:
        cand_tags = {t.strip().lower() for t in (tags or []) if t.strip()}
        cand_title_toks = {t for t in query_tokens(title)}
        cand_content = content_tokens(f"{title}\n{body}")
        cand_refs = extract_refs(body)
        cand_links = {normalize_wikilink(x).lower() for x in WIKILINK_RE.findall(strip_fenced_code(body))}

        # Pre-filter with the existing ranker so we only dim-score plausible
        # neighbours, not the whole wiki.
        probe = f"{title} {' '.join(cand_tags)}"
        ranked = self._rank_pages(probe) if probe.strip() else []
        candidates = [p for p, _score, _r in ranked[: max(k * 3, 12)]]
        # Fallback: nothing ranked (e.g. empty index) — scan all material pages.
        if not candidates:
            candidates = [
                p for p in self.pages()
                if not p.id.startswith("raw/")
                and p.path.name not in {"index.md", "log.md", "schema.md", "L0_rules.md", "L1_index.md"}
            ]

        scored: list[dict[str, Any]] = []
        for page in candidates:
            if page.id.startswith("raw/"):
                continue
            if listish_has_value(page.frontmatter.get("superseded-by", "")):
                continue
            dims: dict[str, bool] = {}
            # subject: title token Jaccard, or >=2 shared significant tokens
            p_title_toks = set(query_tokens(page.title))
            shared_title = cand_title_toks & p_title_toks
            dims["subject"] = jaccard(cand_title_toks, p_title_toks) >= 0.34 or len(shared_title) >= 2
            # tags: any shared tag
            dims["tags"] = bool(cand_tags & {t.lower() for t in page.tags})
            # content: body content-token Jaccard
            dims["content"] = jaccard(cand_content, content_tokens(page.body)) >= 0.18
            # refs: any shared referenced code path
            dims["refs"] = bool(cand_refs & extract_refs(page.body))
            # links: any shared wikilink target
            dims["links"] = bool(cand_links & {l.lower() for l in page.links})
            matched = [d for d in self.OVERLAP_DIMENSIONS if dims[d]]
            score = len(matched)
            if score == 0:
                continue
            scored.append({
                "id": page.id,
                "path": page.path.relative_to(self.root).as_posix(),
                "title": page.title,
                "score": score,
                "matched": matched,
            })
        scored.sort(key=lambda c: (-c["score"], c["id"]))
        scored = scored[:k]

        best = scored[0]["score"] if scored else 0
        if best >= 4:
            band, action = "high", "update-existing"
        elif best >= 2:
            band, action = "moderate", "create-and-flag"
        else:
            band, action = "low", "create"
        return {
            "title": title,
            "overlap": band,
            "recommended_action": action,
            "best_match": scored[0] if scored else None,
            "candidates": scored,
        }

    def resolve(self, title: str, body: str = "", trust: str = DEFAULT_TRUST,
                tags: list[str] | None = None, k: int = 5) -> dict[str, Any]:
        """Trust-gated conflict resolution — the poison defense (eval/exp5_adversarial).

        Runs `overlap` to find a same-subject page, reads its `trust:` frontmatter, and
        applies the provenance policy: higher candidate trust -> replace; lower -> reject;
        equal -> dispute. `write-gate` decides *quality*; this decides *who wins a
        contradiction* by provenance, not by confidence of phrasing (a well-formed wrong
        lesson passes the gate). The same-subject signal is structural (overlap); whether
        the facts truly disagree stays the caller's judgement.
        """
        cand_name = (trust or DEFAULT_TRUST).strip().lower()
        cand_t = TRUST_TIERS.get(cand_name, TRUST_TIERS[DEFAULT_TRUST])
        ov = self.overlap(title, body=body, tags=tags, k=k)
        bm = ov.get("best_match")
        band = ov.get("overlap")
        base: dict[str, Any] = {"title": title, "overlap": band,
                                "candidate_trust": {cand_name: cand_t}, "best_match": bm}
        if not bm or band == "low":
            return {**base, "action": "create",
                    "reason": "no strong same-subject page (overlap low) — safe to create"}
        try:
            page = self.read_page(self.root / bm["path"])
            existing_name = (page.frontmatter.get("trust") or DEFAULT_TRUST).strip().lower()
        except (OSError, KeyError):
            existing_name = DEFAULT_TRUST
        existing_t = TRUST_TIERS.get(existing_name, TRUST_TIERS[DEFAULT_TRUST])
        base["existing_trust"] = {existing_name: existing_t}
        if cand_t > existing_t:
            action = "replace"
            reason = (f"candidate trust {cand_name}({cand_t}) > existing {existing_name}({existing_t}) "
                      f"— higher-trust correction permitted; supersede {bm['id']} (wire supersedes/superseded-by).")
        elif cand_t < existing_t:
            action = "reject"
            reason = (f"candidate trust {cand_name}({cand_t}) < existing {existing_name}({existing_t}) "
                      f"— an established higher-trust page exists; do NOT overwrite it. Raise trust first "
                      f"(verify against code/test, or user-confirm), or record contradicts:[[{bm['id']}]] for review.")
        else:
            action = "dispute"
            reason = (f"equal trust ({existing_name}) on same-subject page {bm['id']}. If the facts AGREE, "
                      f"update in place; if they CONFLICT, mark contradicts:[[{bm['id']}]] both ways so retrieval "
                      f"surfaces the dispute instead of serving one as truth.")
        return {**base, "action": action, "reason": reason}

    # GRAFT 2 support — code-grounded staleness signal. The refresh skill reads
    # this to decide Keep/Update/Replace/Delete: a page whose cited code paths
    # have vanished is drifting against ground truth, not just against the clock.
    def audit_refs(self, code_root: str | Path | None = None, stale_days: int = 180) -> dict[str, Any]:
        root_code = Path(code_root).expanduser().resolve() if code_root else self.root.parent
        today = date.today()
        skip_dirs = {"templates", "skills", "prompts", "hooks", "configs", "extensions", "adapters"}
        skip_names = {"index.md", "log.md", "schema.md", "L0_rules.md", "L1_index.md", "README.md"}
        out: list[dict[str, Any]] = []
        for page in self.pages():
            if page.id.startswith("raw/") or page.path.name in skip_names:
                continue
            rel_parts = set(page.path.relative_to(self.root).parts) if page.path.is_relative_to(self.root) else set()
            if rel_parts & skip_dirs:
                continue
            refs = sorted(extract_refs(page.body))
            if not refs:
                continue
            present, missing = [], []
            for ref in refs:
                if (root_code / ref).exists() or (self.root / ref).exists():
                    present.append(ref)
                else:
                    missing.append(ref)
            verified = page.frontmatter.get("verified", "").strip().strip("\"'")
            age_days = None
            if verified:
                try:
                    age_days = (today - date.fromisoformat(verified)).days
                except ValueError:
                    age_days = None
            protected = (
                page.frontmatter.get("type", "") in {"error", "lesson", "sop", "procedure"}
                or str(page.frontmatter.get("protected", "")).lower() == "true"
                or page.id.startswith("L3_sops/")
            )
            if missing:
                out.append({
                    "id": page.id,
                    "path": page.path.relative_to(self.root).as_posix(),
                    "type": page.type,
                    "missing_refs": missing,
                    "present_refs": present,
                    "missing_count": len(missing),
                    "ref_count": len(refs),
                    "verified": verified,
                    "age_days": age_days,
                    "protected": protected,
                    "signal": "all-refs-gone" if not present else "some-refs-gone",
                })
        out.sort(key=lambda c: (-c["missing_count"], c["id"]))
        return {
            "code_root": str(root_code),
            "scanned": len([p for p in self.pages() if not p.id.startswith("raw/")]),
            "drifted": out,
            "drifted_count": len(out),
        }

    # GRAFT 3 — discoverability. A curated store only compounds if a fresh /
    # plugin-less agent knows it exists, how to query it, and when. Check whether
    # a host instruction file surfaces the wiki; emit a snippet if not. (Installer-
    # managed CLAUDE/AGENTS/GEMINI get this automatically; this is for ad-hoc or
    # downstream-adopter instruction files outside the installer's reach.)
    DISCOVERABILITY_SNIPPET = (
        "## Durable memory store (`wiki/`)\n\n"
        "Curated knowledge store at `wiki/` (the why/decision/failure-lesson layer). "
        "Relevant when the task references past work, prior decisions, or \"have we done X\". "
        "Read `wiki/L1_index.md` first, then "
        "`python3 skills/wiki-memory/tools/wiki.py search \"<q>\"` → `timeline` → `fetch`.\n"
    )

    def discoverability(self, instruction_file: str | Path) -> dict[str, Any]:
        path = Path(instruction_file).expanduser()
        if not path.is_absolute():
            path = (self.root.parent / path)
        if not path.exists():
            # Don't nag for a file the project hasn't adopted.
            return {"file": str(path), "exists": False, "pass": None,
                    "reason": "instruction file not found — skipped", "suggested_snippet": None}
        text = path.read_text(encoding="utf-8", errors="replace").lower()
        names_store = any(s in text for s in ("wiki/", "wiki-memory", "l1_index", "wiki.py"))
        gives_query_cue = any(s in text for s in ("search", "retriev", "query", "timeline", "fetch", "l1_index"))
        passed = names_store and gives_query_cue
        if passed:
            reason = "instruction file surfaces the wiki store and how to query it"
        elif names_store:
            reason = "mentions the store but not how/when to query it"
        else:
            reason = "no mention of the wiki store — a fresh agent won't know to consult it"
        return {
            "file": str(path),
            "exists": True,
            "pass": passed,
            "reason": reason,
            "suggested_snippet": None if passed else self.DISCOVERABILITY_SNIPPET,
        }

    def new_page(self, template: str, title: str, domain: str = "framework", slug: str | None = None,
                 trust: str = DEFAULT_TRUST) -> dict[str, Any]:
        self.init()
        template_map = {
            "page": ("templates/page.template.md", "concepts"),
            "decision": ("templates/decision.template.md", "queries"),
            "handoff": ("templates/handoff.template.md", "L2_facts"),
            "source-summary": ("templates/source-summary.template.md", "raw"),
            "import-manifest": ("templates/import-manifest.template.md", "raw"),
        }
        if template not in template_map:
            raise KeyError(f"unknown template: {template}")
        template_rel, target_dir = template_map[template]
        template_path = self.root / template_rel
        if not template_path.exists():
            template_path = Path(__file__).resolve().parents[1] / template_rel
        content_template = template_path.read_text(encoding="utf-8")
        today = date.today().isoformat()
        page_slug = slugify(slug or title)
        filename = f"{today}-{page_slug}.md" if target_dir == "raw" else f"{page_slug}.md"
        target = self.root / target_dir / filename
        if target.exists():
            raise FileExistsError(target)
        content = render_template(
            content_template,
            {
                "title": title,
                "domain": domain,
                "date": today,
                "trust": trust if trust in TRUST_TIERS else DEFAULT_TRUST,
            },
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        self.append_log("update", title, f"Created `{target.relative_to(self.root).as_posix()}` from `{template}` template.")
        # M4 fix: was `self.index()` — full re-index on every page creation,
        # O(N) per `new` call. Now: incremental insert (O(1)); fall back to
        # full reindex if the DB doesn't exist yet. `te wiki index` remains
        # available for manual recovery if the incremental path ever drifts.
        self._invalidate_caches()
        if not self.db_path.exists():
            self.index()
        else:
            self._index_add_one(target)
        return {"created": target.relative_to(self.root).as_posix(), "template": template, "title": title}

    def _index_add_one(self, path: Path) -> None:
        """Append a single page to the existing sqlite index (M4)."""
        page = self.read_page(path)
        try:
            mtime = path.stat().st_mtime
        except OSError:
            mtime = 0.0
        with sqlite3.connect(self.db_path) as conn:
            tags = ",".join(page.tags)
            # ON CONFLICT REPLACE — handles edits to the same page later.
            conn.execute(
                "INSERT OR REPLACE INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    page.id,
                    page.path.relative_to(self.root).as_posix(),
                    page.title,
                    page.type,
                    tags,
                    page.preview,
                    page.body,
                    json.dumps(page.links),
                    mtime,
                ),
            )
            try:
                conn.execute("DELETE FROM docs_fts WHERE id = ?", (page.id,))
                conn.execute(
                    "INSERT INTO docs_fts VALUES (?, ?, ?, ?)",
                    (page.id, page.title, page.body, tags),
                )
            except sqlite3.OperationalError:
                pass  # fts5 not available; docs table is enough for fallback search

    def ingest(self, source: str, title: str | None = None) -> dict[str, Any]:
        self.init()
        today = date.today().isoformat()
        source_path = Path(source).expanduser()
        is_file = source_path.exists()
        note_title = title or (source_path.stem if is_file else source)
        slug = slugify(note_title)
        if is_file:
            body = source_path.read_text(encoding="utf-8", errors="replace")
            source_ref = source_path.as_posix()
        else:
            body = f"Source URL: {source}\n"
            source_ref = source
        safe_title = note_title.replace('"', '\\"')
        safe_source = source_ref.replace('"', '\\"')
        content = (
            "---\n"
            "schema_version: 2\n"
            f"title: \"{safe_title}\"\n"
            "type: raw\n"
            "domain: external-source\n"
            "tier: episodic\n"
            "confidence: 0.6\n"
            f"created: {today}\n"
            f"updated: {today}\n"
            f"verified: {today}\n"
            f"sources: [\"{safe_source}\"]\n"
            "supersedes: []\n"
            "superseded-by:\n"
            "contradicts: []\n"
            "tags: [ingest, raw]\n"
            "---\n\n"
            f"# {note_title}\n\n"
            f"{body}\n"
        )
        # H5 fix: previous code did `while target.exists(): i += 1` then
        # `target.write_text` — a TOCTOU window let two concurrent ingests
        # both pick `<date>-<slug>.md`, then one clobbered the other. Use
        # `open(..., "x")` (atomic O_EXCL create) in a retry loop instead.
        raw_dir = self.root / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        target = raw_dir / f"{today}-{slug}.md"
        i = 2
        while True:
            try:
                with open(target, "x", encoding="utf-8") as f:
                    f.write(content)
                break
            except FileExistsError:
                target = raw_dir / f"{today}-{slug}-{i}.md"
                i += 1
                if i > 10_000:
                    raise RuntimeError(f"could not find unused name for ingest: {slug}")
        self.append_log("ingest", note_title, f"Added raw source `{target.relative_to(self.root).as_posix()}`.")
        index_result = self.index()
        return {"created": target.relative_to(self.root).as_posix(), "indexed": index_result["indexed"]}

    def append_log(self, op: str, title: str, body: str) -> None:
        log_path = self.root / "log.md"
        if not log_path.exists():
            log_path.write_text("# Wiki Log\n\n", encoding="utf-8")
        entry = f"## [{date.today().isoformat()}] {op} | {title}\n\n{body}\n\n"
        with log_path.open("a", encoding="utf-8") as f:
            f.write(entry)


# ---------------------------------------------------------------------------
# CLI dispatcher.
#
# Exposes WikiStore methods so the commands referenced in
# skills/wiki-memory/SKILL.md actually work from the shell:
#
#   python3 wiki.py init                          # bootstrap ./wiki in cwd
#   python3 wiki.py init --root /path/to/wiki     # explicit target
#   python3 wiki.py search "auth race"            # progressive retrieval, tier 1
#   python3 wiki.py timeline <page-id>            # tier 2: backlinks + neighbors
#   python3 wiki.py fetch <page-id>               # tier 3: full page
#   python3 wiki.py new --template page --title "X" --domain framework
#   python3 wiki.py ingest <source-or-url> [--title T]
#   python3 wiki.py index                         # rebuild SQLite index
#   python3 wiki.py lint [--strict]               # stale claims, orphans, broken links
#
# All commands print JSON to stdout. `--root <path>` overrides the default
# (`./wiki` in cwd). Idempotent — `init` will not overwrite existing seed
# files; re-running it after pages are written is safe.
# ---------------------------------------------------------------------------


def _cli_default_root() -> Path:
    """Default wiki root: <cwd>/wiki. Honours WIKI_ROOT env var if set."""
    import os
    env = os.environ.get("WIKI_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.cwd() / "wiki").resolve()


def _cli_print(result: Any) -> None:
    print(json.dumps(result, indent=2, default=str))


def _cli_main(argv: list[str] | None = None) -> int:
    import argparse
    p = argparse.ArgumentParser(
        prog="wiki.py",
        description="Repo-local markdown wiki for agent memory — see "
                    "skills/wiki-memory/SKILL.md for the retrieval/write contract.",
    )
    p.add_argument("--root", default=None,
                   help="Wiki root dir (default: ./wiki in cwd, or $WIKI_ROOT)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Create the wiki dir tree + seed files. Idempotent.")

    sp = sub.add_parser("search", help="Tier 1: compact search hits.")
    sp.add_argument("query")
    sp.add_argument("-k", type=int, default=10)

    sp = sub.add_parser("timeline", help="Tier 2: backlinks, neighbors, log slice.")
    sp.add_argument("item_id")
    sp.add_argument("--window", type=int, default=3)

    sp = sub.add_parser("fetch", help="Tier 3: one full page.")
    sp.add_argument("item_id")

    sp = sub.add_parser("new", help="Create a new page from a template.")
    sp.add_argument("--template", required=True,
                    help="Template name (page, decision, handoff, source-summary, import-manifest)")
    sp.add_argument("--title", required=True)
    sp.add_argument("--domain", default="framework")
    sp.add_argument("--slug", default=None)
    sp.add_argument("--trust", default=DEFAULT_TRUST, choices=list(TRUST_TIERS),
                    help="Provenance trust tier for the new page (default asserted).")

    sp = sub.add_parser("ingest", help="Add a source (file path or URL) to raw/.")
    sp.add_argument("source")
    sp.add_argument("--title", default=None)

    sub.add_parser("index", help="Rebuild the SQLite search index.")

    sp = sub.add_parser("lint", help="Stale claims, orphans, broken links, duplicate titles, hub gravity-wells.")
    sp.add_argument("--strict", action="store_true",
                    help="Enforce v2 frontmatter on every page (not just v2/templated).")
    sp.add_argument("--stale-days", type=int, default=180,
                    help="Threshold for stale `verified:` in days (default 180).")
    sp.add_argument("--hub-threshold", type=int, default=20,
                    help="Inbound-link count above which a page is flagged as a gravity-well hub (default 20).")
    sp.add_argument("--scope", action="append", default=[],
                    help="Extra root (dir or .md file) to include in the lint pass. Repeatable. "
                         "Use for trees outside the wiki, e.g. --scope concepts --scope runbooks --scope designs/foo/ledger.md.")

    sp = sub.add_parser("import-audit", help="Validate an import manifest.")
    sp.add_argument("--manifest", required=True)

    sp = sub.add_parser("overlap", help="Dedup-at-write: score a candidate fact against existing pages (subject/tags/content/refs/links).")
    sp.add_argument("--title", required=True)
    sp.add_argument("--body", default="", help="Candidate body text.")
    sp.add_argument("--body-file", default=None, help="Read candidate body from a file (overrides --body).")
    sp.add_argument("--tags", default="", help="Comma-separated candidate tags.")
    sp.add_argument("-k", type=int, default=5)

    sp = sub.add_parser("resolve", help="Trust-gated conflict resolution: should a candidate fact replace / be rejected by / dispute an existing same-subject page? (poison defense)")
    sp.add_argument("--title", required=True)
    sp.add_argument("--body", default="", help="Candidate body text.")
    sp.add_argument("--body-file", default=None, help="Read candidate body from a file (overrides --body).")
    sp.add_argument("--tags", default="", help="Comma-separated candidate tags.")
    sp.add_argument("--trust", default=DEFAULT_TRUST, choices=list(TRUST_TIERS),
                    help="Provenance trust tier of the candidate (default asserted).")
    sp.add_argument("-k", type=int, default=5)

    sp = sub.add_parser("audit-refs", help="Code-grounded staleness: list pages whose cited code paths no longer exist.")
    sp.add_argument("--code-root", default=None, help="Repo root to resolve refs against (default: wiki root's parent).")
    sp.add_argument("--stale-days", type=int, default=180)

    sp = sub.add_parser("discoverability", help="Check whether a host instruction file surfaces the wiki store; emit a snippet if not.")
    sp.add_argument("--file", required=True, help="Instruction file to check (e.g. CLAUDE.md, AGENTS.md).")

    args = p.parse_args(argv)
    root = Path(args.root).expanduser().resolve() if args.root else _cli_default_root()
    store = WikiStore(root)

    if args.cmd == "init":
        _cli_print(store.init())
    elif args.cmd == "search":
        _cli_print(store.search(args.query, k=args.k))
    elif args.cmd == "timeline":
        _cli_print(store.timeline(args.item_id, window=args.window))
    elif args.cmd == "fetch":
        _cli_print(store.fetch(args.item_id))
    elif args.cmd == "new":
        _cli_print(store.new_page(args.template, args.title,
                                  domain=args.domain, slug=args.slug, trust=args.trust))
    elif args.cmd == "ingest":
        _cli_print(store.ingest(args.source, title=args.title))
    elif args.cmd == "index":
        _cli_print(store.index())
    elif args.cmd == "lint":
        _cli_print(store.lint_pages(
            strict=args.strict,
            stale_days=args.stale_days,
            hub_threshold=args.hub_threshold,
            extra_roots=args.scope or None,
        ))
    elif args.cmd == "import-audit":
        _cli_print(store.import_audit(args.manifest))
    elif args.cmd == "overlap":
        body = args.body
        if args.body_file:
            body = Path(args.body_file).expanduser().read_text(encoding="utf-8", errors="replace")
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        _cli_print(store.overlap(args.title, body=body, tags=tags, k=args.k))
    elif args.cmd == "resolve":
        body = args.body
        if args.body_file:
            body = Path(args.body_file).expanduser().read_text(encoding="utf-8", errors="replace")
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        _cli_print(store.resolve(args.title, body=body, trust=args.trust, tags=tags, k=args.k))
    elif args.cmd == "audit-refs":
        _cli_print(store.audit_refs(code_root=args.code_root, stale_days=args.stale_days))
    elif args.cmd == "discoverability":
        _cli_print(store.discoverability(args.file))
    else:  # unreachable — argparse enforces choices
        p.error(f"unknown subcommand: {args.cmd}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_cli_main())
