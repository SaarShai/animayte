"""CLI: semdiff read <path> --session <id>"""
import argparse, sys
from pathlib import Path
from .core import read_smart


def main():
    ap = argparse.ArgumentParser(prog="semdiff")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("read")
    r.add_argument("path")
    r.add_argument("--session", required=True)
    r.add_argument("--cache-dir", default=None)
    r.add_argument("--meta", action="store_true", help="print metadata to stderr")

    c = sub.add_parser("clear")
    c.add_argument("--session", required=True)
    c.add_argument("--cache-dir", default=None)

    args = ap.parse_args()

    if args.cmd == "read":
        text, meta = read_smart(args.path, args.session,
                                 cache_dir=Path(args.cache_dir) if args.cache_dir else None)
        print(text)
        if args.meta:
            print(f"\n[meta] {meta}", file=sys.stderr)
    elif args.cmd == "clear":
        from .cache import SessionCache
        SessionCache(args.session,
                     cache_dir=Path(args.cache_dir) if args.cache_dir else None).clear()
        print(f"cleared session {args.session}")


if __name__ == "__main__":
    main()
