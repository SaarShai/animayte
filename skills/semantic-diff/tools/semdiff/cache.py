"""Session-scoped snapshot cache. File-backed JSON for persistence across process runs."""
from __future__ import annotations
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Optional


def _safe_session_filename(session_id: str) -> str:
    """Hash the session_id when it contains path-unsafe chars (/, .., null) so
    the cache file always lands inside cache_dir. Keeps a readable prefix for
    well-formed UUID-ish ids."""
    if not session_id or any(c in session_id for c in ("/", "\\", "\x00")) or ".." in session_id:
        return hashlib.sha256((session_id or "unknown").encode("utf-8", "replace")).hexdigest()[:16] + ".json"
    return f"{session_id}.json"


class SessionCache:
    def __init__(self, session_id: str, cache_dir: Optional[Path] = None):
        self.session_id = session_id
        repo_root = Path(os.environ.get("TOKEN_ECONOMY_ROOT", Path.cwd()))
        self.cache_dir = Path(cache_dir) if cache_dir else repo_root / ".brainer" / "semdiff"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.cache_dir / _safe_session_filename(session_id)
        self._data = self._load()

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        # A corrupt/truncated session file used to crash every subsequent MCP
        # call for this session_id. Recover by archiving the bad file and
        # starting fresh — the next snapshot will repopulate.
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            try:
                self.path.replace(self.path.with_suffix(".json.corrupt"))
            except OSError:
                pass
            sys.stderr.write(f"semdiff: session cache corrupt at {self.path} ({e!r}); reset\n")
            return {}

    def _save(self):
        self.path.write_text(json.dumps(self._data, indent=2), encoding="utf-8")

    def get(self, file_path: str) -> Optional[dict]:
        return self._data.get(file_path)

    def set(self, file_path: str, snapshot: dict):
        self._data[file_path] = snapshot
        self._save()

    def clear(self):
        self._data = {}
        self._save()
