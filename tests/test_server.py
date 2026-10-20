import json
import struct
import threading
import urllib.request

import pytest

from lpcview.server import find_files, make_server
from tests.conftest import N_POINTS


@pytest.fixture(scope="module")
def server(sample_las, sample_laz):
    srv = make_server([sample_las, sample_laz], port=0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def get(url: str) -> tuple[int, bytes, str]:
    try:
        with urllib.request.urlopen(url) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")


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
        assert a.url == f"http://127.0.0.1:{pa}/"
        assert a.catalog.files == [sample_las]
    finally:
        a.server_close()
        b.server_close()


def test_catalog_add_files(sample_las, sample_laz, tmp_path):
    from lpcview.server import Catalog

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
    srv = make_server([sample_las], port=0)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        url = srv.url.rstrip("/")
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
    assert status == 200 and b"<title>lpcview</title>" in body
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
