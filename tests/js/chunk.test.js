// Chunk parsing and segment lookup (static/cells.js), on hand-built LPC2 buffers.
import test from "node:test";
import assert from "node:assert/strict";
import { binChunk, binnedBuffers, chunkCount, parseChunk, segmentOf } from "../../src/lpc_view/static/cells.js";

// An LPC2 chunk of `points` ({x, y, z, i, c, r, nr, p, a, t, f, rgb?}) in the
// layout reader.CloudSet documents: magic, count u32, has_rgb u8, has_time u8,
// nseg u16, nseg x (file u32, local u32, count u32), then the arrays.
function buildChunk(points, segments, hasRgb) {
  const n = points.length;
  const size = 12 + 12 * segments.length + n * (12 + 2 + 1 + 1 + 1 + 2 + 4 + 4 + 1 + (hasRgb ? 3 : 0));
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  [..."LPC2"].forEach((ch, i) => dv.setUint8(i, ch.charCodeAt(0)));
  dv.setUint32(4, n, true);
  dv.setUint8(8, hasRgb ? 1 : 0);
  dv.setUint8(9, 1);
  dv.setUint16(10, segments.length, true);
  let off = 12;
  for (const [file, local, count] of segments) {
    dv.setUint32(off, file, true); dv.setUint32(off + 4, local, true); dv.setUint32(off + 8, count, true);
    off += 12;
  }
  const put = (setter, bytes, values) => { for (const v of values) { setter(off, v); off += bytes; } };
  put((o, v) => dv.setFloat32(o, v, true), 4, points.flatMap((p) => [p.x, p.y, p.z]));
  put((o, v) => dv.setUint16(o, v, true), 2, points.map((p) => p.i));
  put((o, v) => dv.setUint8(o, v), 1, points.map((p) => p.c));
  put((o, v) => dv.setUint8(o, v), 1, points.map((p) => p.r));
  put((o, v) => dv.setUint8(o, v), 1, points.map((p) => p.nr));
  put((o, v) => dv.setUint16(o, v, true), 2, points.map((p) => p.p));
  put((o, v) => dv.setFloat32(o, v, true), 4, points.map((p) => p.a));
  put((o, v) => dv.setFloat32(o, v, true), 4, points.map((p) => p.t));
  put((o, v) => dv.setUint8(o, v), 1, points.map((p) => p.f));
  if (hasRgb) put((o, v) => dv.setUint8(o, v), 1, points.flatMap((p) => p.rgb));
  assert.equal(off, size);
  return buf;
}

const pt = (k, rgb) => ({ x: 10 * k, y: -3 * k, z: 0.5 * k, i: 1000 + k, c: k % 3, r: 1 + (k % 2), nr: 2, p: 300 + k, a: -7.5 + k, t: 100.25 + k, f: k & 7, rgb: rgb ? [k, 2 * k, 3 * k] : undefined });

test("parseChunk: two segments, odd count, every array aligned or copied right", () => {
  // Three points: after the 2-byte intensity array and three 1-byte arrays, the
  // point source ids start on an odd offset, so the u16 and f32 arrays from there
  // on come back as aligned copies, and the earlier ones as views.
  const points = [pt(1, true), pt(2, true), pt(3, true)];
  const buf = buildChunk(points, [[4, 1000, 2], [9, 50, 1]], true);
  const c = parseChunk(buf, 7000);
  assert.equal(c.n, 3);
  assert.equal(c.hasRgb, true);
  assert.deepEqual(c.segments, [{ file: 4, local: 1000, count: 2, start: 7000 }, { file: 9, local: 50, count: 1, start: 7002 }]);
  assert.deepEqual(Array.from(c.pos), points.flatMap((p) => [p.x, p.y, p.z]));
  assert.deepEqual(Array.from(c.intensity), [1001, 1002, 1003]);
  assert.deepEqual(Array.from(c.cls), [1, 2, 0]);
  assert.deepEqual(Array.from(c.ret), [2, 1, 2]);
  assert.deepEqual(Array.from(c.nret), [2, 2, 2]);
  assert.deepEqual(Array.from(c.psid), [301, 302, 303]);
  assert.deepEqual(Array.from(c.angle), [-6.5, -5.5, -4.5]);
  assert.deepEqual(Array.from(c.time), [101.25, 102.25, 103.25]);
  assert.deepEqual(Array.from(c.flags), [1, 2, 3]);
  assert.deepEqual(Array.from(c.rgb), [1, 2, 3, 2, 4, 6, 3, 6, 9]);
  // The views share the chunk's buffer; the copies had to be made.
  assert.equal(c.pos.buffer, buf);
  assert.equal(c.intensity.buffer, buf);
  assert.notEqual(c.psid.buffer, buf);
  assert.notEqual(c.angle.buffer, buf);
  assert.notEqual(c.time.buffer, buf);
});

test("parseChunk: an even count keeps every array a view, without rgb", () => {
  const points = [pt(1), pt(2), pt(3), pt(4)];
  const c = parseChunk(buildChunk(points, [[0, 0, 4]], false), 0);
  assert.equal(c.rgb, null);
  for (const k of ["pos", "intensity", "cls", "psid", "angle", "time", "flags"]) assert.equal(c[k].buffer.byteLength, c.pos.buffer.byteLength, k);
  assert.deepEqual(Array.from(c.psid), [301, 302, 303, 304]);
  assert.deepEqual(Array.from(c.time), [101.25, 102.25, 103.25, 104.25]);
});

test("parseChunk: empty segments are dropped, bad chunks throw", () => {
  const c = parseChunk(buildChunk([pt(1), pt(2)], [[3, 0, 0], [5, 8, 2]], false), 10);
  assert.deepEqual(c.segments, [{ file: 5, local: 8, count: 2, start: 10 }]);
  assert.throws(() => parseChunk(buildChunk([pt(1)], [[0, 0, 2]], false), 0), /do not add up/);
  const bad = buildChunk([pt(1)], [[0, 0, 1]], false);
  new DataView(bad).setUint8(3, "X".charCodeAt(0));
  assert.throws(() => parseChunk(bad, 0), /bad chunk/);
});

test("segmentOf finds the segment holding a stream index", () => {
  const segs = [
    { start: 0, file: 0, local: 0, count: 10 },
    { start: 10, file: 1, local: 0, count: 5 },
    { start: 15, file: 0, local: 10, count: 7 },
    { start: 22, file: 1, local: 5, count: 3 },
  ];
  assert.equal(segmentOf(segs, 0), segs[0]);
  assert.equal(segmentOf(segs, 9), segs[0]);
  assert.equal(segmentOf(segs, 10), segs[1]);
  assert.equal(segmentOf(segs, 14), segs[1]);
  assert.equal(segmentOf(segs, 21), segs[2]);
  assert.equal(segmentOf(segs, 24), segs[3]);
  assert.equal(segmentOf(segs, 25), null);
  assert.equal(segmentOf([], 0), null);
  // The point's index in its file, as pickAt computes it.
  const s = segmentOf(segs, 17);
  assert.equal(s.local + (17 - s.start), 12);
});

test("binChunk sorts a chunk's points by cell with offsets, stream indices and z ranges", () => {
  // A 2 x 2 grid of 10 m cells from (0, 0); five points, two of them strays.
  const grid = { nx: 2, ny: 2, x0: 0, y0: 0, dx: 10, dy: 10 };
  const points = [
    { ...pt(1, true), x: 15, y: 5, z: 3 },      // cell 1
    { ...pt(2, true), x: 5, y: 15, z: 7 },      // cell 2
    { ...pt(3, true), x: 12, y: 2, z: -1 },     // cell 1
    { ...pt(4, true), x: 99, y: -99, z: 0 },    // stray: clamped to cell 1
    { ...pt(5, true), x: 1, y: 1, z: 5 },       // cell 0
  ];
  const c = parseChunk(buildChunk(points, [[0, 0, 5]], true), 1000);
  const b = binChunk(c, grid, 1000);
  assert.equal(b.n, 5);
  assert.equal(b.start, 1000);
  assert.deepEqual(Array.from(b.counts), [1, 3, 1, 0]);
  assert.deepEqual(Array.from(b.offsets), [0, 1, 4, 5]);
  // Cell order, arrival order within a cell: points 5; 1, 3, 4; 2.
  assert.deepEqual(Array.from(b.arrays.stream), [1004, 1000, 1002, 1003, 1001]);
  assert.deepEqual(Array.from(b.arrays.intensity), [1005, 1001, 1003, 1004, 1002]);
  assert.deepEqual(Array.from(b.arrays.pos).filter((_, i) => i % 3 === 2), [5, 3, -1, 0, 7]);
  assert.deepEqual(Array.from(b.arrays.rgb.subarray(0, 6)), [5, 10, 15, 1, 2, 3]);
  assert.deepEqual(Array.from(b.zmin), [5, -1, 7, Infinity]);
  assert.deepEqual(Array.from(b.zmax), [5, 3, 7, -Infinity]);
  assert.deepEqual(b.segments, [{ file: 0, local: 0, count: 5, start: 1000 }]);
  // Every buffer the worker transfers is distinct and belongs to the binned chunk.
  const bufs = binnedBuffers(b);
  assert.equal(new Set(bufs).size, bufs.length);
  assert.ok(bufs.includes(b.arrays.stream.buffer) && bufs.includes(b.counts.buffer));
  assert.equal(chunkCount(buildChunk(points, [[0, 0, 5]], true)), 5);
});
