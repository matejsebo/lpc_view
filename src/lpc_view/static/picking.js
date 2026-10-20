// lpc_view: GPU picking. A click renders the scene with the pick material into a
// 1x1 target whose colour is (cell id, index in cell); the index maps back through
// the cell's stream table to the file and the exact point is fetched.
//
// three.js comes in as an argument of createPicker and makeMarker, not as an
// import, so the pure pick-code maths above them loads in Node.

import { apiFetch } from "./api.js";
import { segmentOf } from "./cells.js";

export const NO_PICK = 0xffffffff;   // the clear colour: nothing under the cursor

// The 32-bit code the pick shader writes: the cell id in the high bits, the index
// in the cell in the low `localBits`.
export function encodePick(cellId, local, localBits) {
  return cellId * 2 ** localBits + local;
}

// The code as the RGBA bytes read back from the target (little endian).
export function pickBytes(code) {
  return Uint8Array.of(code & 255, (code >>> 8) & 255, (code >>> 16) & 255, code >>> 24);
}

export function codeOf(bytes) {
  return bytes[0] + bytes[1] * 256 + bytes[2] * 65536 + bytes[3] * 16777216;
}

// (cell id, index) from a code, or null for the clear colour.
export function decodePick(code, localSpan) {
  if (code === NO_PICK) return null;
  const cellId = Math.floor(code / localSpan);
  return { cellId, local: code - cellId * localSpan };
}

// The ring that marks the picked point.
export function makeMarker(THREE) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.strokeStyle = "#ffffff"; g.lineWidth = 6; g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = "#ffb454"; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.045, 0.045, 1);
  s.visible = false;
  s.renderOrder = 10;
  return s;
}

export function createPicker({ THREE, renderer, scene, camera, canvas, cloud, shading, marker, cells, panels, ui }) {
  const pickTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const pickBuffer = new Uint8Array(4);

  async function pickAt(cx, cy) {
    const grid = cloud.grid;
    if (!grid || cloud.loaded === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = (cx - rect.left) * renderer.getPixelRatio();
    const y = (cy - rect.top) * renderer.getPixelRatio();
    const size = renderer.getSize(new THREE.Vector2()).multiplyScalar(renderer.getPixelRatio());
    camera.setViewOffset(size.x, size.y, Math.floor(x), Math.floor(y), 1, 1);
    const markerVisible = marker.visible;
    marker.visible = false;
    const boundsHelper = cells.boundsHelper;
    if (boundsHelper) boundsHelper.visible = false;
    // The pick render draws the cells with the draw ranges of the last frame; each
    // cell's onBeforeRender sets uCellId, so the colour read back is (cell, index).
    scene.overrideMaterial = shading.pickMaterial;
    renderer.setRenderTarget(pickTarget);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.render(scene, camera);
    // The async read issues its readPixels into a buffer object at once and then
    // waits for the GPU without stalling the page; the scene's state is put back
    // before the wait, so the frames drawn meanwhile are ordinary ones. Without
    // it (WebGL 1, old three), the synchronous read.
    const read = renderer.readRenderTargetPixelsAsync
      ? renderer.readRenderTargetPixelsAsync(pickTarget, 0, 0, 1, 1, pickBuffer)
      : (renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickBuffer), null);
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x0b0e14, 1);
    scene.overrideMaterial = null;
    camera.clearViewOffset();
    marker.visible = markerVisible;
    if (boundsHelper) boundsHelper.visible = ui.bounds.checked;
    if (read) await read;
    if (cloud.grid !== grid) return;   // a new load began while the read was in flight
    const hit = decodePick(codeOf(pickBuffer), grid.localSpan);
    if (!hit) { panels.showPoint(null); return; }
    const cell = grid.cells[hit.cellId], local = hit.local;
    if (!cell || !cell.n || local >= cell.n) { panels.showPoint(null); return; }
    const { pos } = cell.arrays;
    marker.position.set(pos[3 * local], pos[3 * local + 1], pos[3 * local + 2]);
    marker.visible = true;
    const id = cell.arrays.stream[local];
    panels.showPoint({ loadingIndex: id });
    const seg = segmentOf(cloud.segments, id);
    if (!seg) { panels.showPoint(null); return; }
    try {
      const r = await apiFetch(`/api/point?file=${seg.file}&i=${seg.local + (id - seg.start)}`);
      const rec = await r.json();
      if (rec.error) throw new Error(rec.error);
      rec.file_id = seg.file;
      rec.file_name = panels.fileName(seg.file);
      panels.showPoint(rec);
      panels.selectMetaFile(seg.file);
    } catch (err) {
      panels.showPointError(err.message);
    }
  }

  return { pickAt, pickBuffer, pickTarget };
}
