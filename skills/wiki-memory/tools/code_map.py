from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tokens import estimate_tokens


CODE_EXTS = {".py", ".js", ".jsx", ".ts", ".tsx", ".sh", ".bash", ".zsh"}
SKIP_PARTS = {".git", ".brainer", "__pycache__", ".pytest_cache", "node_modules", ".venv", "venv", "dist", "build"}
IMPORT_RE = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.,\s{}*]+)|(?:const|let|var)\s+.*=\s+require\(['\"]([^'\"]+)['\"]\))", re.MULTILINE)
JS_SYMBOL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|^\s*(?:export\s+)?(?:class|interface|type)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=",
    re.MULTILINE,
)
SHELL_SYMBOL_RE = re.compile(r"^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{", re.MULTILINE)


@dataclass
class Symbol:
    name: str
    kind: str
    line: int
    signature: str = ""

    def as_dict(self) -> dict[str, Any]:
        out = {"name": self.name, "kind": self.kind, "line": self.line}
        if self.signature:
            out["signature"] = self.signature
        return out


@dataclass
class FileMap:
    path: str
    language: str
    tokens: int
    imports: list[str] = field(default_factory=list)
    symbols: list[Symbol] = field(default_factory=list)
    reason: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "language": self.language,
            "tokens": self.tokens,
            "imports": self.imports[:20],
            "symbols": [symbol.as_dict() for symbol in self.symbols[:40]],
            "reason": self.reason,
        }


def iter_code_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        if path.suffix in CODE_EXTS:
            files.append(path)
    return sorted(files)


def language_for(path: Path) -> str:
    if path.suffix == ".py":
        return "python"
    if path.suffix in {".js", ".jsx", ".ts", ".tsx"}:
        return "javascript"
    if path.suffix in {".sh", ".bash", ".zsh"}:
        return "shell"
    return path.suffix.removeprefix(".") or "text"


def python_signature(node: ast.AST) -> str:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [arg.arg for arg in node.args.args]
        if node.args.vararg:
            args.append("*" + node.args.vararg.arg)
        args.extend(arg.arg for arg in node.args.kwonlyargs)
        if node.args.kwarg:
            args.append("**" + node.args.kwarg.arg)
        return f"{node.name}({', '.join(args)})"
    if isinstance(node, ast.ClassDef):
        bases = [getattr(base, "id", "") or getattr(base, "attr", "") for base in node.bases]
        bases = [base for base in bases if base]
        return f"{node.name}({', '.join(bases)})" if bases else node.name
    return ""


def parse_python(text: str) -> tuple[list[str], list[Symbol]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return [], []
    imports: list[str] = []
    symbols: list[Symbol] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imports.append(node.module or "")
        elif isinstance(node, ast.ClassDef):
            symbols.append(Symbol(node.name, "class", node.lineno, python_signature(node)))
        elif isinstance(node, ast.FunctionDef):
            symbols.append(Symbol(node.name, "function", node.lineno, python_signature(node)))
        elif isinstance(node, ast.AsyncFunctionDef):
            symbols.append(Symbol(node.name, "async_function", node.lineno, python_signature(node)))
    return sorted({item for item in imports if item}), sorted(symbols, key=lambda item: item.line)


def parse_regex_symbols(text: str, language: str) -> tuple[list[str], list[Symbol]]:
    imports = sorted({match.group(1) or match.group(2) or match.group(3) for match in IMPORT_RE.finditer(text) if match.group(1) or match.group(2) or match.group(3)})
    symbols: list[Symbol] = []
    if language == "javascript":
        for match in JS_SYMBOL_RE.finditer(text):
            name = next(group for group in match.groups() if group)
            line = text.count("\n", 0, match.start()) + 1
            symbols.append(Symbol(name, "symbol", line))
    elif language == "shell":
        for match in SHELL_SYMBOL_RE.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            symbols.append(Symbol(match.group(1), "function", line))
    return imports, symbols


def map_file(root: Path, path: Path) -> FileMap:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    language = language_for(path)
    if language == "python":
        imports, symbols = parse_python(text)
    else:
        imports, symbols = parse_regex_symbols(text, language)
    return FileMap(path=rel, language=language, tokens=estimate_tokens(text), imports=imports, symbols=symbols)


def relevance_score(file_map: FileMap, query: str) -> tuple[int, str]:
    if not query:
        return 1, "all"
    tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9_/-]+", query) if len(token) > 1]
    haystack = " ".join(
        [
            file_map.path,
            file_map.language,
            " ".join(file_map.imports),
            " ".join(symbol.name for symbol in file_map.symbols),
        ]
    ).lower()
    hits = [token for token in tokens if token in haystack]
    return len(hits), f"matched:{','.join(hits[:6])}" if hits else "no-match"


def code_map(root: str | Path, query: str = "", max_files: int = 20, max_symbols: int = 200) -> dict[str, Any]:
    base = Path(root).expanduser().resolve()
    mapped: list[tuple[int, FileMap]] = []
    scanned = 0
    for path in iter_code_files(base):
        scanned += 1
        file_map = map_file(base, path)
        score, reason = relevance_score(file_map, query)
        if score <= 0:
            continue
        file_map.reason = reason
        mapped.append((score, file_map))
    mapped.sort(key=lambda item: (-item[0], item[1].path))

    files = []
    symbol_count = 0
    for _, file_map in mapped[:max_files]:
        remaining = max(0, max_symbols - symbol_count)
        kept = FileMap(file_map.path, file_map.language, file_map.tokens, file_map.imports, file_map.symbols[:remaining], file_map.reason)
        files.append(kept.as_dict())
        symbol_count += len(kept.symbols)
        if symbol_count >= max_symbols:
            break
    return {
        "root": str(base),
        "query": query,
        "scanned_files": scanned,
        "matched_files": len(mapped),
        "returned_files": len(files),
        "symbol_count": symbol_count,
        "token_estimate": estimate_tokens(str(files)),
        "files": files,
    }
