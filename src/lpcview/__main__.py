"""`python -m lpcview`, and the entry point of the one-file build (tools/build_exe.py)."""

import sys

from lpcview.cli import main

if __name__ == "__main__":
    sys.exit(main())
