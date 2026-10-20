"""`lpcview app`: the viewer in a window of its own.

The HTTP server (server.py) runs on a free localhost port in a background thread;
a pywebview window (WebView2 on Windows) shows its page. The page reaches back
into Python through `window.pywebview.api` (the `Api` class here) to open the
native file dialog and add files to the server's catalog; closing the window
stops the server.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .server import LpcServer, find_files, make_server, start_in_thread

TITLE = "lpcview"
FILE_TYPES = ("LAS/LAZ point clouds (*.las;*.laz)", "All files (*.*)")

ChooseFiles = Callable[[], Sequence[str] | None]


class Api:
    """What the page may call: `window.pywebview.api.<method>()`.

    `choose` shows the file dialog and returns the chosen paths (None when
    cancelled); the window's own dialog in the app, anything in a test.
    """

    def __init__(self, server: LpcServer, choose: ChooseFiles) -> None:
        self._server = server
        self._choose = choose

    def open_files(self) -> dict[str, Any]:
        """Ask for files, add them to the catalog; the ids of the ones chosen, new or not."""
        chosen = self._choose()
        if not chosen:
            return {"cancelled": True, "added": [], "selected": []}
        paths = [Path(p) for p in chosen]
        try:
            added = self._server.catalog.add_files(paths)
        except FileNotFoundError as exc:
            return {"cancelled": False, "added": [], "selected": [], "error": f"not found: {exc}"}
        selected = self._server.catalog.ids_of(paths)
        return {"cancelled": False, "added": added, "selected": selected}

    def file_count(self) -> int:
        return len(self._server.catalog.files)


def _window_chooser(window: Any) -> ChooseFiles:
    import webview

    def choose() -> Sequence[str] | None:
        return window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True, file_types=FILE_TYPES)

    return choose


def run(paths: list[str | Path], max_loaded: int = 64, maximized: bool = True) -> int:
    """Start the server, open the window, and stop the server when the window closes."""
    import webview

    files = find_files(paths) if paths else []
    server = make_server(files, port=0, max_loaded=max_loaded, quiet=True)
    start_in_thread(server)
    try:
        window = webview.create_window(TITLE, server.url, maximized=maximized, width=1400, height=900,
                                       min_size=(640, 400), text_select=False)
        api = Api(server, _window_chooser(window))
        window.expose(api.open_files, api.file_count)
        webview.start()
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":  # a quick manual check: python -m lpcview.app <files>
    sys.exit(run(sys.argv[1:]))
