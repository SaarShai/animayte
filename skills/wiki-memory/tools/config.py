from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONFIG_NAME = "brainer.yaml"


@dataclass
class Config:
    repo_root: Path
    wiki_root: Path
    config_path: Path | None = None
    agent_adapter: str = "auto"
    context_max_tokens: int | str = "auto"
    refresh_threshold: float = 0.20
    default_scope: str = "project"
    profile: str = "ultra"
    reasoning_effort: str = "high"
    reply_style: str = "ultra"
    model_registry: Path | None = None
    external_adapters: list[str] | None = None
    output_filter_archive: bool = True
    output_filter_session_aware: bool = False
    output_filter_rules: Path | None = None


def find_repo_root(start: str | Path | None = None) -> Path:
    cur = Path(start or Path.cwd()).resolve()
    if cur.is_file():
        cur = cur.parent
    for candidate in (cur, *cur.parents):
        if (candidate / CONFIG_NAME).exists() or (candidate / ".git").exists():
            return candidate
    return cur


def find_config_path(repo_root: Path) -> Path | None:
    root_config = repo_root / CONFIG_NAME
    if root_config.exists():
        return root_config
    embedded_config = repo_root / "framework" / CONFIG_NAME
    if embedded_config.exists():
        return embedded_config
    return None


def resolve_config_path(value: str, repo_root: Path, config_dir: Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    root_path = repo_root / path
    config_path = config_dir / path
    if config_path.exists() and not root_path.exists():
        return config_path
    return root_path


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value in {"[]", "[ ]"}:
        return []
    if value.startswith("[") and value.endswith("]"):
        body = value[1:-1].strip()
        if not body:
            return []
        return [parse_scalar(part.strip()) for part in body.split(",")]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if value.lower() in {"auto", "none", "null"}:
        return "auto" if value.lower() == "auto" else None
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value.strip("\"'")


def load_simple_yaml(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    current_key: str | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line:
            continue
        if line.startswith((" ", "\t")) and current_key:
            item = line.strip()
            if item.startswith("- "):
                data.setdefault(current_key, [])
                if isinstance(data[current_key], list):
                    data[current_key].append(parse_scalar(item[2:]))
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            current_key = key.strip()
            value = value.strip()
            # An empty value is NOT an empty list — it means "key present, no
            # inline value". Block-style list items (if any) attach below via
            # setdefault; otherwise the key falls through to its typed default in
            # load_config. Forcing [] here made `refresh_threshold:` parse as []
            # and crash float([]), and flipped bool defaults via bool([]).
            if value != "":
                data[current_key] = parse_scalar(value)
    return data


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [value]


def load_config(repo_root: str | Path | None = None) -> Config:
    root = find_repo_root(repo_root)
    path = find_config_path(root)
    raw = load_simple_yaml(path) if path else {}
    config_dir = path.parent if path else root
    wiki_root_raw = raw.get("wiki_root", ".")
    wiki_root = resolve_config_path(str(wiki_root_raw), root, config_dir)
    model_registry_raw = raw.get("model_registry", "./models.yaml")
    model_registry = resolve_config_path(str(model_registry_raw), root, config_dir)
    output_filter_rules_raw = raw.get("output_filter_rules", ".brainer/output-filter-rules.txt")
    output_filter_rules = resolve_config_path(str(output_filter_rules_raw), root, config_dir)
    return Config(
        repo_root=root,
        wiki_root=wiki_root.resolve(),
        config_path=path,
        agent_adapter=str(raw.get("agent_adapter", "auto")),
        context_max_tokens=raw.get("context_max_tokens", "auto"),
        refresh_threshold=_as_float(raw.get("refresh_threshold", 0.20), 0.20),
        default_scope=str(raw.get("default_scope", "project")),
        profile=str(raw.get("profile", "ultra")),
        reasoning_effort=str(raw.get("reasoning_effort", "high")),
        reply_style=str(raw.get("reply_style", "ultra")),
        model_registry=model_registry,
        external_adapters=_as_list(raw.get("external_adapters")),
        output_filter_archive=bool(raw.get("output_filter_archive", True)),
        output_filter_session_aware=bool(raw.get("output_filter_session_aware", False)),
        output_filter_rules=output_filter_rules,
    )


def detect_agent() -> str:
    env = {k.lower() for k in __import__("os").environ}

    def host_key_contains(needle: str) -> bool:
        return any(needle in k and "api" not in k and "key" not in k and "token" not in k for k in env)

    if host_key_contains("codex"):
        return "codex"
    if host_key_contains("cursor"):
        return "cursor"
    if host_key_contains("gemini"):
        return "gemini"
    if host_key_contains("claude"):
        return "claude"
    return "codex"
