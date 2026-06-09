"""Stress tests: JS, TS, Rust diff round-trip."""
import sys, tempfile, warnings
warnings.filterwarnings("ignore")
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from semdiff import read_smart, snapshot

JS = ("""
function alpha(x) { return x + 1; }
function beta(x) { return x * 2; }
class Widget {
  constructor() { this.v = 0; }
  render() { return String(this.v); }
  click() { this.v += 1; }
}
""",
"""
function alpha(x) { return x + 1; }
function beta(x) { return x * 4; }  // changed
function gamma(x) { return x - 3; } // added
class Widget {
  constructor() { this.v = 0; }
  render() { return `v=${this.v}`; }  // changed
  click() { this.v += 1; }
}
""")

TS = ("""
function alpha(x: number): number { return x + 1; }
interface Shape { area(): number; }
class Circle implements Shape {
  constructor(private r: number) {}
  area(): number { return Math.PI * this.r ** 2; }
}
""",
"""
function alpha(x: number): number { return x + 2; }  // changed
interface Shape { area(): number; perimeter(): number; }  // changed
class Circle implements Shape {
  constructor(private r: number) {}
  area(): number { return Math.PI * this.r ** 2; }
  perimeter(): number { return 2 * Math.PI * this.r; }  // added
}
""")

RUST = ("""
fn alpha(x: i32) -> i32 { x + 1 }
fn beta(x: i32) -> i32 { x * 2 }
struct Widget { v: i32 }
impl Widget {
    fn new() -> Self { Self { v: 0 } }
    fn render(&self) -> String { self.v.to_string() }
}
""",
"""
fn alpha(x: i32) -> i32 { x + 1 }
fn beta(x: i32) -> i32 { x * 4 }  // changed
fn gamma(x: i32) -> i32 { x - 3 }  // added
struct Widget { v: i32 }
impl Widget {
    fn new() -> Self { Self { v: 0 } }
    fn render(&self) -> String { format!("v={}", self.v) }  // changed
}
""")


def run_case(lang, ext, v1, v2):
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        f = td / f"w.{ext}"
        f.write_text(v1)
        s = snapshot(f)
        text1, meta1 = read_smart(f, "test", cache_dir=td/"cache")
        assert meta1["mode"] == "full"
        f.write_text(v2)
        text2, meta2 = read_smart(f, "test", cache_dir=td/"cache")
        assert meta2["mode"] == "diff"
        print(f"[{lang:<4}] nodes={len(s):<3} "
              f"+{len(meta2['added']):<2} ~{len(meta2['changed']):<2} "
              f"-{len(meta2['removed']):<2} ={len(meta2['unchanged']):<3} "
              f"full_len={len(v2):<4} diff_len={len(text2):<4}")
        return meta2


def run():
    print("snapshot keys sample:", list(snapshot(Path(__file__)))[:5])
    print()
    run_case("js", "js", *JS)
    run_case("ts", "ts", *TS)
    run_case("rust", "rs", *RUST)
    print("\nALL PASS")


if __name__ == "__main__":
    run()
