import tempfile
from pathlib import Path

from semdiff import read_smart


def run():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        f = root / "bad.py"
        cache = root / "cache"
        f.write_text("def ok():\n    return 1\n")
        _text1, meta1 = read_smart(f, "sess", cache_dir=cache)
        assert meta1["mode"] == "full"

        f.write_text("def broken(\n    return 1\n")
        _text2, meta2 = read_smart(f, "sess", cache_dir=cache)
        assert meta2["mode"] == "diff"
        assert "ok" in meta2["removed"]


if __name__ == "__main__":
    run()
    print("pass")
