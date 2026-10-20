// lpc_view: the grid of cells the points live in, the chunk ingest that fills
// them, and the level of detail that sets each cell's draw range.
//
// three.js comes in as an argument of createCells, not as an import, so the pure
// functions above it (the extent, grid sizing, cell index maths, chunk parsing,
// segment lookup and the LOD maths) load in Node for the tests.

// The grid: the loaded extent cut into cells about CELL_M square (at most MAX_CELLS
// of them, larger when the extent is huge), each with its own buffers filled in
// arrival order. The stream is a uniform shuffle, so each cell's points are too,
// and a cell's draw range is a uniform sample of it. Picks come back as
// (cell id, index in cell): cell ids take the high bits of the 32-bit pick colour
// and indices the rest, and `stream` maps an index back to its stream position.
export const CELL_M = 100;
export const MAX_CELLS = 4096;
// Shader attribute name, cell array key, items per point.
export const ATTRS = [["position", "pos", 3], ["intensity", "intensity", 1], ["classification", "cls", 1], ["returnNumber", "ret", 1], ["numReturns", "nret", 1], ["pointSource", "psid", 1], ["scanAngle", "angle", 1], ["gpsTime", "time", 1], ["flags", "flags", 1], ["rgb", "rgb", 3]];

// Level of detail. The points sit in a grid of cells (makeGrid), each filled in
// arrival order, so the first k points of a cell are a uniform sample of it. Each
// frame culls the cells outside the frustum and gives every visible cell a draw
// range from its distance d to the camera: all its points within `near` metres,
// a fraction (near / d)^2 beyond, which keeps the points per screen area about
// constant. `near` is the knob a frame-time controller turns: while the camera
// moves, a frame over the 16 ms target (with a fifth of slack for vsync jitter)
// pulls it in, by the ratio of the times but never below 0.7 on the drawn count,
// and a frame at or under it pushes it out, 4 % more points (15 % when the frame
// took under half the target), so on a display whose refresh pins every frame to
// the same interval the detail still climbs until a frame is skipped; once the
// camera has been still for a moment it grows a fifth each frame until every
// cell draws everything. A move starts where the last one settled, not at the
// still camera's all.
export const TARGET_MS = 16;
export const NEAR_ALL = 1e6;                      // metres: farther than any cell, i.e. all

// What a point costs in memory: its cell arrays (cellArrays below: 12 position,
// 2 intensity, 1 each class, return, returns and flags, 2 source id, 4 angle,
// 4 time, 4 stream index) and the same again on the GPU, less the stream index;
// 3 more each with RGB. The cells' growth margins come on top of this.
export const BYTES_PER_POINT = { arrays: 32, gpu: 28, rgb: 3 };
export const DEFAULT_MEMORY_GB = 8;               // when navigator.deviceMemory is not there

export function pointCost(hasRgb) {
  return BYTES_PER_POINT.arrays + BYTES_PER_POINT.gpu + (hasRgb ? 2 * BYTES_PER_POINT.rgb : 0);
}

// The most points this machine should hold: a quarter of its memory (GB, as
// navigator.deviceMemory reports it, DEFAULT_MEMORY_GB when it does not).
export function budgetCap(deviceMemoryGb, hasRgb) {
  const gb = deviceMemoryGb > 0 ? deviceMemoryGb : DEFAULT_MEMORY_GB;
  return Math.floor((gb * 2 ** 30) / 4 / pointCost(hasRgb));
}

// The budget for a load of `want` points ("all" being the cloud's count) out of
// `total`, and whether the machine's memory cut it.
export function capBudget(want, total, deviceMemoryGb, hasRgb) {
  const cap = budgetCap(deviceMemoryGb, hasRgb);
  const budget = Math.min(want, total);
  return { budget: Math.min(budget, cap), cap, capped: budget > cap };
}

// The loaded extent around the cloud's centre; without stats, a default box.
export function extentOf(stats, center) {
  if (!stats) return { min: [-500, -500, -50], max: [500, 500, 50] };
  const c = center;
  const min = stats.bounds.min.map((v, i) => v - c[i]), max = stats.bounds.max.map((v, i) => v - c[i]);
  // Stray noise points can put the z bounds kilometres out; frame the 1-99 percentile band.
  min[2] = stats.z.percentiles["1"] - c[2];
  max[2] = stats.z.percentiles["99"] - c[2];
  return { min, max };
}

// How many cells an ex by ey metre extent gets, and how the 32-bit pick code is
// split between cell id and index in the cell.
export function gridSizing(ex, ey, cellM = CELL_M, maxCells = MAX_CELLS) {
  ex = Math.max(ex, 1); ey = Math.max(ey, 1);
  if ((ex / cellM) * (ey / cellM) > maxCells) cellM = Math.sqrt((ex * ey) / maxCells);
  const nx = Math.max(1, Math.round(ex / cellM)), ny = Math.max(1, Math.round(ey / cellM));
  const cellBits = Math.max(1, Math.ceil(Math.log2(nx * ny + 1)));
  return { nx, ny, dx: ex / nx, dy: ey / ny, cellBits, localBits: 32 - cellBits, localSpan: 2 ** (32 - cellBits) };
}

// The cell (x, y) falls in; points outside the extent go to the edge cells.
export function cellIndex(grid, x, y) {
  const ix = Math.min(grid.nx - 1, Math.max(0, Math.floor((x - grid.x0) / grid.dx)));
  const iy = Math.min(grid.ny - 1, Math.max(0, Math.floor((y - grid.y0) / grid.dy)));
  return ix + iy * grid.nx;
}

// The cell index ranges whose footprint comes within r metres of (x, y).
export function cellsNear(grid, x, y, r) {
  const ax = Math.max(0, Math.floor((x - r - grid.x0) / grid.dx)), bx = Math.min(grid.nx - 1, Math.floor((x + r - grid.x0) / grid.dx));
  const ay = Math.max(0, Math.floor((y - r - grid.y0) / grid.dy)), by = Math.min(grid.ny - 1, Math.floor((y + r - grid.y0) / grid.dy));
  return { ax, bx, ay, by };
}

// Which file a stream index came from: the segment {start, file, local, count}
// holding it, by binary search over the segments in stream order.
export function segmentOf(segments, streamIndex) {
  let lo = 0, hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (streamIndex < s.start) hi = mid - 1;
    else if (streamIndex >= s.start + s.count) lo = mid + 1;
    else return s;
  }
  return null;
}

// Parse one LPC2 chunk (the format is documented at reader.CloudSet): header, the
// segments saying which file each run of points came from (given stream starts
// from `start`, the points loaded before this chunk), and typed views of the
// arrays. A view is taken where its offset is aligned for the element size, else
// an aligned copy (the last chunk's odd count can leave the 2- and 4-byte arrays
// misaligned).
export function parseChunk(buf, start) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "LPC2") throw new Error("bad chunk");
  const n = dv.getUint32(4, true);
  const hasRgb = dv.getUint8(8) === 1;
  const nseg = dv.getUint16(10, true);
  let off = 12;
  let at = start;
  const segments = [];
  for (let k = 0; k < nseg; k++) {
    const seg = { file: dv.getUint32(off, true), local: dv.getUint32(off + 4, true), count: dv.getUint32(off + 8, true), start: at };
    off += 12;
    at += seg.count;
    if (seg.count) segments.push(seg);
  }
  if (at - start !== n) throw new Error("chunk segments do not add up");
  const take = (Ctor, count) => {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    const v = off % Ctor.BYTES_PER_ELEMENT === 0 ? new Ctor(buf, off, count) : new Ctor(buf.slice(off, off + bytes));
    off += bytes;
    return v;
  };
  const pos = take(Float32Array, 3 * n);
  const intensity = take(Uint16Array, n);
  const cls = take(Uint8Array, n);
  const ret = take(Uint8Array, n);
  const nret = take(Uint8Array, n);
  const psid = take(Uint16Array, n);
  const angle = take(Float32Array, n);
  const time = take(Float32Array, n);
  const flags = take(Uint8Array, n);
  const rgb = hasRgb ? take(Uint8Array, 3 * n) : null;
  return { n, hasRgb, segments, pos, intensity, cls, ret, nret, psid, angle, time, flags, rgb };
}

// How many of a cell's n points to draw when it is d metres away and cells within
// `near` draw in full.
export function drawCount(n, d, near) {
  const f = d <= near ? 1 : (near * near) / (d * d);
  return f >= 1 ? n : Math.floor(n * f);
}

export function newLod() {
  return { near: 200, movingNear: 200, moving: false, stillSince: 0, drawn: 0, cellsDrawn: 0 };
}

// One frame of the controller described above: `moved` says whether the camera
// pose changed since the last frame, frameMs how long that frame took.
export function stepLod(lod, moved, now, frameMs, targetMs = TARGET_MS) {
  if (moved) lod.stillSince = now;
  const wasMoving = lod.moving;
  lod.moving = now - lod.stillSince < 150;
  if (lod.moving) {
    if (!wasMoving) lod.near = Math.min(lod.near, lod.movingNear);
    // The drawn count goes with near^2, so a factor on the count is its square root on near.
    let factor = 1.04;
    if (frameMs > targetMs * 1.2) factor = Math.max(0.7, (0.9 * targetMs) / frameMs);
    else if (frameMs < targetMs * 0.5) factor = 1.15;
    lod.near = Math.min(NEAR_ALL, Math.max(5, lod.near * Math.sqrt(factor)));
    lod.movingNear = lod.near;
  } else if (lod.near < NEAR_ALL) {
    lod.near = Math.min(NEAR_ALL, lod.near * 1.2);
  }
  return lod;
}

export function cellArrays(cap, hasRgb) {
  return {
    pos: new Float32Array(3 * cap), intensity: new Uint16Array(cap), cls: new Uint8Array(cap), ret: new Uint8Array(cap),
    nret: new Uint8Array(cap), psid: new Uint16Array(cap), angle: new Float32Array(cap), time: new Float32Array(cap),
    flags: new Uint8Array(cap), rgb: hasRgb ? new Uint8Array(3 * cap) : null, stream: new Uint32Array(cap),
  };
}

// The point count in a chunk's header, readable before the buffer is handed to
// the worker.
export function chunkCount(buf) {
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "LPC2") throw new Error("bad chunk");
  return dv.getUint32(4, true);
}

// The grid's numbers, which a worker can be sent.
export function gridParams(grid) {
  return { nx: grid.nx, ny: grid.ny, x0: grid.x0, y0: grid.y0, dx: grid.dx, dy: grid.dy };
}

// Sort a parsed chunk's points by cell, so that each cell takes its share with
// one copy: the count and offset of every cell, the arrays in cell order (stream
// indices counted from `start`, the points loaded before this chunk) and each
// cell's z range. Pure; the ingest worker runs it off the main thread.
export function binChunk(c, grid, start) {
  const n = c.n, ncells = grid.nx * grid.ny;
  const target = new Uint32Array(n), counts = new Uint32Array(ncells);
  for (let i = 0; i < n; i++) { const t = cellIndex(grid, c.pos[3 * i], c.pos[3 * i + 1]); target[i] = t; counts[t]++; }
  const offsets = new Uint32Array(ncells);
  for (let t = 0, o = 0; t < ncells; t++) { offsets[t] = o; o += counts[t]; }
  const cursor = offsets.slice();
  const a = cellArrays(n, c.hasRgb);
  const zmin = new Float32Array(ncells).fill(Infinity), zmax = new Float32Array(ncells).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const t = target[i], k = cursor[t]++;
    const z = c.pos[3 * i + 2];
    a.pos[3 * k] = c.pos[3 * i]; a.pos[3 * k + 1] = c.pos[3 * i + 1]; a.pos[3 * k + 2] = z;
    a.intensity[k] = c.intensity[i]; a.cls[k] = c.cls[i]; a.ret[k] = c.ret[i]; a.nret[k] = c.nret[i]; a.psid[k] = c.psid[i];
    a.angle[k] = c.angle[i]; a.time[k] = c.time[i]; a.flags[k] = c.flags[i]; a.stream[k] = start + i;
    if (a.rgb) { a.rgb[3 * k] = c.rgb[3 * i]; a.rgb[3 * k + 1] = c.rgb[3 * i + 1]; a.rgb[3 * k + 2] = c.rgb[3 * i + 2]; }
    if (z < zmin[t]) zmin[t] = z;
    if (z > zmax[t]) zmax[t] = z;
  }
  return { n, start, hasRgb: c.hasRgb, segments: c.segments, counts, offsets, zmin, zmax, arrays: a };
}

// A binned chunk's buffers, for postMessage to transfer rather than copy.
export function binnedBuffers(b) {
  const out = [b.counts.buffer, b.offsets.buffer, b.zmin.buffer, b.zmax.buffer];
  for (const k of Object.keys(b.arrays)) if (b.arrays[k]) out.push(b.arrays[k].buffer);
  return out;
}

// The cells in the scene: a THREE.Group of one THREE.Points per grid cell, the
// extent box, and the LOD state. `cloud` is the shared bookkeeping (stats, center,
// budget, loaded, grid, segments).
export function createCells({ THREE, scene, camera, shading, cloud }) {
  const { uniforms, material, pickMaterial } = shading;
  const lod = newLod();
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  let cellGroup = null;    // THREE.Group of one THREE.Points per grid cell
  let boundsHelper = null;

  function makeGrid(stats) {
    const e = extentOf(cloud.stats, cloud.center);
    const s = gridSizing(e.max[0] - e.min[0], e.max[1] - e.min[1]);
    const grid = { ...s, x0: e.min[0], y0: e.min[1], cells: [], hasRgb: !!stats.rgb };
    for (let iy = 0; iy < s.ny; iy++) {
      for (let ix = 0; ix < s.nx; ix++) {
        const x = grid.x0 + ix * grid.dx, y = grid.y0 + iy * grid.dy;
        grid.cells.push({
          id: grid.cells.length, ix, iy, n: 0, cap: 0, expected: 0, drawn: 0, zmin: Infinity, zmax: -Infinity,
          box: new THREE.Box3(new THREE.Vector3(x, y, 0), new THREE.Vector3(x + grid.dx, y + grid.dy, 0)),
          arrays: null, geometry: null, points: null,
        });
      }
    }
    uniforms.uLocalBits.value = grid.localBits;
    return grid;
  }

  // The filled cells whose footprint comes within r metres of (x, y).
  function cellsAround(x, y, r) {
    const g = cloud.grid, out = [];
    if (!g) return out;
    const { ax, bx, ay, by } = cellsNear(g, x, y, r);
    for (let iy = ay; iy <= by; iy++) for (let ix = ax; ix <= bx; ix++) { const c = g.cells[ix + iy * g.nx]; if (c.n) out.push(c); }
    return out;
  }

  // Give a cell room for `needed` points: fresh arrays and a fresh geometry (the old
  // geometry is disposed, which frees its GPU buffers) with the points so far copied.
  // The first chunk is a uniform sample of the whole load, so a cell's share of it
  // says how many points it will get; the first allocation is that and a margin,
  // and a cell that outgrows it gets half as much again each time.
  function growCell(cell, needed) {
    const grid = cloud.grid;
    const cap = Math.max(needed, cell.cap ? Math.ceil(cell.cap * 1.5) : Math.ceil(cell.expected * 1.15) + 1024);
    const a = cellArrays(cap, grid.hasRgb);
    if (cell.arrays) for (const k of Object.keys(a)) if (a[k]) a[k].set(cell.arrays[k].subarray(0, cell.n * (k === "pos" || k === "rgb" ? 3 : 1)));
    const g = new THREE.BufferGeometry();
    for (const [name, key, items] of ATTRS) {
      if (key === "rgb" && !grid.hasRgb) continue;
      const attr = new THREE.BufferAttribute(a[key], items, key === "intensity" || key === "rgb");
      attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, attr);
    }
    g.setDrawRange(0, cell.drawn);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);   // culled here, not by three
    if (cell.geometry) cell.geometry.dispose();
    cell.arrays = a; cell.cap = cap; cell.geometry = g;
    if (cell.points) cell.points.geometry = g;
    else {
      const p = new THREE.Points(g, material);
      p.frustumCulled = false;
      p.onBeforeRender = (r, s, c, geom, mat) => { if (mat === pickMaterial) { uniforms.uCellId.value = cell.id; mat.uniformsNeedUpdate = true; } };
      cell.points = p;
      cellGroup.add(p);
    }
    if (cell.n > grid.localSpan) console.warn(`cell ${cell.id} holds ${cell.n} points, more than a pick can address (${grid.localSpan})`);
  }

  // Make the grid and the extent box for a load of n points. Returns whether the
  // RGB fields hold any colour (fields that are present but all zero were never filled).
  function allocate(n, stats, showBounds) {
    cloud.hasRgb = !!stats.rgb;
    for (const m of [material, pickMaterial]) {
      const want = cloud.hasRgb ? { HAS_RGB: 1 } : {};
      if (JSON.stringify(m.defines || {}) !== JSON.stringify(want)) { m.defines = want; m.needsUpdate = true; }
    }
    cellGroup = new THREE.Group();
    scene.add(cellGroup);
    cloud.grid = makeGrid(stats);
    const e = extentOf(cloud.stats, cloud.center);
    const box = new THREE.Box3(new THREE.Vector3(...e.min), new THREE.Vector3(...e.max));
    boundsHelper = new THREE.Box3Helper(box, 0x3a4560);
    boundsHelper.visible = showBounds;
    scene.add(boundsHelper);
    return !!stats.rgb && ["red", "green", "blue"].some((k) => stats.rgb[k].max > 0);
  }

  // Append a binned chunk after the points already loaded: each cell takes its
  // run of the chunk's arrays with one copy. A chunk asked for as stream positions
  // [s, s+count) holds the mosaic's points at those positions, which is count
  // points give or take one per file (each file contributes floor(p * n_k / N)
  // points below position p), so chunks are placed by their actual counts, not by
  // s: the binned chunk's `start` must be the points loaded so far.
  function applyBinned(b) {
    const start = cloud.loaded;
    if (b.start !== start) throw new Error(`chunk binned for stream position ${b.start} applied at ${start}`);
    const grid = cloud.grid;
    for (const seg of b.segments) cloud.segments.push(seg);
    const { counts, offsets, arrays } = b;
    for (let c = 0; c < counts.length; c++) {
      const count = counts[c];
      if (!count) continue;
      const cell = grid.cells[c];
      // The first chunk is a uniform sample of the whole load, so a cell's share
      // of it says how many points it will get.
      if (start === 0) cell.expected = (count * cloud.budget) / b.n;
      if (cell.n + count > cell.cap) growCell(cell, cell.n + count);
      const a = cell.arrays, off = offsets[c];
      for (const k of Object.keys(a)) {
        if (!a[k] || !arrays[k]) continue;
        const items = k === "pos" || k === "rgb" ? 3 : 1;
        a[k].set(arrays[k].subarray(off * items, (off + count) * items), cell.n * items);
      }
      if (b.zmin[c] < cell.zmin) cell.zmin = b.zmin[c];
      if (b.zmax[c] > cell.zmax) cell.zmax = b.zmax[c];
      for (const [name, key, items] of ATTRS) {
        if (key === "rgb" && !grid.hasRgb) continue;
        const attr = cell.geometry.getAttribute(name);
        attr.addUpdateRange(cell.n * items, count * items);
        attr.needsUpdate = true;
      }
      cell.n += count;
    }
    cloud.loaded = start + b.n;
  }

  // Parse, bin and append a chunk here, on the main thread.
  function ingest(buf) {
    applyBinned(binChunk(parseChunk(buf, cloud.loaded), cloud.grid, cloud.loaded));
  }

  // The ingest worker parses and bins chunks off the main thread (ingest_worker.js)
  // and answers them in the order they were sent. When workers are not to be had,
  // or the worker fails, the binning runs here.
  let worker = null, workerFailed = false;
  const waiting = [];      // {resolve, reject} per chunk sent, in order
  function getWorker() {
    if (worker || workerFailed || typeof Worker === "undefined") return worker;
    try {
      worker = new Worker(new URL("./ingest_worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (e) => {
        const w = waiting.shift();
        if (!w) return;
        if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data);
      };
      worker.onerror = (e) => {
        workerFailed = true;
        const err = new Error(`ingest worker failed: ${e.message || "could not start"}`);
        for (const w of waiting.splice(0)) w.reject(err);
        worker.terminate();
        worker = null;
      };
    } catch (e) {
      workerFailed = true;
      worker = null;
    }
    return worker;
  }

  // Bin a chunk for stream position `start` (the points queued before it), in the
  // worker when there is one (the buffer is transferred); the result goes to
  // applyBinned, in order.
  function binAsync(buf, start) {
    const grid = cloud.grid;
    const w = getWorker();
    if (!w) return Promise.resolve(binChunk(parseChunk(buf, start), grid, start));
    return new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      w.postMessage({ buf, grid: gridParams(grid), start }, [buf]);
    });
  }

  // Drop the cells and the extent box, freeing their GPU buffers, and reset the
  // cloud's bookkeeping.
  function dispose() {
    if (cellGroup) {
      for (const cell of cloud.grid.cells) if (cell.geometry) cell.geometry.dispose();
      scene.remove(cellGroup); cellGroup = null;
    }
    if (boundsHelper) { scene.remove(boundsHelper); boundsHelper = null; }
    cloud.grid = null; cloud.loaded = 0; cloud.count = 0; cloud.stats = null; cloud.segments = [];
  }

  function updateLod(moved, now, frameMs) { stepLod(lod, moved, now, frameMs); }

  // Cull and set every cell's draw range for the current camera.
  function applyLod() {
    lod.drawn = 0; lod.cellsDrawn = 0;
    const grid = cloud.grid;
    if (!grid) return;
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    for (const cell of grid.cells) {
      if (!cell.n) continue;
      cell.box.min.z = cell.zmin; cell.box.max.z = cell.zmax;
      const visible = frustum.intersectsBox(cell.box);
      cell.points.visible = visible;
      if (!visible) { cell.drawn = 0; continue; }
      cell.drawn = drawCount(cell.n, cell.box.distanceToPoint(camera.position), lod.near);
      cell.geometry.setDrawRange(0, cell.drawn);
      lod.drawn += cell.drawn;
      lod.cellsDrawn++;
    }
  }

  return {
    lod, makeGrid, cellsAround, growCell, allocate, ingest, binAsync, applyBinned, dispose, updateLod, applyLod,
    get group() { return cellGroup; },
    get boundsHelper() { return boundsHelper; },
  };
}
