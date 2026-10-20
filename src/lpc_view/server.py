"""The local HTTP server behind the viewer: static files plus a small JSON/binary API.

Routes:
  GET /                         the viewer page
  GET /static/<file>            its scripts, styles and the vendored three.js
  GET /api/files                the files on offer: id, name, size, point count
  GET /api/meta?file=<id>       header, VLRs, EVLRs, CRS (no point decoding)
  GET /api/load?files=<id,id,..>
                                decode those files (once each); returns the merged
                                statistics, point count and centre. At most
                                --max-loaded files in one set (400 above it).
  GET /api/points?files=<id,..>&start=<n>&count=<n>
                                a binary chunk of the merged stream (reader.CloudSet);
                                count at most MAX_POINTS_PER_REQUEST (400 above it)
  GET /api/point?file=<id>&i=<index in that file's shuffled order>
                                every attribute of one point, exact, with lat/lon
  GET /api/sha256?file=<id>     the file's SHA-256 (slow on big files)

The server is a local tool, not a host: it binds only to a loopback address, it
answers only requests whose Host header is one (so a web page cannot reach it
through DNS rebinding), and every /api/ request must carry the token the server
made at start (`X-Lpc-Token` header, or `token=` in the query), which only the
page opened from the printed URL knows. Other programs and users on the machine,
and any page from the internet, get 403.
"""

from __future__ import annotations

import json
import mimetypes
import secrets
import sys
import threading
import time
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import laspy

from .reader import CloudSet, PointCloud, file_sha256, load_cloud, read_metadata

STATIC_DIR = Path(__file__).parent / "static"
LAS_SUFFIXES = {".las", ".laz"}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
TOKEN_HEADER = "X-Lpc-Token"
MAX_POINTS_PER_REQUEST = 2_000_000  # one /api/points chunk; the page asks for 500,000


def find_files(paths: list[str | Path]) -> list[Path]:
    """Expand files and directories (non-recursive) to the LAS/LAZ files in them."""
    out: list[Path] = []
    for p in paths:
        p = Path(p)
        if p.is_dir():
            out.extend(sorted(q for q in p.iterdir() if q.suffix.lower() in LAS_SUFFIXES))
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(p)
    seen: set[Path] = set()
    unique: list[Path] = []
    for p in out:
        r = p.resolve()
        if r not in seen:
            seen.add(r)
            unique.append(p)
    return unique


class Catalog:
    """The files on offer and the clouds decoded so far, with one lock per file.

    At most `max_loaded` clouds stay decoded; past that the least recently used
    goes, and any cached CloudSet that held it goes with it (the set is rebuilt,
    and the cloud decoded again, on its next use). A set never has more than
    `max_loaded` files, so building one cannot evict its own clouds.
    """

    def __init__(self, files: list[Path], max_loaded: int = 64) -> None:
        self.files = files
        self.max_loaded = max(1, max_loaded)
        self._clouds: dict[int, PointCloud] = {}
        self._sets: dict[tuple[int, ...], CloudSet] = {}
        self._meta: dict[int, dict[str, Any]] = {}
        self._rows: dict[int, tuple[tuple[str, int, int], dict[str, Any]]] = {}  # listing rows by (path, mtime, size)
        self._locks = [threading.Lock() for _ in files]
        self._recent: list[int] = []
        self._transformers: dict[int, Any] = {}
        self._files_lock = threading.Lock()

    def add_files(self, paths: list[str | Path]) -> list[int]:
        """Put more files (or directories of them) on offer; returns the ids of the new ones.

        A file already in the catalog keeps its id and is not repeated. Ids are
        positions in `files`, so existing ids never change.
        """
        new_ids: list[int] = []
        with self._files_lock:
            known = {p.resolve() for p in self.files}
            for p in find_files(paths):
                r = p.resolve()
                if r in known:
                    continue
                known.add(r)
                self.files.append(p)
                self._locks.append(threading.Lock())
                new_ids.append(len(self.files) - 1)
                self._rows.pop(new_ids[-1], None)
        return new_ids

    def ids_of(self, paths: list[str | Path]) -> list[int]:
        """The ids of those paths, for the ones in the catalog."""
        wanted = {Path(p).resolve() for p in paths}
        return [i for i, p in enumerate(self.files) if p.resolve() in wanted]

    def listing(self) -> list[dict[str, Any]]:
        """One row per file. The header is read once per (path, mtime, size); only
        `loaded` is fresh on every call."""
        rows = []
        for i, p in enumerate(self.files):
            try:
                st = p.stat()
                key = (str(p), st.st_mtime_ns, st.st_size)
            except OSError as exc:
                key = (str(p), -1, -1)
                st = None
            cached = self._rows.get(i)
            if cached is None or cached[0] != key:
                if st is None:
                    count, pf, version = -1, -1, f"error: {exc}"
                else:
                    try:
                        with laspy.open(p) as r:
                            count = int(r.header.point_count)
                            pf = int(r.header.point_format.id)
                            version = str(r.header.version)
                    except Exception as exc:  # noqa: BLE001
                        count, pf, version = -1, -1, f"error: {exc}"
                row = {
                    "id": i,
                    "name": p.name,
                    "path": str(p),
                    "size_bytes": st.st_size if st else -1,
                    "point_count": count,
                    "point_format": pf,
                    "version": version,
                }
                self._rows[i] = cached = (key, row)
            rows.append({**cached[1], "loaded": i in self._clouds})
        return rows

    def meta(self, i: int) -> dict[str, Any]:
        if i not in self._meta:
            self._meta[i] = read_metadata(self.files[i])
        return self._meta[i]

    def cloud(self, i: int, keep: tuple[int, ...] = ()) -> PointCloud:
        """The decoded cloud `i`; `keep` names clouds that must not be evicted to make room."""
        with self._locks[i]:
            if i not in self._clouds:
                t0 = time.perf_counter()
                cloud = load_cloud(self.files[i])
                cloud.stats()
                self._clouds[i] = cloud
                print(
                    f"[lpc_view] decoded {self.files[i].name}: {cloud.count} points"
                    f" in {time.perf_counter() - t0:.1f} s"
                )
                self._evict(keep={i, *keep})
        if i in self._recent:
            self._recent.remove(i)
        self._recent.append(i)
        return self._clouds[i]

    def _evict(self, keep: set[int]) -> None:
        while len(self._clouds) > self.max_loaded:
            victim = next((k for k in self._recent if k not in keep and k in self._clouds), None)
            if victim is None:
                break
            del self._clouds[victim]
            self._recent.remove(victim)
            self._transformers.pop(victim, None)
            self._sets = {key: v for key, v in self._sets.items() if victim not in key}
            print(f"[lpc_view] released {self.files[victim].name}")

    def cloud_set(self, ids: list[int]) -> CloudSet:
        """The clouds of `ids` as one stream; decoded on first use, cached as a set."""
        if len(ids) > self.max_loaded:
            raise ValueError(f"{len(ids)} files in one set; at most {self.max_loaded} (--max-loaded) can be loaded at once")
        key = tuple(ids)
        if key not in self._sets:
            clouds = [self.cloud(i, keep=key) for i in ids]
            cs = CloudSet(list(ids), clouds)
            cs.stats()
            self._sets[key] = cs
        return self._sets[key]

    def lonlat(self, i: int, x: float, y: float) -> tuple[float, float] | None:
        """WGS84 longitude/latitude of a point, when the file's CRS is known."""
        if i not in self._transformers:
            self._transformers[i] = self._make_transformer(i)
        tr = self._transformers[i]
        if tr is None:
            return None
        try:
            lon, lat = tr.transform(x, y)
        except Exception:  # noqa: BLE001
            return None
        return (float(lon), float(lat))

    def _make_transformer(self, i: int) -> Any:
        try:
            import pyproj

            with laspy.open(self.files[i]) as r:
                crs = r.header.parse_crs()
            if crs is None:
                return None
            if crs.is_compound and crs.sub_crs_list:
                crs = crs.sub_crs_list[0]
            return pyproj.Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        except Exception:  # noqa: BLE001
            return None


class Handler(SimpleHTTPRequestHandler):
    catalog: Catalog
    quiet: bool
    token: str

    def __init__(self, *args: Any, catalog: Catalog, token: str, quiet: bool = False, **kwargs: Any) -> None:
        self.catalog = catalog
        self.token = token
        self.quiet = quiet
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    # -- who may ask ---------------------------------------------------------------

    def _host_is_loopback(self) -> bool:
        host = (self.headers.get("Host") or "").strip()
        if host.startswith("["):  # [::1]:port
            host = host[1:].split("]", 1)[0]
        else:
            host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
        return host.lower() in LOOPBACK_HOSTS

    def _authorised(self, q: dict[str, list[str]]) -> bool:
        given = self.headers.get(TOKEN_HEADER) or (q.get("token") or [""])[0]
        return bool(given) and secrets.compare_digest(given, self.token)

    def end_headers(self) -> None:  # on every response, static files and errors included
        self.send_header("Referrer-Policy", "no-referrer")  # the token rides in the page's URL
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def list_directory(self, path: Any) -> None:  # no directory listings of static/
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter console
        if self.quiet or sys.stderr is None:  # no console in the windowed build
            return
        if args and isinstance(args[0], str) and "/api/points" in args[0]:
            return
        super().log_message(fmt, *args)

    # -- helpers ---------------------------------------------------------------

    def _send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str = "application/octet-stream") -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file_id(self, q: dict[str, list[str]]) -> int:
        i = int(q.get("file", ["0"])[0])
        if not 0 <= i < len(self.catalog.files):
            raise IndexError(i)
        return i

    def _file_ids(self, q: dict[str, list[str]]) -> list[int]:
        """`files=0,3,4` (or a single `file=`), in order, without repeats."""
        raw = q.get("files", q.get("file", ["0"]))[0]
        ids: list[int] = []
        for part in raw.split(","):
            part = part.strip()
            if not part:
                continue
            i = int(part)
            if not 0 <= i < len(self.catalog.files):
                raise IndexError(i)
            if i not in ids:
                ids.append(i)
        if not ids:
            raise ValueError("no files given")
        return ids

    # -- routing ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        parts = urlsplit(self.path)
        if not self._host_is_loopback():
            self._send_json({"error": "lpc_view answers only on this machine"}, HTTPStatus.FORBIDDEN)
            return
        if parts.path == "/":
            self.path = "/index.html"
            return super().do_GET()
        if parts.path.startswith("/static/"):
            self.path = parts.path[len("/static") :]
            if Path(self.translate_path(self.path)).is_dir():  # files only, no index or listing
                self.send_error(HTTPStatus.NOT_FOUND)
                return None
            return super().do_GET()
        if parts.path.startswith("/api/"):
            q = parse_qs(parts.query, keep_blank_values=True)
            if not self._authorised(q):
                self._send_json({"error": "missing or wrong token: open the page from the URL lpc_view printed"},
                                HTTPStatus.FORBIDDEN)
                return
            try:
                self._api(parts.path[len("/api/") :], q)
            except (IndexError, ValueError, KeyError) as exc:
                self._send_json({"error": f"bad request: {exc}"}, HTTPStatus.BAD_REQUEST)
            except FileNotFoundError as exc:
                self._send_json({"error": f"not found: {exc}"}, HTTPStatus.NOT_FOUND)
            except Exception as exc:  # noqa: BLE001 - report, don't crash the thread
                self._send_json({"error": f"{type(exc).__name__}: {exc}"},
                                HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _api(self, route: str, q: dict[str, list[str]]) -> None:
        cat = self.catalog
        if route == "files":
            self._send_json(cat.listing())
        elif route == "meta":
            self._send_json(cat.meta(self._file_id(q)))
        elif route == "load":
            ids = self._file_ids(q)
            cs = cat.cloud_set(ids)
            self._send_json(
                {
                    "files": ids,
                    "point_count": cs.count,
                    "center": [float(v) for v in cs.center],
                    "stats": cs.stats(),
                }
            )
        elif route == "points":
            ids = self._file_ids(q)
            start = int(q.get("start", ["0"])[0])
            count = int(q.get("count", ["1000000"])[0])
            if not 0 <= count <= MAX_POINTS_PER_REQUEST:
                raise ValueError(f"count must be 0..{MAX_POINTS_PER_REQUEST}")
            if start < 0:
                raise ValueError("start must not be negative")
            self._send_bytes(cat.cloud_set(ids).pack_chunk(start, count))
        elif route == "point":
            i = self._file_id(q)
            k = int(q.get("i", ["0"])[0])
            rec = cat.cloud(i).point_record(k)
            ll = cat.lonlat(i, rec["x"], rec["y"])
            if ll is not None:
                rec["longitude"], rec["latitude"] = ll
            self._send_json(rec)
        elif route == "sha256":
            i = self._file_id(q)
            self._send_json({"sha256": file_sha256(cat.files[i])})
        else:
            self._send_json({"error": "no such route"}, HTTPStatus.NOT_FOUND)


class LpcServer(ThreadingHTTPServer):
    """The HTTP server with its catalog and token attached."""

    catalog: Catalog
    token: str

    @property
    def base_url(self) -> str:
        host, port = self.server_address[:2]
        return f"http://{host}:{port}/"

    @property
    def url(self) -> str:
        """The page's URL with the token: the one to open, and the only one that works."""
        return f"{self.base_url}?token={self.token}"


def make_server(files: list[Path], host: str = "127.0.0.1", port: int = 8765, max_loaded: int = 64,
                quiet: bool = False, token: str | None = None) -> LpcServer:
    """Bind the server on a loopback address. `port=0` takes a free port.

    The token (a fresh random one unless given, as the tests do) must come with
    every API request; `server.url` carries it for the page.
    """
    if host not in LOOPBACK_HOSTS:
        raise ValueError(f"lpc_view serves only this machine; {host!r} is not a loopback address")
    mimetypes.add_type("application/javascript", ".js")
    catalog = Catalog(list(files), max_loaded=max_loaded)
    token = token or secrets.token_urlsafe(24)
    handler = partial(Handler, catalog=catalog, token=token, quiet=quiet)
    server = LpcServer((host, port), handler)
    server.catalog = catalog
    server.token = token
    server.daemon_threads = True
    return server


def start_in_thread(server: LpcServer) -> threading.Thread:
    """Serve on a daemon thread; `server.shutdown()` stops it."""
    thread = threading.Thread(target=server.serve_forever, name="lpc_view-http", daemon=True)
    thread.start()
    return thread


def serve(files: list[Path], port: int = 8765, open_browser: bool = False, max_loaded: int = 64) -> None:
    server = make_server(files, port=port, max_loaded=max_loaded)
    url = server.url
    print(f"[lpc_view] serving {len(files)} file(s) at {url}")
    print("[lpc_view] only this machine can reach it, and only through that URL (its token)")
    for p in files:
        print(f"[lpc_view]   {p}")
    sys.stdout.flush()  # the URL must appear at once, even when stdout is a pipe
    if open_browser:
        import webbrowser

        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[lpc_view] stopped")
    finally:
        server.server_close()
