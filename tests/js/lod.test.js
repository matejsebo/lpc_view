// The level-of-detail maths (static/cells.js): a cell's draw range from its
// distance, the frame-time controller on `near`, and the point budget cap.
import test from "node:test";
import assert from "node:assert/strict";
import { NEAR_ALL, TARGET_MS, budgetCap, capBudget, drawCount, newLod, pointCost, stepLod } from "../../src/lpc_view/static/cells.js";

test("drawCount: all within near, (near / d)^2 of the points beyond", () => {
  assert.equal(drawCount(1000, 0, 200), 1000);
  assert.equal(drawCount(1000, 200, 200), 1000);
  assert.equal(drawCount(1000, 400, 200), 250);
  assert.equal(drawCount(1000, 2000, 200), 10);
  assert.equal(drawCount(7, 2000, 200), 0);              // floors, never rounds up
  assert.equal(drawCount(123456, 5000, NEAR_ALL), 123456);
});

test("stepLod: a slow frame while moving pulls near in, a fast one pushes it out", () => {
  const lod = newLod();
  stepLod(lod, true, 1000, TARGET_MS * 2);                // twice the target: factor 0.9 * 16 / 32 = 0.45 -> 0.7
  assert.ok(lod.moving);
  assert.ok(Math.abs(lod.near - 200 * Math.sqrt(0.7)) < 1e-9, `near ${lod.near}`);
  const after = lod.near;
  stepLod(lod, true, 1016, TARGET_MS * 0.4);              // under half the target: 15 % more points
  assert.ok(Math.abs(lod.near - after * Math.sqrt(1.15)) < 1e-9);
  const again = lod.near;
  stepLod(lod, true, 1032, TARGET_MS);                    // at the target: 4 % more
  assert.ok(Math.abs(lod.near - again * Math.sqrt(1.04)) < 1e-9);
  assert.equal(lod.movingNear, lod.near);
});

test("stepLod: near never drops below 5 m and never passes NEAR_ALL", () => {
  const lod = newLod();
  for (let i = 0; i < 100; i++) stepLod(lod, true, 1000 + 16 * i, 1000);
  assert.equal(lod.near, 5);
  for (let i = 0; i < 200; i++) stepLod(lod, true, 5000 + 16 * i, 1);
  assert.ok(lod.near <= NEAR_ALL);
});

test("stepLod: a still camera grows near a fifth a frame until everything draws", () => {
  const lod = newLod();
  stepLod(lod, true, 0, 10);
  const moving = lod.near;
  stepLod(lod, false, 200, 10);                           // still for 200 ms: no longer moving
  assert.ok(!lod.moving);
  assert.ok(Math.abs(lod.near - moving * 1.2) < 1e-9);
  let t = 216;
  while (lod.near < NEAR_ALL) { stepLod(lod, false, t, 10); t += 16; }
  assert.equal(lod.near, NEAR_ALL);
  stepLod(lod, false, t, 10);
  assert.equal(lod.near, NEAR_ALL);
  // The next move starts from where the last one settled, not from "all".
  assert.equal(lod.movingNear, moving);
  stepLod(lod, true, t + 16, 10);
  assert.ok(lod.near <= moving * Math.sqrt(1.15) + 1e-9, `near ${lod.near} after moving ${moving}`);
});

test("stepLod: a short pause under 150 ms still counts as moving", () => {
  const lod = newLod();
  stepLod(lod, true, 0, 10);
  stepLod(lod, false, 100, 10);
  assert.ok(lod.moving);
});

test("budgetCap and capBudget: a quarter of the memory, at the point's cost", () => {
  assert.equal(pointCost(false), 60);
  assert.equal(pointCost(true), 66);
  assert.equal(budgetCap(8, false), Math.floor((8 * 2 ** 30) / 4 / 60));
  assert.equal(budgetCap(undefined, false), budgetCap(8, false));       // no deviceMemory: 8 GB assumed
  assert.equal(budgetCap(0, true), budgetCap(8, true));
  assert.deepEqual(capBudget(5e6, 42e6, 8, false), { budget: 5e6, cap: budgetCap(8, false), capped: false });
  assert.deepEqual(capBudget(50e6, 42e6, 8, false), { budget: 35791394, cap: 35791394, capped: true });
  const small = capBudget(42e6, 42e6, 0.5, false);                      // "all" on a small machine
  assert.equal(small.budget, 2236962);
  assert.ok(small.capped);
  assert.deepEqual(capBudget(42e6, 1000, 0.5, false), { budget: 1000, cap: 2236962, capped: false });
});
