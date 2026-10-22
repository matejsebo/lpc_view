// Hiding points behind relief. The depth test alone lets a hill's far side show
// through the gaps between the near side's points. When the toggle is on, a
// terrain surface is built from the loaded points (the lowest point of every
// cell, ground-classified returns first, then eroded so that bumps narrower than
// the erosion radius, such as tree crowns, fall away) and drawn depth-only into a
// half-resolution depth texture before the main pass. The main and pick shaders
// discard any point behind that surface by more than a tolerance (a fixed part
// plus a share of the distance, which also covers the depth buffer's coarseness
// far away). Only the ground occludes: a tree behind a tree stays, a valley
// behind a ridge goes. Off by default; when off, nothing here runs.
//
// Pure helpers (no three.js, no DOM) are at the top so the tests load them in Node.

// A perspective depth buffer value (0..1) back to a positive view-space distance,
// the same formula as three's perspectiveDepthToViewZ, sign flipped.
export function linearDepth(d, near, far) {
  return (near * far) / (far - d * (far - near));
}

// Is a point at view distance z hidden by a surface at distance s?
export function occluded(z, s, tolerance = 1.0, fraction = 0.01) {
  return z > s + tolerance + fraction * s;
}

export const DEFAULTS = { cellM: 2, erodeCells: 2, tolerance: 1.0, fraction: 0.01, scale: 0.5 };
const NOISE_CLASSES = new Set([7, 18]);
const FLAG_WITHHELD = 4;

// The lowest point of every cellM square over `bounds` ({min:[x,y], max:[x,y]}),
// from the cells' arrays (each {arrays: {pos, cls, flags}, n}). Ground-classified
// points win where a cell has any; noise classes and withheld points never count.
// Cells with no point hold NaN.
export function buildHeightfield(cells, bounds, cellM = DEFAULTS.cellM) {
  const x0 = bounds.min[0], y0 = bounds.min[1];
  const w = Math.max(1, Math.ceil((bounds.max[0] - x0) / cellM));
  const h = Math.max(1, Math.ceil((bounds.max[1] - y0) / cellM));
  const zAll = new Float32Array(w * h).fill(Infinity);
  const zGround = new Float32Array(w * h).fill(Infinity);
  for (const c of cells) {
    const { pos, cls, flags } = c.arrays || c;
    const n = c.n ?? cls.length;
    for (let i = 0; i < n; i++) {
      const k = cls[i];
      if (NOISE_CLASSES.has(k) || (flags[i] & FLAG_WITHHELD)) continue;
      const ix = Math.floor((pos[3 * i] - x0) / cellM), iy = Math.floor((pos[3 * i + 1] - y0) / cellM);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const z = pos[3 * i + 2], at = iy * w + ix;
      if (z < zAll[at]) zAll[at] = z;
      if (k === 2 && z < zGround[at]) zGround[at] = z;
    }
  }
  const z = new Float32Array(w * h);
  let filled = 0;
  for (let i = 0; i < z.length; i++) {
    const v = zGround[i] < Infinity ? zGround[i] : zAll[i];
    z[i] = v < Infinity ? v : NaN;
    if (v < Infinity) filled++;
  }
  return { w, h, x0, y0, cellM, z, filled };
}

// Each cell becomes the minimum over the (2r+1)-square around it, ignoring holes:
// a bump narrower than 2r cells (a crown, a building) sinks to the ground beside
// it, while slopes and ridges wider than that keep their shape within r cells.
export function erodeMin(hf, r = DEFAULTS.erodeCells) {
  if (r <= 0) return hf;
  const { w, h, z } = hf;
  const pass = (src, dx, dy) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = Infinity;
        for (let k = -r; k <= r; k++) {
          const xx = x + k * dx, yy = y + k * dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = src[yy * w + xx];
          if (v === v && v < m) m = v;   // v === v: not NaN
        }
        out[y * w + x] = m < Infinity ? m : NaN;
      }
    }
    return out;
  };
  return { ...hf, z: pass(pass(z, 1, 0), 0, 1) };
}

// Triangle mesh data for a heightfield: vertices at cell centres, two triangles
// per square whose four corners all have heights.
export function heightfieldMesh(hf) {
  const { w, h, x0, y0, cellM, z } = hf;
  const positions = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      positions[3 * i] = x0 + (x + 0.5) * cellM;
      positions[3 * i + 1] = y0 + (y + 0.5) * cellM;
      positions[3 * i + 2] = z[i] === z[i] ? z[i] : 0;
    }
  }
  const index = [];
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      if ([a, b, c, d].some((i) => z[i] !== z[i])) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  return { positions, index: index.length > 65535 ? new Uint32Array(index) : new Uint16Array(index), triangles: index.length / 3 };
}

export function createOcclusion({ THREE, renderer, scene, camera, shading, cloud, marker }) {
  const { uniforms } = shading;
  const params = { ...DEFAULTS };
  let enabled = false;
  let target = null;
  let builtFor = -1;            // cloud.loaded the terrain was built from
  let builtGrid = null;
  const occScene = new THREE.Scene();
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  let terrain = null;
  const info = { cells: 0, filled: 0, triangles: 0, buildMs: 0 };

  function size() {
    const pr = renderer.getPixelRatio();
    const s = renderer.getSize(new THREE.Vector2());
    return [Math.max(1, Math.round(s.x * pr * params.scale)), Math.max(1, Math.round(s.y * pr * params.scale)), s.x * pr, s.y * pr];
  }

  function ensureTarget() {
    const [w, h, fw, fh] = size();
    if (!target) {
      const depthTexture = new THREE.DepthTexture(w, h);
      depthTexture.type = THREE.UnsignedIntType;
      target = new THREE.WebGLRenderTarget(w, h, { depthTexture, depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      uniforms.uDepthTex.value = depthTexture;
    } else if (target.width !== w || target.height !== h) {
      target.setSize(w, h);
    }
    uniforms.uViewport.value.set(fw, fh);
  }

  function extentOf() {
    const c = cloud.center, s = cloud.stats;
    return { min: [s.bounds.min[0] - c[0], s.bounds.min[1] - c[1]], max: [s.bounds.max[0] - c[0], s.bounds.max[1] - c[1]] };
  }

  function clearTerrain() {
    if (terrain) { occScene.remove(terrain); terrain.geometry.dispose(); terrain = null; }
    builtFor = -1; builtGrid = null;
  }

  // The terrain from the points loaded so far; called when the toggle goes on and
  // again when a load has grown the cloud.
  function build() {
    const grid = cloud.grid;
    if (!grid || !cloud.loaded) { clearTerrain(); return; }
    const t0 = performance.now();
    const cells = grid.cells.filter((c) => c.n && c.arrays);
    const hf = erodeMin(buildHeightfield(cells, extentOf(), params.cellM), params.erodeCells);
    const mesh = heightfieldMesh(hf);
    clearTerrain();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e9);
    terrain = new THREE.Mesh(g, depthOnly);
    terrain.frustumCulled = false;
    occScene.add(terrain);
    builtFor = cloud.loaded; builtGrid = grid;
    Object.assign(info, { cells: hf.w * hf.h, filled: hf.filled, triangles: mesh.triangles, buildMs: performance.now() - t0 });
  }

  // Draw the terrain's depth for this frame; called before the main render.
  function render() {
    if (!enabled || !cloud.grid || !cloud.loaded) { uniforms.uOcclude.value = 0; return; }
    if (cloud.grid !== builtGrid || cloud.loaded !== builtFor) build();
    if (!terrain) { uniforms.uOcclude.value = 0; return; }
    ensureTarget();
    uniforms.uOccTol.value = params.tolerance;
    uniforms.uOccFrac.value = params.fraction;
    uniforms.uNearFar.value.set(camera.near, camera.far);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(occScene, camera);
    renderer.setRenderTarget(null);
    uniforms.uOcclude.value = 1;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) uniforms.uOcclude.value = 0;
  }

  // Forget the terrain so the next frame rebuilds it (after changing params from the console).
  function rebuild() { clearTerrain(); }

  return { params, info, render, setEnabled, rebuild, get enabled() { return enabled; }, get target() { return target; }, get terrain() { return terrain; } };
}
