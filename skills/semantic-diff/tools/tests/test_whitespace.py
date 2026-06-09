import tempfile
from pathlib import Path

from semdiff import read_smart


def run():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        f = root / "w.py"
        cache = root / "cache"
        f.write_text("def foo():\n    return 1\n")
        _text1, meta1 = read_smart(f, "sess", cache_dir=cache)
        assert meta1["mode"] == "full"

        f.write_text("def foo():\n        return 1\n")
        _text2, meta2 = read_smart(f, "sess", cache_dir=cache)
        assert "foo" in meta2["changed"]


if __name__ == "__main__":
    run()
    print("pass")
