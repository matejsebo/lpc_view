// lpc_view: the browser side. Streams a point cloud from the local server into a
// grid of cells, draws them with a colour-mode shader at a level of detail set by
// distance and frame time, flies a camera through them, picks points on the GPU
// and shows the file's metadata.
//
// This file wires the modules: api.js (token and fetch), shaders.js (GLSL and the
// materials), cells.js (grid, ingest, level of detail), camera.js (fly controls
// and views), picking.js (GPU picks) and panels.js (the DOM). It is the only one
// that imports three.js; the others take it as an argument so that their pure
// parts load in Node for the tests.

import * as THREE from "three";
import { bootstrapToken, apiFetch, fetchJson } from "./api.js";
import { createShading } from "./shaders.js";
import { createCells, capBudget, chunkCount, NEAR_ALL } from "./cells.js";
import { createFlyCamera } from "./camera.js";
import { createPicker, makeMarker } from "./picking.js";
import { createOcclusion } from "./occlusion.js";
import { $, ui, fmt, fmtInt, setStatus, setProgress, createPanels } from "./panels.js";

const { debug } = bootstrapToken();

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0b0e14, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.2, 100000);
camera.up.set(0, 0, 1);

const shading = createShading(THREE);
const { uniforms } = shading;

const cloud = {          // the loaded cloud's bookkeeping
  fileIds: [], stats: null, center: [0, 0, 0], count: 0, budget: 0, loaded: 0,
  hasRgb: false, hasTime: false,
  grid: null,            // the cells (see cells.js makeGrid)
  segments: [],          // {start, file, local, count}: which file each stream index came from
};

const marker = makeMarker(THREE);
scene.add(marker);

const cells = createCells({ THREE, scene, camera, shading, cloud });
const { lod } = cells;
const actions = {};      // the camera's keys reach into picking and the panels; filled below
const fly = createFlyCamera({ THREE, canvas, camera, ui, cloud, cells, actions });
const { cam } = fly;
const panels = createPanels({ cloud, cam, marker, shading });
const picker = createPicker({ THREE, renderer, scene, camera, canvas, cloud, shading, marker, cells, panels, ui });
const occlusion = createOcclusion({ THREE, renderer, scene, camera, shading, cloud, marker });
Object.assign(actions, { pickAt: picker.pickAt, togglePanels: panels.togglePanels, openFiles: panels.openFiles, setStatus });

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  uniforms.uMaxSize.value = 8 * renderer.getPixelRatio();
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastT = performance.now(), frames = 0, fpsT = lastT;
function frame(now) {
  const frameMs = now - lastT;
  const dt = Math.min(0.1, frameMs / 1000);
  lastT = now;
  fly.stepCamera(dt);
  fly.applyCamera();
  cells.updateLod(fly.cameraMoved(), now, frameMs);
  cells.applyLod();
  occlusion.render();
  renderer.render(scene, camera);
  frames++;
  if (now - fpsT > 500) {
    ui.hudFps.textContent = `${Math.round((frames * 1000) / (now - fpsT))} fps`;
    frames = 0; fpsT = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}
function updateHud() {
  const c = cloud.center;
  ui.hudPos.textContent = `E ${fmt(cam.pos.x + c[0], 1)}  N ${fmt(cam.pos.y + c[1], 1)}  Z ${fmt(cam.pos.z + c[2], 1)}`;
  const hd = ((cam.yaw * 180) / Math.PI) % 360;
  ui.hudLook.textContent = `hdg ${fmt((hd + 360) % 360, 0)}  pitch ${fmt((cam.pitch * 180) / Math.PI, 0)}  ${cam.speed.toFixed(cam.speed >= 10 ? 0 : 1)} m/s`;
  ui.hudPts.textContent = cloud.count ? `${fmtInt(cloud.loaded)} / ${fmtInt(cloud.count)} pts` : "-";
  const f = cloud.loaded ? lod.drawn / cloud.loaded : 0;
  const full = lod.near >= NEAR_ALL ? "full everywhere" : `full to ${lod.near < 100 ? lod.near.toFixed(0) : (Math.round(lod.near / 10) * 10).toFixed(0)} m`;
  ui.hudDraw.textContent = !cloud.loaded ? "-" : `${fmtInt(lod.drawn)} drawn (${(100 * f).toFixed(f < 0.1 ? 1 : 0)}%) in ${lod.cellsDrawn} cells, ${full}`;
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Display controls
// ---------------------------------------------------------------------------

ui.mode.addEventListener("change", () => (uniforms.uMode.value = Number(ui.mode.value)));
ui.size.addEventListener("input", () => { uniforms.uSize.value = Number(ui.size.value); ui.sizeOut.textContent = ui.size.value; });
ui.adaptive.addEventListener("change", () => (uniforms.uAdaptive.value = ui.adaptive.checked ? 1 : 0));
ui.occlude.addEventListener("change", () => occlusion.setEnabled(ui.occlude.checked));
ui.bounds.addEventListener("change", () => { if (cells.boundsHelper) cells.boundsHelper.visible = ui.bounds.checked; });
ui.hideWithheld.addEventListener("change", () => (uniforms.uHideWithheld.value = ui.hideWithheld.checked ? 1 : 0));
ui.hideOverlap.addEventListener("change", () => (uniforms.uHideOverlap.value = ui.hideOverlap.checked ? 1 : 0));
ui.hideSynthetic.addEventListener("change", () => (uniforms.uHideSynthetic.value = ui.hideSynthetic.checked ? 1 : 0));
ui.zrange.addEventListener("change", applyRanges);
$("fit-btn").addEventListener("click", fly.fitView);
$("top-btn").addEventListener("click", fly.topView);
$("eye-btn").addEventListener("click", fly.eyeLevel);

function applyRanges() {
  const s = cloud.stats;
  if (!s) return;
  const c = cloud.center;
  if (ui.zrange.value === "p") {
    uniforms.uZMin.value = s.z.percentiles["1"] - c[2];
    uniforms.uZMax.value = s.z.percentiles["99"] - c[2];
  } else {
    uniforms.uZMin.value = s.z.min - c[2];
    uniforms.uZMax.value = s.z.max - c[2];
  }
  uniforms.uIMin.value = s.intensity.percentiles["1"];
  uniforms.uIMax.value = s.intensity.percentiles["99"];
  uniforms.uTMax.value = s.gps_time ? s.gps_time.span_seconds : 1;
  uniforms.uAMax.value = Math.max(Math.abs(s.scan_angle_deg.min), Math.abs(s.scan_angle_deg.max), 1);
}

// RGB fields that are present but all zero were never filled: grey the mode out.
function setRgbOption(stats, hasColour) {
  const rgbOption = ui.mode.querySelector('option[value="8"]');
  rgbOption.disabled = !hasColour;
  rgbOption.textContent = !stats.rgb ? "RGB (none in file)" : hasColour ? "RGB" : "RGB (fields all zero)";
  if (!hasColour && ui.mode.value === "8") { ui.mode.value = "0"; uniforms.uMode.value = 0; }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let loading = null;      // AbortController while streaming
const ingestMs = [];     // main-thread time per chunk, for the debug handle

// Point counts in millions for the status line: "12 M", "4.3 M", "850,000".
const fmtM = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)} M` : fmtInt(n));

ui.loadBtn.addEventListener("click", () => {
  const ids = panels.selectedIds();
  if (!ids.length) { setStatus("tick at least one file"); return; }
  startLoad(ids);
});
ui.stopBtn.addEventListener("click", () => loading && loading.abort());

function disposeCloud() {
  cells.dispose();
  marker.visible = false;
}

async function startLoad(ids) {
  const filesParam = ids.join(",");
  if (loading) loading.abort();
  const ctl = new AbortController();
  loading = ctl;
  ui.loadBtn.disabled = true; ui.stopBtn.disabled = false;
  setProgress(0);
  try {
    setStatus(`decoding ${ids.length} file${ids.length === 1 ? "" : "s"} on the server (LAZ takes a while)...`);
    const info = await fetchJson(`/api/load?files=${filesParam}`, ctl.signal);
    if (ctl.signal.aborted) return;
    disposeCloud();
    cloud.fileIds = ids;
    cloud.count = info.point_count;
    cloud.center = info.center;
    cloud.stats = info.stats;
    const want = ui.budgetSelect.value === "all" ? info.point_count : Number(ui.budgetSelect.value);
    const { budget, capped } = capBudget(want, info.point_count, navigator.deviceMemory, !!info.stats.rgb);
    cloud.budget = budget;
    // Why the load stops short of what was asked, on the status line while it streams and after.
    const capNote = capped ? `capped at ${fmtM(budget)} of ${fmtM(info.point_count)} points for this machine's memory` : "";
    panels.renderStats(info.stats);
    panels.buildClassList(info.stats);
    applyRanges();
    setRgbOption(info.stats, cells.allocate(cloud.budget, info.stats, ui.bounds.checked));
    fly.fitView();
    // Each chunk goes to the ingest worker to be binned by cell while the next one
    // is fetched; the main thread then appends it, one copy per cell, in order.
    const chunk = 500000;
    let queued = 0;          // points sent to be binned so far: the next chunk's stream position
    let pending = null;      // the binned chunk still to append
    const append = async () => {
      const b = await pending;
      pending = null;
      if (ctl.signal.aborted) return;
      const t0 = performance.now();
      cells.applyBinned(b);
      ingestMs.push(performance.now() - t0);
      setProgress(cloud.loaded / cloud.budget);
      setStatus(`${fmtInt(cloud.loaded)} of ${fmtInt(cloud.budget)} points loaded${capNote ? ` (${capNote})` : ""}`);
    };
    for (let start = 0; start < cloud.budget; start += chunk) {
      const n = Math.min(chunk, cloud.budget - start);
      const r = await apiFetch(`/api/points?files=${filesParam}&start=${start}&count=${n}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`chunk ${start}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (ctl.signal.aborted) return;
      const count = chunkCount(buf);
      const binned = cells.binAsync(buf, queued);
      queued += count;
      if (pending) await append();
      if (ctl.signal.aborted) return;
      pending = binned;
    }
    if (pending) await append();
    if (ctl.signal.aborted) return;
    const sample = cloud.loaded < cloud.count ? [`a uniform sample of ${fmtInt(cloud.count)}`, capNote].filter(Boolean).join("; ") : "";
    setStatus(`${fmtInt(cloud.loaded)} points loaded from ${ids.length} file${ids.length === 1 ? "" : "s"}${sample ? ` (${sample})` : ""}`);
  } catch (err) {
    if (err.name === "AbortError") setStatus(`stopped at ${fmtInt(cloud.loaded)} points`);
    else { setStatus(`load failed: ${err.message}`); console.error(err); }
  } finally {
    if (loading === ctl) loading = null;
    ui.loadBtn.disabled = false; ui.stopBtn.disabled = true;
  }
}

// ---------------------------------------------------------------------------

panels.loadFiles().catch((err) => setStatus(`could not list files: ${err.message}`));

// A handle for debugging from the console, when the page was opened with ?debug.
if (debug) {
  window.lpc_view = { occlusion,
    pickAt: picker.pickAt, cloud, cam, lod, uniforms, fitView: fly.fitView, topView: fly.topView, eyeLevel: fly.eyeLevel, startLoad,
    pickBuffer: picker.pickBuffer, get cells() { return cells.group; }, renderer, scene, camera, ingestMs,
  };
}
