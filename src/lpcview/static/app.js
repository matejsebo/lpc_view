// lpcview: the browser side. Streams a point cloud from the local server into a
// grid of cells, draws them with a colour-mode shader at a level of detail set by
// distance and frame time, flies a camera through them, picks points on the GPU
// and shows the file's metadata.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ui = {
  fileList: $("file-list"),
  filesCount: $("files-count"),
  metaFile: $("meta-file"),
  budgetSelect: $("budget-select"),
  loadBtn: $("load-btn"),
  stopBtn: $("stop-btn"),
  progress: $("progress-bar"),
  status: $("status"),
  mode: $("mode-select"),
  size: $("size-range"),
  sizeOut: $("size-out"),
  adaptive: $("adaptive-check"),
  bounds: $("bounds-check"),
  zrange: $("zrange-select"),
  hideWithheld: $("hide-withheld"),
  hideOverlap: $("hide-overlap"),
  hideSynthetic: $("hide-synthetic"),
  classList: $("class-list"),
  speed: $("speed-range"),
  speedOut: $("speed-out"),
  hudPos: $("hud-pos"),
  hudLook: $("hud-look"),
  hudPts: $("hud-pts"),
  hudDraw: $("hud-draw"),
  hudFps: $("hud-fps"),
  crosshair: $("crosshair"),
};

const fmtInt = (n) => Number(n).toLocaleString("en-US");
const fmt = (v, d = 2) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const COLOR_FUNCS = /* glsl */ `
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec4 kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec4 kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR4) + dot(v2, kR2), dot(v4, kG4) + dot(v2, kG2), dot(v4, kB4) + dot(v2, kB2)), 0.0, 1.0);
}
vec3 viridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 categorical(float i) {
  float h = fract(i * 0.6180339887);
  return hsv2rgb(vec3(h, 0.65, 0.95));
}
vec3 returnColor(float r) {
  if (r < 1.5) return vec3(0.95, 0.35, 0.25);
  if (r < 2.5) return vec3(0.98, 0.78, 0.25);
  if (r < 3.5) return vec3(0.35, 0.85, 0.35);
  if (r < 4.5) return vec3(0.30, 0.65, 1.00);
  if (r < 5.5) return vec3(0.75, 0.45, 1.00);
  if (r < 6.5) return vec3(1.00, 0.45, 0.85);
  return vec3(0.85, 0.85, 0.85);
}
`;

const VERTEX_COMMON = /* glsl */ `
in float intensity;
in float classification;
in float returnNumber;
in float numReturns;
in float pointSource;
in float scanAngle;
in float gpsTime;
in float flags;
#ifdef HAS_RGB
in vec3 rgb;
#else
const vec3 rgb = vec3(0.78);
#endif
uniform int uMode;
uniform float uSize;
uniform float uAdaptive;
uniform float uZMin;
uniform float uZMax;
uniform float uIMin;
uniform float uIMax;
uniform float uTMax;
uniform float uAMax;
uniform float uHideWithheld;
uniform float uHideOverlap;
uniform float uHideSynthetic;
uniform sampler2D uClassTex;
uniform float uPickSize;
uniform float uMaxSize;
uniform int uCellId;
uniform int uLocalBits;

bool hiddenPoint() {
  vec4 cls = texture(uClassTex, vec2((classification + 0.5) / 256.0, 0.5));
  if (cls.a < 0.5) return true;
  int f = int(flags + 0.5);
  if (uHideSynthetic > 0.5 && (f & 1) != 0) return true;
  if (uHideWithheld > 0.5 && (f & 4) != 0) return true;
  if (uHideOverlap > 0.5 && (f & 8) != 0) return true;
  return false;
}

float pointSizeFor(vec4 mv, float base) {
  float s = base;
  if (uAdaptive > 0.5) {
    float d = max(-mv.z, 0.5);
    // Bigger when near, but never past uMaxSize pixels (unless the base size already
    // is): the fragment cost of the points next to the camera stays bounded.
    s = min(base * clamp(60.0 / d, 0.6, 3.0), max(base, uMaxSize));
  }
  return s;
}
`;

const VERTEX_SHADER = /* glsl */ `
${VERTEX_COMMON}
${COLOR_FUNCS}
out vec3 vColor;
out float vSize;

vec3 shade() {
  if (uMode == 0) return turbo((position.z - uZMin) / max(uZMax - uZMin, 1e-6));
  if (uMode == 1) { float t = (intensity * 65535.0 - uIMin) / max(uIMax - uIMin, 1.0); return vec3(clamp(t, 0.0, 1.0)); }
  if (uMode == 2) return texture(uClassTex, vec2((classification + 0.5) / 256.0, 0.5)).rgb;
  if (uMode == 3) return returnColor(returnNumber);
  if (uMode == 4) return returnColor(numReturns);
  if (uMode == 5) return categorical(pointSource);
  if (uMode == 6) return viridis(gpsTime / max(uTMax, 1e-6));
  if (uMode == 7) return turbo(scanAngle / max(2.0 * uAMax, 1e-6) + 0.5);
  if (uMode == 8) return rgb;
  if (uMode == 9) {
    if (numReturns < 1.5) return vec3(0.85, 0.85, 0.85);
    if (returnNumber < 1.5) return vec3(0.35, 0.85, 0.35);
    if (returnNumber >= numReturns - 0.5) return vec3(0.95, 0.45, 0.25);
    return vec3(0.30, 0.60, 1.00);
  }
  return vec3(1.0);
}

void main() {
  if (hiddenPoint()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vSize = 0.0; vColor = vec3(0.0); return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vSize = pointSizeFor(mv, uSize);
  gl_PointSize = vSize;
  vColor = shade();
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
in vec3 vColor;
in float vSize;
out vec4 outColor;
void main() {
  if (vSize > 2.5) { vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard; }
  outColor = vec4(vColor, 1.0);
}
`;

const PICK_VERTEX = /* glsl */ `
${VERTEX_COMMON}
flat out vec4 vPick;
void main() {
  if (hiddenPoint()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vPick = vec4(1.0); return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(pointSizeFor(mv, uSize), uPickSize);
  // The pick colour is the cell id in the high bits and the index in the cell below.
  uint id = (uint(uCellId) << uint(uLocalBits)) | uint(gl_VertexID);
  vPick = vec4(float(id & 255u), float((id >> 8u) & 255u), float((id >> 16u) & 255u), float(id >> 24u)) / 255.0;
}
`;

const PICK_FRAGMENT = /* glsl */ `
precision highp float;
flat in vec4 vPick;
out vec4 outColor;
void main() { outColor = vPick; }
`;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0b0e14, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.2, 100000);
camera.up.set(0, 0, 1);

const classTexData = new Uint8Array(256 * 4);
const classTex = new THREE.DataTexture(classTexData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
classTex.magFilter = classTex.minFilter = THREE.NearestFilter;
classTex.needsUpdate = true;

const uniforms = {
  uMode: { value: 0 },
  uSize: { value: 2 },
  uAdaptive: { value: 1 },
  uZMin: { value: 0 },
  uZMax: { value: 1 },
  uIMin: { value: 0 },
  uIMax: { value: 65535 },
  uTMax: { value: 1 },
  uAMax: { value: 20 },
  uHideWithheld: { value: 1 },
  uHideOverlap: { value: 0 },
  uHideSynthetic: { value: 0 },
  uClassTex: { value: classTex },
  uPickSize: { value: 7 },
  uMaxSize: { value: 8 },
  uCellId: { value: 0 },
  uLocalBits: { value: 32 },
};

const material = new THREE.ShaderMaterial({
  uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER, glslVersion: THREE.GLSL3,
});
const pickMaterial = new THREE.ShaderMaterial({
  uniforms, vertexShader: PICK_VERTEX, fragmentShader: PICK_FRAGMENT, glslVersion: THREE.GLSL3, blending: THREE.NoBlending,
});
const pickTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const pickBuffer = new Uint8Array(4);

let cellGroup = null;    // THREE.Group of one THREE.Points per grid cell
let boundsHelper = null;
let marker = null;
const cloud = {          // the loaded cloud's bookkeeping
  fileIds: [], stats: null, center: [0, 0, 0], count: 0, budget: 0, loaded: 0,
  hasRgb: false, hasTime: false,
  grid: null,            // the cells (see makeGrid)
  segments: [],          // {start, file, local, count}: which file each stream index came from
};
let files = [];          // the server's file listing

function segmentOf(streamIndex) {
  const segs = cloud.segments;
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (streamIndex < s.start) hi = mid - 1;
    else if (streamIndex >= s.start + s.count) lo = mid + 1;
    else return s;
  }
  return null;
}
let loading = null;      // AbortController while streaming

function makeMarker() {
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
marker = makeMarker();
scene.add(marker);

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
// Camera: fly controls
// ---------------------------------------------------------------------------

const cam = { pos: new THREE.Vector3(0, 0, 100), yaw: 0, pitch: -0.3, speed: 50 };
const keys = new Set();
let dragging = false, dragMoved = 0, dragLast = [0, 0], locked = false;

function forwardVector() {
  const cp = Math.cos(cam.pitch);
  return new THREE.Vector3(Math.sin(cam.yaw) * cp, Math.cos(cam.yaw) * cp, Math.sin(cam.pitch));
}
function rightVector() { return new THREE.Vector3(Math.cos(cam.yaw), -Math.sin(cam.yaw), 0); }
function applyCamera() {
  camera.position.copy(cam.pos);
  camera.lookAt(cam.pos.clone().add(forwardVector()));
}
function setSpeed(v) {
  cam.speed = Math.min(2000, Math.max(0.1, v));
  ui.speed.value = Math.log10(cam.speed);
  ui.speedOut.textContent = cam.speed >= 10 ? `${cam.speed.toFixed(0)} m/s` : `${cam.speed.toFixed(1)} m/s`;
}
ui.speed.addEventListener("input", () => setSpeed(10 ** Number(ui.speed.value)));
setSpeed(50);

function extent() {
  const s = cloud.stats;
  if (!s) return { min: [-500, -500, -50], max: [500, 500, 50] };
  const c = cloud.center;
  const min = s.bounds.min.map((v, i) => v - c[i]), max = s.bounds.max.map((v, i) => v - c[i]);
  // Stray noise points can put the z bounds kilometres out; frame the 1-99 percentile band.
  min[2] = s.z.percentiles["1"] - c[2];
  max[2] = s.z.percentiles["99"] - c[2];
  return { min, max };
}
function fitView() {
  const e = extent();
  const ex = e.max[0] - e.min[0], ey = e.max[1] - e.min[1], ez = e.max[2] - e.min[2];
  const span = Math.max(ex, ey);
  cam.pos.set((e.min[0] + e.max[0]) / 2, e.min[1] - span * 0.55, e.max[2] + span * 0.45);
  cam.yaw = 0;
  cam.pitch = -Math.atan2(span * 0.45 + ez * 0.5, span * 1.05);
  setSpeed(Math.max(1, span / 20));
}
function topView() {
  const e = extent();
  cam.pos.set((e.min[0] + e.max[0]) / 2, (e.min[1] + e.max[1]) / 2, e.max[2] + Math.max(e.max[0] - e.min[0], e.max[1] - e.min[1]) * 0.9);
  cam.yaw = 0;
  cam.pitch = -Math.PI / 2 + 0.001;
}
function eyeLevel() {
  // Stand 1.8 m above the highest ground point within 3 m; failing ground, any point.
  if (!cloud.grid) return;
  let best = -Infinity, bestAny = -Infinity;
  const r = 3, r2 = r * r;
  for (const cell of cellsAround(cam.pos.x, cam.pos.y, r)) {
    const { pos, cls } = cell.arrays;
    for (let i = 0; i < cell.n; i++) {
      const dx = pos[3 * i] - cam.pos.x, dy = pos[3 * i + 1] - cam.pos.y;
      if (dx * dx + dy * dy > r2) continue;
      const z = pos[3 * i + 2];
      if (z > bestAny) bestAny = z;
      if (cls[i] === 2 && z > best) best = z;
    }
  }
  const ground = best > -Infinity ? best : bestAny;
  if (ground === -Infinity) { setStatus("no points within 3 m of the camera"); return; }
  cam.pos.z = ground + 1.8;
  if (cam.pitch < -0.6) cam.pitch = -0.05;
  setSpeed(Math.min(cam.speed, 6));
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true; dragMoved = 0; dragLast = [e.clientX, e.clientY];
});
window.addEventListener("mousemove", (e) => {
  if (locked) {
    cam.yaw += e.movementX * 0.0022;
    cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - e.movementY * 0.0022));
    return;
  }
  if (!dragging) return;
  const dx = e.clientX - dragLast[0], dy = e.clientY - dragLast[1];
  dragLast = [e.clientX, e.clientY];
  dragMoved += Math.abs(dx) + Math.abs(dy);
  cam.yaw += dx * 0.004;
  cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - dy * 0.004));
});
window.addEventListener("mouseup", (e) => {
  if (e.button !== 0) return;
  if (locked) { pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2); return; }
  if (dragging && dragMoved < 4 && e.target === canvas) pickAt(e.clientX, e.clientY);
  dragging = false;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  setSpeed(cam.speed * Math.pow(1.15, -Math.sign(e.deltaY)));
}, { passive: false });
canvas.addEventListener("dblclick", () => canvas.requestPointerLock());
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  ui.crosshair.hidden = !locked;
  canvas.style.cursor = locked ? "none" : "crosshair";
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;
  const k = e.key.toLowerCase();
  if (k === "f") fitView();
  else if (k === "t") topView();
  else if (k === "g") eyeLevel();
  else if (k === "l") { if (locked) document.exitPointerLock(); else canvas.requestPointerLock(); }
  else if (k === "h") togglePanels();
  else if (k === "p") pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
  else if (k === "o") openFiles();
  else if (k === " ") { keys.add("e"); e.preventDefault(); }
  else keys.add(k);
  if (k.startsWith("arrow")) e.preventDefault();
});
window.addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); if (e.key === " ") keys.delete("e"); });
window.addEventListener("blur", () => keys.clear());

function stepCamera(dt) {
  let mult = 1;
  if (keys.has("shift")) mult *= 5;
  if (keys.has("control")) mult *= 0.2;
  const d = cam.speed * mult * dt;
  const f = forwardVector(), r = rightVector();
  if (keys.has("w")) cam.pos.addScaledVector(f, d);
  if (keys.has("s")) cam.pos.addScaledVector(f, -d);
  if (keys.has("d")) cam.pos.addScaledVector(r, d);
  if (keys.has("a")) cam.pos.addScaledVector(r, -d);
  if (keys.has("e")) cam.pos.z += d;
  if (keys.has("q")) cam.pos.z -= d;
  const look = 1.6 * dt;
  if (keys.has("arrowleft")) cam.yaw -= look;
  if (keys.has("arrowright")) cam.yaw += look;
  if (keys.has("arrowup")) cam.pitch = Math.min(1.55, cam.pitch + look);
  if (keys.has("arrowdown")) cam.pitch = Math.max(-1.55, cam.pitch - look);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

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
const TARGET_MS = 16;
const NEAR_ALL = 1e6;                      // metres: farther than any cell, i.e. all
const lod = { near: 200, movingNear: 200, moving: false, stillSince: 0, drawn: 0, cellsDrawn: 0 };
const prevPose = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN };
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();

function cameraMoved() {
  const p = cam.pos;
  const moved = p.x !== prevPose.x || p.y !== prevPose.y || p.z !== prevPose.z || cam.yaw !== prevPose.yaw || cam.pitch !== prevPose.pitch;
  prevPose.x = p.x; prevPose.y = p.y; prevPose.z = p.z; prevPose.yaw = cam.yaw; prevPose.pitch = cam.pitch;
  return moved;
}

function updateLod(now, frameMs) {
  if (cameraMoved()) lod.stillSince = now;
  const wasMoving = lod.moving;
  lod.moving = now - lod.stillSince < 150;
  if (lod.moving) {
    if (!wasMoving) lod.near = Math.min(lod.near, lod.movingNear);
    // The drawn count goes with near^2, so a factor on the count is its square root on near.
    let factor = 1.04;
    if (frameMs > TARGET_MS * 1.2) factor = Math.max(0.7, (0.9 * TARGET_MS) / frameMs);
    else if (frameMs < TARGET_MS * 0.5) factor = 1.15;
    lod.near = Math.min(NEAR_ALL, Math.max(5, lod.near * Math.sqrt(factor)));
    lod.movingNear = lod.near;
  } else if (lod.near < NEAR_ALL) {
    lod.near = Math.min(NEAR_ALL, lod.near * 1.2);
  }
}

// Cull and set every cell's draw range for the current camera.
function applyLod() {
  lod.drawn = 0; lod.cellsDrawn = 0;
  const grid = cloud.grid;
  if (!grid) return;
  camera.updateMatrixWorld();
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  const near2 = lod.near * lod.near;
  for (const cell of grid.cells) {
    if (!cell.n) continue;
    cell.box.min.z = cell.zmin; cell.box.max.z = cell.zmax;
    const visible = frustum.intersectsBox(cell.box);
    cell.points.visible = visible;
    if (!visible) { cell.drawn = 0; continue; }
    const d = cell.box.distanceToPoint(camera.position);
    const f = d <= lod.near ? 1 : near2 / (d * d);
    cell.drawn = f >= 1 ? cell.n : Math.floor(cell.n * f);
    cell.geometry.setDrawRange(0, cell.drawn);
    lod.drawn += cell.drawn;
    lod.cellsDrawn++;
  }
}

let lastT = performance.now(), frames = 0, fpsT = lastT;
function frame(now) {
  const frameMs = now - lastT;
  const dt = Math.min(0.1, frameMs / 1000);
  lastT = now;
  stepCamera(dt);
  applyCamera();
  updateLod(now, frameMs);
  applyLod();
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
// Picking
// ---------------------------------------------------------------------------

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
  if (boundsHelper) boundsHelper.visible = false;
  // The pick render draws the cells with the draw ranges of the last frame; each
  // cell's onBeforeRender sets uCellId, so the colour read back is (cell, index).
  scene.overrideMaterial = pickMaterial;
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickBuffer);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x0b0e14, 1);
  scene.overrideMaterial = null;
  camera.clearViewOffset();
  marker.visible = markerVisible;
  if (boundsHelper) boundsHelper.visible = ui.bounds.checked;
  const code = pickBuffer[0] + pickBuffer[1] * 256 + pickBuffer[2] * 65536 + pickBuffer[3] * 16777216;
  if (code === 0xffffffff) { showPoint(null); return; }
  const cellId = Math.floor(code / grid.localSpan), local = code - cellId * grid.localSpan;
  const cell = grid.cells[cellId];
  if (!cell || !cell.n || local >= cell.n) { showPoint(null); return; }
  const { pos } = cell.arrays;
  marker.position.set(pos[3 * local], pos[3 * local + 1], pos[3 * local + 2]);
  marker.visible = true;
  const id = cell.arrays.stream[local];
  showPoint({ loadingIndex: id });
  const seg = segmentOf(id);
  if (!seg) { showPoint(null); return; }
  try {
    const r = await fetch(`/api/point?file=${seg.file}&i=${seg.local + (id - seg.start)}`);
    const rec = await r.json();
    if (rec.error) throw new Error(rec.error);
    rec.file_id = seg.file;
    rec.file_name = (files[seg.file] || {}).name || String(seg.file);
    showPoint(rec);
    if (String(ui.metaFile.value) !== String(seg.file)) { ui.metaFile.value = String(seg.file); showMetadata(seg.file); }
  } catch (err) {
    $("tab-point").innerHTML = `<em>could not fetch the point: ${esc(err.message)}</em>`;
  }
}

function showPoint(rec) {
  const page = $("tab-point");
  activateTab("point");
  if (!rec) { page.innerHTML = "<em>nothing under the cursor</em>"; marker.visible = false; return; }
  if (rec.loadingIndex !== undefined) { page.innerHTML = `<em>point ${fmtInt(rec.loadingIndex)} of the stream, fetching...</em>`; return; }
  const c = cloud.center;
  const dist = Math.hypot(rec.x - c[0] - cam.pos.x, rec.y - c[1] - cam.pos.y, rec.z - c[2] - cam.pos.z);
  const rows = [];
  const add = (k, v, cls = "") => rows.push(`<tr><th>${esc(k)}</th><td class="${cls}">${v}</td></tr>`);
  add("x (east)", fmt(rec.x, 2)); add("y (north)", fmt(rec.y, 2)); add("z", fmt(rec.z, 2));
  if (rec.latitude !== undefined) add("lat / lon", `${fmt(rec.latitude, 6)}, ${fmt(rec.longitude, 6)} <a href="https://www.openstreetmap.org/?mlat=${rec.latitude}&mlon=${rec.longitude}#map=17/${rec.latitude}/${rec.longitude}" target="_blank" rel="noopener">map</a>`);
  add("raw X Y Z", `${rec.X} ${rec.Y} ${rec.Z}`);
  add("distance from camera", `${fmt(dist, 1)} m`);
  const sw = (code) => { const col = classColor(code); return `<span class="sw" style="background:rgb(${col.join(",")})"></span>`; };
  add("classification", `${sw(rec.classification)}${rec.classification} ${esc(rec.classification_name)}`);
  add("intensity", fmtInt(rec.intensity));
  add("return", `${rec.return_number} of ${rec.number_of_returns}`);
  add("point source id", rec.point_source_id);
  add("scan angle", `${fmt(rec.scan_angle_deg, 2)} deg`);
  if (rec.scanner_channel !== undefined) add("scanner channel", rec.scanner_channel);
  add("user data", rec.user_data);
  if (rec.gps_time !== undefined) { add("gps time", fmt(rec.gps_time, 6)); add("gps time (UTC)", rec.gps_time_utc ? esc(rec.gps_time_utc) : "week time, no date"); }
  if (rec.rgb) add("rgb", `<span class="sw" style="background:rgb(${rec.rgb.join(",")})"></span>${rec.rgb.join(" ")}`);
  if (rec.nir !== undefined) add("nir", rec.nir);
  const flags = ["synthetic", "key_point", "withheld", "overlap", "edge_of_flight_line"].map((f) => `<span class="${rec[f] ? "flag-on" : ""}">${f}${rec[f] ? " = 1" : " = 0"}</span>`).join(", ");
  add("flags", flags);
  add("scan direction", rec.scan_direction_flag ? "positive (1)" : "negative (0)");
  add("file", esc(rec.file_name));
  add("index in file", fmtInt(rec.file_index));
  add("index in stream", fmtInt(rec.stream_index));
  page.innerHTML = `<table class="kv">${rows.join("")}</table>
    <div class="row"><button id="copy-point" class="mini">copy as JSON</button></div>`;
  $("copy-point").addEventListener("click", () => navigator.clipboard.writeText(JSON.stringify(rec, null, 2)));
}

// ---------------------------------------------------------------------------
// Class colours (mirrors lpcview/classes.py for codes the stats have not named)
// ---------------------------------------------------------------------------

const CLASS_COLORS = {};
function classColor(code) {
  if (CLASS_COLORS[code]) return CLASS_COLORS[code];
  const h = (code * 137.508) % 360;
  const col = hsvToRgb(h / 360, 0.6, 0.85);
  CLASS_COLORS[code] = col;
  return col;
}
function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
const classVisible = new Array(256).fill(true);
function writeClassTexture() {
  for (let c = 0; c < 256; c++) {
    const col = classColor(c);
    classTexData[4 * c] = col[0]; classTexData[4 * c + 1] = col[1]; classTexData[4 * c + 2] = col[2];
    classTexData[4 * c + 3] = classVisible[c] ? 255 : 0;
  }
  classTex.needsUpdate = true;
}
writeClassTexture();

function buildClassList(stats) {
  const rows = stats.classification.map((r) => {
    CLASS_COLORS[r.value] = r.color;
    return `<label><input type="checkbox" data-class="${r.value}" ${classVisible[r.value] ? "checked" : ""}>
      <span class="sw" style="background:rgb(${r.color.join(",")})"></span>
      <span class="nm" title="${esc(r.name)}">${r.value} ${esc(r.name)}</span>
      <span class="ct">${(100 * r.fraction).toFixed(1)}%</span></label>`;
  });
  ui.classList.innerHTML = rows.join("");
  ui.classList.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
    classVisible[Number(cb.dataset.class)] = cb.checked;
    writeClassTexture();
  }));
  writeClassTexture();
}
$("classes-all").addEventListener("click", () => { classVisible.fill(true); ui.classList.querySelectorAll("input").forEach((cb) => (cb.checked = true)); writeClassTexture(); });
$("classes-none").addEventListener("click", () => { classVisible.fill(false); ui.classList.querySelectorAll("input").forEach((cb) => (cb.checked = false)); writeClassTexture(); });

// ---------------------------------------------------------------------------
// Display controls
// ---------------------------------------------------------------------------

ui.mode.addEventListener("change", () => (uniforms.uMode.value = Number(ui.mode.value)));
ui.size.addEventListener("input", () => { uniforms.uSize.value = Number(ui.size.value); ui.sizeOut.textContent = ui.size.value; });
ui.adaptive.addEventListener("change", () => (uniforms.uAdaptive.value = ui.adaptive.checked ? 1 : 0));
ui.bounds.addEventListener("change", () => { if (boundsHelper) boundsHelper.visible = ui.bounds.checked; });
ui.hideWithheld.addEventListener("change", () => (uniforms.uHideWithheld.value = ui.hideWithheld.checked ? 1 : 0));
ui.hideOverlap.addEventListener("change", () => (uniforms.uHideOverlap.value = ui.hideOverlap.checked ? 1 : 0));
ui.hideSynthetic.addEventListener("change", () => (uniforms.uHideSynthetic.value = ui.hideSynthetic.checked ? 1 : 0));
ui.zrange.addEventListener("change", applyRanges);
$("fit-btn").addEventListener("click", fitView);
$("top-btn").addEventListener("click", topView);
$("eye-btn").addEventListener("click", eyeLevel);

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

// Panels
function togglePanels() {
  const hide = !$("left").hidden;
  $("left").hidden = hide; $("right").hidden = hide;
  $("show-left").hidden = !hide; $("show-right").hidden = !hide;
}
$("toggle-left").addEventListener("click", () => { $("left").hidden = true; $("show-left").hidden = false; });
$("show-left").addEventListener("click", () => { $("left").hidden = false; $("show-left").hidden = true; });
$("toggle-right").addEventListener("click", () => { $("right").hidden = true; $("show-right").hidden = false; });
$("show-right").addEventListener("click", () => { $("right").hidden = false; $("show-right").hidden = true; });
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));
function activateTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-page").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
}

function setStatus(text) { ui.status.textContent = text; }
function setProgress(frac) { ui.progress.style.width = `${Math.round(100 * frac)}%`; }

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function fetchJson(url, signal) {
  const r = await fetch(url, { signal });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

function selectedIds() {
  return [...ui.fileList.querySelectorAll("input:checked")].map((cb) => Number(cb.dataset.file));
}
function updateFilesCount() {
  const ids = selectedIds();
  const pts = ids.reduce((n, i) => n + Math.max(0, files[i].point_count), 0);
  ui.filesCount.textContent = `${ids.length} of ${files.length}, ${fmtInt(pts)} pts`;
}
// (Re)list the server's files. On the first call the URL's ?files= picks the ticked
// ones (all, by default); later calls keep the ticks and tick `select` (new files).
async function loadFiles(select = null) {
  const before = files.length ? new Set(selectedIds()) : null;
  files = await fetchJson("/api/files");
  const params = new URLSearchParams(location.search);
  const wanted = (params.get("files") || params.get("file") || "").split(",").filter((s) => s !== "").map(Number);
  const checked = (f) => (before ? before.has(f.id) || (select || []).includes(f.id) : wanted.length ? wanted.includes(f.id) : true);
  ui.fileList.innerHTML = files.length
    ? files.map((f) => `<label title="${esc(f.path)}"><input type="checkbox" data-file="${f.id}" ${checked(f) ? "checked" : ""}>
    <span class="nm">${esc(f.name)}</span><span class="ct">${fmtInt(f.point_count)} pf${f.point_format}</span></label>`).join("")
    : "<em>no files open</em>";
  ui.fileList.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", updateFilesCount));
  ui.metaFile.innerHTML = files.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
  updateFilesCount();
  if (!files.length) { setStatus(window.pywebview ? "open a file (Open... or O)" : "no files; start lpcview with some"); return; }
  const first = (select || []).find((i) => files[i]) ?? selectedIds()[0] ?? 0;
  ui.metaFile.value = String(first);
  await showMetadata(first);
}

// In the app (pywebview window), Open... asks Python for the native file dialog.
let opening = false;
async function openFiles() {
  if (opening || !window.pywebview) return;
  opening = true;
  try {
    const r = await window.pywebview.api.open_files();
    if (r.error) { setStatus(r.error); return; }
    if (r.cancelled) { if (!files.length) setStatus("no files open; Open... (or O) to pick some"); return; }
    await loadFiles(r.selected);
    if (r.added.length) setStatus(`${r.added.length} file(s) opened; press Load`);
  } catch (err) {
    setStatus(`open failed: ${err.message || err}`);
  } finally {
    opening = false;
  }
}
window.addEventListener("pywebviewready", () => {
  $("open-btn").hidden = false;
  if (!files.length) openFiles();
});
$("open-btn").addEventListener("click", openFiles);
$("files-all").addEventListener("click", () => { ui.fileList.querySelectorAll("input").forEach((cb) => (cb.checked = true)); updateFilesCount(); });
$("files-none").addEventListener("click", () => { ui.fileList.querySelectorAll("input").forEach((cb) => (cb.checked = false)); updateFilesCount(); });
ui.metaFile.addEventListener("change", () => showMetadata(Number(ui.metaFile.value)));

async function showMetadata(fileId) {
  try {
    const meta = await fetchJson(`/api/meta?file=${fileId}`);
    renderHeader(meta, fileId);
    renderVlrs(meta);
    renderCrs(meta);
    if (!cloud.stats) setStatus(`${fmtInt(meta.header.point_count)} points, ${(meta.file.size_bytes / 1048576).toFixed(1)} MB; tick files and press Load`);
  } catch (err) {
    setStatus(`metadata failed: ${err.message}`);
  }
}

ui.loadBtn.addEventListener("click", () => {
  const ids = selectedIds();
  if (!ids.length) { setStatus("tick at least one file"); return; }
  startLoad(ids);
});
ui.stopBtn.addEventListener("click", () => loading && loading.abort());

function disposeCloud() {
  if (cellGroup) {
    for (const cell of cloud.grid.cells) if (cell.geometry) cell.geometry.dispose();
    scene.remove(cellGroup); cellGroup = null;
  }
  if (boundsHelper) { scene.remove(boundsHelper); boundsHelper = null; }
  marker.visible = false;
  cloud.grid = null; cloud.loaded = 0; cloud.count = 0; cloud.stats = null; cloud.segments = [];
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
    cloud.budget = Math.min(want, info.point_count);
    renderStats(info.stats);
    buildClassList(info.stats);
    applyRanges();
    allocate(cloud.budget, info.stats);
    fitView();
    const chunk = 500000;
    for (let start = 0; start < cloud.budget; start += chunk) {
      const n = Math.min(chunk, cloud.budget - start);
      const r = await fetch(`/api/points?files=${filesParam}&start=${start}&count=${n}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`chunk ${start}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (ctl.signal.aborted) return;
      ingest(buf);
      setProgress(cloud.loaded / cloud.budget);
      setStatus(`${fmtInt(cloud.loaded)} of ${fmtInt(cloud.budget)} points loaded`);
    }
    setStatus(`${fmtInt(cloud.loaded)} points loaded from ${ids.length} file${ids.length === 1 ? "" : "s"}${cloud.loaded < cloud.count ? ` (a uniform sample of ${fmtInt(cloud.count)})` : ""}`);
  } catch (err) {
    if (err.name === "AbortError") setStatus(`stopped at ${fmtInt(cloud.loaded)} points`);
    else { setStatus(`load failed: ${err.message}`); console.error(err); }
  } finally {
    if (loading === ctl) loading = null;
    ui.loadBtn.disabled = false; ui.stopBtn.disabled = true;
  }
}

// The grid: the loaded extent cut into cells about CELL_M square (at most MAX_CELLS
// of them, larger when the extent is huge), each with its own buffers filled in
// arrival order. The stream is a uniform shuffle, so each cell's points are too,
// and a cell's draw range is a uniform sample of it. Picks come back as
// (cell id, index in cell): cell ids take the high bits of the 32-bit pick colour
// and indices the rest, and `stream` maps an index back to its stream position.
const CELL_M = 100;
const MAX_CELLS = 4096;
const ATTRS = [["position", "pos", 3], ["intensity", "intensity", 1], ["classification", "cls", 1], ["returnNumber", "ret", 1], ["numReturns", "nret", 1], ["pointSource", "psid", 1], ["scanAngle", "angle", 1], ["gpsTime", "time", 1], ["flags", "flags", 1], ["rgb", "rgb", 3]];

function makeGrid(budget, stats) {
  const e = extent();
  const ex = Math.max(e.max[0] - e.min[0], 1), ey = Math.max(e.max[1] - e.min[1], 1);
  let cellM = CELL_M;
  if ((ex / cellM) * (ey / cellM) > MAX_CELLS) cellM = Math.sqrt((ex * ey) / MAX_CELLS);
  const nx = Math.max(1, Math.round(ex / cellM)), ny = Math.max(1, Math.round(ey / cellM));
  const cellBits = Math.max(1, Math.ceil(Math.log2(nx * ny + 1)));
  const grid = {
    nx, ny, x0: e.min[0], y0: e.min[1], dx: ex / nx, dy: ey / ny, cells: [],
    localBits: 32 - cellBits, localSpan: 2 ** (32 - cellBits),
    hasRgb: !!stats.rgb,
  };
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
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

function cellIndex(grid, x, y) {
  const ix = Math.min(grid.nx - 1, Math.max(0, Math.floor((x - grid.x0) / grid.dx)));
  const iy = Math.min(grid.ny - 1, Math.max(0, Math.floor((y - grid.y0) / grid.dy)));
  return ix + iy * grid.nx;
}

// The filled cells whose footprint comes within r metres of (x, y).
function cellsAround(x, y, r) {
  const g = cloud.grid, out = [];
  if (!g) return out;
  const ax = Math.max(0, Math.floor((x - r - g.x0) / g.dx)), bx = Math.min(g.nx - 1, Math.floor((x + r - g.x0) / g.dx));
  const ay = Math.max(0, Math.floor((y - r - g.y0) / g.dy)), by = Math.min(g.ny - 1, Math.floor((y + r - g.y0) / g.dy));
  for (let iy = ay; iy <= by; iy++) for (let ix = ax; ix <= bx; ix++) { const c = g.cells[ix + iy * g.nx]; if (c.n) out.push(c); }
  return out;
}

function cellArrays(cap, hasRgb) {
  return {
    pos: new Float32Array(3 * cap), intensity: new Uint16Array(cap), cls: new Uint8Array(cap), ret: new Uint8Array(cap),
    nret: new Uint8Array(cap), psid: new Uint16Array(cap), angle: new Float32Array(cap), time: new Float32Array(cap),
    flags: new Uint8Array(cap), rgb: hasRgb ? new Uint8Array(3 * cap) : null, stream: new Uint32Array(cap),
  };
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

function allocate(n, stats) {
  cloud.hasRgb = !!stats.rgb;
  for (const m of [material, pickMaterial]) {
    const want = cloud.hasRgb ? { HAS_RGB: 1 } : {};
    if (JSON.stringify(m.defines || {}) !== JSON.stringify(want)) { m.defines = want; m.needsUpdate = true; }
  }
  cellGroup = new THREE.Group();
  scene.add(cellGroup);
  cloud.grid = makeGrid(n, stats);
  const e = extent();
  const box = new THREE.Box3(new THREE.Vector3(...e.min), new THREE.Vector3(...e.max));
  boundsHelper = new THREE.Box3Helper(box, 0x3a4560);
  boundsHelper.visible = ui.bounds.checked;
  scene.add(boundsHelper);
  // RGB fields that are present but all zero were never filled: grey the mode out.
  const hasColour = !!stats.rgb && ["red", "green", "blue"].some((k) => stats.rgb[k].max > 0);
  const rgbOption = ui.mode.querySelector('option[value="8"]');
  rgbOption.disabled = !hasColour;
  rgbOption.textContent = !stats.rgb ? "RGB (none in file)" : hasColour ? "RGB" : "RGB (fields all zero)";
  if (!hasColour && ui.mode.value === "8") { ui.mode.value = "0"; uniforms.uMode.value = 0; }
}

// Append a chunk after the points already loaded, each point into its cell. A chunk
// asked for as stream positions [s, s+count) holds the mosaic's points at those
// positions, which is count points give or take one per file (each file contributes
// floor(p * n_k / N) points below position p), so chunks are placed by their actual
// counts, not by s.
function ingest(buf) {
  const start = cloud.loaded;
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "LPC2") throw new Error("bad chunk");
  const n = dv.getUint32(4, true);
  const hasRgb = dv.getUint8(8) === 1;
  const nseg = dv.getUint16(10, true);
  let off = 12;
  let at = start;
  for (let k = 0; k < nseg; k++) {
    const seg = { file: dv.getUint32(off, true), local: dv.getUint32(off + 4, true), count: dv.getUint32(off + 8, true), start: at };
    off += 12;
    at += seg.count;
    if (seg.count) cloud.segments.push(seg);
  }
  if (at - start !== n) throw new Error("chunk segments do not add up");
  // A typed view where the offset is aligned for the element size, else an aligned copy
  // (the last chunk's odd count can leave the 2- and 4-byte arrays misaligned).
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

// ---------------------------------------------------------------------------
// Metadata panels
// ---------------------------------------------------------------------------

function kvTable(pairs) {
  return `<table class="kv">${pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}</table>`;
}

function renderHeader(meta, fileId) {
  const h = meta.header, f = meta.file, pf = meta.point_format, ge = h.global_encoding;
  const html = [];
  html.push("<h4>File</h4>", kvTable([
    ["name", esc(f.name)], ["path", esc(f.path)], ["size", `${fmtInt(f.size_bytes)} bytes (${(f.size_bytes / 1048576).toFixed(1)} MB)`],
    ["modified", esc(f.modified)], ["compressed", f.compressed ? "yes (LAZ)" : "no (LAS)"],
    ["sha256", `<button class="mini" id="sha-btn">compute</button> <span id="sha-out"></span>`],
    ["download", `<a href="/api/meta?file=${fileId}" download="${esc(f.name)}.meta.json">metadata JSON</a>`],
  ]));
  html.push("<h4>Public header block</h4>", kvTable([
    ["version", h.version], ["file source id", h.file_source_id], ["project id (GUID)", h.project_id],
    ["system identifier", esc(h.system_identifier)], ["generating software", esc(h.generating_software)],
    ["creation date", h.creation_date ?? "-"], ["header size", h.header_size], ["offset to point data", h.offset_to_point_data],
    ["number of VLRs", h.number_of_vlrs], ["point data record format", h.point_data_record_format],
    ["point data record length", `${h.point_data_record_length} bytes`], ["number of point records", fmtInt(h.point_count)],
    ["points by return", h.number_of_points_by_return.map((n, i) => (n ? `${i + 1}: ${fmtInt(n)}` : null)).filter(Boolean).join("<br>") || "-"],
    ["scale factors", h.scales.join(", ")], ["offsets", h.offsets.join(", ")],
    ["min x y z", h.mins.map((v) => fmt(v, 2)).join(", ")], ["max x y z", h.maxs.map((v) => fmt(v, 2)).join(", ")],
    ["extent", h.extent.map((v) => fmt(v, 2)).join(" x ") + " m"], ["area", `${fmt(h.area_m2 / 1e4, 2)} ha`],
    ["density (header)", h.points_per_m2 ? `${fmt(h.points_per_m2, 2)} pts/m2` : "-"],
    ["start of waveform data", h.start_of_waveform_data_packet_record], ["start of first EVLR", h.start_of_first_evlr],
    ["number of EVLRs", h.number_of_evlrs], ["extra header bytes", h.extra_header_bytes], ["extra VLR bytes", h.extra_vlr_bytes],
  ]));
  html.push("<h4>Global encoding</h4>", kvTable([
    ["value", `${ge.value} (0b${ge.value.toString(2).padStart(5, "0")})`], ["GPS time type", ge.gps_time_type === "standard" ? "adjusted standard GPS time" : "GPS week time"],
    ["waveform packets internal", ge.waveform_data_packets_internal], ["waveform packets external", ge.waveform_data_packets_external],
    ["synthetic return numbers", ge.synthetic_return_numbers], ["WKT CRS", ge.wkt],
  ]));
  html.push(`<h4>Point format ${pf.id} (${pf.size} bytes)</h4>`);
  html.push(kvTable([["gps time", pf.has_gps_time], ["rgb", pf.has_rgb], ["nir", pf.has_nir], ["waveform", pf.has_waveform], ["extra dimensions", pf.extra_dimensions.join(", ") || "none"]]));
  html.push(`<table class="grid"><tr><th>dimension</th><th>kind</th><th>bits</th><th>dtype</th></tr>${pf.dimensions.map((d) => `<tr><td class="nm">${esc(d.name)}${d.extra ? " (extra)" : ""}</td><td>${esc(d.kind)}</td><td>${d.bits}</td><td>${d.dtype ?? "bitfield"}</td></tr>`).join("")}</table>`);
  $("tab-header").innerHTML = html.join("");
  $("sha-btn").addEventListener("click", async () => {
    $("sha-out").textContent = "hashing...";
    try { const r = await fetchJson(`/api/sha256?file=${fileId}`); $("sha-out").textContent = r.sha256; } catch (e) { $("sha-out").textContent = e.message; }
  });
}

function renderVlrs(meta) {
  const card = (v, kind) => {
    const parts = [`<div class="vlr"><div class="t">${kind} ${esc(v.user_id)} / ${v.record_id} <span class="d">${esc(v.kind)}, ${fmtInt(v.size_bytes)} bytes</span></div><div class="d">${esc(v.description || "(no description)")}</div>`];
    const p = v.parsed;
    if (p) {
      if (p.lookups) parts.push(`<table class="grid"><tr><th>code</th><th>name</th></tr>${p.lookups.filter((l) => l.name.trim()).map((l) => `<tr><td>${l.code}</td><td class="nm">${esc(l.name)}</td></tr>`).join("")}</table>`);
      else if (p.wkt) parts.push(`<details><summary>WKT</summary><pre>${esc(p.wkt)}</pre></details>`);
      else if (p.items) parts.push(kvTable([["compressor", esc(p.compressor)], ["coder", esc(p.coder)], ["version", esc(p.version)], ["chunk size", fmtInt(p.chunk_size)], ["items", p.items.map((it) => `${esc(it.type)} v${it.version} (${it.size} B)`).join(", ")]]));
      else if (p.keys) parts.push(`<table class="grid"><tr><th>key</th><th>tag loc</th><th>count</th><th>value</th></tr>${p.keys.map((k) => `<tr><td>${k.id}</td><td>${k.tiff_tag_location}</td><td>${k.count}</td><td>${k.value_offset}</td></tr>`).join("")}</table>`);
      else parts.push(`<pre>${esc(JSON.stringify(p, null, 1))}</pre>`);
    }
    if (v.raw && v.raw.length) parts.push(`<details><summary>raw bytes${v.raw.truncated ? " (first 64)" : ""}</summary><pre>${esc(v.raw.hex)}\n${esc(v.raw.ascii)}</pre></details>`);
    parts.push("</div>");
    return parts.join("");
  };
  const html = [`<h4>${meta.vlrs.length} VLR${meta.vlrs.length === 1 ? "" : "s"}</h4>`, ...meta.vlrs.map((v) => card(v, "VLR")),
    `<h4>${meta.evlrs.length} EVLR${meta.evlrs.length === 1 ? "" : "s"}</h4>`, ...meta.evlrs.map((v) => card(v, "EVLR"))];
  $("tab-vlrs").innerHTML = html.join("") || "<em>none</em>";
}

function renderCrs(meta) {
  const c = meta.crs;
  if (!c) { $("tab-crs").innerHTML = "<em>the file carries no coordinate reference system</em>"; return; }
  if (c.error) { $("tab-crs").innerHTML = `<em>${esc(c.error)}</em>`; return; }
  const one = (x) => kvTable([["name", esc(x.name)], ["type", esc(x.type)], ["EPSG", x.epsg ?? "-"], ["datum", esc(x.datum ?? "-")],
    ["axes", (x.axes || []).map((a) => `${esc(a.name)}${a.abbrev ? ` (${esc(a.abbrev)})` : ""}: ${esc(a.direction)}, ${esc(a.unit)}`).join("<br>") || "-"], ["area of use", esc(x.area_of_use ?? "-")]]);
  const html = ["<h4>Coordinate reference system</h4>", one(c)];
  c.components.forEach((s, i) => { html.push(`<h4>Component ${i + 1}</h4>`, one(s)); });
  if (c.wkt) html.push(`<details open><summary>WKT2</summary><pre>${esc(c.wkt)}</pre></details>`);
  $("tab-crs").innerHTML = html.join("");
}

function histSvg(hist, label, fmtEdge = (v) => fmt(v, 0)) {
  const { edges, counts } = hist;
  const w = 360, h = 56, pad = 2;
  const max = Math.max(...counts, 1);
  const bw = (w - 2 * pad) / counts.length;
  const bars = counts.map((c, i) => `<rect x="${(pad + i * bw).toFixed(1)}" y="${(h - 12 - ((h - 14) * c) / max).toFixed(1)}" width="${Math.max(bw - 0.5, 0.5).toFixed(1)}" height="${(((h - 14) * c) / max).toFixed(1)}"/>`).join("");
  return `<svg class="hist" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><title>${esc(label)}</title>${bars}<text x="${pad}" y="${h - 2}">${esc(fmtEdge(edges[0]))}</text><text x="${w - pad}" y="${h - 2}" text-anchor="end">${esc(fmtEdge(edges[edges.length - 1]))}</text></svg>`;
}

function renderStats(s) {
  const html = [];
  const ranged = (r, digits = 2) => kvTable([["min / max", `${fmt(r.min, digits)} / ${fmt(r.max, digits)}`], ["mean / std", `${fmt(r.mean, digits)} / ${fmt(r.std, digits)}`],
    ["percentiles", Object.entries(r.percentiles || {}).map(([p, v]) => `p${p} ${fmt(v, digits)}`).join(", ") + (r.percentiles_note ? ` <span class="d">(${esc(r.percentiles_note)})</span>` : "")]]);
  if (s.files) html.push("<h4>Files</h4>", `<table class="grid"><tr><th>file</th><th>points</th></tr>${s.files.map((f) => `<tr><td class="nm">${esc(f.name)}</td><td>${fmtInt(f.count)}</td></tr>`).join("")}</table>`);
  html.push("<h4>Points</h4>", kvTable([["count", fmtInt(s.point_count)], ["density", s.density_per_m2 ? `${fmt(s.density_per_m2, 2)} pts/m2${s.density_note ? ` (${esc(s.density_note)})` : ""}` : "-"],
    ["ground points", `${fmtInt(s.ground_points)} (${s.ground_density_per_m2 ? fmt(s.ground_density_per_m2, 2) : "-"} pts/m2)`],
    ["bounds min", s.bounds.min.map((v) => fmt(v, 2)).join(", ")], ["bounds max", s.bounds.max.map((v) => fmt(v, 2)).join(", ")]]));
  html.push("<h4>Classification</h4>", `<table class="grid"><tr><th>code</th><th>name</th><th>count</th><th>%</th></tr>${s.classification.map((r) => `<tr><td><span class="sw" style="background:rgb(${r.color.join(",")})"></span>${r.value}</td><td class="nm">${esc(r.name)}</td><td>${fmtInt(r.count)}</td><td>${(100 * r.fraction).toFixed(2)}</td></tr>`).join("")}</table>`);
  html.push("<h4>Elevation (z)</h4>", ranged(s.z), histSvg(s.z.histogram, "z"));
  html.push("<h4>Intensity</h4>", ranged(s.intensity, 0), histSvg(s.intensity.histogram, "intensity"));
  const countTable = (rows, head) => `<table class="grid"><tr><th>${head}</th><th>count</th><th>%</th></tr>${rows.map((r) => `<tr><td>${r.value}</td><td>${fmtInt(r.count)}</td><td>${(100 * r.fraction).toFixed(2)}</td></tr>`).join("")}</table>`;
  html.push("<h4>Returns</h4>", countTable(s.return_number, "return number"), countTable(s.number_of_returns, "number of returns"));
  if (s.gps_time) {
    const g = s.gps_time;
    html.push("<h4>GPS time</h4>", kvTable([["type", g.type === "standard" ? "adjusted standard GPS time" : "GPS week time"], ["min / max", `${fmt(g.min, 3)} / ${fmt(g.max, 3)}`], ["span", `${fmt(g.span_seconds, 1)} s (${fmt(g.span_seconds / 60, 1)} min)`],
      ["UTC", g.min_utc ? `${esc(g.min_utc)}<br>${esc(g.max_utc)}<br><span class="d">(${g.leap_seconds_assumed} leap seconds assumed)</span>` : "week time, no date"]]), histSvg(g.histogram, "gps time", (v) => fmt(v - g.min, 0) + " s"));
  }
  html.push("<h4>Scan angle (deg)</h4>", ranged(s.scan_angle_deg, 2), histSvg(s.scan_angle_deg.histogram, "scan angle", (v) => fmt(v, 1)));
  html.push("<h4>Point source ids</h4>", kvTable([["distinct", s.point_source_id_unique]]), countTable(s.point_source_id, "point source id"));
  if (s.scanner_channel) html.push("<h4>Scanner channel</h4>", countTable(s.scanner_channel, "channel"));
  html.push("<h4>Flags</h4>", kvTable(Object.entries(s.flags).map(([k, v]) => [k.replace(/_/g, " "), fmtInt(v)])));
  html.push("<h4>User data</h4>", countTable(s.user_data, "value"));
  if (s.rgb) html.push("<h4>RGB</h4>", ...Object.entries(s.rgb).map(([k, r]) => `<div class="d">${k}</div>` + ranged(r, 0)));
  if (s.nir) html.push("<h4>NIR</h4>", ranged(s.nir, 0));
  $("tab-stats").innerHTML = html.join("");
}

// ---------------------------------------------------------------------------

loadFiles().catch((err) => setStatus(`could not list files: ${err.message}`));

// A handle for debugging from the console.
window.lpcview = { pickAt, cloud, cam, lod, uniforms, fitView, topView, eyeLevel, startLoad, pickBuffer, get cells() { return cellGroup; }, renderer, scene, camera };
