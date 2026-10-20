"""ASPRS point classes: the one table of names and display colours.

The names follow the LAS 1.4 specification (R15). Classes 23-63 are reserved and
64-255 are user definable; `class_name` says so for those.
"""

from __future__ import annotations

ASPRS_CLASSES: dict[int, str] = {
    0: "Created, never classified",
    1: "Unclassified",
    2: "Ground",
    3: "Low vegetation",
    4: "Medium vegetation",
    5: "High vegetation",
    6: "Building",
    7: "Low point (noise)",
    8: "Model key-point (LAS 1.1-1.3) / reserved",
    9: "Water",
    10: "Rail",
    11: "Road surface",
    12: "Overlap (LAS 1.1-1.3) / reserved",
    13: "Wire - guard (shield)",
    14: "Wire - conductor (phase)",
    15: "Transmission tower",
    16: "Wire-structure connector (insulator)",
    17: "Bridge deck",
    18: "High noise",
    19: "Overhead structure",
    20: "Ignored ground",
    21: "Snow",
    22: "Temporal exclusion",
}

# Display colours, RGB 0-255. Unlisted classes get a hashed hue (see `class_color`).
CLASS_COLORS: dict[int, tuple[int, int, int]] = {
    0: (120, 120, 120),
    1: (190, 190, 190),
    2: (166, 118, 62),
    3: (120, 200, 90),
    4: (60, 170, 60),
    5: (20, 110, 40),
    6: (230, 80, 60),
    7: (255, 0, 255),
    8: (255, 220, 120),
    9: (40, 110, 230),
    10: (170, 60, 170),
    11: (80, 80, 80),
    12: (200, 200, 120),
    13: (255, 160, 0),
    14: (255, 120, 0),
    15: (200, 60, 200),
    16: (255, 200, 0),
    17: (160, 110, 60),
    18: (255, 0, 120),
    19: (200, 130, 200),
    20: (140, 100, 50),
    21: (240, 240, 255),
    22: (255, 255, 0),
}


def class_name(code: int) -> str:
    """The ASPRS name of a class code, or what the range is reserved for."""
    if code in ASPRS_CLASSES:
        return ASPRS_CLASSES[code]
    if 23 <= code <= 63:
        return "Reserved"
    if 64 <= code <= 255:
        return "User definable"
    return "Invalid"


def class_color(code: int) -> tuple[int, int, int]:
    """A display colour for any class code, stable from run to run."""
    if code in CLASS_COLORS:
        return CLASS_COLORS[code]
    # Golden-angle hue spread for the unlisted codes.
    hue = (code * 137.508) % 360.0
    return _hsv_to_rgb(hue, 0.6, 0.85)


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    c = v * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = v - c
    sector = int(h // 60) % 6
    r, g, b = [(c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)][sector]
    return (round((r + m) * 255), round((g + m) * 255), round((b + m) * 255))
