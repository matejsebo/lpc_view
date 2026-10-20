// lpc_view: the fly camera (keys, drag and pointer lock) and the fit, top and
// eye-level views.
//
// three.js comes in as an argument of createFlyCamera, not as an import, so the
// pure pose maths above it loads in Node.

import { extentOf } from "./cells.js";

export function forwardOf(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.cos(yaw) * cp, Math.sin(pitch)];
}
export function rightOf(yaw) { return [Math.cos(yaw), -Math.sin(yaw), 0]; }
export function clampSpeed(v) { return Math.min(2000, Math.max(0.1, v)); }

// The pose that frames the extent e from the south, looking down at it.
export function fitPose(e) {
  const ex = e.max[0] - e.min[0], ey = e.max[1] - e.min[1], ez = e.max[2] - e.min[2];
  const span = Math.max(ex, ey);
  return {
    pos: [(e.min[0] + e.max[0]) / 2, e.min[1] - span * 0.55, e.max[2] + span * 0.45],
    yaw: 0,
    pitch: -Math.atan2(span * 0.45 + ez * 0.5, span * 1.05),
    speed: Math.max(1, span / 20),
  };
}

// The pose that looks straight down on the extent e.
export function topPose(e) {
  return {
    pos: [(e.min[0] + e.max[0]) / 2, (e.min[1] + e.max[1]) / 2, e.max[2] + Math.max(e.max[0] - e.min[0], e.max[1] - e.min[1]) * 0.9],
    yaw: 0,
    pitch: -Math.PI / 2 + 0.001,
  };
}

// `actions` is filled by app.js once everything exists: pickAt, togglePanels,
// openFiles, setStatus; the key handler reaches them at event time.
export function createFlyCamera({ THREE, canvas, camera, ui, cloud, cells, actions }) {
  const cam = { pos: new THREE.Vector3(0, 0, 100), yaw: 0, pitch: -0.3, speed: 50 };
  const keys = new Set();
  let dragging = false, dragMoved = 0, dragLast = [0, 0], locked = false;
  const prevPose = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN };

  function forwardVector() { return new THREE.Vector3(...forwardOf(cam.yaw, cam.pitch)); }
  function rightVector() { return new THREE.Vector3(...rightOf(cam.yaw)); }
  function applyCamera() {
    camera.position.copy(cam.pos);
    camera.lookAt(cam.pos.clone().add(forwardVector()));
  }
  function setSpeed(v) {
    cam.speed = clampSpeed(v);
    ui.speed.value = Math.log10(cam.speed);
    ui.speedOut.textContent = cam.speed >= 10 ? `${cam.speed.toFixed(0)} m/s` : `${cam.speed.toFixed(1)} m/s`;
  }
  ui.speed.addEventListener("input", () => setSpeed(10 ** Number(ui.speed.value)));
  setSpeed(50);

  function extent() { return extentOf(cloud.stats, cloud.center); }
  function fitView() {
    const p = fitPose(extent());
    cam.pos.set(...p.pos); cam.yaw = p.yaw; cam.pitch = p.pitch;
    setSpeed(p.speed);
  }
  function topView() {
    const p = topPose(extent());
    cam.pos.set(...p.pos); cam.yaw = p.yaw; cam.pitch = p.pitch;
  }
  function eyeLevel() {
    // Stand 1.8 m above the highest ground point within 3 m; failing ground, any point.
    if (!cloud.grid) return;
    let best = -Infinity, bestAny = -Infinity;
    const r = 3, r2 = r * r;
    for (const cell of cells.cellsAround(cam.pos.x, cam.pos.y, r)) {
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
    if (ground === -Infinity) { actions.setStatus("no points within 3 m of the camera"); return; }
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
    if (locked) { actions.pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2); return; }
    if (dragging && dragMoved < 4 && e.target === canvas) actions.pickAt(e.clientX, e.clientY);
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
    else if (k === "h") actions.togglePanels();
    else if (k === "p") actions.pickAt(canvas.clientWidth / 2, canvas.clientHeight / 2);
    else if (k === "o") actions.openFiles();
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

  // Whether the pose changed since the last call (the LOD controller's "moving").
  function cameraMoved() {
    const p = cam.pos;
    const moved = p.x !== prevPose.x || p.y !== prevPose.y || p.z !== prevPose.z || cam.yaw !== prevPose.yaw || cam.pitch !== prevPose.pitch;
    prevPose.x = p.x; prevPose.y = p.y; prevPose.z = p.z; prevPose.yaw = cam.yaw; prevPose.pitch = cam.pitch;
    return moved;
  }

  return { cam, keys, forwardVector, applyCamera, setSpeed, extent, fitView, topView, eyeLevel, stepCamera, cameraMoved };
}
