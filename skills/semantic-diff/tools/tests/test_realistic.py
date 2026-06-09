"""Realistic benchmark: argparse.py (~2500 lines). Modify 2 methods. Compare."""
import sys, tempfile, shutil, warnings
warnings.filterwarnings("ignore")
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tiktoken
from semdiff import read_smart

ARGPARSE = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/lib/python3.9/argparse.py"
ENC = tiktoken.get_encoding("cl100k_base")

def tok(s): return len(ENC.encode(s))


def run():
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        f = td / "argparse.py"
        shutil.copy(ARGPARSE, f)
        orig_src = f.read_text()
        orig_toks = tok(orig_src)

        # First read
        text1, meta1 = read_smart(f, "sess", cache_dir=td/"cache")
        t1 = tok(text1)
        print(f"FIRST  read: mode={meta1['mode']} tokens={t1} (full file baseline)")

        # Modify: change 2 methods — inject a comment in format_help and add_argument
        src = orig_src
        src = src.replace(
            "def format_help(self):",
            "def format_help(self):\n        # SEMDIFF-TEST modification",
            1)
        src = src.replace(
            "def add_argument(self, *args, **kwargs):",
            "def add_argument(self, *args, **kwargs):\n        # SEMDIFF-TEST edit",
            1)
        f.write_text(src)

        # Second read (diff)
        text2, meta2 = read_smart(f, "sess", cache_dir=td/"cache")
        t2 = tok(text2)
        reread_full_toks = tok(src)

        print(f"\nNaive re-read would send: {reread_full_toks} tokens")
        print(f"SECOND read (diff)      : {t2} tokens")
        print(f"Savings vs naive reread : {1 - t2/reread_full_toks:.1%}")
        print(f"\nChanged: {meta2['changed']}")
        print(f"Added  : {meta2['added']}")
        print(f"Removed: {meta2['removed']}")
        print(f"Unchanged count: {len(meta2['unchanged'])}")

        # Show first ~40 lines of diff
        print("\n--- first 40 lines of diff output ---")
        for ln in text2.splitlines()[:40]:
            print(ln)

        # Third read: no changes
        text3, meta3 = read_smart(f, "sess", cache_dir=td/"cache")
        t3 = tok(text3)
        print(f"\nTHIRD  read (no changes): {t3} tokens (stubs only)")
        print(f"Savings vs naive reread : {1 - t3/reread_full_toks:.1%}")


if __name__ == "__main__":
    run()
