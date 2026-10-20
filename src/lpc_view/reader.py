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

CHUNK_MAGIC = b"LPC2"
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
    with open(path, "rb") as f:
        head = f.read(96)
    # The public header's own size field (bytes 94-95), as the file states it.
    header_size = struct.unpack_from("<H", head, 94)[0] if len(head) >= 96 else None
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
            "header_size": header_size,
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
    rgb_note: str | None = None  # how the file's colour fields were read, see load_cloud
    class_lookup: dict[int, str] = field(default_factory=dict)
    order: np.ndarray = field(default=None)  # type: ignore[assignment]
    _stats: dict[str, Any] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.order is None:
            # A fixed shuffle so every prefix of the stream is a uniform sample.
            rng = np.random.default_rng(12345)
            self.order = np.arange(self.count, dtype=np.uint32)
            rng.shuffle(self.order)  # the same permutation as rng.permutation(n), without its int64 copy

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

    def slice_arrays(self, idx: np.ndarray, center: np.ndarray, t0: float) -> dict[str, np.ndarray]:
        """The streamed attributes of the given points, positions relative to `center`.

        gps_time comes back relative to `t0` as float32; rgb is zeros when the file
        has none, so that files with and without colour can share one stream.
        """
        n = len(idx)
        return {
            "xyz": np.ascontiguousarray((self.xyz(idx) - center).astype(np.float32)),
            "intensity": self.intensity[idx].astype("<u2"),
            "classification": self.classification[idx].astype(np.uint8),
            "return_number": self.return_number[idx].astype(np.uint8),
            "number_of_returns": self.number_of_returns[idx].astype(np.uint8),
            "point_source_id": self.point_source_id[idx].astype("<u2"),
            "scan_angle": self.scan_angle[idx].astype("<f4"),
            "gps_time": (self.gps_time[idx] - t0).astype("<f4")
            if self.gps_time is not None
            else np.zeros(n, dtype="<f4"),
            "flags": self.flags[idx].astype(np.uint8),
            "rgb": np.ascontiguousarray(self.rgb[idx]) if self.rgb is not None else np.zeros((n, 3), np.uint8),
        }

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
            codes, cnt = _value_counts(values)
            rows = [
                {"value": int(c), "count": int(k), "fraction": float(k) / n}
                for c, k in zip(codes, cnt, strict=True)
            ]
            rows.sort(key=lambda r: -r["count"])
            return rows[:limit]

        # One axis at a time: a float64 copy of all three would be 24 bytes a point.
        xmin, xmax = _scaled_range(self.X, self.scale[0], self.offset[0])
        ymin, ymax = _scaled_range(self.Y, self.scale[1], self.offset[1])
        out["z"] = _ranged(self.Z, bins=64, scale=self.scale[2], offset=self.offset[2])
        out["bounds"] = {"min": [xmin, ymin, out["z"]["min"]], "max": [xmax, ymax, out["z"]["max"]]}
        area = (xmax - xmin) * (ymax - ymin)
        out["density_per_m2"] = float(n / area) if area > 0 else None
        out["intensity"] = _ranged(self.intensity, bins=64)
        out["scan_angle_deg"] = _ranged(self.scan_angle, percentiles=(1, 50, 99), bins=45)

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
        out["point_source_id_unique"] = int(_value_counts(self.point_source_id)[0].size)
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
        out["ground_points"] = int(np.count_nonzero(self.classification == 2))
        out["ground_density_per_m2"] = float(out["ground_points"] / area) if area > 0 else None
        if self.gps_time is not None:
            t = _ranged(self.gps_time, percentiles=(), bins=96)
            out["gps_time"] = {
                "type": self.gps_time_type,
                "min": t["min"],
                "max": t["max"],
                "mean": t["mean"],
                "std": t["std"],
                "span_seconds": t["max"] - t["min"],
                "min_utc": gps_time_to_utc(t["min"], self.gps_time_type),
                "max_utc": gps_time_to_utc(t["max"], self.gps_time_type),
                "leap_seconds_assumed": GPS_UTC_LEAP_SECONDS,
                "histogram": t["histogram"],
            }
        if self.rgb is not None:
            out["rgb"] = {
                c: _ranged(self.rgb[:, k], percentiles=(1, 50, 99))
                for k, c in enumerate(("red", "green", "blue"))
            }
            if self.rgb_note:
                out["rgb_note"] = self.rgb_note
        if self.nir is not None:
            out["nir"] = _ranged(self.nir, percentiles=(1, 50, 99))
        return out


# -- statistics without a float64 copy of the whole array ----------------------

STAT_BLOCK = 1 << 20  # points per block in the passes below


def _blocks(values: np.ndarray, scale: float = 1.0, offset: float = 0.0):
    """`values * scale + offset` as float64, one block at a time."""
    for a in range(0, len(values), STAT_BLOCK):
        v = values[a : a + STAT_BLOCK].astype(np.float64)
        if scale != 1.0:
            v *= scale
        if offset != 0.0:
            v += offset
        yield v


def _scaled_range(values: np.ndarray, scale: float = 1.0, offset: float = 0.0) -> tuple[float, float]:
    return float(values.min()) * scale + offset, float(values.max()) * scale + offset


def _value_counts(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The distinct values and their counts (np.unique without the sort for small ints)."""
    if values.dtype.kind == "u" and values.dtype.itemsize <= 2:
        counts = np.zeros(1 << (8 * values.dtype.itemsize), dtype=np.int64)
        for a in range(0, len(values), STAT_BLOCK):  # bincount casts its input to int64: by blocks
            counts += np.bincount(values[a : a + STAT_BLOCK], minlength=len(counts))
        codes = np.flatnonzero(counts)
        return codes, counts[codes]
    return np.unique(values, return_counts=True)


def _histogram(values: np.ndarray, edges: np.ndarray, scale: float = 1.0, offset: float = 0.0) -> np.ndarray:
    counts = np.zeros(len(edges) - 1, dtype=np.int64)
    for v in _blocks(values, scale, offset):
        counts += np.histogram(v, bins=edges)[0]
    return counts


def _edges(lo: float, hi: float, bins: int) -> np.ndarray:
    """np.histogram's bin edges for `bins` bins over [lo, hi]."""
    if hi <= lo:
        lo, hi = lo - 0.5, hi + 0.5
    return np.linspace(lo, hi, bins + 1)


def _ranged(
    values: np.ndarray,
    percentiles: tuple[int, ...] = (1, 5, 50, 95, 99),
    bins: int | None = None,
    scale: float = 1.0,
    offset: float = 0.0,
) -> dict[str, Any]:
    """min, max, mean, std, percentiles (and a histogram when `bins` is given) of
    `values * scale + offset`, with no float64 copy of the whole array: the
    moments and the histogram come from block passes, the percentiles from
    np.percentile on the stored values (a copy of their own size), scaled after.
    """
    n = len(values)
    lo, hi = _scaled_range(values, scale, offset)
    raw_mean = float(values.mean(dtype=np.float64))
    ss = 0.0
    for v in _blocks(values):
        v -= raw_mean
        ss += float(np.dot(v, v))
    out: dict[str, Any] = {
        "min": lo,
        "max": hi,
        "mean": raw_mean * scale + offset,
        "std": math.sqrt(ss / n) * scale,
    }
    if percentiles:
        q = np.percentile(values, percentiles)
        out["percentiles"] = {str(p): float(x) * scale + offset for p, x in zip(percentiles, q, strict=True)}
    if bins:
        edges = _edges(lo, hi, bins)
        out["histogram"] = {"edges": edges.tolist(), "counts": _histogram(values, edges, scale, offset).tolist()}
    return out


# -- decoding --------------------------------------------------------------------

DECODE_CHUNK = 1_000_000  # points decoded at a time


def _open(path: Path) -> laspy.LasReader:
    if laspy.LazBackend.LazrsParallel.is_available():
        return laspy.open(path, laz_backend=laspy.LazBackend.LazrsParallel)
    return laspy.open(path)


def load_cloud(path: str | os.PathLike[str], max_points: int | None = None) -> PointCloud:
    """Decode a file's points. `max_points` keeps the first that many (for tests).

    The file is read in chunks of `DECODE_CHUNK` points straight into arrays of
    the final dtypes, so the peak memory is the result plus one chunk, not the
    whole file as laspy's wide records plus a copy of every dimension.
    """
    path = Path(path)
    with _open(path) as reader:
        h = reader.header
        names = set(h.point_format.dimension_names)
        n = int(h.point_count) if max_points is None else min(max_points, int(h.point_count))
        has_rgb = {"red", "green", "blue"} <= names
        fine_scan = "scan_angle" in names  # point formats 6-10: 0.006 degree units

        X = np.empty(n, dtype=np.int32)
        Y = np.empty(n, dtype=np.int32)
        Z = np.empty(n, dtype=np.int32)
        intensity = np.zeros(n, dtype=np.uint16)
        classification = np.zeros(n, dtype=np.uint8)
        return_number = np.zeros(n, dtype=np.uint8)
        number_of_returns = np.zeros(n, dtype=np.uint8)
        point_source_id = np.zeros(n, dtype=np.uint16)
        user_data = np.zeros(n, dtype=np.uint8)
        scan_angle = np.zeros(n, dtype=np.float32)
        flags = np.zeros(n, dtype=np.uint8)
        gps_time = np.empty(n, dtype=np.float64) if "gps_time" in names else None
        scanner_channel = np.empty(n, dtype=np.uint8) if "scanner_channel" in names else None
        rgb16 = np.empty((n, 3), dtype=np.uint16) if has_rgb else None
        nir = np.empty(n, dtype=np.uint16) if "nir" in names else None
        plain = [
            (name, arr)
            for name, arr in (
                ("intensity", intensity),
                ("classification", classification),
                ("return_number", return_number),
                ("number_of_returns", number_of_returns),
                ("point_source_id", point_source_id),
                ("user_data", user_data),
                ("gps_time", gps_time),
                ("scanner_channel", scanner_channel),
                ("nir", nir),
            )
            if arr is not None and name in names
        ]
        flag_bits = [
            (name, bit)
            for name, bit in (
                ("synthetic", FLAG_SYNTHETIC),
                ("key_point", FLAG_KEY_POINT),
                ("withheld", FLAG_WITHHELD),
                ("overlap", FLAG_OVERLAP),
                ("edge_of_flight_line", FLAG_EDGE_OF_FLIGHT_LINE),
                ("scan_direction_flag", FLAG_SCAN_DIRECTION),
            )
            if name in names
        ]

        pos = 0
        for chunk in reader.chunk_iterator(DECODE_CHUNK):
            if pos >= n:
                break
            m = min(len(chunk), n - pos)
            sl = slice(pos, pos + m)
            X[sl] = np.asarray(chunk["X"])[:m]
            Y[sl] = np.asarray(chunk["Y"])[:m]
            Z[sl] = np.asarray(chunk["Z"])[:m]
            for name, arr in plain:
                arr[sl] = np.asarray(chunk[name])[:m]
            for name, bit in flag_bits:
                flags[sl] |= (np.asarray(chunk[name])[:m].astype(bool) * np.uint8(bit)).astype(np.uint8)
            if fine_scan:
                scan_angle[sl] = np.asarray(chunk["scan_angle"])[:m].astype(np.float32) * np.float32(0.006)
            elif "scan_angle_rank" in names:
                scan_angle[sl] = np.asarray(chunk["scan_angle_rank"])[:m]
            if rgb16 is not None:
                for k, name in enumerate(("red", "green", "blue")):
                    rgb16[sl, k] = np.asarray(chunk[name])[:m]
            pos += m

    if pos < n:  # the header promised more points than the file holds
        n = pos
        X, Y, Z = X[:n].copy(), Y[:n].copy(), Z[:n].copy()
        intensity, classification = intensity[:n].copy(), classification[:n].copy()
        return_number, number_of_returns = return_number[:n].copy(), number_of_returns[:n].copy()
        point_source_id, user_data = point_source_id[:n].copy(), user_data[:n].copy()
        scan_angle, flags = scan_angle[:n].copy(), flags[:n].copy()
        gps_time = gps_time[:n].copy() if gps_time is not None else None
        scanner_channel = scanner_channel[:n].copy() if scanner_channel is not None else None
        rgb16 = rgb16[:n].copy() if rgb16 is not None else None
        nir = nir[:n].copy() if nir is not None else None

    rgb = None
    rgb_note = None
    if rgb16 is not None:
        # The LAS colour fields are 16-bit; some writers put 8-bit values in them.
        # 16-bit colour when any channel exceeds 255 (scaled down), else kept as is.
        shift = 8 if (n and int(rgb16.max()) > 255) else 0
        rgb_note = "16-bit colours scaled to 8-bit" if shift else "colours are 8-bit in 16-bit fields"
        rgb = np.empty((n, 3), dtype=np.uint8)
        for k in range(3):
            rgb[:, k] = rgb16[:, k] >> shift
        del rgb16

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
        X=X,
        Y=Y,
        Z=Z,
        intensity=intensity,
        classification=classification,
        return_number=return_number,
        number_of_returns=number_of_returns,
        point_source_id=point_source_id,
        scan_angle=scan_angle,
        gps_time=gps_time,
        flags=flags,
        user_data=user_data,
        scanner_channel=scanner_channel,
        rgb=rgb,
        nir=nir,
        gps_time_type=gps_type,
        rgb_note=rgb_note,
        class_lookup=lookup,
    )


# ----------------------------------------------------------------------------
# Several clouds as one stream
# ----------------------------------------------------------------------------

STREAM_FIELDS = (
    "xyz", "intensity", "classification", "return_number", "number_of_returns",
    "point_source_id", "scan_angle", "gps_time", "flags", "rgb",
)
SAMPLE_PER_CLOUD = 1_000_000  # points per file behind the merged percentiles


def _raw(cloud: PointCloud, name: str) -> tuple[np.ndarray, float, float] | None:
    """The stored array behind a ranged statistic and the scale and offset to apply."""
    if name == "z":
        return cloud.Z, float(cloud.scale[2]), float(cloud.offset[2])
    arr = getattr(cloud, name)
    return None if arr is None else (arr, 1.0, 0.0)


class CloudSet:
    """Clouds streamed together: a uniform mix, each file in proportion to its size.

    Stream position p holds, from cloud k, its shuffled points below floor(p*n_k/N),
    so every chunk [start, start+count) is a fixed set of per-cloud slices and a
    prefix of any length is a uniform sample of the whole. The chunk header lists
    those slices so the viewer can map a point back to its file.

    Layout (little endian): magic 'LPC2', count u32, has_rgb u8, has_time u8,
    nseg u16; nseg x (file id u32, local start u32, count u32); then the arrays of
    `PointCloud.slice_arrays` concatenated across the slices: xyz f32 x3,
    intensity u16, classification u8, return_number u8, number_of_returns u8,
    point_source_id u16, scan_angle f32, gps_time f32, flags u8, rgb u8 x3 (only
    when has_rgb).
    """

    def __init__(self, ids: list[int], clouds: list[PointCloud]) -> None:
        if not clouds:
            raise ValueError("a CloudSet needs at least one cloud")
        self.ids = list(ids)
        self.clouds = list(clouds)
        self.count = sum(c.count for c in clouds)
        filled = [c for c in clouds if c.count]
        if filled:
            mins = np.min([c.stats()["bounds"]["min"] for c in filled], axis=0)
            maxs = np.max([c.stats()["bounds"]["max"] for c in filled], axis=0)
            self.center = (np.asarray(mins, dtype=np.float64) + np.asarray(maxs, dtype=np.float64)) / 2.0
        else:
            self.center = np.zeros(3)
        self._stats: dict[str, Any] | None = None

    def segments(self, start: int, count: int) -> list[tuple[int, int, int]]:
        """(cloud index, local start, count) for stream positions [start, start+count)."""
        start = max(0, min(start, self.count))
        end = max(start, min(start + count, self.count))
        segs = []
        for k, c in enumerate(self.clouds):
            a = start * c.count // self.count if self.count else 0
            b = end * c.count // self.count if self.count else 0
            if b > a:
                segs.append((k, a, b - a))
        return segs

    def pack_chunk(self, start: int, count: int) -> bytes:
        segs = self.segments(start, count)
        t0 = self.stats().get("gps_time", {}).get("min", 0.0)
        has_rgb = any(c.rgb is not None for c in self.clouds)
        has_time = any(c.gps_time is not None for c in self.clouds)
        parts: dict[str, list[np.ndarray]] = {f: [] for f in STREAM_FIELDS}
        for k, a, n in segs:
            c = self.clouds[k]
            arrays = c.slice_arrays(c.order[a : a + n], self.center, t0)
            for f in STREAM_FIELDS:
                parts[f].append(arrays[f])
        total = sum(n for _, _, n in segs)
        head = [CHUNK_MAGIC, struct.pack("<IBBH", total, int(has_rgb), int(has_time), len(segs))]
        for k, a, n in segs:
            head.append(struct.pack("<III", self.ids[k], a, n))
        body = []
        for f in STREAM_FIELDS:
            if f == "rgb" and not has_rgb:
                continue
            body.append(np.concatenate(parts[f]).tobytes() if parts[f] else b"")
        return b"".join(head + body)

    def stats(self) -> dict[str, Any]:
        if self._stats is None:
            if len(self.clouds) == 1:
                self._stats = self.clouds[0].stats()
            else:
                self._stats = _json_safe(self._merged_stats())
        return self._stats

    def _merged_stats(self) -> dict[str, Any]:
        clouds = [c for c in self.clouds if c.count]
        n = self.count
        out: dict[str, Any] = {
            "point_count": n,
            "files": [{"id": i, "name": Path(c.path).name, "count": c.count} for i, c in zip(self.ids, self.clouds)],
        }
        if n == 0:
            return out
        mins = np.min([c.stats()["bounds"]["min"] for c in clouds], axis=0).tolist()
        maxs = np.max([c.stats()["bounds"]["max"] for c in clouds], axis=0).tolist()
        out["bounds"] = {"min": mins, "max": maxs}
        area = (maxs[0] - mins[0]) * (maxs[1] - mins[1])
        out["density_per_m2"] = float(n / area) if area > 0 else None
        out["density_note"] = "over the bounding box of all files"

        def merged_ranged(name: str, key: str, bins: int, percentiles=(1, 5, 50, 95, 99)) -> dict[str, Any] | None:
            """The files' `key` statistics as one: exact moments and histogram, sampled percentiles."""
            have = [(c, _raw(c, name)) for c in clouds if _raw(c, name) is not None]
            if not have:
                return None
            per = [c.stats()[key] for c, _ in have]
            lo = min(s["min"] for s in per)
            hi = max(s["max"] for s in per)
            counts = np.array([c.count for c, _ in have], dtype=np.float64)
            means = np.array([s["mean"] for s in per])
            stds = np.array([s["std"] for s in per])
            mean = float((counts * means).sum() / counts.sum())
            var = float((counts * (stds**2 + (means - mean) ** 2)).sum() / counts.sum())
            edges = _edges(lo, hi, bins)
            hist = np.zeros(bins, dtype=np.int64)
            samples = []
            for c, (arr, scale, offset) in have:
                hist += _histogram(arr, edges, scale, offset)
                idx = c.order[: min(c.count, SAMPLE_PER_CLOUD)]
                samples.append(arr[idx].astype(np.float64) * scale + offset)
            q = np.percentile(np.concatenate(samples), percentiles)
            return {
                "min": lo, "max": hi, "mean": mean, "std": math.sqrt(var),
                "percentiles": {str(p): float(x) for p, x in zip(percentiles, q, strict=True)},
                "percentiles_note": f"from a sample of up to {SAMPLE_PER_CLOUD} points per file",
                "histogram": {"edges": edges.tolist(), "counts": hist.tolist()},
            }

        out["z"] = merged_ranged("z", "z", 64)
        out["intensity"] = merged_ranged("intensity", "intensity", 64)
        out["scan_angle_deg"] = merged_ranged("scan_angle", "scan_angle_deg", 45, percentiles=(1, 50, 99))

        def merged_counts(key: str, limit: int = 256) -> list[dict[str, Any]]:
            acc: dict[int, int] = {}
            for c in clouds:
                for row in c.stats().get(key, []):
                    acc[row["value"]] = acc.get(row["value"], 0) + row["count"]
            rows = [{"value": v, "count": k, "fraction": k / n} for v, k in acc.items()]
            rows.sort(key=lambda r: -r["count"])
            return rows[:limit]

        classes = []
        for row in merged_counts("classification"):
            code = row["value"]
            names = {c.class_label(code) for c in clouds}
            classes.append({**row, "name": " / ".join(sorted(names)), "color": list(class_color(code))})
        out["classification"] = classes
        out["return_number"] = merged_counts("return_number")
        out["number_of_returns"] = merged_counts("number_of_returns")
        out["point_source_id"] = merged_counts("point_source_id", 64)
        out["point_source_id_unique"] = len({r["value"] for c in clouds for r in c.stats()["point_source_id"]})
        out["user_data"] = merged_counts("user_data", 16)
        if any("scanner_channel" in c.stats() for c in clouds):
            out["scanner_channel"] = merged_counts("scanner_channel")
        flags: dict[str, int] = {}
        for c in clouds:
            for k, v in c.stats()["flags"].items():
                flags[k] = flags.get(k, 0) + v
        out["flags"] = flags
        out["ground_points"] = sum(c.stats()["ground_points"] for c in clouds)
        out["ground_density_per_m2"] = float(out["ground_points"] / area) if area > 0 else None
        timed = [c for c in clouds if c.gps_time is not None]
        if timed:
            g = merged_ranged("gps_time", "gps_time", 96, percentiles=(1, 50, 99))
            types = {c.gps_time_type for c in timed}
            gtype = types.pop() if len(types) == 1 else "mixed"
            out["gps_time"] = {
                "type": gtype,
                "min": g["min"], "max": g["max"], "span_seconds": g["max"] - g["min"],
                "min_utc": gps_time_to_utc(g["min"], gtype), "max_utc": gps_time_to_utc(g["max"], gtype),
                "leap_seconds_assumed": GPS_UTC_LEAP_SECONDS,
                "histogram": g["histogram"],
            }
        coloured = [c for c in clouds if c.rgb is not None]
        if coloured:
            out["rgb"] = {}
            for k, name in enumerate(("red", "green", "blue")):
                vals = [c.rgb[:, k] for c in coloured]
                out["rgb"][name] = {
                    "min": min(int(v.min()) for v in vals), "max": max(int(v.max()) for v in vals),
                    "mean": float(np.mean([float(v.mean()) for v in vals])), "std": 0.0, "percentiles": {},
                }
        return out
