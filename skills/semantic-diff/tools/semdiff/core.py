"""AST extraction + diff. Language-agnostic via tree-sitter."""
from __future__ import annotations
import hashlib
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

warnings.filterwarnings("ignore", category=FutureWarning)
from tree_sitter_languages import get_parser

# Language-specific node types to extract. (type, name_field)
# name_field is the child field whose text gives the node's identifier.
LANG_NODES = {
    "python": {
        "function_definition": "name",
        "class_definition": "name",
    },
    "javascript": {
        "function_declaration": "name",
        "method_definition": "name",
        "class_declaration": "name",
    },
    "typescript": {
        "function_declaration": "name",
        "method_definition": "name",
        "class_declaration": "name",
        "interface_declaration": "name",
    },
    "rust": {
        "function_item": "name",
        "struct_item": "name",
        "enum_item": "name",
        "trait_item": "name",
        "impl_item": None,   # name derived from type
    },
}

EXT_LANG = {
    ".py": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".rs": "rust",
}


@dataclass
class Node:
    name: str          # fully-qualified name e.g. "ClassName.method"
    kind: str          # tree-sitter node type
    start: int         # byte offset
    end: int
    source: bytes
    hash: str
    line_start: int    # 1-indexed
    line_end: int


def detect_lang(path: str | Path) -> Optional[str]:
    return EXT_LANG.get(Path(path).suffix.lower())


def _node_name(node, source: bytes, kind_map) -> Optional[str]:
    """Best-effort name from a tree-sitter node."""
    field = kind_map.get(node.type)
    if field is None:
        # Rust impl: name = "impl <type>"
        if node.type == "impl_item":
            ty = node.child_by_field_name("type")
            if ty:
                return "impl_" + source[ty.start_byte:ty.end_byte].decode("utf-8", "replace")
        return None
    child = node.child_by_field_name(field)
    if child is None:
        return None
    return source[child.start_byte:child.end_byte].decode("utf-8", "replace")


def _strip_comment_bytes(node, source: bytes) -> bytes:
    """Comment-stripped body of an AST node, using tree-sitter comment NODES.

    The previous flat regex (`#...`, `//...`, `/* */`) was not string-aware, so a
    comment marker INSIDE a string literal (e.g. a URL `"http://x"` or `"#ff0000"`)
    was stripped — collapsing genuinely-different bodies to the same hash and
    hiding real changes under ignore_comments=True. tree-sitter knows what is a
    comment vs a string, so masking comment node spans is correct across langs
    (python `comment`, js/ts `comment`, rust `line_comment`/`block_comment`).
    """
    base = node.start_byte
    body = source[node.start_byte:node.end_byte]
    spans: list[tuple[int, int]] = []

    def walk(n):
        if "comment" in n.type:
            spans.append((n.start_byte - base, n.end_byte - base))
        for c in n.children:
            walk(c)

    walk(node)
    if not spans:
        return body.strip()
    spans.sort()
    out = bytearray()
    cursor = 0
    for s, e in spans:
        if s > cursor:
            out += body[cursor:s]
        cursor = max(cursor, e)
    if cursor < len(body):
        out += body[cursor:]
    return bytes(out).strip()


def _header_slice(parent: "Node", nodes: list["Node"]) -> str | None:
    """Declaration/header region of a parent: its bytes up to the first direct
    member. Returns None if the parent has no direct member node (then the caller
    falls back to rendering the full body). Used to surface class-level changes
    without re-dumping member bodies that are emitted separately."""
    pref = parent.name + "."
    kids = [n for n in nodes
            if n.name.startswith(pref) and "." not in n.name[len(pref):]]
    if not kids:
        return None
    cut = min(n.start for n in kids) - parent.start
    if cut <= 0:
        return None
    return parent.source[:cut].decode("utf-8", "replace").rstrip()


def extract_nodes(source: bytes, lang: str, ignore_comments: bool = False) -> list[Node]:
    """Walk AST, extract top-level + nested definitions with qualified names.

    If ignore_comments=True, hash is computed on comment-stripped body so that
    comment-only edits don't register as changes.
    """
    parser = get_parser(lang)
    tree = parser.parse(source)
    kind_map = LANG_NODES[lang]
    out: list[Node] = []

    def walk(ts_node, prefix: str):
        for child in ts_node.children:
            if child.type in kind_map:
                nm = _node_name(child, source, kind_map)
                if nm:
                    qname = f"{prefix}{nm}" if prefix else nm
                    body = source[child.start_byte:child.end_byte]
                    hash_body = _strip_comment_bytes(child, source) if ignore_comments else body
                    h = hashlib.sha1(hash_body).hexdigest()[:12]
                    out.append(Node(
                        name=qname, kind=child.type,
                        start=child.start_byte, end=child.end_byte,
                        source=body, hash=h,
                        line_start=child.start_point[0] + 1,
                        line_end=child.end_point[0] + 1,
                    ))
                    # recurse into class/impl bodies for methods
                    body_node = child.child_by_field_name("body")
                    if body_node:
                        walk(body_node, f"{qname}.")
                    continue
            walk(child, prefix)

    walk(tree.root_node, "")
    return out


def snapshot(path: str | Path, ignore_comments: bool = False) -> dict[str, str]:
    """{qualified_name → hash} for a file. Used for diff baseline."""
    path = Path(path)
    lang = detect_lang(path)
    if not lang:
        raise ValueError(f"unsupported extension: {path.suffix}")
    source = path.read_bytes()
    nodes = extract_nodes(source, lang, ignore_comments=ignore_comments)
    return {n.name: n.hash for n in nodes}


def snapshot_full(path: str | Path, ignore_comments: bool = False) -> dict[str, dict]:
    """Extended snapshot: {qname: {hash, body_b64}}. Used when rename detection is desired."""
    import base64
    path = Path(path)
    lang = detect_lang(path)
    if not lang:
        raise ValueError(f"unsupported extension: {path.suffix}")
    source = path.read_bytes()
    nodes = extract_nodes(source, lang, ignore_comments=ignore_comments)
    return {n.name: {"hash": n.hash,
                      "body": base64.b64encode(n.source).decode("ascii")}
            for n in nodes}


def render_diff(path: str | Path, prev: dict[str, str]) -> tuple[str, dict]:
    """Compare current file vs prev snapshot; render diff view.

    Returns (rendered_text, metadata).
    metadata has: added, removed, changed, unchanged (lists of names).
    """
    path = Path(path)
    lang = detect_lang(path)
    source = path.read_bytes()
    nodes = extract_nodes(source, lang)
    curr = {n.name: n.hash for n in nodes}
    by_name = {n.name: n for n in nodes}

    # Backward-compat: prev may be {name: hash} OR {name: {hash, body}}.
    def _prev_hash(v): return v["hash"] if isinstance(v, dict) else v
    prev_hashes = {k: _prev_hash(v) for k, v in prev.items()}

    added = [n for n in curr if n not in prev_hashes]
    removed = [n for n in prev_hashes if n not in curr]
    changed = [n for n in curr if n in prev_hashes and curr[n] != prev_hashes[n]]
    unchanged = [n for n in curr if n in prev_hashes and curr[n] == prev_hashes[n]]

    # Rename detection: if prev has bodies, try to match added↔removed by body similarity.
    renames = []
    if added and removed and any(isinstance(v, dict) and "body" in v for v in prev.values()):
        try:
            import base64
            from .rename_detect import detect_renames
            prev_snap_short = {k: _prev_hash(v) for k, v in prev.items() if k in removed}
            curr_snap_short = {n.name: n.hash for n in nodes if n.name in added}
            prev_bodies = {k: base64.b64decode(v["body"])
                            for k, v in prev.items() if isinstance(v, dict) and "body" in v and k in removed}
            curr_bodies = {n.name: n.source for n in nodes if n.name in added}
            rename_results = detect_renames(prev_snap_short, curr_snap_short, prev_bodies, curr_bodies)
            # Strong-confidence renames only (≥0.7 per lib threshold)
            for old_name, new_name, conf in rename_results:
                if conf >= 0.7:
                    renames.append((old_name, new_name, conf))
            # remove renamed names from added/removed
            renamed_old = {o for o, _, _ in renames}
            renamed_new = {n for _, n, _ in renames}
            added = [n for n in added if n not in renamed_new]
            removed = [n for n in removed if n not in renamed_old]
        except Exception:
            pass  # rename detection is best-effort

    lines = [f"// semdiff: {path} (lang={lang}, diff-since-last-read)"]
    lines.append(f"// summary: +{len(added)} ~{len(changed)} -{len(removed)} ={len(unchanged)} "
                 f"(renamed: {len(renames)})")
    lines.append("")

    for old_name, new_name, conf in renames:
        lines.append(f"// [renamed: {old_name} → {new_name}  conf={conf:.2f}]")
    if renames:
        lines.append("")

    for nm in removed:
        lines.append(f"// [removed: {nm}]")
    if removed:
        lines.append("")

    # emit changed + added in file order
    emit_set = set(changed) | set(added)
    # A parent (class/impl) whose members are emitted separately is rendered
    # HEADER-ONLY (declaration + leading class-level lines, up to the first
    # member) instead of its full body. This avoids re-dumping member bodies
    # while still surfacing class-level changes — a changed base class, decorator,
    # leading class constant, or a brand-new class's signature. The old code
    # deleted such parents from emit_set entirely, silently dropping every
    # class-level change whenever a member also changed.
    def has_emitted_member(name):
        pref = name + "."
        return any(other != name and other.startswith(pref) for other in emit_set)
    header_only = {n for n in emit_set if has_emitted_member(n)}
    emit = [n for n in nodes if n.name in emit_set]
    emit.sort(key=lambda n: n.start)

    unchanged_set = set(unchanged)
    emitted_unchanged_stub = False

    last_end_line = 0
    for n in emit:
        # Stub unchanged nodes between last and this one
        between = [u for u in nodes
                   if u.name in unchanged_set
                   and u.start < n.start
                   and u.line_start > last_end_line]
        if between:
            names = [u.name for u in between[:5]]
            more = len(between) - 5
            stub = ", ".join(names) + (f", +{more} more" if more > 0 else "")
            lines.append(f"// [unchanged: {stub}]")
            lines.append("")

        tag = "ADDED" if n.name in added else "CHANGED"
        hdr = _header_slice(n, nodes) if n.name in header_only else None
        if hdr is not None:
            lines.append(f"// --- {tag}: {n.name} (header; members below) (L{n.line_start}) ---")
            lines.append(hdr)
            lines.append("")
            # advance only past the header so members between aren't over-stubbed
            last_end_line = n.line_start
        else:
            lines.append(f"// --- {tag}: {n.name} (L{n.line_start}-{n.line_end}) ---")
            lines.append(n.source.decode("utf-8", "replace"))
            lines.append("")
            last_end_line = n.line_end

    # trailing unchanged stub
    trailing = [u for u in nodes if u.name in unchanged_set and u.line_start > last_end_line]
    if trailing:
        names = [u.name for u in trailing[:5]]
        more = len(trailing) - 5
        stub = ", ".join(names) + (f", +{more} more" if more > 0 else "")
        lines.append(f"// [unchanged: {stub}]")

    meta = {
        "added": added, "removed": removed,
        "changed": changed, "unchanged": unchanged,
        "renamed": renames,
        "lang": lang, "node_count": len(nodes),
    }
    return "\n".join(lines), meta


def read_smart(path: str | Path, session_id: str, cache_dir: Optional[Path] = None) -> tuple[str, dict]:
    """Main entry. First read: return full file + store snapshot.
    Subsequent: return diff view.
    """
    from .cache import SessionCache
    path = Path(path).resolve()
    cache = SessionCache(session_id, cache_dir=cache_dir)
    prev = cache.get(str(path))

    if prev is None:
        source = path.read_bytes().decode("utf-8", "replace")
        cache.set(str(path), snapshot_full(path))  # store bodies for future rename detection
        return source, {"mode": "full", "reason": "first-read"}

    rendered, meta = render_diff(path, prev)
    # rewrite snapshot fully (simpler than incremental merge, avoids staleness)
    cache.set(str(path), snapshot_full(path))
    meta["mode"] = "diff"
    return rendered, meta
