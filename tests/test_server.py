import json
import socket
import struct
import threading
import urllib.request
from pathlib import Path

import pytest

from lpc_view.server import find_files, make_server
from tests.conftest import N_POINTS


TOKEN = "test-token"


@pytest.fixture(scope="module")
def server(sample_las, sample_laz):
    srv = make_server([sample_las, sample_laz], port=0, token=TOKEN)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def get(url: str, token: str | None = TOKEN, host: str | None = None) -> tuple[int, bytes, str]:
    status, body, headers = get_with_headers(url, token, host)
    return status, body, headers.get("Content-Type", "")


def get_with_headers(url: str, token: str | None = TOKEN, host: str | None = None):
    headers = {}
    if token:
        headers["X-Lpc-Token"] = token
    if host:
        headers["Host"] = host
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers


def test_only_this_machine_and_only_with_the_token(server):
    # No token: the page still comes, the API does not.
    assert get(server + "/", token=None)[0] == 200
    status, body, _ = get(server + "/api/files", token=None)
    assert status == 403 and "token" in json.loads(body)["error"]
    assert get(server + "/api/files", token="wrong")[0] == 403
    # The token may ride in the query (for download links).
    assert get(server + f"/api/files?token={TOKEN}", token=None)[0] == 200
    # A Host header that is not loopback (what DNS rebinding would send) is refused everywhere.
    assert get(server + "/", host="evil.example:80")[0] == 403
    assert get(server + "/api/files", host="evil.example")[0] == 403
    assert get(server + "/api/files", host="localhost:1")[0] == 200
    assert get(server + "/api/files", host="[::1]:1")[0] == 200
    # Binding anywhere but loopback is refused.
    with pytest.raises(ValueError):
        make_server([], host="0.0.0.0", port=0)


def test_find_files(sample_las, sample_laz, tmp_path):
    (tmp_path / "a.laz").write_bytes(b"")
    (tmp_path / "b.LAS").write_bytes(b"")
    (tmp_path / "c.txt").write_bytes(b"")
    found = find_files([tmp_path, sample_las, sample_las])
    assert [p.name for p in found] == ["a.laz", "b.LAS", "sample.las"]
    with pytest.raises(FileNotFoundError):
        find_files([tmp_path / "missing.laz"])


def test_make_server_takes_a_free_port(sample_las):
    a = make_server([sample_las], port=0)
    b = make_server([sample_las], port=0)
    try:
        pa, pb = a.server_address[1], b.server_address[1]
        assert pa != 0 and pb != 0 and pa != pb
        assert a.base_url == f"http://127.0.0.1:{pa}/"
        assert a.url == f"{a.base_url}?token={a.token}" and len(a.token) >= 24
        assert a.token != b.token
        assert a.catalog.files == [sample_las]
    finally:
        a.server_close()
        b.server_close()


def test_catalog_add_files(sample_las, sample_laz, tmp_path):
    from lpc_view.server import Catalog

    cat = Catalog([sample_las])
    assert cat.add_files([sample_las]) == []  # already there: no repeat
    assert cat.add_files([sample_laz]) == [1]
    assert cat.files == [sample_las, sample_laz] and len(cat._locks) == 2
    # A directory expands; files already present keep their ids.
    (tmp_path / "x.laz").write_bytes(sample_laz.read_bytes())
    (tmp_path / "y.las").write_bytes(sample_las.read_bytes())
    (tmp_path / "ignored.txt").write_bytes(b"")
    assert cat.add_files([tmp_path, sample_laz]) == [2, 3]
    assert [p.name for p in cat.files] == ["sample.las", "sample.laz", "x.laz", "y.las"]
    assert cat.ids_of([tmp_path / "y.las", sample_las, tmp_path / "ignored.txt"]) == [0, 3]
    with pytest.raises(FileNotFoundError):
        cat.add_files([tmp_path / "missing.laz"])
    assert len(cat.files) == 4
    # The new files work like the first ones: listing, metadata, points.
    rows = cat.listing()
    assert [r["id"] for r in rows] == [0, 1, 2, 3] and rows[2]["point_count"] == N_POINTS
    assert cat.meta(3)["file"]["name"] == "y.las"
    assert cat.cloud(2).count == N_POINTS and cat.cloud_set([0, 3]).count == 2 * N_POINTS


def test_add_files_shows_in_the_api(sample_las, sample_laz):
    srv = make_server([sample_las], port=0, token=TOKEN)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        url = srv.base_url.rstrip("/")
        assert len(json.loads(get(url + "/api/files")[1])) == 1
        assert srv.catalog.add_files([sample_laz]) == [1]
        files = json.loads(get(url + "/api/files")[1])
        assert [f["name"] for f in files] == ["sample.las", "sample.laz"]
        status, body, _ = get(url + "/api/load?file=1")
        assert status == 200 and json.loads(body)["point_count"] == N_POINTS
    finally:
        srv.shutdown()
        srv.server_close()


def test_static_and_files(server):
    status, body, ctype = get(server + "/")
    assert status == 200 and b"<title>lpc_view</title>" in body
    status, body, ctype = get(server + "/static/app.js")
    assert status == 200 and "javascript" in ctype
    status, body, _ = get(server + "/static/vendor/three.module.js")
    assert status == 200
    status, body, _ = get(server + "/api/files")
    files = json.loads(body)
    assert [f["name"] for f in files] == ["sample.las", "sample.laz"]
    assert files[0]["point_count"] == N_POINTS and files[0]["loaded"] is False


def test_meta_load_points_point(server):
    status, body, _ = get(server + "/api/meta?file=1")
    assert status == 200
    meta = json.loads(body)
    assert meta["file"]["compressed"] is True
    assert Path(meta["file"]["path"]).is_absolute()
    # The share-safe export: the same JSON with the path cut to the name.
    safe = json.loads(get(server + "/api/meta?file=1&safe=1")[1])
    assert safe["file"]["path"] == safe["file"]["name"] == "sample.laz"
    assert {**safe, "file": {**safe["file"], "path": meta["file"]["path"]}} == meta
    assert str(Path(meta["file"]["path"]).parent) not in json.dumps(safe)
    assert json.loads(get(server + "/api/meta?file=1&safe=0")[1]) == meta
    status, body, _ = get(server + "/api/load?file=1")
    info = json.loads(body)
    assert info["point_count"] == N_POINTS and info["files"] == [1]
    assert len(info["center"]) == 3
    assert info["stats"]["classification"][0]["count"] > 0
    status, body, ctype = get(server + "/api/points?file=1&start=0&count=100")
    assert status == 200 and ctype == "application/octet-stream"
    assert body[:4] == b"LPC2" and struct.unpack_from("<I", body, 4)[0] == 100
    assert struct.unpack_from("<III", body, 12) == (1, 0, 100)
    # Both files as one stream.
    status, body, _ = get(server + "/api/load?files=0,1,1")
    info = json.loads(body)
    assert info["files"] == [0, 1] and info["point_count"] == 2 * N_POINTS
    assert [f["count"] for f in info["stats"]["files"]] == [N_POINTS, N_POINTS]
    status, body, _ = get(server + "/api/points?files=0,1&start=0&count=100")
    count, _, _, nseg = struct.unpack_from("<IBBH", body, 4)
    assert count == 100 and nseg == 2
    assert struct.unpack_from("<III", body, 12) == (0, 0, 50)
    assert struct.unpack_from("<III", body, 24) == (1, 0, 50)
    status, body, _ = get(server + "/api/point?file=1&i=3")
    rec = json.loads(body)
    assert rec["stream_index"] == 3
    assert "latitude" in rec and -123.5 < rec["longitude"] < -121.0
    assert 37.0 < rec["latitude"] < 38.5
    status, body, _ = get(server + "/api/files")
    assert json.loads(body)[1]["loaded"] is True


def test_errors_are_json(server):
    status, body, _ = get(server + "/api/meta?file=9")
    assert status == 400 and "error" in json.loads(body)
    status, body, _ = get(server + "/api/points?file=0&start=0&count=2000001")
    assert status == 400 and "count" in json.loads(body)["error"]
    assert get(server + "/api/points?file=0&start=0&count=2000000")[0] == 200
    assert get(server + "/api/points?file=0&start=-1&count=10")[0] == 400
    status, body, _ = get(server + "/api/load?files=0,9")
    assert status == 400
    status, body, _ = get(server + "/api/load?files=")
    assert status == 400
    status, body, _ = get(server + "/api/point?file=0&i=999999")
    assert status == 400
    status, body, _ = get(server + "/api/nothing")
    assert status == 404 and "error" in json.loads(body)
    status, _, _ = get(server + "/nothing.html")
    assert status == 404
    # No directory listings: the static tree is served file by file only.
    for path in ("/static/", "/static", "/static/vendor/", "/static/vendor"):
        status, body, _ = get(server + path)
        assert status == 404 and b"Directory listing" not in body, path


def test_eviction_keeps_a_set_whole_and_drops_sets_with_their_clouds(sample_las, sample_laz, tmp_path):
    from lpc_view.server import Catalog

    (tmp_path / "c.las").write_bytes(sample_las.read_bytes())
    cat = Catalog([sample_las, sample_laz, tmp_path / "c.las"], max_loaded=2)
    # A set larger than max_loaded is refused (400 through the API) rather than evicting its own clouds.
    with pytest.raises(ValueError):
        cat.cloud_set([0, 1, 2])
    pair = cat.cloud_set([1, 2])
    assert set(cat._clouds) == {1, 2} and (1, 2) in cat._sets
    # Loading a third cloud evicts the least recently used one, and the set that held it.
    cat.cloud(1)  # 1 is now more recent than 2
    cat.cloud(0)
    assert set(cat._clouds) == {0, 1} and (1, 2) not in cat._sets
    # The set comes back on its next use, with its missing cloud decoded again.
    again = cat.cloud_set([1, 2])
    assert again is not pair and again.count == pair.count
    assert set(cat._clouds) == {1, 2}  # 0 went to make room for 2, not 1: the set's own clouds are kept
    assert cat.cloud_set([1, 2]) is again


def test_load_refuses_more_files_than_max_loaded(sample_las, sample_laz):
    srv = make_server([sample_las, sample_laz], port=0, token=TOKEN, max_loaded=1)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        url = srv.base_url.rstrip("/")
        status, body, _ = get(url + "/api/load?files=0,1")
        assert status == 400 and "max-loaded" in json.loads(body)["error"]
        assert get(url + "/api/load?files=1")[0] == 200
    finally:
        srv.shutdown()
        srv.server_close()


def test_busy_port_is_a_one_line_message(sample_las, capsys):
    from lpc_view.cli import main

    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen()
        port = taken.getsockname()[1]
        assert main(["serve", str(sample_las), "--port", str(port)]) == 2
    err = capsys.readouterr().err
    assert err.count("\n") == 1 and f"port {port}" in err and "--port" in err


def test_every_response_carries_the_safety_headers(server):
    for path, token in (("/", None), ("/static/app.js", None), ("/api/files", TOKEN), ("/api/files", None),
                        ("/api/points?file=0&count=10", TOKEN), ("/nothing.html", None), ("/static/", None)):
        status, _, headers = get_with_headers(server + path, token=token)
        assert headers["Referrer-Policy"] == "no-referrer", (path, status)
        assert headers["X-Content-Type-Options"] == "nosniff", (path, status)


def test_listing_reads_each_header_once_until_the_file_changes(sample_las, sample_laz, tmp_path, monkeypatch):
    import os

    import laspy

    from lpc_view.server import Catalog

    opened = []
    real_open = laspy.open
    monkeypatch.setattr(laspy, "open", lambda p, *a, **k: opened.append(Path(p).name) or real_open(p, *a, **k))
    cat = Catalog([sample_las, sample_laz])
    first = cat.listing()
    assert opened == ["sample.las", "sample.laz"]
    assert cat.listing() == first and opened == ["sample.las", "sample.laz"]  # cached
    cat.cloud(1)  # decoding opens the file too, once
    assert cat.listing()[1]["loaded"] is True  # but `loaded` is live
    assert opened == ["sample.las", "sample.laz", "sample.laz"]
    opened.clear()
    # A changed file (newer mtime) is read again; an added file is read on its first listing.
    copy = tmp_path / "c.las"
    copy.write_bytes(sample_las.read_bytes())
    assert cat.add_files([copy]) == [2]
    st = sample_laz.stat()
    os.utime(sample_laz, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))
    rows = cat.listing()
    assert [r["name"] for r in rows] == ["sample.las", "sample.laz", "c.las"] and rows[2]["point_count"] == N_POINTS
    assert opened == ["sample.laz", "c.las"]
    assert cat.listing() == rows and len(opened) == 2
