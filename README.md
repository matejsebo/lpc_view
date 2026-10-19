# lpcview

View, inspect and fly through LAS/LAZ lidar point clouds in a browser, from a
small local Python server. It shows every piece of metadata a file carries: the
public header, the global encoding bits, the point format's dimensions, each VLR
and EVLR (parsed where known, raw bytes always), the coordinate reference system,
and statistics computed from the points themselves.

## Run

Needs [uv](https://docs.astral.sh/uv/) and Python 3.13.

```bash
uv sync
```

```bash
uv run lpcview serve path/to/tile.laz
```

Then open <http://127.0.0.1:8765/>. Several files, or a directory of them, can be
given; the page has a file picker. `--open` opens the page for you, `--port`
changes the port.

A quick look without the browser:

```bash
uv run lpcview info path/to/tile.laz --stats
```

`--json` prints the full metadata as JSON.

## In the viewer

- **Load** decodes the file on the server (a 170 MB LAZ of 28 M points takes
  about ten seconds), computes its statistics, and streams a uniform random
  sample of up to the chosen number of points into the view, drawing as it goes.
  "all" loads every point; 20 M points take roughly 500 MB of GPU memory.
- **Colour by** elevation, intensity, classification, return number, number of
  returns, point source id, GPS time, scan angle, RGB (when the file has it), or
  single/first/last return.
- **Filter** by class (checkboxes with each class's share), and hide withheld,
  overlap or synthetic points.
- **Fly**: drag to look, `W A S D` to move, `Q`/`E` down and up, `Shift` fast,
  `Ctrl` slow, mouse wheel sets the speed. `L` or a double click locks the mouse
  for free look (`Esc` releases it). `F` fits the whole cloud, `T` looks straight
  down, `G` drops the camera to eye level above the nearest ground points.
- **Inspect**: click a point (or press `P` with the mouse locked) to see every
  attribute of that exact point from the file: raw integer coordinates, scaled
  coordinates, latitude and longitude, intensity, return, class with the file's
  own lookup name, scan angle, flags, GPS time as UTC, and so on.
- The right panel's tabs hold the picked point, the statistics (class counts,
  elevation, intensity, scan angle and time histograms, returns, point source
  ids, flags), the header, the VLRs and the CRS. The metadata is also served as
  JSON at `/api/meta?file=0`.

## Layout

- `src/lpcview/reader.py`: metadata extraction, point decoding, statistics, and
  the binary chunk format the viewer streams.
- `src/lpcview/server.py`: the HTTP server and its API (documented at the top of
  the file).
- `src/lpcview/classes.py`: the ASPRS class table and colours.
- `src/lpcview/static/`: the page, its style, `app.js` (three.js scene, fly
  camera, GPU picking, panels) and the vendored three.js r180 (MIT).
- `tests/`: pytest, on a synthetic LAS/LAZ written with laspy.

```bash
uv run pytest
```

## Notes

- GPS times tagged "adjusted standard" are converted to UTC assuming 18 leap
  seconds (correct from 2017 on).
- The point sample is a fixed shuffle of the file, so the same points come back
  from run to run and a prefix of any size is a uniform sample.
- Point coordinates are sent to the browser as float32 offsets from the centre
  of the file's bounding box; the inspector fetches the exact values from the
  server.
