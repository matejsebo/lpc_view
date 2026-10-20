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

  // Append a chunk after the points already loaded, each point into its cell. A chunk
  // asked for as stream positions [s, s+count) holds the mosaic's points at those
  // positions, which is count points give or take one per file (each file contributes
  // floor(p * n_k / N) points below position p), so chunks are placed by their actual
  // counts, not by s.
  function ingest(buf) {
    const start = cloud.loaded;
    const { n, segments, pos, intensity, cls, ret, nret, psid, angle, time, flags, rgb } = parseChunk(buf, start);
    for (const seg of segments) cloud.segments.push(seg);
    const grid = cloud.grid;
    // Which cell each point goes to, and how many each cell gets, so a cell grows once.
    const target = new Uint32Array(n), counts = new Uint32Array(grid.cells.length);
    for (let i = 0; i < n; i++) { const c = cellIndex(grid, pos[3 * i], pos[3 * i + 1]); target[i] = c; counts[c]++; }
    const cursor = new Uint32Array(grid.cells.length);
    for (let c = 0; c < counts.length; c++) {
      if (!counts[c]) continue;
      const cell = grid.cells[c];
      if (start === 0) cell.expected = (counts[c] * cloud.budget) / n;
      if (cell.n + counts[c] > cell.cap) growCell(cell, cell.n + counts[c]);
      cursor[c] = cell.n;
    }
    for (let i = 0; i < n; i++) {
      const cell = grid.cells[target[i]], a = cell.arrays, k = cursor[target[i]]++;
      const z = pos[3 * i + 2];
      a.pos[3 * k] = pos[3 * i]; a.pos[3 * k + 1] = pos[3 * i + 1]; a.pos[3 * k + 2] = z;
      a.intensity[k] = intensity[i]; a.cls[k] = cls[i]; a.ret[k] = ret[i]; a.nret[k] = nret[i]; a.psid[k] = psid[i];
      a.angle[k] = angle[i]; a.time[k] = time[i]; a.flags[k] = flags[i]; a.stream[k] = start + i;
      if (a.rgb && rgb) { a.rgb[3 * k] = rgb[3 * i]; a.rgb[3 * k + 1] = rgb[3 * i + 1]; a.rgb[3 * k + 2] = rgb[3 * i + 2]; }
      if (z < cell.zmin) cell.zmin = z;
      if (z > cell.zmax) cell.zmax = z;
    }
    for (let c = 0; c < counts.length; c++) {
      if (!counts[c]) continue;
      const cell = grid.cells[c];
      for (const [name, key, items] of ATTRS) {
        if (key === "rgb" && !grid.hasRgb) continue;
        const attr = cell.geometry.getAttribute(name);
        attr.addUpdateRange(cell.n * items, counts[c] * items);
        attr.needsUpdate = true;
      }
      cell.n += counts[c];
    }
    cloud.loaded = start + n;
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
    lod, makeGrid, cellsAround, growCell, allocate, ingest, dispose, updateLod, applyLod,
    get group() { return cellGroup; },
    get boundsHelper() { return boundsHelper; },
  };
}
