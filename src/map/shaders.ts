const HEAT_GLSL = `
vec3 depthHeat(float depthMeters) {
  float d = clamp(depthMeters, 0.0, 82.0);
  vec3 lake = vec3(0.23, 0.67, 1.0);
  vec3 cyan = vec3(0.10, 0.97, 0.80);
  vec3 ember = vec3(1.0, 0.37, 0.13);
  if (d < 31.0) {
    return mix(lake, cyan, smoothstep(5.0, 31.0, d));
  }
  return mix(cyan, ember, smoothstep(33.0, 68.0, d));
}
`;

export const TUBE_VERTEX = `
precision highp float;

attribute float aProgress;
attribute float aFeature;
attribute float aSeed;

uniform float uExpand;

varying vec3 vLocal;
varying vec3 vNormalLocal;
varying float vProgress;
varying float vFeature;
varying float vSeed;

void main() {
  vLocal = position;
  vNormalLocal = normal;
  vProgress = aProgress;
  vFeature = aFeature;
  vSeed = aSeed;

  vec3 expanded = position + normal * uExpand;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(expanded, 1.0);
}
`;

export const TUBE_FRAGMENT = `
precision highp float;

${HEAT_GLSL}

uniform float uTime;
uniform float uScan;
uniform float uRadius;
uniform float uSelected;
uniform float uHovered;
uniform float uOpacity;
uniform float uGlow;
uniform float uOpen;
uniform vec3 uAccent;

varying vec3 vLocal;
varying vec3 vNormalLocal;
varying float vProgress;
varying float vFeature;
varying float vSeed;

void main() {
  float depth = clamp(-vLocal.z, 0.0, 86.0);
  float radial = length(vLocal.xy);
  // Wide "city overview" radius and the tighter surgical cut are blended by
  // uOpen: near the surface nothing is masked away so the whole loaded network
  // is readable, and as the cut deepens the cylinder closes in.
  float outer = 1.0 - smoothstep(uRadius - 3.0, uRadius + 3.5, radial);
  float slice = mix(1.0, outer, smoothstep(0.12, 0.72, uOpen));
  float reveal = 1.0 - smoothstep(uScan + 1.0, uScan + 10.0, depth);
  float surfaceGate = smoothstep(2.0, 12.0, uScan);
  float visibility = slice * reveal * surfaceGate;

  if (visibility < 0.012) discard;

  vec3 base = depthHeat(depth);
  float topLight = clamp(vNormalLocal.z * 0.5 + 0.64, 0.25, 1.0);
  float packet = pow(fract(vProgress * (19.0 + vSeed * 11.0) - uTime * (0.17 + vSeed * 0.22)), 14.0);
  float ember = 0.5 + 0.5 * sin(uTime * 1.15 + vProgress * 34.0 + vSeed * 17.0);
  float selected = 1.0 - step(0.5, abs(vFeature - uSelected));
  float hovered = 1.0 - step(0.5, abs(vFeature - uHovered));
  float scanBand = exp(-pow((depth - uScan) / 2.8, 2.0));
  float rim = exp(-pow((radial - uRadius) / 2.7, 2.0));

  vec3 color = base * (0.58 + 0.38 * topLight);
  color += base * packet * (0.78 + ember * 0.3);
  color += vec3(0.70, 1.0, 0.94) * packet * packet * 0.18;
  color += base * scanBand * 0.36;
  color += uAccent * rim * 0.42;
  color = mix(color, vec3(1.0, 0.96, 0.82), selected * 0.44 + hovered * 0.24);

  float alpha;
  if (uGlow > 0.5) {
    alpha = uOpacity * visibility * (0.12 + packet * 0.33 + scanBand * 0.16) * (0.5 + topLight * 0.5);
  } else {
    alpha = uOpacity * visibility * (0.62 + packet * 0.35 + scanBand * 0.12) * (0.58 + topLight * 0.42);
  }
  alpha += rim * 0.22 * visibility;
  alpha *= 1.0 + selected * 0.75 + hovered * 0.34;
  alpha = clamp(alpha, 0.0, 1.0);

  if (alpha < 0.006) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

export const GROUND_VERTEX = `
precision highp float;

uniform float uRadius;

varying vec2 vLocal;

void main() {
  // The mesh is a unit quad scaled by the aperture at draw time, so expand the
  // varying back into metres before the fragment stage reasons about grids.
  vLocal = position.xy * uRadius;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const GROUND_FRAGMENT = `
precision highp float;

uniform float uTime;
uniform float uScan;
uniform float uRadius;
uniform float uOpen;
uniform float uReveal;
uniform vec3 uAccent;

varying vec2 vLocal;

float lineGrid(vec2 point, float spacing, float width) {
  vec2 q = abs(fract(point / spacing - 0.5) - 0.5) * spacing;
  float distanceToLine = min(q.x, q.y);
  return 1.0 - smoothstep(0.0, width, distanceToLine);
}

float ringGrid(float radius, float spacing, float width) {
  float q = abs(fract(radius / spacing - 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(0.0, width, q);
}

void main() {
  vec2 metric = vLocal;
  float radial = length(metric);
  float inside = 1.0 - smoothstep(uRadius - 4.0, uRadius + 4.0, radial);

  // The plane is scaled to exactly the aperture, so anything outside it simply
  // does not exist. Discarding here is what keeps the basemap visible.
  if (inside <= 0.001) discard;

  float aperture = inside * uOpen;
  // Decorative density has to fall away at city scale, otherwise the grid turns
  // into a black sheet over the whole viewport.
  float scaleFade = 1.0 - smoothstep(900.0, 2600.0, uRadius);

  float minor = lineGrid(metric, 40.0, 0.9);
  float major = lineGrid(metric, 200.0, 1.7);
  float rings = ringGrid(radial, 80.0, 1.25) * inside;
  float angle = atan(metric.y, metric.x);
  float sweep = pow(max(0.0, cos(angle - uTime * 0.34)), 22.0) * inside * uOpen;
  float rim = exp(-pow((radial - uRadius) / 7.0, 2.0));
  float rimOuter = exp(-pow((radial - uRadius - 18.0) / 1.5, 2.0));
  float crossX = 1.0 - smoothstep(0.0, 0.9, abs(metric.x));
  float crossY = 1.0 - smoothstep(0.0, 0.9, abs(metric.y));
  float crosshair = (crossX + crossY) * inside * uOpen;

  float depthCore = 1.0 - smoothstep(0.0, uRadius, radial);
  float baseAlpha = mix(0.0, (0.12 + depthCore * 0.08) * scaleFade, uOpen) * inside;
  float spokes = pow(abs(sin(angle * 12.0 + uTime * 0.025)), 80.0) * aperture;

  vec3 color = vec3(0.004, 0.012, 0.015);
  float structure = minor * 0.1 + major * 0.22 + rings * 0.09 + sweep * 0.34 + spokes * 0.1;
  color = mix(color, uAccent, clamp(structure * (0.55 + 0.45 * inside), 0.0, 0.7));
  color += uAccent * rim * (0.30 + 0.15 * sin(uTime * 1.5));
  color += uAccent * rimOuter * 0.16;
  color += uAccent * crosshair * 0.06;

  float alpha = baseAlpha;
  alpha += (minor * 0.02 + major * 0.05 + rings * 0.022 + sweep * 0.03 + spokes * 0.02)
    * (0.2 + 0.8 * uOpen) * inside * scaleFade;
  alpha += rim * (0.34 + 0.12 * sin(uTime * 1.5)) * uOpen;
  alpha += rimOuter * 0.12 * uOpen;
  alpha += crosshair * 0.02 * uOpen;
  alpha = clamp(alpha, 0.0, 0.42);

  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha * uReveal);
}
`;

export const SCAN_VERTEX = `
precision highp float;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SCAN_FRAGMENT = `
precision highp float;

uniform float uTime;
uniform float uOpen;
uniform vec3 uAccent;
uniform float uScan;

varying vec2 vUv;

void main() {
  vec2 point = (vUv - 0.5) * 2.0;
  float radial = length(point);
  if (radial > 1.0) discard;
  float angle = atan(point.y, point.x);
  float rings = pow(abs(sin(radial * 25.0)), 34.0);
  float sweep = pow(max(0.0, cos(angle - uTime * 0.8)), 40.0);
  float edge = smoothstep(0.92, 1.0, radial);
  float dashedRim = edge * step(0.36, fract(angle * 10.6 - uTime * 0.08));
  float focal = exp(-radial * 7.5);
  float alpha = (rings * 0.05 + sweep * 0.12 + dashedRim * 0.48 + focal * 0.15) * uOpen;
  alpha *= smoothstep(1.0, 0.84, radial);
  vec3 color = mix(uAccent * 0.65, vec3(0.82, 1.0, 0.98), dashedRim * 0.8 + focal * 0.4);
  if (uScan < 4.0) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

export const SECTION_VERTEX = `
precision highp float;

uniform float uRadius;

varying vec2 vSectionUv;

void main() {
  vSectionUv = uv;
  vec3 local = vec3(position.x * uRadius, 0.0, position.z * 80.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);
}
`;

export const SECTION_FRAGMENT = `
precision highp float;

${HEAT_GLSL}

uniform float uTime;
uniform float uOpen;
uniform float uScan;
uniform vec3 uAccent;

varying vec2 vSectionUv;

void main() {
  float depth = (1.0 - vSectionUv.y) * 80.0;
  vec3 base = depthHeat(depth);

  float contour = pow(abs(sin(depth * 0.314159)), 60.0);
  float microContour = pow(abs(sin(depth * 1.5708)), 160.0);
  float vertical = pow(abs(sin(vSectionUv.x * 3.14159 * 12.0)), 120.0);
  float scanLine = exp(-pow((depth - uScan) / 1.2, 2.0));
  float floorLine = smoothstep(0.014, 0.0, abs(vSectionUv.y));
  float topLine = smoothstep(0.985, 1.0, vSectionUv.y);
  float sideEdge = smoothstep(0.008, 0.0, abs(vSectionUv.x))
    + smoothstep(0.992, 1.0, vSectionUv.x);
  float band = 0.5 + 0.5 * sin(depth * 0.16 + vSectionUv.x * 5.0);

  vec3 color = base * (0.22 + contour * 0.38 + band * 0.08);
  color += uAccent * vertical * 0.16;
  color += mix(base, vec3(1.0, 0.98, 0.84), 0.55) * scanLine * 0.8;
  color += uAccent * (floorLine + topLine + sideEdge) * 0.32;

  float alpha = uOpen * (
    0.012
    + contour * 0.045
    + microContour * 0.018
    + vertical * 0.025
    + scanLine * 0.24
    + floorLine * 0.15
    + topLine * 0.14
    + sideEdge * 0.045
  );
  alpha *= 0.78 + 0.22 * sin(uTime * 0.6 + depth * 0.12);
  gl_FragColor = vec4(color, alpha);
}
`;

export const CAGE_VERTEX = `
precision highp float;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const CAGE_FRAGMENT = `
precision highp float;

uniform float uOpen;
uniform float uTime;
uniform float uScan;
uniform vec3 uAccent;
uniform float uRadius;

varying vec2 vUv;

void main() {
  float vertical = pow(abs(sin(vUv.x * 3.14159265 * 16.0)), 120.0);
  float horizontal = pow(abs(sin(vUv.y * 3.14159265 * 8.0)), 150.0);
  float topFade = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
  float scanPosition = 1.0 - uScan / 80.0;
  float scanLine = exp(-pow((vUv.y - scanPosition) * 22.0, 2.0));
  float alpha = ((vertical * 0.065 + horizontal * 0.04 + scanLine * 0.16) * topFade) * uOpen;
  alpha *= 0.72 + 0.28 * sin(uTime * 0.8 + vUv.x * 8.0);
  vec3 color = mix(uAccent * 0.45, vec3(0.75, 1.0, 0.95), scanLine);
  gl_FragColor = vec4(color, alpha);
}
`;

export const NODE_VERTEX = `
precision highp float;

attribute float aDepth;
attribute float aSeed;
attribute float aNodeIndex;

uniform float uTime;
uniform float uScan;
uniform float uRadius;
uniform float uPixelRatio;
uniform float uPointScale;

varying float vDepth;
varying float vSeed;
varying float vNodeIndex;
varying float vVisibility;

void main() {
  float radial = length(position.xy);
  float slice = 1.0 - smoothstep(uRadius - 4.0, uRadius + 3.0, radial);
  float reveal = 1.0 - smoothstep(uScan + 1.0, uScan + 9.0, aDepth);
  float surfaceGate = smoothstep(2.0, 12.0, uScan);
  vVisibility = slice * reveal * surfaceGate;
  vDepth = aDepth;
  vSeed = aSeed;
  vNodeIndex = aNodeIndex;

  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip;
  float pulse = 0.5 + 0.5 * sin(uTime * 2.1 + aSeed * 11.0);
  gl_PointSize = uPixelRatio * uPointScale * (15.0 + pulse * 8.0) * step(0.01, vVisibility);
}
`;

export const NODE_FRAGMENT = `
precision highp float;

${HEAT_GLSL}

uniform float uTime;
uniform float uSelectedNode;

varying float vDepth;
varying float vSeed;
varying float vNodeIndex;
varying float vVisibility;

void main() {
  if (vVisibility < 0.01) discard;
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radial = length(point);
  if (radial > 1.0) discard;

  float core = 1.0 - smoothstep(0.0, 0.22, radial);
  float ring = smoothstep(0.30, 0.43, radial) * (1.0 - smoothstep(0.47, 0.60, radial));
  float halo = pow(1.0 - radial, 3.0);
  float pulse = 0.5 + 0.5 * sin(uTime * 2.1 + vSeed * 11.0);
  float selected = 1.0 - step(0.5, abs(vNodeIndex - uSelectedNode));

  vec3 color = depthHeat(vDepth);
  color = mix(color, vec3(1.0, 0.98, 0.86), core * 0.55 + selected * 0.32);
  float alpha = (core * 0.82 + ring * (0.48 + pulse * 0.24) + halo * 0.16) * vVisibility;
  alpha *= 1.0 + selected * 0.6;
  gl_FragColor = vec4(color, alpha);
}
`;
