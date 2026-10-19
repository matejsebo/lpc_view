"""Read a LAS/LAZ file through laspy: every piece of metadata, the points, and the
statistics the viewer shows.

Two levels: `read_metadata` touches only the header, VLRs and EVLRs (fast, no point
decoding); `load_cloud` decodes the points into a `PointCloud` whose arrays feed the
statistics (`cloud.stats()`), the binary chunks the viewer streams (`pack_chunk`) and
the exact attributes of one point (`point_record`).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import os
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import laspy
import numpy as np

from .classes import class_color, class_name

CHUNK_MAGIC = b"LPC1"
GPS_EPOCH = dt.datetime(1980, 1, 6, tzinfo=dt.timezone.utc)
GPS_UTC_LEAP_SECONDS = 18  # since 2017-01-01; the LAS header does not say
ADJUSTED_GPS_OFFSET = 1.0e9

FLAG_SYNTHETIC = 1
FLAG_KEY_POINT = 2
FLAG_WITHHELD = 4
FLAG_OVERLAP = 8
FLAG_EDGE_OF_FLIGHT_LINE = 16
FLAG_SCAN_DIRECTION = 32


# ----------------------------------------------------------------------------
# Metadata (header, VLRs, EVLRs, CRS)
# ----------------------------------------------------------------------------


def _json_safe(value: Any) -> Any:
    """Turn numpy scalars, arrays, dates and bytes into JSON-ready values."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        v = float(value)
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(value, np.ndarray):
        return [_json_safe(v) for v in value.tolist()]
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    return value


def _bytes_preview(data: bytes, limit: int = 64) -> dict[str, Any]:
    head = data[:limit]
    printable = "".join(chr(b) if 32 <= b < 127 else "." for b in head)
    return {
        "length": len(data),
        "hex": head.hex(" "),
        "ascii": printable,
        "truncated": len(data) > limit,
    }


def _describe_vlr(vlr: Any) -> dict[str, Any]:
    """One VLR or EVLR as a dict: identity, raw size, and the parsed payload laspy knows."""
    kind = type(vlr).__name__
    try:
        raw = bytes(vlr.record_data_bytes())
    except Exception:  # noqa: BLE001 - a VLR type without raw access
        raw = b""
    out: dict[str, Any] = {
        "user_id": vlr.user_id,
        "record_id": int(vlr.record_id),
        "description": vlr.description,
        "kind": kind,
        "size_bytes": len(raw),
        "raw": _bytes_preview(raw),
    }
    parsed: dict[str, Any] | None = None
    if kind == "ClassificationLookupVlr":
        parsed = {
            "lookups": [
                {"code": int(code), "name": name}
                for code, name in sorted(vlr.lookups.items())
            ]
        }
    elif kind == "WktCoordinateSystemVlr":
        parsed = {"wkt": vlr.string}
    elif kind == "LasZipVlr":
        parsed = _parse_laszip_vlr(raw)
    elif kind == "GeoKeyDirectoryVlr":
        parsed = {
            "keys": [
                {
                    "id": int(k.id),
                    "tiff_tag_location": int(k.tiff_tag_location),
                    "count": int(k.count),
                    "value_offset": int(k.value_offset),
                }
                for k in vlr.geo_keys
            ]
        }
    elif kind == "GeoAsciiParamsVlr":
        parsed = {"strings": list(vlr.strings)}
    elif kind == "GeoDoubleParamsVlr":
        parsed = {"doubles": [float(d) for d in vlr.doubles]}
    elif kind == "ExtraBytesVlr":
        parsed = {
            "extra_bytes": [
                {
                    "name": eb.name.rstrip(b"\x00").decode("utf-8", "replace")
                    if isinstance(eb.name, bytes)
                    else str(eb.name),
                    "data_type": int(eb.data_type),
                    "description": eb.description.rstrip(b"\x00").decode("utf-8", "replace")
                    if isinstance(eb.description, bytes)
                    else str(eb.description),
                }
                for eb in vlr.extra_bytes_structs
            ]
        }
    elif kind == "WaveformPacketVlr":
        parsed = {"waveform_packet": str(vlr.parsed_record)}
    if parsed is not None:
        out["parsed"] = _json_safe(parsed)
    return out


def _parse_laszip_vlr(raw: bytes) -> dict[str, Any]:
    """The laszip VLR layout: compressor, coder, version, options, chunk size, items."""
    if len(raw) < 34:
        return {"error": "record too short"}
    compressor, coder, vmaj, vmin, vrev, options, chunk_size = struct.unpack_from(
        "<HHBBHII", raw, 0
    )
    num_special, num_items = struct.unpack_from("<qq", raw, 16)[0:1] + (
        struct.unpack_from("<H", raw, 32)[0],
    )
    items = []
    off = 34
    item_names = {
        0: "BYTE",
        6: "POINT10",
        7: "GPSTIME11",
        8: "RGB12",
        9: "WAVEPACKET13",
        10: "POINT14",
        11: "RGB14",
        12: "RGBNIR14",
        13: "WAVEPACKET14",
        14: "BYTE14",
    }
    for _ in range(num_items):
        if off + 6 > len(raw):
            break
        item_type, size, version = struct.unpack_from("<HHH", raw, off)
        items.append(
            {
                "type": item_names.get(item_type, str(item_type)),
                "size": size,
                "version": version,
            }
        )
        off += 6
    compressor_names = {
        0: "none",
        1: "pointwise",
        2: "pointwise chunked",
        3: "layered chunked",
    }
    return {
        "compressor": compressor_names.get(compressor, str(compressor)),
        "coder": "arithmetic" if coder == 0 else str(coder),
        "version": f"{vmaj}.{vmin}r{vrev}",
        "options": options,
        "chunk_size": chunk_size,
        "number_of_special_evlrs": num_special,
        "items": items,
    }


def _crs_info(header: laspy.LasHeader) -> dict[str, Any] | None:
    try:
        crs = header.parse_crs()
    except Exception as exc:  # noqa: BLE001 - laspy raises assorted errors on odd VLRs
        return {"error": f"could not parse: {exc}"}
    if crs is None:
        return None

    def one(c: Any) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": c.name,
            "type": c.type_name,
            "epsg": c.to_epsg(),
        }
        try:
            d["datum"] = c.datum.name if c.datum is not None else None
        except Exception:  # noqa: BLE001
            d["datum"] = None
        try:
            d["axes"] = [
                {
                    "name": a.name,
                    "abbrev": a.abbrev,
                    "direction": a.direction,
                    "unit": a.unit_name,
                }
                for a in c.axis_info
            ]
        except Exception:  # noqa: BLE001
            d["axes"] = []
        try:
            d["area_of_use"] = str(c.area_of_use) if c.area_of_use else None
        except Exception:  # noqa: BLE001
            d["area_of_use"] = None
        return d

    info = one(crs)
    info["components"] = [one(c) for c in (crs.sub_crs_list or [])]
    info["is_projected"] = bool(crs.is_projected)
    info["is_compound"] = bool(crs.is_compound)
    try:
        info["wkt"] = crs.to_wkt(pretty=True)
    except Exception:  # noqa: BLE001
        info["wkt"] = None
    return info


def gps_time_to_utc(value: float, gps_time_type: str) -> str | None:
    """Adjusted standard GPS time -> an ISO UTC string (18 leap seconds assumed).

    GPS week time has no date, so it yields None.
    """
    if gps_time_type != "standard":
        return None
    seconds = value + ADJUSTED_GPS_OFFSET - GPS_UTC_LEAP_SECONDS
    try:
        return (GPS_EPOCH + dt.timedelta(seconds=seconds)).isoformat()
    except (OverflowError, ValueError):
        return None


def read_metadata(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Everything the file says about itself, without decoding any points."""
    path = Path(path)
    st = path.stat()
    with laspy.open(path) as reader:
        h = reader.header
        evlrs = list(reader.evlrs or [])
    ge = h.global_encoding
    gps_type = "week" if ge.gps_time_type == laspy.header.GpsTimeType.WEEK_TIME else "standard"
    pf = h.point_format
    dims = []
    for d in pf.dimensions:
        dims.append(
            {
                "name": d.name,
                "kind": d.kind.name,
                "bits": int(d.num_bits),
                "dtype": str(d.dtype) if d.dtype is not None else None,
                "extra": d.name in {e.name for e in pf.extra_dimensions},
            }
        )
    by_return = [int(n) for n in h.number_of_points_by_return]
    mins = [float(v) for v in h.mins]
    maxs = [float(v) for v in h.maxs]
    area = max(maxs[0] - mins[0], 0.0) * max(maxs[1] - mins[1], 0.0)
    meta: dict[str, Any] = {
        "file": {
            "path": str(path),
            "name": path.name,
            "size_bytes": st.st_size,
            "modified": dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "compressed": bool(h.are_points_compressed),
        },
        "header": {
            "version": str(h.version),
            "file_source_id": int(h.file_source_id),
            "global_encoding": {
                "value": int(ge.value),
                "gps_time_type": gps_type,
                "waveform_data_packets_internal": bool(ge.waveform_data_packets_internal),
                "waveform_data_packets_external": bool(ge.waveform_data_packets_external),
                "synthetic_return_numbers": bool(ge.synthetic_return_numbers),
                "wkt": bool(ge.wkt),
            },
            "project_id": str(h.uuid),
            "system_identifier": h.system_identifier,
            "generating_software": h.generating_software,
            "creation_date": h.creation_date.isoformat() if h.creation_date else None,
            "header_size": int(h.offset_to_point_data) - len(h.extra_header_bytes or b"")
            - sum(54 + len(v.record_data_bytes()) for v in h.vlrs)
            - len(h.extra_vlr_bytes or b""),
            "offset_to_point_data": int(h.offset_to_point_data),
            "number_of_vlrs": len(h.vlrs),
            "point_data_record_format": int(pf.id),
            "point_data_record_length": int(pf.size),
            "point_count": int(h.point_count),
            "number_of_points_by_return": by_return,
            "scales": [float(v) for v in h.scales],
            "offsets": [float(v) for v in h.offsets],
            "mins": mins,
            "maxs": maxs,
            "extent": [maxs[i] - mins[i] for i in range(3)],
            "area_m2": area,
            "points_per_m2": (int(h.point_count) / area) if area > 0 else None,
            "start_of_waveform_data_packet_record": int(h.start_of_waveform_data_packet_record),
            "start_of_first_evlr": int(h.start_of_first_evlr),
            "number_of_evlrs": int(h.number_of_evlrs),
            "extra_header_bytes": len(h.extra_header_bytes or b""),
            "extra_vlr_bytes": len(h.extra_vlr_bytes or b""),
        },
        "point_format": {
            "id": int(pf.id),
            "size": int(pf.size),
            "has_gps_time": "gps_time" in pf.dimension_names,
            "has_rgb": "red" in pf.dimension_names,
            "has_nir": "nir" in pf.dimension_names,
            "has_waveform": "wavepacket_index" in pf.dimension_names,
            "dimensions": dims,
            "extra_dimensions": [e.name for e in pf.extra_dimensions],
        },
        "crs": _crs_info(h),
        "vlrs": [_describe_vlr(v) for v in h.vlrs],
        "evlrs": [_describe_vlr(v) for v in evlrs],
    }
    return _json_safe(meta)


def file_sha256(path: str | os.PathLike[str]) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ----------------------------------------------------------------------------
# Points
# ----------------------------------------------------------------------------


@dataclass
class PointCloud:
    """The decoded points of one file, kept as compact arrays.

    Coordinates stay as the file's scaled integers (exact); `scale` and `offset`
    turn them into map units. `center` is the midpoint of the header's bounding box
    and the origin of the float32 positions the viewer draws.
    """

    path: str
    count: int
    scale: np.ndarray
    offset: np.ndarray
    center: np.ndarray
    X: np.ndarray
    Y: np.ndarray
    Z: np.ndarray
    intensity: np.ndarray
    classification: np.ndarray
    return_number: np.ndarray
    number_of_returns: np.ndarray
    point_source_id: np.ndarray
    scan_angle: np.ndarray  # degrees, float32
    gps_time: np.ndarray | None  # float64 or None
    flags: np.ndarray  # uint8 bits, see FLAG_*
    user_data: np.ndarray
    scanner_channel: np.ndarray | None
    rgb: np.ndarray | None  # uint8 N x 3 or None
    nir: np.ndarray | None
    gps_time_type: str
    class_lookup: dict[int, str] = field(default_factory=dict)
    order: np.ndarray = field(default=None)  # type: ignore[assignment]
    _stats: dict[str, Any] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.order is None:
            # A fixed shuffle so every prefix of the stream is a uniform sample.
            rng = np.random.default_rng(12345)
            self.order = rng.permutation(self.count).astype(np.uint32)

    # -- derived coordinates --------------------------------------------------

    def xyz(self, idx: np.ndarray | slice) -> np.ndarray:
        """Map-unit coordinates of the given points, float64 N x 3."""
        return np.column_stack(
            [
                self.X[idx].astype(np.float64) * self.scale[0] + self.offset[0],
                self.Y[idx].astype(np.float64) * self.scale[1] + self.offset[1],
                self.Z[idx].astype(np.float64) * self.scale[2] + self.offset[2],
            ]
        )

    # -- the stream ----------------------------------------------------------

    def pack_chunk(self, start: int, count: int) -> bytes:
        """Points [start, start+count) of the shuffled order as one binary chunk.

        Layout (little endian): magic 'LPC1', count u32, has_rgb u8, has_time u8,
        pad u16; then xyz f32 x3 relative to `center`, intensity u16, classification
        u8, return_number u8, number_of_returns u8, point_source_id u16, scan_angle
        f32, gps_time f32 (relative to the file's minimum), flags u8, rgb u8 x3 when
        has_rgb.
        """
        start = max(0, min(start, self.count))
        count = max(0, min(count, self.count - start))
        idx = self.order[start : start + count]
        rel = (self.xyz(idx) - self.center).astype(np.float32)
        parts = [
            CHUNK_MAGIC,
            struct.pack("<IBBH", count, 1 if self.rgb is not None else 0,
                        1 if self.gps_time is not None else 0, 0),
            np.ascontiguousarray(rel).tobytes(),
            self.intensity[idx].astype("<u2").tobytes(),
            self.classification[idx].astype(np.uint8).tobytes(),
            self.return_number[idx].astype(np.uint8).tobytes(),
            self.number_of_returns[idx].astype(np.uint8).tobytes(),
            self.point_source_id[idx].astype("<u2").tobytes(),
            self.scan_angle[idx].astype("<f4").tobytes(),
        ]
        if self.gps_time is not None:
            t0 = self.stats()["gps_time"]["min"]
            parts.append((self.gps_time[idx] - t0).astype("<f4").tobytes())
        else:
            parts.append(np.zeros(count, dtype="<f4").tobytes())
        parts.append(self.flags[idx].astype(np.uint8).tobytes())
        if self.rgb is not None:
            parts.append(np.ascontiguousarray(self.rgb[idx]).tobytes())
        return b"".join(parts)

    # -- one point, exactly --------------------------------------------------

    def point_record(self, stream_index: int) -> dict[str, Any]:
        """Every attribute of the point at `stream_index` in the shuffled order."""
        if not 0 <= stream_index < self.count:
            raise IndexError(stream_index)
        i = int(self.order[stream_index])
        xyz = self.xyz(np.array([i]))[0]
        rec: dict[str, Any] = {
            "stream_index": stream_index,
            "file_index": i,
            "x": float(xyz[0]),
            "y": float(xyz[1]),
            "z": float(xyz[2]),
            "X": int(self.X[i]),
            "Y": int(self.Y[i]),
            "Z": int(self.Z[i]),
            "intensity": int(self.intensity[i]),
            "return_number": int(self.return_number[i]),
            "number_of_returns": int(self.number_of_returns[i]),
            "classification": int(self.classification[i]),
            "classification_name": self.class_label(int(self.classification[i])),
            "point_source_id": int(self.point_source_id[i]),
            "scan_angle_deg": float(self.scan_angle[i]),
            "user_data": int(self.user_data[i]),
            "synthetic": bool(self.flags[i] & FLAG_SYNTHETIC),
            "key_point": bool(self.flags[i] & FLAG_KEY_POINT),
            "withheld": bool(self.flags[i] & FLAG_WITHHELD),
            "overlap": bool(self.flags[i] & FLAG_OVERLAP),
            "edge_of_flight_line": bool(self.flags[i] & FLAG_EDGE_OF_FLIGHT_LINE),
            "scan_direction_flag": int(bool(self.flags[i] & FLAG_SCAN_DIRECTION)),
        }
        if self.scanner_channel is not None:
            rec["scanner_channel"] = int(self.scanner_channel[i])
        if self.gps_time is not None:
            t = float(self.gps_time[i])
            rec["gps_time"] = t
            rec["gps_time_utc"] = gps_time_to_utc(t, self.gps_time_type)
        if self.rgb is not None:
            rec["rgb"] = [int(v) for v in self.rgb[i]]
        if self.nir is not None:
            rec["nir"] = int(self.nir[i])
        return rec

    def class_label(self, code: int) -> str:
        """The file's own lookup name when it has one, else the ASPRS name."""
        own = self.class_lookup.get(code, "").strip()
        std = class_name(code)
        if own and own.lower() != std.lower():
            return f"{own} ({std})"
        return std

    # -- statistics ----------------------------------------------------------

    def stats(self) -> dict[str, Any]:
        if self._stats is None:
            self._stats = _json_safe(self._compute_stats())
        return self._stats

    def _compute_stats(self) -> dict[str, Any]:
        n = self.count
        out: dict[str, Any] = {"point_count": n}
        if n == 0:
            return out

        def counts_of(values: np.ndarray, limit: int = 256) -> list[dict[str, Any]]:
            codes, cnt = np.unique(values, return_counts=True)
            rows = [
                {"value": int(c), "count": int(k), "fraction": float(k) / n}
                for c, k in zip(codes, cnt)
            ]
            rows.sort(key=lambda r: -r["count"])
            return rows[:limit]

        def ranged(values: np.ndarray, percentiles=(1, 5, 50, 95, 99)) -> dict[str, Any]:
            v = values.astype(np.float64)
            q = np.percentile(v, percentiles)
            return {
                "min": float(v.min()),
                "max": float(v.max()),
                "mean": float(v.mean()),
                "std": float(v.std()),
                "percentiles": {str(p): float(x) for p, x in zip(percentiles, q)},
            }

        def histogram(values: np.ndarray, bins: int = 64) -> dict[str, Any]:
            counts, edges = np.histogram(values.astype(np.float64), bins=bins)
            return {"edges": edges.tolist(), "counts": counts.tolist()}

        x = self.X.astype(np.float64) * self.scale[0] + self.offset[0]
        y = self.Y.astype(np.float64) * self.scale[1] + self.offset[1]
        z = self.Z.astype(np.float64) * self.scale[2] + self.offset[2]
        out["bounds"] = {
            "min": [float(x.min()), float(y.min()), float(z.min())],
            "max": [float(x.max()), float(y.max()), float(z.max())],
        }
        area = (x.max() - x.min()) * (y.max() - y.min())
        out["density_per_m2"] = float(n / area) if area > 0 else None
        out["z"] = ranged(z)
        out["z"]["histogram"] = histogram(z)
        out["intensity"] = ranged(self.intensity)
        out["intensity"]["histogram"] = histogram(self.intensity)
        out["scan_angle_deg"] = ranged(self.scan_angle, percentiles=(1, 50, 99))
        out["scan_angle_deg"]["histogram"] = histogram(self.scan_angle, bins=45)

        classes = []
        for row in counts_of(self.classification):
            code = row["value"]
            classes.append(
                {
                    **row,
                    "name": self.class_label(code),
                    "color": list(class_color(code)),
                }
            )
        out["classification"] = classes
        out["return_number"] = counts_of(self.return_number)
        out["number_of_returns"] = counts_of(self.number_of_returns)
        out["point_source_id"] = counts_of(self.point_source_id, limit=64)
        out["point_source_id_unique"] = int(np.unique(self.point_source_id).size)
        out["user_data"] = counts_of(self.user_data, limit=16)
        if self.scanner_channel is not None:
            out["scanner_channel"] = counts_of(self.scanner_channel)
        out["flags"] = {
            "synthetic": int(np.count_nonzero(self.flags & FLAG_SYNTHETIC)),
            "key_point": int(np.count_nonzero(self.flags & FLAG_KEY_POINT)),
            "withheld": int(np.count_nonzero(self.flags & FLAG_WITHHELD)),
            "overlap": int(np.count_nonzero(self.flags & FLAG_OVERLAP)),
            "edge_of_flight_line": int(np.count_nonzero(self.flags & FLAG_EDGE_OF_FLIGHT_LINE)),
            "scan_direction_positive": int(np.count_nonzero(self.flags & FLAG_SCAN_DIRECTION)),
        }
        ground = self.classification == 2
        out["ground_points"] = int(np.count_nonzero(ground))
        out["ground_density_per_m2"] = float(out["ground_points"] / area) if area > 0 else None
        if self.gps_time is not None:
            t = self.gps_time
            out["gps_time"] = {
                "type": self.gps_time_type,
                "min": float(t.min()),
                "max": float(t.max()),
                "span_seconds": float(t.max() - t.min()),
                "min_utc": gps_time_to_utc(float(t.min()), self.gps_time_type),
                "max_utc": gps_time_to_utc(float(t.max()), self.gps_time_type),
                "leap_seconds_assumed": GPS_UTC_LEAP_SECONDS,
                "histogram": histogram(t, bins=96),
            }
        if self.rgb is not None:
            out["rgb"] = {
                c: ranged(self.rgb[:, k], percentiles=(1, 50, 99))
                for k, c in enumerate(("red", "green", "blue"))
            }
        if self.nir is not None:
            out["nir"] = ranged(self.nir, percentiles=(1, 50, 99))
        return out


def _dim(las: laspy.LasData, name: str, dtype: Any, default: Any = 0) -> np.ndarray:
    if name in las.point_format.dimension_names:
        return np.asarray(las[name]).astype(dtype)
    return np.full(len(las.points), default, dtype=dtype)


def load_cloud(path: str | os.PathLike[str], max_points: int | None = None) -> PointCloud:
    """Decode a file's points. `max_points` keeps the first that many (for tests)."""
    path = Path(path)
    backend = laspy.LazBackend.LazrsParallel if laspy.LazBackend.LazrsParallel.is_available() else None
    if max_points is None:
        las = laspy.read(path, laz_backend=backend) if backend else laspy.read(path)
    else:
        with laspy.open(path, laz_backend=backend) if backend else laspy.open(path) as reader:
            las = reader.read_points(max_points)
            header = reader.header
        las = laspy.LasData(header, las)
    h = las.header
    n = len(las.points)
    names = set(las.point_format.dimension_names)

    flags = np.zeros(n, dtype=np.uint8)
    for name, bit in (
        ("synthetic", FLAG_SYNTHETIC),
        ("key_point", FLAG_KEY_POINT),
        ("withheld", FLAG_WITHHELD),
        ("overlap", FLAG_OVERLAP),
        ("edge_of_flight_line", FLAG_EDGE_OF_FLIGHT_LINE),
        ("scan_direction_flag", FLAG_SCAN_DIRECTION),
    ):
        if name in names:
            flags |= (np.asarray(las[name]).astype(bool) * bit).astype(np.uint8)

    if "scan_angle" in names:  # point formats 6-10: 0.006 degree units
        scan = np.asarray(las.scan_angle).astype(np.float32) * np.float32(0.006)
    else:  # formats 0-5: whole degrees
        scan = _dim(las, "scan_angle_rank", np.float32)

    rgb = None
    if {"red", "green", "blue"} <= names:
        r = np.asarray(las.red).astype(np.uint16)
        g = np.asarray(las.green).astype(np.uint16)
        b = np.asarray(las.blue).astype(np.uint16)
        # 16-bit colour when any channel exceeds 255, else already 8-bit.
        shift = 8 if max(int(r.max()), int(g.max()), int(b.max())) > 255 else 0
        rgb = np.column_stack([r >> shift, g >> shift, b >> shift]).astype(np.uint8)
    nir = np.asarray(las.nir).astype(np.uint16) if "nir" in names else None

    ge = h.global_encoding
    gps_type = "week" if ge.gps_time_type == laspy.header.GpsTimeType.WEEK_TIME else "standard"
    lookup: dict[int, str] = {}
    for v in h.vlrs:
        if type(v).__name__ == "ClassificationLookupVlr":
            lookup = {int(k): str(name) for k, name in v.lookups.items()}

    mins = np.asarray(h.mins, dtype=np.float64)
    maxs = np.asarray(h.maxs, dtype=np.float64)
    return PointCloud(
        path=str(path),
        count=n,
        scale=np.asarray(h.scales, dtype=np.float64),
        offset=np.asarray(h.offsets, dtype=np.float64),
        center=(mins + maxs) / 2.0,
        X=np.asarray(las.X).astype(np.int32),
        Y=np.asarray(las.Y).astype(np.int32),
        Z=np.asarray(las.Z).astype(np.int32),
        intensity=_dim(las, "intensity", np.uint16),
        classification=_dim(las, "classification", np.uint8),
        return_number=_dim(las, "return_number", np.uint8),
        number_of_returns=_dim(las, "number_of_returns", np.uint8),
        point_source_id=_dim(las, "point_source_id", np.uint16),
        scan_angle=scan,
        gps_time=np.asarray(las.gps_time).astype(np.float64) if "gps_time" in names else None,
        flags=flags,
        user_data=_dim(las, "user_data", np.uint8),
        scanner_channel=np.asarray(las.scanner_channel).astype(np.uint8)
        if "scanner_channel" in names
        else None,
        rgb=rgb,
        nir=nir,
        gps_time_type=gps_type,
        class_lookup=lookup,
    )
