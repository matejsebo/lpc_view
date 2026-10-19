// lpcview: the browser side. Streams a point cloud from the local server into one
// preallocated geometry, draws it with a colour-mode shader, flies a camera through
// it, picks points on the GPU and shows the file's metadata.

import * as THREE from "three";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const canvas = $("view");
const ui = {
  fileSelect: $("file-select"),
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
in vec3 rgb;
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
    s = base * clamp(60.0 / d, 0.6, 3.0);
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
  float id = float(gl_VertexID);
  vPick = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), mod(floor(id / 65536.0), 256.0), floor(id / 16777216.0)) / 255.0;
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
};

const material = new THREE.ShaderMaterial({
  uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER, glslVersion: THREE.GLSL3,
});
const pickMaterial = new THREE.ShaderMaterial({
  uniforms, vertexShader: PICK_VERTEX, fragmentShader: PICK_FRAGMENT, glslVersion: THREE.GLSL3, blending: THREE.NoBlending,
});
const pickTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
const pickBuffer = new Uint8Array(4);

let points = null;       // THREE.Points
let geometry = null;     // its BufferGeometry
let boundsHelper = null;
let marker = null;
const cloud = {          // the loaded cloud's arrays and bookkeeping
  fileId: null, meta: null, stats: null, center: [0, 0, 0], count: 0, budget: 0, loaded: 0,
  hasRgb: false, hasTime: false, arrays: null,
};
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
  return { min: s.bounds.min.map((v, i) => v - c[i]), max: s.bounds.max.map((v, i) => v - c[i]) };
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
  if (!cloud.arrays) return;
  const { pos, cls } = cloud.arrays;
  const n = cloud.loaded;
  let best = -Infinity, bestAny = -Infinity;
  const r2 = 9;
  for (let i = 0; i < n; i++) {
    const dx = pos[3 * i] - cam.pos.x, dy = pos[3 * i + 1] - cam.pos.y;
    if (dx * dx + dy * dy > r2) continue;
    const z = pos[3 * i + 2];
    if (z > bestAny) bestAny = z;
    if (cls[i] === 2 && z > best) best = z;
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

let lastT = performance.now(), frames = 0, fpsT = lastT;
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  stepCamera(dt);
  applyCamera();
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
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

async function pickAt(cx, cy) {
  if (!points || cloud.loaded === 0) return;
  const rect = canvas.getBoundingClientRect();
  const x = (cx - rect.left) * renderer.getPixelRatio();
  const y = (cy - rect.top) * renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2()).multiplyScalar(renderer.getPixelRatio());
  camera.setViewOffset(size.x, size.y, Math.floor(x), Math.floor(y), 1, 1);
  const keepMat = points.material;
  points.material = pickMaterial;
  const markerVisible = marker.visible;
  marker.visible = false;
  if (boundsHelper) boundsHelper.visible = false;
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0xffffff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickBuffer);
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x0b0e14, 1);
  camera.clearViewOffset();
  points.material = keepMat;
  marker.visible = markerVisible;
  if (boundsHelper) boundsHelper.visible = ui.bounds.checked;
  const id = pickBuffer[0] + pickBuffer[1] * 256 + pickBuffer[2] * 65536 + pickBuffer[3] * 16777216;
  if (id === 0xffffffff || id >= cloud.loaded) { showPoint(null); return; }
  const { pos } = cloud.arrays;
  marker.position.set(pos[3 * id], pos[3 * id + 1], pos[3 * id + 2]);
  marker.visible = true;
  showPoint({ loadingIndex: id });
  try {
    const r = await fetch(`/api/point?file=${cloud.fileId}&i=${id}`);
    const rec = await r.json();
    if (rec.error) throw new Error(rec.error);
    showPoint(rec);
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

async function loadFiles() {
  const files = await fetchJson("/api/files");
  ui.fileSelect.innerHTML = files.map((f) => `<option value="${f.id}">${esc(f.name)} (${fmtInt(f.point_count)} pts, LAS ${esc(f.version)} pf${f.point_format})</option>`).join("");
  const wanted = new URLSearchParams(location.search).get("file");
  if (wanted !== null && files.some((f) => String(f.id) === wanted)) ui.fileSelect.value = wanted;
  await showMetadata(Number(ui.fileSelect.value));
}
ui.fileSelect.addEventListener("change", () => showMetadata(Number(ui.fileSelect.value)));

async function showMetadata(fileId) {
  try {
    const meta = await fetchJson(`/api/meta?file=${fileId}`);
    renderHeader(meta, fileId);
    renderVlrs(meta);
    renderCrs(meta);
    if (cloud.fileId !== fileId) {
      $("tab-stats").innerHTML = "<em>load the file to compute its statistics</em>";
    }
    setStatus(`${fmtInt(meta.header.point_count)} points, ${(meta.file.size_bytes / 1048576).toFixed(1)} MB; press Load`);
  } catch (err) {
    setStatus(`metadata failed: ${err.message}`);
  }
}

ui.loadBtn.addEventListener("click", () => startLoad(Number(ui.fileSelect.value)));
ui.stopBtn.addEventListener("click", () => loading && loading.abort());

function disposeCloud() {
  if (points) { scene.remove(points); geometry.dispose(); points = null; geometry = null; }
  if (boundsHelper) { scene.remove(boundsHelper); boundsHelper = null; }
  marker.visible = false;
  cloud.arrays = null; cloud.loaded = 0; cloud.count = 0; cloud.stats = null;
}

async function startLoad(fileId) {
  if (loading) loading.abort();
  const ctl = new AbortController();
  loading = ctl;
  ui.loadBtn.disabled = true; ui.stopBtn.disabled = false;
  setProgress(0);
  try {
    setStatus("decoding the file on the server (LAZ takes a while)...");
    const info = await fetchJson(`/api/load?file=${fileId}`, ctl.signal);
    if (ctl.signal.aborted) return;
    disposeCloud();
    cloud.fileId = fileId;
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
      const r = await fetch(`/api/points?file=${fileId}&start=${start}&count=${n}`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`chunk ${start}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (ctl.signal.aborted) return;
      ingest(buf, start);
      setProgress(cloud.loaded / cloud.budget);
      setStatus(`${fmtInt(cloud.loaded)} of ${fmtInt(cloud.budget)} points loaded`);
    }
    setStatus(`${fmtInt(cloud.loaded)} points loaded${cloud.loaded < cloud.count ? ` (a uniform sample of ${fmtInt(cloud.count)})` : ""}`);
  } catch (err) {
    if (err.name === "AbortError") setStatus(`stopped at ${fmtInt(cloud.loaded)} points`);
    else { setStatus(`load failed: ${err.message}`); console.error(err); }
  } finally {
    if (loading === ctl) loading = null;
    ui.loadBtn.disabled = false; ui.stopBtn.disabled = true;
  }
}

function allocate(n, stats) {
  const a = {
    pos: new Float32Array(3 * n),
    intensity: new Uint16Array(n),
    cls: new Uint8Array(n),
    ret: new Uint8Array(n),
    nret: new Uint8Array(n),
    psid: new Uint16Array(n),
    angle: new Float32Array(n),
    time: new Float32Array(n),
    flags: new Uint8Array(n),
    rgb: stats.rgb ? new Uint8Array(3 * n) : new Uint8Array(3),
  };
  cloud.arrays = a;
  cloud.hasRgb = !!stats.rgb;
  geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(a.pos, 3));
  geometry.setAttribute("intensity", new THREE.BufferAttribute(a.intensity, 1, true));
  geometry.setAttribute("classification", new THREE.BufferAttribute(a.cls, 1));
  geometry.setAttribute("returnNumber", new THREE.BufferAttribute(a.ret, 1));
  geometry.setAttribute("numReturns", new THREE.BufferAttribute(a.nret, 1));
  geometry.setAttribute("pointSource", new THREE.BufferAttribute(a.psid, 1));
  geometry.setAttribute("scanAngle", new THREE.BufferAttribute(a.angle, 1));
  geometry.setAttribute("gpsTime", new THREE.BufferAttribute(a.time, 1));
  geometry.setAttribute("flags", new THREE.BufferAttribute(a.flags, 1));
  // Without RGB in the file, one grey for every vertex keeps the shader uniform.
  geometry.setAttribute("rgb", new THREE.BufferAttribute(stats.rgb ? a.rgb : new Uint8Array(3 * n).fill(200), 3, true));
  for (const name of Object.keys(geometry.attributes)) geometry.getAttribute(name).setUsage(THREE.DynamicDrawUsage);
  geometry.setDrawRange(0, 0);
  const e = extent();
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(e.max[0] - e.min[0], e.max[1] - e.min[1], e.max[2] - e.min[2]));
  points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);
  const box = new THREE.Box3(new THREE.Vector3(...e.min), new THREE.Vector3(...e.max));
  boundsHelper = new THREE.Box3Helper(box, 0x3a4560);
  boundsHelper.visible = ui.bounds.checked;
  scene.add(boundsHelper);
  ui.mode.querySelector('option[value="8"]').disabled = !stats.rgb;
  if (!stats.rgb && ui.mode.value === "8") { ui.mode.value = "0"; uniforms.uMode.value = 0; }
}

function ingest(buf, start) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "LPC1") throw new Error("bad chunk");
  const n = dv.getUint32(4, true);
  const hasRgb = dv.getUint8(8) === 1;
  let off = 12;
  const a = cloud.arrays;
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
  a.pos.set(pos, 3 * start);
  a.intensity.set(intensity, start);
  a.cls.set(cls, start);
  a.ret.set(ret, start);
  a.nret.set(nret, start);
  a.psid.set(psid, start);
  a.angle.set(angle, start);
  a.time.set(time, start);
  a.flags.set(flags, start);
  if (hasRgb && cloud.hasRgb) a.rgb.set(take(Uint8Array, 3 * n), 3 * start);
  for (const [name, items] of [["position", 3], ["intensity", 1], ["classification", 1], ["returnNumber", 1], ["numReturns", 1], ["pointSource", 1], ["scanAngle", 1], ["gpsTime", 1], ["flags", 1], ["rgb", 3]]) {
    const attr = geometry.getAttribute(name);
    if (name === "rgb" && !cloud.hasRgb) continue;
    attr.addUpdateRange(start * items, n * items);
    attr.needsUpdate = true;
  }
  cloud.loaded = start + n;
  geometry.setDrawRange(0, cloud.loaded);
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
    ["percentiles", Object.entries(r.percentiles).map(([p, v]) => `p${p} ${fmt(v, digits)}`).join(", ")]]);
  html.push("<h4>Points</h4>", kvTable([["count", fmtInt(s.point_count)], ["density", s.density_per_m2 ? `${fmt(s.density_per_m2, 2)} pts/m2` : "-"],
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
window.lpcview = { pickAt, cloud, cam, uniforms, fitView, topView, eyeLevel, startLoad, pickBuffer, get points() { return points; }, renderer, scene, camera };
