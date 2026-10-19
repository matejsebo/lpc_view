"""The local HTTP server behind the viewer: static files plus a small JSON/binary API.

Routes:
  GET /                         the viewer page
  GET /static/<file>            its scripts, styles and the vendored three.js
  GET /api/files                the files on offer: id, name, size, point count
  GET /api/meta?file=<id>       header, VLRs, EVLRs, CRS (no point decoding)
  GET /api/load?files=<id,id,..>
                                decode those files (once each); returns the merged
                                statistics, point count and centre
  GET /api/points?files=<id,..>&start=<n>&count=<n>
                                a binary chunk of the merged stream (reader.CloudSet)
  GET /api/point?file=<id>&i=<index in that file's shuffled order>
                                every attribute of one point, exact, with lat/lon
  GET /api/sha256?file=<id>     the file's SHA-256 (slow on big files)
"""

from __future__ import annotations

import json
import mimetypes
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
    """The files on offer and the clouds decoded so far, with one lock per file."""

    def __init__(self, files: list[Path], max_loaded: int = 64) -> None:
        self.files = files
        self.max_loaded = max(1, max_loaded)
        self._clouds: dict[int, PointCloud] = {}
        self._sets: dict[tuple[int, ...], CloudSet] = {}
        self._meta: dict[int, dict[str, Any]] = {}
        self._locks = [threading.Lock() for _ in files]
        self._recent: list[int] = []
        self._transformers: dict[int, Any] = {}

    def listing(self) -> list[dict[str, Any]]:
        rows = []
        for i, p in enumerate(self.files):
            try:
                with laspy.open(p) as r:
                    count = int(r.header.point_count)
                    pf = int(r.header.point_format.id)
                    version = str(r.header.version)
            except Exception as exc:  # noqa: BLE001
                count, pf, version = -1, -1, f"error: {exc}"
            rows.append(
                {
                    "id": i,
                    "name": p.name,
                    "path": str(p),
                    "size_bytes": p.stat().st_size,
                    "point_count": count,
                    "point_format": pf,
                    "version": version,
                    "loaded": i in self._clouds,
                }
            )
        return rows

    def meta(self, i: int) -> dict[str, Any]:
        if i not in self._meta:
            self._meta[i] = read_metadata(self.files[i])
        return self._meta[i]

    def cloud(self, i: int) -> PointCloud:
        with self._locks[i]:
            if i not in self._clouds:
                t0 = time.perf_counter()
                cloud = load_cloud(self.files[i])
                cloud.stats()
                self._clouds[i] = cloud
                print(
                    f"[lpcview] decoded {self.files[i].name}: {cloud.count} points"
                    f" in {time.perf_counter() - t0:.1f} s"
                )
                self._evict(keep=i)
        if i in self._recent:
            self._recent.remove(i)
        self._recent.append(i)
        return self._clouds[i]

    def _evict(self, keep: int) -> None:
        while len(self._clouds) > self.max_loaded:
            victim = next((k for k in self._recent if k != keep and k in self._clouds), None)
            if victim is None:
                break
            del self._clouds[victim]
            self._recent.remove(victim)
            self._transformers.pop(victim, None)
            self._sets = {key: v for key, v in self._sets.items() if victim not in key}
            print(f"[lpcview] released {self.files[victim].name}")

    def cloud_set(self, ids: list[int]) -> CloudSet:
        """The clouds of `ids` as one stream; decoded on first use, cached as a set."""
        key = tuple(ids)
        if key not in self._sets:
            clouds = [self.cloud(i) for i in ids]
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

    def __init__(self, *args: Any, catalog: Catalog, **kwargs: Any) -> None:
        self.catalog = catalog
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:  # quieter console
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
        if parts.path == "/":
            self.path = "/index.html"
            return super().do_GET()
        if parts.path.startswith("/static/"):
            self.path = parts.path[len("/static") :]
            return super().do_GET()
        if parts.path.startswith("/api/"):
            try:
                self._api(parts.path[len("/api/") :], parse_qs(parts.query, keep_blank_values=True))
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


def make_server(files: list[Path], host: str = "127.0.0.1", port: int = 8765, max_loaded: int = 64) -> ThreadingHTTPServer:
    catalog = Catalog(files, max_loaded=max_loaded)
    handler = partial(Handler, catalog=catalog)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server


def serve(files: list[Path], host: str = "127.0.0.1", port: int = 8765, open_browser: bool = False, max_loaded: int = 64) -> None:
    mimetypes.add_type("application/javascript", ".js")
    server = make_server(files, host, port, max_loaded=max_loaded)
    url = f"http://{host}:{server.server_address[1]}/"
    print(f"[lpcview] serving {len(files)} file(s) at {url}")
    for p in files:
        print(f"[lpcview]   {p}")
    if open_browser:
        import webbrowser

        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[lpcview] stopped")
    finally:
        server.server_close()
