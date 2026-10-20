"""Build lpc_view with PyInstaller: the page and the vendored three.js inside, no console.

    uv run python tools/build_exe.py            # one file:  dist/lpc_view.exe
    uv run python tools/build_exe.py --onedir   # one folder: dist/lpc_view/lpc_view.exe

One file is a single exe that unpacks itself into a temporary folder at every
start: the handiest to pass around, but slower to start and the kind of
self-extracting program antivirus heuristics flag most often. One folder is the
exe next to its libraries in dist/lpc_view/: zip and ship the folder; it starts
faster and gets far fewer false positives.

PyInstaller collects the Python side (laspy with its lazrs backend, numpy, pyproj
with its PROJ database, pywebview with pythonnet); `--add-data` puts
src/lpc_view/static next to the package, where server.STATIC_DIR looks for it.
The exe runs `lpc_view.cli.main`: double-clicked or given files it opens the
window (`app`); `serve` and `info` still work from a console but print nothing
in this windowed build (`--console` builds a variant that does), so use the uv
install for those. `--keep-build` keeps PyInstaller's work directory.
"""

from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
STATIC = SRC / "lpc_view" / "static"
ENTRY = SRC / "lpc_view" / "__main__.py"
DIST = ROOT / "dist"
BUILD = ROOT / "build"
EXE = "lpc_view.exe" if sys.platform == "win32" else "lpc_view"


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def main(argv: list[str]) -> int:
    onedir = "--onedir" in argv
    console = "--console" in argv
    args = [
        str(ENTRY),
        "--name", "lpc_view",
        "--onedir" if onedir else "--onefile",
        "--console" if console else "--windowed",
        "--noconfirm",
        "--clean",
        "--paths", str(SRC),
        "--distpath", str(DIST),
        "--workpath", str(BUILD / "pyinstaller"),
        "--specpath", str(BUILD),
        "--add-data", f"{STATIC}{';' if sys.platform == 'win32' else ':'}lpc_view/static",
        "--hidden-import", "lazrs",  # laspy imports its LAZ backend lazily
        "--collect-submodules", "lpc_view",
        # Not used by lpc_view; dropping them keeps the exe smaller and the start quicker.
        "--exclude-module", "tkinter",
        "--exclude-module", "unittest",
        "--exclude-module", "pydoc",
    ]
    # Both layouts share dist/; clear the other one's output so the two never mix.
    shutil.rmtree(DIST / "lpc_view", ignore_errors=True)
    (DIST / EXE).unlink(missing_ok=True)
    t0 = time.perf_counter()
    PyInstaller.__main__.run(args)
    seconds = time.perf_counter() - t0
    if onedir:
        folder = DIST / "lpc_view"
        exe = folder / EXE
        if not exe.exists():
            print(f"build failed: no {exe} produced", file=sys.stderr)
            return 1
        print(f"built {folder}{Path('/')} ({dir_size(folder) / 1048576:.1f} MB, "
              f"{sum(1 for p in folder.rglob('*') if p.is_file())} files) in {seconds:.0f} s")
        print(f"one folder: run or ship the whole folder; the exe is {exe}")
    else:
        exe = DIST / EXE
        if not exe.exists():
            print(f"build failed: no {exe} produced", file=sys.stderr)
            return 1
        print(f"built {exe} ({exe.stat().st_size / 1048576:.1f} MB) in {seconds:.0f} s")
        print("one file: the exe unpacks itself at every start; "
              "--onedir builds a folder that starts faster")
    if "--keep-build" not in argv:
        shutil.rmtree(BUILD / "pyinstaller", ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
