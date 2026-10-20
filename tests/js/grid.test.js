// Grid sizing and cell index maths (static/cells.js).
import test from "node:test";
import assert from "node:assert/strict";
import { CELL_M, MAX_CELLS, cellIndex, cellsNear, extentOf, gridSizing } from "../../src/lpc_view/static/cells.js";

test("gridSizing cuts the extent into ~100 m cells and splits the pick code", () => {
  const g = gridSizing(1000, 2000);
  assert.equal(g.nx, 10);
  assert.equal(g.ny, 20);
  assert.equal(g.dx, 100);
  assert.equal(g.dy, 100);
  assert.equal(g.cellBits, 8);            // 201 ids need 8 bits
  assert.equal(g.localBits, 24);
  assert.equal(g.localSpan, 2 ** 24);
});

test("gridSizing rounds to whole cells and never goes below one", () => {
  const g = gridSizing(2840, 3360);        // the UCSD mosaic, roughly
  assert.equal(g.nx, 28);
  assert.equal(g.ny, 34);
  assert.ok(Math.abs(g.dx - 2840 / 28) < 1e-9);
  const one = gridSizing(0, 0.3);
  assert.deepEqual([one.nx, one.ny], [1, 1]);
  assert.equal(one.cellBits, 1);
  assert.equal(one.localBits, 31);
});

test("gridSizing caps the cell count on a huge extent", () => {
  const g = gridSizing(100000, 100000);
  assert.ok(g.nx * g.ny <= MAX_CELLS * 1.01, `${g.nx * g.ny} cells`);
  assert.ok(g.dx > CELL_M);
  assert.equal(g.cellBits, Math.ceil(Math.log2(g.nx * g.ny + 1)));
  assert.equal(g.localBits + g.cellBits, 32);
});

test("cellIndex maps points to cells and clamps strays to the edge", () => {
  const grid = { ...gridSizing(1000, 500), x0: -500, y0: -250 };
  assert.equal(cellIndex(grid, -500, -250), 0);
  assert.equal(cellIndex(grid, -401, -250), 0);
  assert.equal(cellIndex(grid, -400, -250), 1);
  assert.equal(cellIndex(grid, 0, 0), 5 + 2 * grid.nx);
  assert.equal(cellIndex(grid, 499.9, 249.9), grid.nx * grid.ny - 1);
  assert.equal(cellIndex(grid, 500, 250), grid.nx * grid.ny - 1);      // on the far edge
  assert.equal(cellIndex(grid, 9999, -9999), grid.nx - 1);             // far outside
  assert.equal(cellIndex(grid, -9999, 9999), (grid.ny - 1) * grid.nx);
});

test("cellsNear gives the index ranges within r of a point, clamped", () => {
  const grid = { ...gridSizing(1000, 500), x0: -500, y0: -250 };
  assert.deepEqual(cellsNear(grid, 0, 0, 3), { ax: 4, bx: 5, ay: 2, by: 2 });
  assert.deepEqual(cellsNear(grid, -500, -250, 3), { ax: 0, bx: 0, ay: 0, by: 0 });
  assert.deepEqual(cellsNear(grid, 480, 240, 50), { ax: 9, bx: 9, ay: 4, by: 4 });
});

test("extentOf centres the bounds and frames z by the 1-99 percentiles", () => {
  const stats = { bounds: { min: [100, 200, -900], max: [300, 600, 2000] }, z: { percentiles: { 1: 5, 99: 45 } } };
  assert.deepEqual(extentOf(stats, [200, 400, 20]), { min: [-100, -200, -15], max: [100, 200, 25] });
  assert.deepEqual(extentOf(null, [0, 0, 0]), { min: [-500, -500, -50], max: [500, 500, 50] });
});
