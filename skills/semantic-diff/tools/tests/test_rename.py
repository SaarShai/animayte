import tempfile
import os
import sys
from semdiff import read_smart

def run():
    with tempfile.TemporaryDirectory() as tmpdir:
        f = os.path.join(tmpdir, "w.py")
        
        # Create initial file
        with open(f, 'w') as fp:
            fp.write("def alpha(x): return x + 1\n")
        
        # First read
        _text, meta = read_smart(f, "sess")
        
        # Rewrite file
        with open(f, 'w') as fp:
            fp.write("def beta(x): return x + 1\n")
        
        # Second read
        _text2, meta2 = read_smart(f, "sess")
        
        assert ("alpha", "beta", 1.0) in meta2["renamed"]

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
    run()
    print("pass")
