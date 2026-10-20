import json
import struct

import numpy as np
import pytest

from lpc_view.reader import CHUNK_MAGIC, CloudSet, load_cloud
from tests.conftest import N_POINTS


@pytest.fixture(scope="module")
def pair(sample_las, sample_laz):
    a = load_cloud(sample_las)
    b = load_cloud(sample_laz, max_points=300)
    return CloudSet([0, 1], [a, b])


def parse_header(blob):
    assert blob[:4] == CHUNK_MAGIC
    count, has_rgb, has_time, nseg = struct.unpack_from("<IBBH", blob, 4)
    segs = [struct.unpack_from("<III", blob, 12 + 12 * k) for k in range(nseg)]
    return count, has_rgb, has_time, segs, 12 + 12 * nseg


def test_segments_cover_each_file_exactly_once(pair):
    assert pair.count == N_POINTS + 300
    seen = {0: [], 1: []}
    total = 0
    for chunk in (7, 64, 1000):
        seen = {0: [], 1: []}
        total = 0
        for start in range(0, pair.count, chunk):
            for k, a, n in pair.segments(start, chunk):
                seen[k].append((a, n))
                total += n
        assert total == pair.count
        for k, c in enumerate(pair.clouds):
            pos = 0
            for a, n in seen[k]:
                assert a == pos  # contiguous, in order
                pos += n
            assert pos == c.count
    # Both files are present in every reasonably sized prefix (a uniform mix).
    assert {k for k, _, _ in pair.segments(0, 50)} == {0, 1}
    assert pair.segments(pair.count + 5, 10) == []


def test_chunk_carries_segments_and_arrays(pair):
    blob = pair.pack_chunk(10, 100)
    count, has_rgb, has_time, segs, off = parse_header(blob)
    assert (has_rgb, has_time) == (0, 1)
    assert sum(n for _, _, n in segs) == count
    assert [s[0] for s in segs] == [0, 1]  # catalog ids, in order
    expected = off + count * (12 + 2 + 1 + 1 + 1 + 2 + 4 + 4 + 1)
    assert len(blob) == expected
    pos = np.frombuffer(blob, dtype="<f4", count=3 * count, offset=off).reshape(count, 3)
    # The first segment's positions are file 0's points at its local range, relative to the set centre.
    _file_id, a, n = segs[0]
    c = pair.clouds[0]
    want = (c.xyz(c.order[a : a + n]) - pair.center).astype(np.float32)
    assert np.allclose(pos[:n], want, atol=1e-3)
    cls = np.frombuffer(blob, dtype=np.uint8, count=count, offset=off + 14 * count)
    assert np.array_equal(cls[:n], c.classification[c.order[a : a + n]])


def test_single_cloud_set_is_the_cloud(sample_las):
    c = load_cloud(sample_las)
    cs = CloudSet([3], [c])
    assert cs.stats() is c.stats()
    count, _, _, segs, _ = parse_header(cs.pack_chunk(0, 10))
    assert count == 10 and segs == [(3, 0, 10)]
    assert np.allclose(cs.center, c.center)


def test_merged_stats(pair):
    s = pair.stats()
    json.dumps(s)
    assert s["point_count"] == pair.count
    assert [f["count"] for f in s["files"]] == [N_POINTS, 300]
    assert sum(r["count"] for r in s["classification"]) == pair.count
    ground = next(r for r in s["classification"] if r["value"] == 2)
    assert ground["name"] == "Bare Earth (Ground)"
    assert s["z"]["min"] == min(c.stats()["z"]["min"] for c in pair.clouds)
    assert sum(s["z"]["histogram"]["counts"]) == pair.count
    assert s["flags"]["withheld"] == sum(c.stats()["flags"]["withheld"] for c in pair.clouds)
    assert s["gps_time"]["type"] == "standard" and s["gps_time"]["min_utc"].startswith("2022-04-18")
    assert 100.0 <= s["z"]["percentiles"]["50"] <= 130.0


def test_chunk_counts_add_up_to_the_prefix(pair):
    # The viewer appends chunks by their actual counts: the stream below nominal
    # position p holds sum(floor(p * n_k / N)) points, at most p, and the chunks of
    # [0, p) hold exactly that many, so a budget of p points never overflows and the
    # stream of the whole set holds every point.
    for p in (1, 7, 100, 777, pair.count):
        want = sum(p * c.count // pair.count for c in pair.clouds)
        assert want <= p
        got = sum(n for start in range(0, p, 64) for _, _, n in pair.segments(start, min(64, p - start)))
        assert got == want
    assert sum(n for _, _, n in pair.segments(0, pair.count)) == pair.count


def test_merged_rgb_stats(sample_las, tmp_path):
    from tests.conftest import write_sample

    a = load_cloud(write_sample(tmp_path / "a.las", point_format=7, rgb_scale=257))
    b = load_cloud(write_sample(tmp_path / "b.las", point_format=7, rgb_scale=1), max_points=250)
    plain = load_cloud(sample_las)
    s = CloudSet([0, 1, 2], [a, b, plain]).stats()
    json.dumps(s)
    red = np.concatenate([a.rgb[:, 0], b.rgb[:, 0]]).astype(np.float64)
    got = s["rgb"]["red"]
    assert (got["min"], got["max"]) == (red.min(), red.max())
    assert np.isclose(got["mean"], red.mean()) and np.isclose(got["std"], red.std())
    assert set(got["percentiles"]) == {"1", "50", "99"}
    assert abs(got["percentiles"]["50"] - np.percentile(red, 50)) <= 2  # every point is in the sample here
    assert s["rgb_note"] == "16-bit colours scaled to 8-bit / colours are 8-bit in 16-bit fields"
    assert s["rgb_files"] == [0, 1]
    assert "rgb" not in CloudSet([2, 3], [plain, load_cloud(sample_las, max_points=10)]).stats()
