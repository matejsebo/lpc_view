"""A small synthetic LAS file, written with laspy, for the tests."""

from __future__ import annotations

from pathlib import Path

import laspy
import numpy as np
import pytest

N_POINTS = 1000


def write_sample(path: Path, compressed: bool = False, point_format: int = 6) -> Path:
    header = laspy.LasHeader(point_format=point_format, version="1.4")
    header.offsets = np.array([600000.0, 4180000.0, 0.0])
    header.scales = np.array([0.01, 0.01, 0.01])
    header.system_identifier = "lpc_view tests"
    header.generating_software = "laspy"
    header.global_encoding.gps_time_type = laspy.header.GpsTimeType.STANDARD
    header.add_crs(__import__("pyproj").CRS.from_epsg(6339))
    lookup = laspy.vlrs.known.ClassificationLookupVlr()
    lookup.lookups[2] = "Bare Earth"
    lookup.lookups[5] = "Tall trees"
    header.vlrs.append(lookup)

    rng = np.random.default_rng(1)
    las = laspy.LasData(header)
    n = N_POINTS
    las.x = 600000.0 + rng.uniform(0, 100, n)
    las.y = 4180000.0 + rng.uniform(0, 50, n)
    las.z = 100.0 + rng.uniform(0, 30, n)
    las.intensity = rng.integers(100, 60000, n).astype(np.uint16)
    cls = np.full(n, 1, dtype=np.uint8)
    cls[: n // 2] = 2
    cls[n // 2 : n // 2 + 100] = 5
    las.classification = cls
    las.return_number = rng.integers(1, 4, n)
    las.number_of_returns = np.maximum(las.return_number, 3)
    las.point_source_id = rng.integers(1000, 1004, n).astype(np.uint16)
    las.scan_angle = rng.integers(-3000, 3000, n).astype(np.int16)  # 0.006 deg units
    las.gps_time = 334339325.0 + rng.uniform(0, 600, n)
    withheld = np.zeros(n, dtype=bool)
    withheld[:7] = True
    las.withheld = withheld
    las.write(path)
    return path


@pytest.fixture(scope="session")
def sample_las(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_sample(tmp_path_factory.mktemp("las") / "sample.las")


@pytest.fixture(scope="session")
def sample_laz(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return write_sample(tmp_path_factory.mktemp("laz") / "sample.laz", compressed=True)
