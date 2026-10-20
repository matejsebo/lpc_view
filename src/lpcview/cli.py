"""Command line: `lpcview app [files]`, `lpcview serve <files or dirs>` and `lpcview info <file>`."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from . import __version__
from .reader import load_cloud, read_metadata
from .server import find_files, serve

COMMANDS = ("app", "serve", "info")


def normalise_argv(argv: list[str], frozen: bool = False) -> list[str]:
    """What the parser sees.

    The one-file build is double-clicked (no arguments) or given files by
    "Open with" (arguments that are paths, no command): both mean `app`. From
    the console, no arguments still prints the help.
    """
    if not argv:
        return ["app"] if frozen else argv
    first = argv[0]
    if first in COMMANDS or first.startswith("-"):
        return argv
    if all(os.path.exists(a) for a in argv):
        return ["app", *argv]
    return argv


def _fmt_int(n: int) -> str:
    return f"{n:,}"


def print_info(meta: dict[str, Any], stats: dict[str, Any] | None) -> None:
    h = meta["header"]
    f = meta["file"]
    print(f"{f['name']}  ({_fmt_int(f['size_bytes'])} bytes, {'LAZ' if f['compressed'] else 'LAS'})")
    print(f"  LAS {h['version']}, point format {h['point_data_record_format']}"
          f" ({h['point_data_record_length']} bytes), {_fmt_int(h['point_count'])} points")
    print(f"  system: {h['system_identifier']!r}  software: {h['generating_software']!r}"
          f"  created: {h['creation_date']}")
    print(f"  scale {h['scales']}  offset {h['offsets']}")
    print(f"  min {h['mins']}")
    print(f"  max {h['maxs']}")
    ex = h["extent"]
    print(f"  extent {ex[0]:.2f} x {ex[1]:.2f} x {ex[2]:.2f}, "
          f"{h['points_per_m2']:.2f} pts/m2" if h["points_per_m2"] else "")
    ret = [str(n) for n in h["number_of_points_by_return"] if n]
    print(f"  points by return: {', '.join(ret) or '-'}")
    crs = meta.get("crs")
    if crs and "name" in crs:
        print(f"  CRS: {crs['name']} (EPSG {crs.get('epsg')})")
        for c in crs.get("components", []):
            print(f"       {c['name']} (EPSG {c.get('epsg')})")
    elif crs:
        print(f"  CRS: {crs}")
    else:
        print("  CRS: none in file")
    print(f"  VLRs ({len(meta['vlrs'])}):")
    for v in meta["vlrs"]:
        print(f"    {v['user_id']}/{v['record_id']}  {v['description']!r}  {v['size_bytes']} bytes  [{v['kind']}]")
    print(f"  EVLRs ({len(meta['evlrs'])}):")
    for v in meta["evlrs"]:
        print(f"    {v['user_id']}/{v['record_id']}  {v['description']!r}  {v['size_bytes']} bytes  [{v['kind']}]")
    dims = ", ".join(d["name"] for d in meta["point_format"]["dimensions"])
    print(f"  dimensions: {dims}")
    if stats:
        print("  classification:")
        for row in stats["classification"]:
            print(f"    {row['value']:3d} {row['name']:<40} {_fmt_int(row['count']):>12}  {100 * row['fraction']:5.1f}%")
        z = stats["z"]
        print(f"  z: {z['min']:.2f} .. {z['max']:.2f}  mean {z['mean']:.2f}")
        it = stats["intensity"]
        print(f"  intensity: {it['min']:.0f} .. {it['max']:.0f}  p1 {it['percentiles']['1']:.0f}"
              f"  p99 {it['percentiles']['99']:.0f}")
        if "gps_time" in stats:
            g = stats["gps_time"]
            print(f"  gps time ({g['type']}): {g['min']:.3f} .. {g['max']:.3f}"
                  f"  ({g['span_seconds']:.0f} s)  {g['min_utc']} .. {g['max_utc']}")
        fl = stats["flags"]
        print(f"  flags: " + ", ".join(f"{k} {v}" for k, v in fl.items()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="lpcview", description="View and inspect LAS/LAZ point clouds.")
    parser.add_argument("--version", action="version", version=f"lpcview {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p_app = sub.add_parser("app", help="open the viewer in a window of its own")
    p_app.add_argument("paths", nargs="*", help="LAS/LAZ files or directories of them (none: a file dialog)")
    p_app.add_argument("--max-loaded", type=int, default=64,
                       help="how many decoded files to keep in memory at once (default 64)")
    p_app.add_argument("--no-maximize", action="store_true", help="open at 1400 x 900 instead of maximised")

    p_serve = sub.add_parser("serve", help="start the viewer on a local port")
    p_serve.add_argument("paths", nargs="+", help="LAS/LAZ files or directories of them")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.add_argument("--open", action="store_true", help="open the page in the default browser")
    p_serve.add_argument("--max-loaded", type=int, default=64,
                         help="how many decoded files to keep in memory at once (default 64)")

    p_info = sub.add_parser("info", help="print a file's metadata")
    p_info.add_argument("path")
    p_info.add_argument("--json", action="store_true", help="print the full metadata as JSON")
    p_info.add_argument("--stats", action="store_true", help="decode the points and print statistics too")

    argv = normalise_argv(sys.argv[1:] if argv is None else list(argv), frozen=getattr(sys, "frozen", False))
    args = parser.parse_args(argv)
    if args.command == "app":
        from .app import run

        try:
            return run(args.paths, max_loaded=args.max_loaded, maximized=not args.no_maximize)
        except FileNotFoundError as exc:
            print(f"lpcview: not found: {exc}", file=sys.stderr or sys.stdout)
            return 2
    if args.command == "serve":
        try:
            files = find_files(args.paths)
        except FileNotFoundError as exc:
            print(f"lpcview: not found: {exc}", file=sys.stderr)
            return 2
        if not files:
            print("lpcview: no LAS/LAZ files found", file=sys.stderr)
            return 2
        serve(files, host=args.host, port=args.port, open_browser=args.open, max_loaded=args.max_loaded)
        return 0
    if args.command == "info":
        meta = read_metadata(args.path)
        stats = load_cloud(args.path).stats() if args.stats else None
        if args.json:
            payload = {"meta": meta, "stats": stats} if stats else meta
            print(json.dumps(payload, indent=2))
        else:
            print_info(meta, stats)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
