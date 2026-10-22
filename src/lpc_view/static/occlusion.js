// Hiding points behind relief. A point cloud has gaps between its points, so the
// depth test alone lets a hill's far side show through its near side. Before the
// main pass, when the toggle is on, the cloud is drawn once more as fat depth-only
// splats into a half-resolution depth texture: the splats close the gaps and the
// texture becomes the nearest surface at every pixel. The main and pick shaders
// then discard any point that lies behind that surface by more than a tolerance
// (a fixed part plus a share of the distance, which also covers the depth
// buffer's own coarseness far away). Off by default; when off, nothing here runs.
//
// Pure helpers (no three.js) are at the top so the tests can load them in Node.

// A perspective depth buffer value (0..1) back to a positive view-space distance,
// the same formula as three's perspectiveDepthToViewZ, sign flipped.
export function linearDepth(d, near, far) {
  return (near * far) / (far - d * (far - near));
}

// Is a point at view distance z hidden by a surface at distance s?
export function occluded(z, s, tolerance = 1.0, fraction = 0.01) {
  return z > s + tolerance + fraction * s;
}

// splatPx: splat diameter in the half-resolution target; tolerance and fraction: the
// discard margin (metres, share of distance); scale: the target's size relative to
// the view; drawShare: the share of each cell's drawn points the occluder pass uses
// (fewer, fatter splats close the same surface for less vertex work).
export const DEFAULTS = { splatPx: 6, tolerance: 1.0, fraction: 0.01, scale: 0.5, drawShare: 0.5 };

export function createOcclusion({ THREE, renderer, scene, camera, shading, cells, marker }) {
  const { uniforms, occluderMaterial } = shading;
  const params = { ...DEFAULTS };
  let enabled = false;
  let target = null;

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

  // Draw the depth surface for this frame; called before the main render.
  function render() {
    if (!enabled || !cells.group) { uniforms.uOcclude.value = 0; return; }
    ensureTarget();
    uniforms.uOccSplat.value = params.splatPx;
    uniforms.uOccTol.value = params.tolerance;
    uniforms.uOccFrac.value = params.fraction;
    uniforms.uNearFar.value.set(camera.near, camera.far);
    const markerVisible = marker.visible;
    marker.visible = false;
    const bounds = cells.boundsHelper;
    const boundsVisible = bounds ? bounds.visible : false;
    if (bounds) bounds.visible = false;
    uniforms.uOcclude.value = 0;              // the occluder pass itself must not be culled by the last frame's surface
    scene.overrideMaterial = occluderMaterial;
    const ranges = [];
    if (params.drawShare < 1) {
      for (const p of cells.group.children) {
        const r = p.geometry.drawRange;
        ranges.push([p.geometry, r.count]);
        p.geometry.setDrawRange(0, Math.floor(r.count * params.drawShare));
      }
    }
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    for (const [g, count] of ranges) g.setDrawRange(0, count);
    renderer.setRenderTarget(null);
    scene.overrideMaterial = null;
    marker.visible = markerVisible;
    if (bounds) bounds.visible = boundsVisible;
    uniforms.uOcclude.value = 1;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) uniforms.uOcclude.value = 0;
  }

  return { params, render, setEnabled, get enabled() { return enabled; }, get target() { return target; } };
}
