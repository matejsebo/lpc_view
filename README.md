# lpc_view

View, inspect and fly through LAS/LAZ lidar point clouds, in a window of its own
or in a browser, from a small local Python server. It shows every piece of metadata a file carries: the
public header, the global encoding bits, the point format's dimensions, each VLR
and EVLR (parsed where known, raw bytes always), the coordinate reference system,
and statistics computed from the points themselves.

## Run

Needs [uv](https://docs.astral.sh/uv/) and Python 3.12 or newer.

```bash
uv sync --extra app
```

(`uv sync` alone leaves out pywebview, the `app` extra: enough for `serve` and
`info`, and for the tests, which skip the window's.)

```bash
uv run lpc_view app path/to/tile.laz
```

opens the viewer in a window of its own (maximised, titled lpc_view), on a free
local port. With no files it asks for some with the native file dialog;
**Open...** in the Files section (or `O`) adds more while it runs. Closing the
window stops the server. On Windows the window is a WebView2 (Edge) view; see
[Building the exe](#building-the-exe) for the runtime it needs.

In a browser instead:

```bash
uv run lpc_view serve path/to/tile.laz
```

Then open the URL it prints: `http://127.0.0.1:8765/?token=...`. The server
binds only to this machine, answers only loopback Host headers, and its API
takes only requests carrying that token, which the page keeps for its tab. So
another program or user on the machine, or a web page you visit, cannot read
your files through it. Several files, or a directory of them, can be given to
either command; the page has a file picker. `--open` opens the page for you,
`--port` changes the port.

A quick look without the browser:

```bash
uv run lpc_view info path/to/tile.laz --stats
```

`--json` prints the full metadata as JSON.

## In the viewer

- **Load** decodes the ticked files on the server (a 170 MB LAZ of 28 M points
  takes about ten seconds), computes their statistics, and streams a uniform
  random sample of up to the chosen number of points into the view, drawing as
  it goes. Several files load as one mosaic, each contributing in proportion to
  its size; the statistics and class list merge, and a picked point reports
  which file it came from. "all" loads every point; 20 M points take roughly
  700 MB of GPU memory and as much again in the page. Every load, "all"
  included, is capped at what a quarter of the machine's memory holds (as the
  browser reports it, 8 GB assumed when it does not, at 60 bytes a point), and
  the status line says so: "capped at 12 M of 42 M points for this machine's
  memory". Each streamed chunk is parsed and binned by cell in a Web Worker
  while the next one downloads, so the view keeps drawing during a load; the
  page only copies each cell's run into place. Decoded files stay in memory
  (`--max-loaded` caps how many), so a 40 M point mosaic wants a few GB of
  RAM.
- **Level of detail**: the points sit in a grid of cells about 100 m square cut
  from the loaded extent, each filled in arrival order, so a prefix of a cell is
  a uniform sample of it. Every frame culls the cells outside the view and draws
  each visible cell in full within a "full to" distance and at (distance ratio)^2
  of its points beyond it, which keeps the points per screen area about even.
  While the camera moves, that distance follows the frame time towards a 16 ms
  target; once the camera is still it grows until every visible cell draws
  everything. The HUD shows the points and cells drawn and the distance.
  "Bigger when near" enlarges points up to 8 px (times the pixel ratio).
- **Hide points behind relief** (off by default): a terrain surface is built
  from the loaded points (the lowest point of every 2 m cell, ground-classified
  returns first, then eroded over 2 cells so that bumps narrower than about
  8 m, such as tree crowns, sink to the ground beside them) and drawn depth-only
  into a half-resolution depth texture before each frame; the main pass drops
  any point more than 1 m plus 1 % of its distance behind that surface, and the
  pick honours the same surface. Only the ground hides: a valley beyond a ridge
  goes, a tree behind a tree stays. Building the terrain for 10 M points takes
  about 150 ms and happens when the toggle goes on and again after a load
  grows the cloud; drawing it costs almost nothing. With `?debug` in the URL,
  `lpc_view.occlusion.params` holds the cell size, erosion radius and
  tolerances (call `lpc_view.occlusion.rebuild()` after changing them).
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

One file, `dist/lpc_view.exe`, with the page, the vendored three.js and the
Python side inside; no console. It is built with PyInstaller (a dev dependency):

```bash
uv run python tools/build_exe.py
```

`--onedir` builds a folder instead, `dist/lpc_view/`, with the exe next to its
libraries; zip and ship the whole folder:

```bash
uv run python tools/build_exe.py --onedir
```

The one-file exe unpacks itself into a temporary folder at every start, which
is slower (about 1.3 s to the window against 0.8 s for the folder, on a 22 MB
LAZ) and is the kind of self-extracting program antivirus heuristics flag most
often, so a fresh build may be quarantined or blocked by SmartScreen on another
machine. The folder build starts faster and gets far fewer such false
positives; prefer it for anything handed to other people. Either way the build
is not signed. Sizes: 30 MB for the file, 84 MB for the folder.

Double-click it, drop files on it, or set it as the "Open with" program for
`.laz` and `.las`: an argument that is a path means `app`. From a console it
takes the same commands as `lpc_view`, but being a windowed build it prints
nothing, so use the uv install for `serve` and `info`. `--console` builds a
console variant that does print (with either layout); `--keep-build` keeps
PyInstaller's work directory for a look at what was collected. The script
clears the other layout's output from `dist/` first, so it holds one build at a
time.

The window needs the **WebView2 runtime** (the Edge engine pywebview uses on
Windows). Windows 11 has it, and so does any Windows 10 with Microsoft Edge or
Office installed. Without it the exe shows a message instead of the page;
install the Evergreen runtime from
<https://developer.microsoft.com/microsoft-edge/webview2/> (the Evergreen
Bootstrapper is a 2 MB download that installs the current version). Nothing else
is needed: Python, laspy, numpy and pyproj are in the exe.

## Layout

- `src/lpc_view/reader.py`: metadata extraction, point decoding, statistics, and
  the binary chunk format the viewer streams.
- `src/lpc_view/server.py`: the HTTP server and its API (documented at the top of
  the file).
- `src/lpc_view/app.py`: `lpc_view app`, the pywebview window around the server,
  and the `Api` the page calls for the file dialog.
- `src/lpc_view/cli.py`: the `lpc_view` command (`app`, `serve`, `info`);
  `__main__.py` runs it for `python -m lpc_view` and the exe.
- `tools/build_exe.py`: the PyInstaller build.
- `src/lpc_view/classes.py`: the ASPRS class table and colours.
- `src/lpc_view/static/`: the page and its style, and the ES modules `app.js`
  wires: `api.js` (token, fetch), `shaders.js` (GLSL, colour ramps, materials),
  `cells.js` (the grid of cells, chunk ingest, level of detail, the point
  budget cap), `camera.js` (fly controls and views), `picking.js` (GPU picks),
  `panels.js` (the DOM: file list, class list, the five tabs), `classes.js`
  (class colours, mirroring `classes.py`), `colormaps.js`, and the vendored
  three.js r180 (MIT). Only `app.js` imports three.js; the other modules take
  it as an argument, so their pure functions load in Node.
- `tests/`: pytest, on a synthetic LAS/LAZ written with laspy; `tests/js/`: the
  page's pure functions (chunk parsing, grid and pick-code maths, the level of
  detail controller, the budget cap, the query split) under `node:test`, no
  dependencies.

```bash
uv run pytest
npm test
```

## Notes

- GPS times tagged "adjusted standard" are converted to UTC assuming 18 leap
  seconds (correct from 2017 on).
- The point sample is a fixed shuffle of the file, so the same points come back
  from run to run and a prefix of any size is a uniform sample.
- Point coordinates are sent to the browser as float32 offsets from the centre
  of the file's bounding box; the inspector fetches the exact values from the
  server.
- A pick reads one pixel of a render in which each point's colour is its cell id
  (high bits) and index in the cell; the cell maps the index to its stream
  position and the stream's segment table to the file and the file's point.
- Frame rates, 2026-10-20, on 16 tiles of the USGS San Diego 2014 survey
  (42.3 M points, 2.8 x 3.4 km) in a 1024 x 768 view on an RTX 5080 with
  vsync off, so the rates are what the GPU and the page allow:
  - Before (one buffer, every loaded point drawn every frame): 10 M points at
    125-144 fps in every view; 42.3 M at 37 fps from the fit view and 58 fps at
    eye level.
  - After (cells, culling and the level of detail): 10 M points at the 144 fps
    cap in every view, every visible cell in full; 42.3 M at eye level 122 fps
    still and flying (the frustum keeps 263 of 914 cells, 13.1 M points, under
    the target so they draw in full), 134 fps turning; from the fit view all
    42.3 M drawn at 42 fps when still, 70 fps flying in with the distance cut
    to 1,775 m (14.0 M points drawn), 123 fps turning away (8 cells).
  - A click resolves to its file and index in every one of those views; the
    marker sits on the server's coordinates of the picked point.

## Development

```bash
uv sync --all-extras --dev
```

installs everything, the test and build tools included. The Python tests:

```bash
uv run pytest
```

The page's tests, with Node 20 or later, once `tests/js/` exists:

```bash
node --test tests/js
```

Lint with ruff (no install needed beyond uv):

```bash
uvx ruff check src tools
```

Continuous integration, `.github/workflows/ci.yml`, runs those same commands on
every push and pull request, on Windows and Ubuntu with Python 3.13 (the page
tests only when `tests/js/` exists). The exe is not built in CI; see
[Building the exe](#building-the-exe).
