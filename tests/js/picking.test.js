// Pick code encode and decode (static/picking.js): the shader writes
// (cellId << localBits) | index as RGBA bytes; the page reads them back.
import test from "node:test";
import assert from "node:assert/strict";
import { NO_PICK, codeOf, decodePick, encodePick, pickBytes } from "../../src/lpc_view/static/picking.js";

// The shader's expression, in 32-bit unsigned arithmetic.
const shaderCode = (cellId, local, localBits) => Number((BigInt(cellId) << BigInt(localBits)) | BigInt(local)) >>> 0;

// gridSizing gives the cells ceil(log2(count + 1)) bits, so the all-ones cell id
// never occurs: the all-ones code stays the clear colour (NO_PICK).
const maxCellId = (localBits) => 2 ** (32 - localBits) - 2;

test("encodePick matches the shader for every split of the 32 bits", () => {
  for (const localBits of [8, 16, 20, 24, 27, 31]) {
    const localSpan = 2 ** localBits, cellMax = maxCellId(localBits);
    for (const [cellId, local] of [[0, 0], [1, 1], [cellMax, localSpan - 1], [Math.floor(cellMax / 2), Math.floor(localSpan / 2)], [Math.min(3, cellMax), localSpan - 2]]) {
      assert.equal(encodePick(cellId, local, localBits), shaderCode(cellId, local, localBits), `${cellId}:${local}@${localBits}`);
    }
  }
});

test("pick codes survive the trip through RGBA bytes and back", () => {
  for (const localBits of [8, 16, 24, 27, 31]) {
    const localSpan = 2 ** localBits, cellMax = maxCellId(localBits);
    for (const [cellId, local] of [[0, 0], [1, 123], [cellMax, localSpan - 1], [cellMax, 0], [0, localSpan - 1], [Math.min(cellMax, 913), Math.min(localSpan - 1, 1234567)]]) {
      const code = encodePick(cellId, local, localBits);
      const bytes = pickBytes(code);
      assert.equal(bytes.length, 4);
      assert.equal(codeOf(bytes), code);
      assert.deepEqual(decodePick(codeOf(bytes), localSpan), { cellId, local }, `${cellId}:${local}@${localBits}`);
    }
  }
});

test("the clear colour decodes to no pick", () => {
  assert.equal(NO_PICK, 0xffffffff);
  assert.deepEqual(Array.from(pickBytes(NO_PICK)), [255, 255, 255, 255]);
  assert.equal(codeOf(Uint8Array.of(255, 255, 255, 255)), NO_PICK);
  assert.equal(decodePick(NO_PICK, 2 ** 24), null);
  // Every other code is a pick, even one whose bytes are mostly 255; the largest
  // cell id a grid can have, with the largest index, is one short of the clear colour.
  assert.deepEqual(decodePick(0xfffffffe, 2 ** 24), { cellId: 255, local: 2 ** 24 - 2 });
  assert.equal(encodePick(maxCellId(24), 2 ** 24 - 1, 24), NO_PICK - 2 ** 24);
});

test("codeOf reads little-endian bytes as the browser does", () => {
  assert.equal(codeOf(Uint8Array.of(243, 34, 0, 54)), 243 + 34 * 256 + 54 * 16777216);
  assert.deepEqual(decodePick(codeOf(Uint8Array.of(243, 34, 0, 54)), 2 ** 24), { cellId: 54, local: 243 + 34 * 256 });
});
