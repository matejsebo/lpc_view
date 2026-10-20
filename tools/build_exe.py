"""Build dist/lpcview.exe: one file, no console, the page and the vendored three.js inside.

    uv run python tools/build_exe.py

PyInstaller collects the Python side (laspy with its lazrs backend, numpy, pyproj
with its PROJ database, pywebview with pythonnet); `--add-data` puts
src/lpcview/static next to the package, where server.STATIC_DIR looks for it.
The exe runs `lpcview.cli.main`: double-clicked or given files it opens the
window (`app`); `serve` and `info` still work from a console but print nothing
in this windowed build, so use the uv install for those.
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
STATIC = SRC / "lpcview" / "static"
ENTRY = SRC / "lpcview" / "__main__.py"
DIST = ROOT / "dist"
BUILD = ROOT / "build"


def main(argv: list[str]) -> int:
    console = "--console" in argv
    args = [
        str(ENTRY),
        "--name", "lpcview",
        "--onefile",
        "--noconfirm",
        "--clean",
        "--paths", str(SRC),
        "--distpath", str(DIST),
        "--workpath", str(BUILD / "pyinstaller"),
        "--specpath", str(BUILD),
        "--add-data", f"{STATIC}{';' if sys.platform == 'win32' else ':'}lpcview/static",
        "--hidden-import", "lazrs",  # laspy imports its LAZ backend lazily
        "--collect-submodules", "lpcview",
        # Not used by lpcview; dropping them keeps the exe smaller and the start quicker.
        "--exclude-module", "tkinter",
        "--exclude-module", "unittest",
        "--exclude-module", "pydoc",
    ]
    args.append("--console" if console else "--windowed")
    t0 = time.perf_counter()
    PyInstaller.__main__.run(args)
    exe = DIST / ("lpcview.exe" if sys.platform == "win32" else "lpcview")
    if not exe.exists():
        print("build failed: no exe produced", file=sys.stderr)
        return 1
    print(f"built {exe} ({exe.stat().st_size / 1048576:.1f} MB) in {time.perf_counter() - t0:.0f} s")
    if "--keep-build" not in argv:
        shutil.rmtree(BUILD / "pyinstaller", ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
