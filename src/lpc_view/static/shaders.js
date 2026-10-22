// lpc_view: the GLSL sources, the colour tables as a texture, and the two
// materials (display and pick) that share one set of uniforms.
//
// three.js comes in as an argument of createShading, not as an import, so the
// module loads in Node (rampData is pure).

import { TURBO, VIRIDIS } from "./colormaps.js";

export const COLOR_FUNCS = /* glsl */ `
// uRampTex: row 0 turbo, row 1 viridis (static/colormaps.js has the tables and their licences).
vec3 turbo(float x) {
  return texture(uRampTex, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.25)).rgb;
}
vec3 viridis(float t) {
  return texture(uRampTex, vec2((clamp(t, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.75)).rgb;
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

export const VERTEX_COMMON = /* glsl */ `
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
uniform sampler2D uRampTex;
uniform float uPickSize;
uniform float uMaxSize;
uniform int uCellId;
uniform int uLocalBits;
uniform float uOcclude;
uniform float uOccSplat;

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

export const VERTEX_SHADER = /* glsl */ `
${VERTEX_COMMON}
${COLOR_FUNCS}
out vec3 vColor;
out float vSize;
out float vViewZ;

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
  if (hiddenPoint()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vSize = 0.0; vColor = vec3(0.0); vViewZ = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vSize = pointSizeFor(mv, uSize);
  gl_PointSize = vSize;
  vViewZ = -mv.z;
  vColor = shade();
}
`;

// The occlusion test for fragment shaders: with uOcclude on, a fragment farther than
// the depth surface at its pixel by more than the tolerance is discarded. The
// tolerance is a fixed distance plus a share of the surface's distance, which also
// absorbs the depth buffer's coarseness far from the camera.
export const OCCLUSION_FRAGMENT = /* glsl */ `
uniform float uOcclude;
uniform sampler2D uDepthTex;
uniform vec2 uViewport;
uniform vec2 uNearFar;
uniform float uOccTol;
uniform float uOccFrac;
float surfaceDepth() {
  float d = texture(uDepthTex, gl_FragCoord.xy / uViewport).r;
  return (uNearFar.x * uNearFar.y) / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
}
bool behindSurface(float viewZ) {
  if (uOcclude < 0.5) return false;
  float s = surfaceDepth();
  return viewZ > s + uOccTol + uOccFrac * s;
}
`;

export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
${OCCLUSION_FRAGMENT}
in vec3 vColor;
in float vSize;
in float vViewZ;
out vec4 outColor;
void main() {
  if (vSize > 2.5) { vec2 c = gl_PointCoord - 0.5; if (dot(c, c) > 0.25) discard; }
  if (behindSurface(vViewZ)) discard;
  outColor = vec4(vColor, 1.0);
}
`;

// The occluder pass: every drawn point as a round splat of uOccSplat pixels, depth only.
export const OCCLUDER_VERTEX = /* glsl */ `
${VERTEX_COMMON}
void main() {
  if (hiddenPoint()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uOccSplat;
}
`;

export const OCCLUDER_FRAGMENT = /* glsl */ `
precision highp float;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  outColor = vec4(1.0);
}
`;

export const PICK_VERTEX = /* glsl */ `
${VERTEX_COMMON}
flat out vec4 vPick;
out float vViewZ;
void main() {
  if (hiddenPoint()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vPick = vec4(1.0); vViewZ = 0.0; return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vViewZ = -mv.z;
  gl_PointSize = max(pointSizeFor(mv, uSize), uPickSize);
  // The pick colour is the cell id in the high bits and the index in the cell below.
  uint id = (uint(uCellId) << uint(uLocalBits)) | uint(gl_VertexID);
  vPick = vec4(float(id & 255u), float((id >> 8u) & 255u), float((id >> 16u) & 255u), float(id >> 24u)) / 255.0;
}
`;

export const PICK_FRAGMENT = /* glsl */ `
precision highp float;
${OCCLUSION_FRAGMENT}
flat in vec4 vPick;
in float vViewZ;
out vec4 outColor;
void main() { if (behindSurface(vViewZ)) discard; outColor = vPick; }
`;

// The colour ramps as one RGBA texture: row 0 turbo, row 1 viridis, RGBA so that
// the rows are 4-byte aligned.
export function rampData(turbo = TURBO, viridis = VIRIDIS) {
  const data = new Uint8Array(256 * 2 * 4);
  for (let i = 0; i < 256; i++) {
    data.set([turbo[3 * i], turbo[3 * i + 1], turbo[3 * i + 2], 255], 4 * i);
    data.set([viridis[3 * i], viridis[3 * i + 1], viridis[3 * i + 2], 255], 4 * (256 + i));
  }
  return data;
}

// The textures, uniforms and materials the cells draw and pick with.
export function createShading(THREE) {
  const classTexData = new Uint8Array(256 * 4);
  const classTex = new THREE.DataTexture(classTexData, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  const rampTex = new THREE.DataTexture(rampData(), 256, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  rampTex.magFilter = THREE.LinearFilter;
  rampTex.minFilter = THREE.LinearFilter;
  rampTex.needsUpdate = true;
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
    uRampTex: { value: rampTex },
    uPickSize: { value: 7 },
    uMaxSize: { value: 8 },
    uCellId: { value: 0 },
    uLocalBits: { value: 32 },
    // Occlusion (occlusion.js): off until the toggle; the depth texture is made on first use.
    uOcclude: { value: 0 },
    uOccSplat: { value: 5 },
    uOccTol: { value: 1.0 },
    uOccFrac: { value: 0.01 },
    uDepthTex: { value: null },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(0.2, 100000) },
  };

  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX_SHADER, fragmentShader: FRAGMENT_SHADER, glslVersion: THREE.GLSL3,
  });
  const pickMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: PICK_VERTEX, fragmentShader: PICK_FRAGMENT, glslVersion: THREE.GLSL3, blending: THREE.NoBlending,
  });
  const occluderMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: OCCLUDER_VERTEX, fragmentShader: OCCLUDER_FRAGMENT, glslVersion: THREE.GLSL3,
    blending: THREE.NoBlending, colorWrite: false,
  });
  return { uniforms, material, pickMaterial, occluderMaterial, classTex, classTexData, rampTex };
}
