"""Round-trip tests. Run: python3 -m tests.test_basic"""
import sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from semdiff import snapshot, render_diff, read_smart
from semdiff.cache import SessionCache

PY_V1 = """
def alpha(x):
    return x + 1

def beta(x):
    return x * 2

def gamma(x):
    return x - 3

class Widget:
    def __init__(self):
        self.v = 0
    def render(self):
        return str(self.v)
    def click(self):
        self.v += 1
"""

PY_V2 = """
def alpha(x):
    return x + 1

def beta(x):
    # CHANGED body
    return x * 4

def gamma(x):
    return x - 3

def delta(x):  # ADDED
    return x / 2

class Widget:
    def __init__(self):
        self.v = 0
    def render(self):
        # CHANGED
        return f"v={self.v}"
    def click(self):
        self.v += 1
"""


def run():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        f = td / "w.py"
        f.write_text(PY_V1)

        # Test snapshot
        s1 = snapshot(f)
        assert "alpha" in s1 and "Widget.render" in s1, s1
        print("✓ snapshot extracts top-level fns + methods:", list(s1.keys()))

        # Test first read = full
        cache_dir = td / "cache"
        text1, meta1 = read_smart(f, session_id="test", cache_dir=cache_dir)
        assert meta1["mode"] == "full"
        assert "def alpha" in text1
        print(f"✓ first read: mode={meta1['mode']}, len={len(text1)}")

        # Modify file
        f.write_text(PY_V2)

        # Second read = diff
        text2, meta2 = read_smart(f, session_id="test", cache_dir=cache_dir)
        assert meta2["mode"] == "diff"
        assert "delta" in meta2["added"], meta2
        assert "beta" in meta2["changed"] and "Widget.render" in meta2["changed"], meta2
        assert "alpha" in meta2["unchanged"], meta2
        print(f"✓ diff read: +{meta2['added']}  ~{meta2['changed']}  -{meta2['removed']}")

        # Token economy check
        full_len = len(PY_V2)
        diff_len = len(text2)
        print(f"\n  FULL len={full_len}  DIFF len={diff_len}  ratio={diff_len/full_len:.1%}")
        print("\n--- diff output ---")
        print(text2)

        # Third read (same file) = diff with everything unchanged
        text3, meta3 = read_smart(f, session_id="test", cache_dir=cache_dir)
        assert meta3["mode"] == "diff"
        assert meta3["changed"] == [] and meta3["added"] == []
        print(f"\n✓ stable re-read: 0 changes, diff-len={len(text3)}")

    print("\nALL PASS")


if __name__ == "__main__":
    run()
