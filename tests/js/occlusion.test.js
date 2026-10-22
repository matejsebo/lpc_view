import { test } from "node:test";
import assert from "node:assert/strict";
import { linearDepth, occluded, DEFAULTS } from "../../src/lpc_view/static/occlusion.js";

test("linearDepth inverts a perspective depth buffer", () => {
  const near = 0.2, far = 100000;
  // The buffer value of a point at distance z, as the GPU writes it (NDC z mapped to 0..1).
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
  assert.equal(occluded(100.5, s), false);            // on the surface
  assert.equal(occluded(101.9, s), false);            // within 1 m + 1 %
  assert.equal(occluded(102.1, s), true);             // just beyond it
  assert.equal(occluded(50, s), false);               // in front, never hidden
  assert.equal(occluded(1010, 1000), false);          // far away the share of distance grows (1 + 10 m)
  assert.equal(occluded(1012, 1000), true);
  assert.equal(occluded(1010, 1000, 1.0, 0.0), true); // without the share, hidden
  assert.equal(DEFAULTS.tolerance, 1.0);
  assert.equal(DEFAULTS.fraction, 0.01);
  assert.equal(DEFAULTS.drawShare, 0.5);
});
