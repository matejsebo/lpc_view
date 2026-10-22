import { test } from "node:test";
import assert from "node:assert/strict";
import { linearDepth, occluded, buildHeightfield, erodeMin, heightfieldMesh, DEFAULTS } from "../../src/lpc_view/static/occlusion.js";

test("linearDepth inverts a perspective depth buffer", () => {
  const near = 0.2, far = 100000;
  const toBuffer = (z) => {
    const ndc = (far + near) / (far - near) - (2 * far * near) / ((far - near) * z);
    return (ndc + 1) / 2;
  };
  for (const z of [0.5, 10, 250, 1000, 5000]) {
    assert.ok(Math.abs(linearDepth(toBuffer(z), near, far) - z) < 1e-6 * z, `z=${z}`);
  }
  assert.ok(Math.abs(linearDepth(0, near, far) - near) < 1e-9);
  assert.ok(Math.abs(linearDepth(1, near, far) - far) < 1e-3);
});

test("occluded applies the fixed and proportional tolerance", () => {
  const s = 100;
  assert.equal(occluded(100.5, s), false);
  assert.equal(occluded(101.9, s), false);
  assert.equal(occluded(102.1, s), true);
  assert.equal(occluded(50, s), false);
  assert.equal(occluded(1010, 1000), false);
  assert.equal(occluded(1012, 1000), true);
  assert.equal(DEFAULTS.cellM, 2);
});

// A cell with points: [x, y, z, class = 1, flags = 0] each.
function cell(points) {
  const pos = new Float32Array(points.length * 3), cls = new Uint8Array(points.length), flags = new Uint8Array(points.length);
  points.forEach(([x, y, z, k = 1, f = 0], i) => { pos.set([x, y, z], 3 * i); cls[i] = k; flags[i] = f; });
  return { arrays: { pos, cls, flags }, n: points.length };
}

test("buildHeightfield takes the lowest point, ground first, never noise or withheld", () => {
  const bounds = { min: [0, 0], max: [4, 2] };          // 2 x 1 cells of 2 m
  const c = cell([
    [0.5, 0.5, 10], [1.5, 1.5, 9], [1, 1, 12, 2],       // cell 0: lowest 9, but the ground point at 12 wins
    [2.5, 0.5, 30], [3.5, 1.5, 20, 7], [3, 1, 5, 1, 4], // cell 1: noise 20 and withheld 5 ignored -> 30
  ]);
  const hf = buildHeightfield([c], bounds, 2);
  assert.deepEqual([hf.w, hf.h, hf.filled], [2, 1, 2]);
  assert.deepEqual(Array.from(hf.z), [12, 30]);
  const empty = buildHeightfield([cell([[1, 1, 3]])], { min: [0, 0], max: [4, 4] }, 2);
  assert.equal(empty.filled, 1);
  assert.ok(Number.isNaN(empty.z[3]));
});

test("erodeMin sinks narrow bumps and keeps wide slopes, ignoring holes", () => {
  // A 7 x 1 strip: a flat floor at 0 with a one-cell bump of 10 at index 3 and a hole at 6.
  const hf = { w: 7, h: 1, x0: 0, y0: 0, cellM: 1, z: new Float32Array([0, 0, 0, 10, 0, 0, NaN]), filled: 6 };
  const e = erodeMin(hf, 1);
  assert.deepEqual(Array.from(e.z.slice(0, 6)), [0, 0, 0, 0, 0, 0]);
  assert.equal(e.z[6], 0);                              // the hole takes its neighbour's height
  // A wide ramp keeps its shape, one cell lower towards the top.
  const ramp = { w: 6, h: 1, x0: 0, y0: 0, cellM: 1, z: new Float32Array([0, 1, 2, 3, 4, 5]), filled: 6 };
  assert.deepEqual(Array.from(erodeMin(ramp, 1).z), [0, 0, 1, 2, 3, 4]);
  assert.equal(erodeMin(ramp, 0), ramp);
});

test("heightfieldMesh triangulates only squares with four heights", () => {
  const hf = { w: 3, h: 2, x0: 0, y0: 0, cellM: 2, z: new Float32Array([1, 2, NaN, 3, 4, 5]), filled: 5 };
  const m = heightfieldMesh(hf);
  assert.equal(m.positions.length, 18);
  assert.deepEqual(Array.from(m.positions.slice(0, 3)), [1, 1, 1]);   // the centre of cell (0,0)
  assert.equal(m.triangles, 2);                                      // one square of the two has a NaN corner
  assert.deepEqual(Array.from(m.index), [0, 3, 1, 1, 3, 4]);
});
