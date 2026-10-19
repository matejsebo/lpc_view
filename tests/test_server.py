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
    assert info["point_count"] == N_POINTS
    assert len(info["center"]) == 3
    assert info["stats"]["classification"][0]["count"] > 0
    status, body, ctype = get(server + "/api/points?file=1&start=0&count=100")
    assert status == 200 and ctype == "application/octet-stream"
    assert body[:4] == b"LPC1" and struct.unpack_from("<I", body, 4)[0] == 100
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
    status, body, _ = get(server + "/api/point?file=0&i=999999")
    assert status == 400
    status, body, _ = get(server + "/api/nothing")
    assert status == 404 and "error" in json.loads(body)
    status, _, _ = get(server + "/nothing.html")
    assert status == 404
