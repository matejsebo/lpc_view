# lpcview

View, inspect and fly through LAS/LAZ lidar point clouds, in a window of its own
or in a browser, from a small local Python server. It shows every piece of metadata a file carries: the
public header, the global encoding bits, the point format's dimensions, each VLR
and EVLR (parsed where known, raw bytes always), the coordinate reference system,
and statistics computed from the points themselves.

## Run

Needs [uv](https://docs.astral.sh/uv/) and Python 3.13.

```bash
uv sync
```

```bash
uv run lpcview app path/to/tile.laz
```

opens the viewer in a window of its own (maximised, titled lpcview), on a free
local port. With no files it asks for some with the native file dialog;
**Open...** in the Files section (or `O`) adds more while it runs. Closing the
window stops the server. On Windows the window is a WebView2 (Edge) view; see
[Building the exe](#building-the-exe) for the runtime it needs.

In a browser instead:

```bash
uv run lpcview serve path/to/tile.laz
```

Then open <http://127.0.0.1:8765/>. Several files, or a directory of them, can be
given to either command; the page has a file picker. `--open` opens the page for
you, `--port` changes the port.

A quick look without the browser:

```bash
uv run lpcview info path/to/tile.laz --stats
```

`--json` prints the full metadata as JSON.

## In the viewer

- **Load** decodes the ticked files on the server (a 170 MB LAZ of 28 M points
  takes about ten seconds), computes their statistics, and streams a uniform
  random sample of up to the chosen number of points into the view, drawing as
  it goes. Several files load as one mosaic, each contributing in proportion to
  its size; the statistics and class list merge, and a picked point reports
  which file it came from. "all" loads every point; 20 M points take roughly
  500 MB of GPU memory. Decoded files stay in memory (`--max-loaded` caps how
  many), so a 40 M point mosaic wants a few GB of RAM.
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
  ids, flags), and the header, VLRs and CRS of the file chosen at the top of the
  panel. The metadata is also served as JSON at `/api/meta?file=0`.

## Building the exe

One file, `dist/lpcview.exe`, with the page, the vendored three.js and the
Python side inside; no console. It is built with PyInstaller (a dev dependency):

```bash
uv run python tools/build_exe.py
```

Double-click it, drop files on it, or set it as the "Open with" program for
`.laz` and `.las`: an argument that is a path means `app`. From a console it
takes the same commands as `lpcview`, but being a windowed build it prints
nothing, so use the uv install for `serve` and `info`. `--console` builds a
console variant that does print; `--keep-build` keeps PyInstaller's work
directory for a look at what was collected.

The window needs the **WebView2 runtime** (the Edge engine pywebview uses on
Windows). Windows 11 has it, and so does any Windows 10 with Microsoft Edge or
Office installed. Without it the exe shows a message instead of the page;
install the Evergreen runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/> (the Evergreen
Bootstrapper is a 2 MB download that installs the current version). Nothing else
is needed: Python, laspy, numpy and pyproj are in the exe.

## Layout

- `src/lpcview/reader.py`: metadata extraction, point decoding, statistics, and
  the binary chunk format the viewer streams.
- `src/lpcview/server.py`: the HTTP server and its API (documented at the top of
  the file).
- `src/lpcview/app.py`: `lpcview app`, the pywebview window around the server,
  and the `Api` the page calls for the file dialog.
- `src/lpcview/cli.py`: the `lpcview` command (`app`, `serve`, `info`);
  `__main__.py` runs it for `python -m lpcview` and the exe.
- `tools/build_exe.py`: the PyInstaller build.
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
