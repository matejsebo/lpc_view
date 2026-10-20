import json
import struct

import numpy as np

from lpc_view import reader
from lpc_view.classes import class_color, class_name
from lpc_view.reader import (
    CHUNK_MAGIC,
    CloudSet,
    FLAG_WITHHELD,
    gps_time_to_utc,
    load_cloud,
    read_metadata,
)
from tests.conftest import N_POINTS


def test_class_table():
    assert class_name(2) == "Ground"
    assert class_name(30) == "Reserved"
    assert class_name(100) == "User definable"
    assert class_color(2) == (166, 118, 62)
    r, g, b = class_color(77)
    assert 0 <= r <= 255 and 0 <= g <= 255 and 0 <= b <= 255
    assert class_color(77) == class_color(77)


def test_gps_time_to_utc():
    # 334339325.246 adjusted standard GPS time is 2022-04-18 17:48 UTC (a USGS 3DEP flight).
    assert gps_time_to_utc(334339325.246, "standard").startswith("2022-04-18T17:48:27")
    assert gps_time_to_utc(1234.5, "week") is None


def test_metadata_is_complete_and_json_safe(sample_las):
    meta = read_metadata(sample_las)
    json.dumps(meta)  # every value serialises
    h = meta["header"]
    assert h["version"] == "1.4"
    assert h["point_count"] == N_POINTS
    assert h["point_data_record_format"] == 6
    assert h["scales"] == [0.01, 0.01, 0.01]
    assert h["offsets"][0] == 600000.0
    assert h["global_encoding"]["gps_time_type"] == "standard"
    assert meta["file"]["compressed"] is False
    assert meta["point_format"]["has_gps_time"] is True
    assert meta["point_format"]["has_rgb"] is False
    names = [d["name"] for d in meta["point_format"]["dimensions"]]
    assert names[:4] == ["X", "Y", "Z", "intensity"]
    kinds = {v["kind"] for v in meta["vlrs"]}
    assert "ClassificationLookupVlr" in kinds
    lookup = next(v for v in meta["vlrs"] if v["kind"] == "ClassificationLookupVlr")
    assert {"code": 5, "name": "Tall trees"} in lookup["parsed"]["lookups"]
    assert meta["crs"] is not None and meta["crs"]["epsg"] == 6339
    assert meta["crs"]["is_projected"] is True
    assert "NAD83(2011) / UTM zone 10N" in meta["crs"]["name"]
    for v in meta["vlrs"]:
        assert v["raw"]["length"] == v["size_bytes"]


def test_laz_metadata_has_laszip_vlr(sample_laz):
    meta = read_metadata(sample_laz)
    assert meta["file"]["compressed"] is True
    laszip = next(v for v in meta["vlrs"] if v["kind"] == "LasZipVlr")
    assert laszip["parsed"]["compressor"] == "layered chunked"
    assert any(it["type"] == "POINT14" for it in laszip["parsed"]["items"])


def test_cloud_arrays_and_stats(sample_las):
    cloud = load_cloud(sample_las)
    assert cloud.count == N_POINTS
    assert cloud.X.dtype == np.int32
    xyz = cloud.xyz(slice(None))
    assert xyz.shape == (N_POINTS, 3)
    assert 600000.0 <= xyz[:, 0].min() and xyz[:, 0].max() <= 600100.0
    assert np.count_nonzero(cloud.flags & FLAG_WITHHELD) == 7
    assert cloud.scan_angle.dtype == np.float32
    assert abs(cloud.scan_angle).max() <= 18.0 + 1e-3  # 3000 * 0.006
    s = cloud.stats()
    json.dumps(s)
    by_code = {row["value"]: row for row in s["classification"]}
    assert by_code[2]["count"] == N_POINTS // 2
    assert by_code[2]["name"] == "Bare Earth (Ground)"
    assert by_code[5]["name"] == "Tall trees (High vegetation)"
    assert by_code[1]["name"] == "Unclassified"
    assert s["flags"]["withheld"] == 7
    assert s["ground_points"] == N_POINTS // 2
    assert s["gps_time"]["type"] == "standard"
    assert s["gps_time"]["min_utc"].startswith("2022-04-18")
    assert s["z"]["min"] >= 100.0 and s["z"]["max"] <= 130.0
    assert len(s["z"]["histogram"]["counts"]) == 64
    assert s["point_source_id_unique"] == 4


def test_laz_decodes_to_the_same_points(sample_las, sample_laz):
    a = load_cloud(sample_las)
    b = load_cloud(sample_laz)
    assert np.array_equal(a.X, b.X) and np.array_equal(a.Z, b.Z)
    assert np.array_equal(a.classification, b.classification)
    assert np.allclose(a.gps_time, b.gps_time)


def test_chunk_layout_and_order(sample_las):
    cloud = load_cloud(sample_las)
    # The order is a permutation, fixed from run to run.
    assert sorted(cloud.order.tolist()) == list(range(N_POINTS))
    assert cloud.order[:5].tolist() == load_cloud(sample_las).order[:5].tolist()
    n = 123
    cs = CloudSet([0], [cloud])
    blob = cs.pack_chunk(10, n)
    assert blob[:4] == CHUNK_MAGIC
    count, has_rgb, has_time, nseg = struct.unpack_from("<IBBH", blob, 4)
    assert (count, has_rgb, has_time, nseg) == (n, 0, 1, 1)
    assert struct.unpack_from("<III", blob, 12) == (0, 10, n)
    head = 12 + 12
    expected = head + n * (12 + 2 + 1 + 1 + 1 + 2 + 4 + 4 + 1)
    assert len(blob) == expected
    pos = np.frombuffer(blob, dtype="<f4", count=3 * n, offset=head).reshape(n, 3)
    idx = cloud.order[10 : 10 + n]
    assert np.allclose(pos, (cloud.xyz(idx) - cloud.center), atol=1e-3)
    off = head + 12 * n
    intensity = np.frombuffer(blob, dtype="<u2", count=n, offset=off)
    assert np.array_equal(intensity, cloud.intensity[idx])
    off += 2 * n
    cls = np.frombuffer(blob, dtype=np.uint8, count=n, offset=off)
    assert np.array_equal(cls, cloud.classification[idx])
    # Out-of-range requests clip rather than fail.
    tail = cs.pack_chunk(N_POINTS - 5, 1000)
    assert struct.unpack_from("<I", tail, 4)[0] == 5
    assert struct.unpack_from("<I", cs.pack_chunk(N_POINTS + 10, 5), 4)[0] == 0


def test_point_record_is_exact(sample_las):
    cloud = load_cloud(sample_las)
    rec = cloud.point_record(0)
    i = rec["file_index"]
    assert i == int(cloud.order[0])
    assert rec["X"] == int(cloud.X[i])
    assert abs(rec["x"] - (cloud.X[i] * 0.01 + 600000.0)) < 1e-9
    assert rec["classification_name"] in {"Bare Earth (Ground)", "Unclassified", "Tall trees (High vegetation)"}
    assert rec["gps_time_utc"].startswith("2022-04-18")
    assert "scanner_channel" in rec
    import pytest

    with pytest.raises(IndexError):
        cloud.point_record(N_POINTS)


def test_max_points_reads_a_prefix(sample_las):
    cloud = load_cloud(sample_las, max_points=50)
    full = load_cloud(sample_las)
    assert cloud.count == 50
    assert np.array_equal(cloud.X, full.X[:50])


def test_decoding_in_small_chunks_gives_the_same_cloud(sample_laz, monkeypatch):
    whole = load_cloud(sample_laz)
    monkeypatch.setattr(reader, "DECODE_CHUNK", 150)  # 7 chunks, the last one partial
    chunked = load_cloud(sample_laz)
    prefix = load_cloud(sample_laz, max_points=200)  # stops inside the second chunk
    assert chunked.count == N_POINTS and prefix.count == 200
    for name in ("X", "Y", "Z", "intensity", "classification", "scan_angle", "gps_time", "flags", "scanner_channel"):
        assert np.array_equal(getattr(whole, name), getattr(chunked, name)), name
        assert np.array_equal(getattr(whole, name)[:200], getattr(prefix, name)), name
    assert chunked.stats() == whole.stats()


def test_block_statistics_match_numpy(monkeypatch):
    monkeypatch.setattr(reader, "STAT_BLOCK", 1000)  # several blocks over 5000 values
    rng = np.random.default_rng(7)
    raw = rng.integers(-50000, 50000, 5000).astype(np.int32)
    scale, offset = 0.01, 4180000.0
    v = raw.astype(np.float64) * scale + offset
    got = reader._ranged(raw, percentiles=(1, 50, 99), bins=16, scale=scale, offset=offset)
    assert got["min"] == v.min() and got["max"] == v.max()
    assert np.isclose(got["mean"], v.mean()) and np.isclose(got["std"], v.std())
    assert np.allclose([got["percentiles"][k] for k in ("1", "50", "99")], np.percentile(v, (1, 50, 99)))
    counts, edges = np.histogram(v, bins=16)
    assert got["histogram"] == {"edges": edges.tolist(), "counts": counts.tolist()}
    codes, counts = reader._value_counts(rng.integers(0, 70000, 5000).astype(np.uint16))
    assert codes.size > 1000 and counts.sum() == 5000
