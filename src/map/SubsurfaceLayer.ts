import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl';
import * as THREE from 'three';
import type {
  FeatureKind,
  LngLat,
  SiteDataset,
  SubFeature,
  SubNode,
} from '../types';
import { depthColorRgb } from './palette';
import {
  CAGE_FRAGMENT,
  CAGE_VERTEX,
  GROUND_FRAGMENT,
  GROUND_VERTEX,
  NODE_FRAGMENT,
  NODE_VERTEX,
  SCAN_FRAGMENT,
  SCAN_VERTEX,
  SECTION_FRAGMENT,
  SECTION_VERTEX,
  TUBE_FRAGMENT,
  TUBE_VERTEX,
} from './shaders';

const EARTH_RADIUS = 6_378_137;
const RADIAL_SEGMENTS = 8;
const VERTICAL_EXAGGERATION = 2.2;
const DEFAULT_APERTURE = 760;

const KIND_RADIUS: Record<FeatureKind, number> = {
  subway: 3.5,
  tunnel: 2.95,
  water: 2.45,
  utility: 1.8,
};

const KIND_GLOW: Record<FeatureKind, number> = {
  subway: 4.9,
  tunnel: 4.1,
  water: 3.6,
  utility: 2.9,
};

export interface NodeProjection {
  node: SubNode;
  x: number;
  y: number;
  visible: boolean;
  inside: boolean;
  revealed: boolean;
  depth: number;
}

export interface PickResult {
  featureIndex: number;
  feature: SubFeature;
  screenX: number;
  screenY: number;
}

interface LocalNode {
  node: SubNode;
  x: number;
  y: number;
  z: number;
  seed: number;
}

interface LocalFeature {
  feature: SubFeature;
  index: number;
  points: THREE.Vector3[];
  seed: number;
}

interface ProjectedPoint {
  x: number;
  y: number;
  visible: boolean;
  w: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const hash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

const mercatorFromLngLat = (lng: number, lat: number): { x: number; y: number } => {
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
};

const meterScaleAt = (lat: number): number =>
  1 / (2 * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180));

const disposeObject = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
  });
};

export class SubsurfaceLayer implements CustomLayerInterface {
  readonly id = 'subterra-subsurface';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  onNodesProjected?: (nodes: NodeProjection[]) => void;

  private map?: MapLibreMap;
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private featureGroup = new THREE.Group();
  private apertureGroup = new THREE.Group();
  private shaftGroup = new THREE.Group();
  private labelGroup = new THREE.Group();

  private dataset: SiteDataset = {
    features: [],
    nodes: [],
    source: 'preset',
    updatedAt: Date.now(),
  };
  private site: { center: LngLat; accent: string } = {
    center: [0, 0],
    accent: '#6fffd5',
  };
  private centerMercator: { x: number; y: number };
  private meterScale: number;
  private localFeatures: LocalFeature[] = [];
  private localNodes: LocalNode[] = [];
  private pickSamples: Array<{ x: number; y: number; z: number; featureIndex: number }> = [];
  private featureMeshes: Array<{
    kind: FeatureKind;
    glow: THREE.Mesh;
    core: THREE.Mesh;
  }> = [];
  private nodePoints?: THREE.Points;
  private shaftMaterials: Array<{
    material: THREE.MeshBasicMaterial;
    phase: number;
    baseOpacity: number;
    depth: number;
  }> = [];
  private strataRings: Array<{
    mesh: THREE.Mesh;
    material: THREE.MeshBasicMaterial;
    depth: number;
  }> = [];
  private apertureRing?: THREE.Mesh;
  private scanPlane?: THREE.Mesh;
  private sectionPlane?: THREE.Mesh;
  private cage?: THREE.Mesh;
  private groundPlane?: THREE.Mesh;
  private lastMvp = new THREE.Matrix4();
  private centerProjected = { x: 0, y: 0, visible: false };

  private scanTarget = 0;
  private scanValue = 0;
  private apertureTarget = 760;
  private apertureValue = 760;
  private shaftsDirty = false;
  private openValue = 0.8;
  private revealTarget = 0;
  private revealValue = 0;
  private selectedIndex = -1;
  private hoveredIndex = -1;
  private selectedNodeIndex = -1;
  private visibleKinds = new Set<FeatureKind>(['subway', 'tunnel', 'water', 'utility']);
  private time = 0;
  private lastFrame = 0;

  private sharedLineUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uRadius: { value: 760 },
    uSelected: { value: -1 },
    uHovered: { value: -1 },
    uOpen: { value: 0.8 },
    uAccent: { value: new THREE.Color('#6fffd5') },
  };

  private groundUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uRadius: { value: 760 },
    uOpen: { value: 0.8 },
    uReveal: { value: 0 },
    uAccent: { value: new THREE.Color('#6fffd5') },
  };
  private scanUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uOpen: { value: 0.8 },
    uAccent: { value: new THREE.Color('#6fffd5') },
  };

  private cageUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uOpen: { value: 0.8 },
    uRadius: { value: 760 },
    uAccent: { value: new THREE.Color('#6fffd5') },
  };

  private sectionUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uOpen: { value: 0.8 },
    uRadius: { value: 760 },
    uAccent: { value: new THREE.Color('#6fffd5') },
  };

  private nodeUniforms = {
    uTime: { value: 0 },
    uScan: { value: 60 },
    uRadius: { value: 760 },
    uSelectedNode: { value: -1 },
    uPixelRatio: { value: 1 },
    uPointScale: { value: 1 },
  };

  constructor(center: LngLat = [0, 0], accent = '#6fffd5') {
    this.site = { center, accent };
    this.centerMercator = mercatorFromLngLat(center[0], center[1]);
    this.meterScale = meterScaleAt(center[1]);
    this.scanTarget = 0;
    this.scanValue = 0;
    this.apertureTarget = DEFAULT_APERTURE / 2;
    this.apertureValue = DEFAULT_APERTURE / 2;
    this.sharedLineUniforms.uRadius.value = DEFAULT_APERTURE / 2;
    this.groundUniforms.uRadius.value = DEFAULT_APERTURE / 2;
    this.nodeUniforms.uRadius.value = DEFAULT_APERTURE / 2;
    this.openValue = smoothstep(0, 42, this.scanValue);
    this.buildStaticScene();
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    const renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
      alpha: true,
    });
    renderer.autoClear = false;
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;
    map.triggerRepaint();
  }

  onRemove(_map: MapLibreMap, _gl: WebGL2RenderingContext): void {
    // The layer instance is reused when a style reload re-adds it, so the scene
    // graph must survive. Only the renderer wrapper (which owns GL state tied
    // to the old context) is torn down here.
    this.renderer?.dispose();
    this.renderer = undefined;
    this.lastFrame = 0;
  }

  setSite(center: LngLat, accent?: string): void {
    this.site = { center, accent: accent ?? this.site.accent };
    this.centerMercator = mercatorFromLngLat(center[0], center[1]);
    this.meterScale = meterScaleAt(center[1]);
    if (accent) this.setAccent(accent);
    this.rebuildShafts();
    this.map?.triggerRepaint();
  }

  setAccent(accent: string): void {
    const color = new THREE.Color(accent);
    this.sharedLineUniforms.uAccent.value.copy(color);
    this.groundUniforms.uAccent.value.copy(color);
    this.scanUniforms.uAccent.value.copy(color);
    this.cageUniforms.uAccent.value.copy(color);
    this.sectionUniforms.uAccent.value.copy(color);
    (this.apertureRing?.material as THREE.MeshBasicMaterial | undefined)?.color.copy(color);
  }

  /**
   * Converts every feature and node into local metres and samples the geometry
   * for picking. Kept separate from `setDataset` so the geometry can be rebuilt
   * without resetting the user's selection state.
   */
  private rebuildLocalFeatures(): void {
    this.localFeatures = this.dataset.features.map((feature, index) => {
      const seed = hash(feature.id);
      const rawPoints = feature.coords
        .map((coords, pointIndex) => {
          if (
            !Number.isFinite(coords[0]) ||
            !Number.isFinite(coords[1]) ||
            Math.abs(coords[1]) > 85 ||
            Math.abs(coords[0]) > 180
          ) {
            return null;
          }
          const local = this.toLocal(coords, 0);
          const n = Math.max(1, feature.coords.length - 1);
          const wave =
            Math.sin((pointIndex / n) * Math.PI * 2.2 + seed * 9) * 0.58 +
            Math.sin((pointIndex / n) * Math.PI * 5.1 + seed * 3) * 0.22;
          return new THREE.Vector3(local.x, local.y, feature.depth + wave);
        })
        .filter((point): point is THREE.Vector3 => Boolean(point));
      const points =
        rawPoints.length > 2
          ? new THREE.CatmullRomCurve3(rawPoints, false, 'centripetal', 0.5).getPoints(
              Math.min(140, Math.max(9, Math.round(rawPoints.length * 2.6))),
            )
          : rawPoints;
      return { feature, index, points, seed };
    });

    this.localNodes = this.dataset.nodes.map((node, index) => {
      const local = this.toLocal(node.coords, node.depth);
      return {
        node,
        x: local.x,
        y: local.y,
        z: local.z,
        seed: hash(`${node.id}:${index}`),
      };
    });

    this.pickSamples = [];
    this.localFeatures.forEach((entry) => {
      const step = Math.max(1, Math.floor(entry.points.length / 36));
      entry.points.forEach((point, index) => {
        if (index % step !== 0 && index !== entry.points.length - 1) return;
        this.pickSamples.push({
          x: point.x,
          y: point.y,
          z: point.z,
          featureIndex: entry.index,
        });
      });
    });
  }

  setDataset(dataset: SiteDataset): void {
    this.dataset = dataset;
    this.rebuildLocalFeatures();
    this.selectedIndex = -1;
    this.hoveredIndex = -1;
    this.selectedNodeIndex = -1;
    this.sharedLineUniforms.uSelected.value = -1;
    this.sharedLineUniforms.uHovered.value = -1;
    this.nodeUniforms.uSelectedNode.value = -1;
    this.rebuildFeatures();
    this.rebuildNodes();
    this.rebuildShafts();
    this.map?.triggerRepaint();
  }

  setScanDepth(depthMeters: number): void {
    this.scanTarget = clamp(depthMeters, 0, 80);
  }

  /** Keeps the excavation grid invisible until the basemap has actually painted. */
  setSurfaceRevealed(revealed: boolean): void {
    this.revealTarget = revealed ? 1 : 0;
    this.map?.triggerRepaint();
  }

  setAperture(radiusMeters: number): void {
    // The upper bound has to track how far the camera can see: at city scale a
    // 750 m cut would hide every line the extractor just loaded.
    this.apertureTarget = clamp(radiusMeters, 140, 6500);
    this.shaftsDirty = true;
  }

  setSelectedFeature(index: number | null): void {
    this.selectedIndex = index ?? -1;
    this.sharedLineUniforms.uSelected.value = this.selectedIndex;
    this.map?.triggerRepaint();
  }

  setHoveredFeature(index: number | null): void {
    const next = index ?? -1;
    if (next === this.hoveredIndex) return;
    this.hoveredIndex = next;
    this.sharedLineUniforms.uHovered.value = next;
    this.map?.triggerRepaint();
  }

  setSelectedNode(index: number | null): void {
    this.selectedNodeIndex = index ?? -1;
    this.nodeUniforms.uSelectedNode.value = this.selectedNodeIndex;
    this.map?.triggerRepaint();
  }

  setKindVisible(kind: FeatureKind, visible: boolean): void {
    if (visible) this.visibleKinds.add(kind);
    else this.visibleKinds.delete(kind);
    this.featureMeshes.forEach((entry) => {
      if (entry.kind !== kind) return;
      entry.glow.visible = visible;
      entry.core.visible = visible;
    });
    this.map?.triggerRepaint();
  }

  setAllKindsVisible(visible: boolean): void {
    (Object.keys(KIND_RADIUS) as FeatureKind[]).forEach((kind) => {
      this.setKindVisible(kind, visible);
    });
  }

  getSmoothedScan(): number {
    return this.scanValue;
  }

  getDataset(): SiteDataset {
    return this.dataset;
  }

  getNodeProjections(): NodeProjection[] {
    return this.localNodes.map((entry) => {
      const projected = this.projectLocal(entry.x, entry.y, entry.z);
      const radial = Math.hypot(entry.x, entry.y);
      const inside = radial <= this.apertureValue * 1.01;
      const revealed = Math.abs(entry.node.depth) <= this.scanValue + 8;
      return {
        node: entry.node,
        x: projected.x,
        y: projected.y,
        visible: projected.visible && inside && revealed,
        inside,
        revealed,
        depth: entry.node.depth,
      };
    });
  }

  projectCenter(): { x: number; y: number; visible: boolean } {
    return this.centerProjected;
  }

  getDepthScale(
    depths: number[],
  ): Array<{ depth: number; x: number; y: number; visible: boolean }> {
    const axisX = -this.apertureValue * 0.93;
    return depths.map((depth) => {
      const projected = this.projectLocal(axisX, 0, -depth);
      return {
        depth,
        x: projected.x,
        y: projected.y,
        visible: projected.visible,
      };
    });
  }

  pick(clientX: number, clientY: number, width: number, height: number): PickResult | null {
    if (!this.pickSamples.length || width <= 0 || height <= 0) return null;
    let closestDistance = 27 * 27;
    let closestIndex = -1;
    for (const sample of this.pickSamples) {
      const feature = this.dataset.features[sample.featureIndex];
      if (!feature || !this.visibleKinds.has(feature.kind)) continue;
      if (Math.abs(feature.depth) > this.scanValue + 8) continue;
      if (Math.hypot(sample.x, sample.y) > this.apertureValue * 1.02) continue;
      const projected = this.projectForSize(sample.x, sample.y, sample.z, width, height);
      if (!projected.visible) continue;
      const dx = projected.x - clientX;
      const dy = projected.y - clientY;
      const distance = dx * dx + dy * dy;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = sample.featureIndex;
      }
    }
    if (closestIndex < 0) return null;
    const feature = this.dataset.features[closestIndex];
    if (!feature) return null;
    const projectedFeature = this.featureScreenAnchor(feature, closestIndex, width, height);
    return {
      featureIndex: closestIndex,
      feature,
      screenX: projectedFeature.x,
      screenY: projectedFeature.y,
    };
  }

  render(_gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    // A style reload calls onRemove (dropping the renderer) but MapLibre keeps
    // this layer registered, so onAdd never runs again. Rebuild lazily here or
    // every intercontinental jump would render an empty scene.
    if (!this.renderer && this.map) {
      this.onAdd(this.map, _gl);
    }
    if (!this.renderer || !this.map) return;
    const now = performance.now() / 1000;
    const delta = this.lastFrame ? Math.min(0.08, now - this.lastFrame) : 0.016;
    this.lastFrame = now;
    this.time += delta;

    const ease = 1 - Math.pow(0.001, delta);
    this.scanValue += (this.scanTarget - this.scanValue) * ease;
    this.apertureValue += (this.apertureTarget - this.apertureValue) * ease;
    this.openValue += (smoothstep(0, 42, this.scanValue) - this.openValue) * ease;
    this.revealValue += (this.revealTarget - this.revealValue) * ease;

    if (
      this.shaftsDirty &&
      Math.abs(this.apertureTarget - this.apertureValue) < 1.5
    ) {
      this.shaftsDirty = false;
      this.rebuildShafts();
    }

    const main = new THREE.Matrix4().fromArray(
      options.defaultProjectionData.mainMatrix as unknown as number[],
    );
    const translation = new THREE.Matrix4().makeTranslation(
      this.centerMercator.x,
      this.centerMercator.y,
      0,
    );
    const scale = new THREE.Matrix4().makeScale(
      this.meterScale,
      -this.meterScale,
      this.meterScale * VERTICAL_EXAGGERATION,
    );
    this.lastMvp.copy(main).multiply(translation).multiply(scale);
    this.camera.projectionMatrix.copy(this.lastMvp);
    this.camera.projectionMatrixInverse.copy(this.lastMvp).invert();
    this.camera.matrixWorld.identity();
    this.camera.matrixWorldInverse.identity();

    this.sharedLineUniforms.uTime.value = this.time;
    this.sharedLineUniforms.uScan.value = this.scanValue;
    this.sharedLineUniforms.uRadius.value = this.apertureValue;
    this.sharedLineUniforms.uOpen.value = this.openValue;
    this.groundUniforms.uTime.value = this.time;
    this.groundUniforms.uScan.value = this.scanValue;
    this.groundUniforms.uRadius.value = this.apertureValue;
    this.groundUniforms.uOpen.value = this.openValue;
    this.groundUniforms.uReveal.value = this.revealValue;
    this.scanUniforms.uTime.value = this.time;
    this.scanUniforms.uScan.value = this.scanValue;
    this.scanUniforms.uOpen.value = this.openValue;
    this.cageUniforms.uTime.value = this.time;
    this.cageUniforms.uScan.value = this.scanValue;
    this.cageUniforms.uOpen.value = this.openValue;
    this.cageUniforms.uRadius.value = this.apertureValue;
    this.sectionUniforms.uTime.value = this.time;
    this.sectionUniforms.uScan.value = this.scanValue;
    this.sectionUniforms.uOpen.value = this.openValue;
    this.sectionUniforms.uRadius.value = this.apertureValue;
    this.nodeUniforms.uTime.value = this.time;
    this.nodeUniforms.uScan.value = this.scanValue;
    this.nodeUniforms.uRadius.value = this.apertureValue;
    this.nodeUniforms.uPixelRatio.value = Math.min(2.5, window.devicePixelRatio || 1);
    const zoom = this.map.getZoom();
    this.nodeUniforms.uPointScale.value = clamp(0.82 + (zoom - 14.4) * 0.18, 0.78, 1.65);

    if (this.groundPlane) {
      // At the surface there is nothing to excavate, so the grid stays off
      // entirely and the city reads as a clean 3D skyline.
      this.groundPlane.visible = this.scanValue > 4;
      this.groundPlane.scale.set(this.apertureValue, this.apertureValue, 1);
    }
    if (this.scanPlane) {
      this.scanPlane.visible = this.scanValue > 3.5 && this.openValue > 0.01;
      this.scanPlane.position.z = -this.scanValue;
      this.scanPlane.scale.set(this.apertureValue, this.apertureValue, 1);
    }
    if (this.apertureRing) {
      this.apertureRing.scale.set(this.apertureValue, this.apertureValue, 1);
      this.apertureRing.visible = this.scanValue > 4;
      const material = this.apertureRing.material as THREE.MeshBasicMaterial;
      material.opacity = 0.16 + this.openValue * (0.33 + 0.12 * Math.sin(this.time * 1.4));
    }
    if (this.cage) {
      this.cage.scale.set(this.apertureValue, 1, this.apertureValue);
      // The cage is the instrument housing for the cut; it has no meaning at
      // the surface where nothing is being excavated.
      this.cage.visible = this.scanValue > 6;
    }
    this.strataRings.forEach((ring) => {
      ring.mesh.scale.set(this.apertureValue, this.apertureValue, 1);
      const proximity = 1 - smoothstep(4, 28, Math.abs(-ring.depth - this.scanValue));
      ring.material.opacity = (0.035 + proximity * 0.16) * this.openValue;
    });
    this.shaftMaterials.forEach((entry) => {
      const reveal = 1 - smoothstep(this.scanValue + 2.5, this.scanValue + 11, entry.depth);
      const flicker = 0.72 + 0.28 * Math.sin(this.time * 1.35 + entry.phase);
      entry.material.opacity =
        entry.baseOpacity * reveal * this.openValue * (0.58 + flicker * 0.42);
    });

    const canvas = this.map.getCanvas();
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    this.centerProjected = this.projectForSize(0, 0, -this.scanValue, width, height);
    this.updateLabels();

    this.renderer.resetState();
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.setViewport(
      0,
      0,
      this.renderer.getContext().drawingBufferWidth,
      this.renderer.getContext().drawingBufferHeight,
    );
    this.renderer.render(this.scene, this.camera);

    this.map.triggerRepaint();
  }

  private buildStaticScene(): void {
    this.scene.add(this.groundPlane ?? this.createGround());
    this.scene.add(this.apertureGroup);
    this.scene.add(this.cage ?? this.createCage());
    this.scene.add(this.sectionPlane ?? this.createSectionPlane());
    this.scene.add(this.scanPlane ?? this.createScanPlane());
    this.scene.add(this.featureGroup);
    this.scene.add(this.shaftGroup);
    this.scene.add(this.labelGroup);
    this.createApertureGeometry();
  }

  private createGround(): THREE.Mesh {
    // A unit plane scaled to the aperture at draw time: the grid only ever has
    // to cover the cut, never the whole 16 km viewport.
    const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
    const material = new THREE.ShaderMaterial({
      uniforms: this.groundUniforms,
      vertexShader: GROUND_VERTEX,
      fragmentShader: GROUND_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = 0.15;
    mesh.renderOrder = 0;
    mesh.frustumCulled = false;
    this.groundPlane = mesh;
    return mesh;
  }

  private createApertureGeometry(): void {
    const ringGeometry = new THREE.RingGeometry(0.992, 1.0, 192, 1);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.site.accent),
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.z = 0.35;
    ring.renderOrder = 9;
    ring.frustumCulled = false;
    this.apertureRing = ring;
    this.apertureGroup.add(ring);

    const depths = [-12, -30, -52, -76];
    depths.forEach((depth) => {
      const geometry = new THREE.RingGeometry(0.992, 1.0, 160, 1);
      const [r, g, b] = depthColorRgb(Math.abs(depth));
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(r / 255, g / 255, b / 255),
        transparent: true,
        opacity: 0.09,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = depth;
      mesh.scale.set(this.apertureValue, this.apertureValue, 1);
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.apertureGroup.add(mesh);
      this.strataRings.push({ mesh, material, depth });
    });
  }

  private createScanPlane(): THREE.Mesh {
    const geometry = new THREE.CircleGeometry(1, 160);
    const material = new THREE.ShaderMaterial({
      uniforms: this.scanUniforms,
      vertexShader: SCAN_VERTEX,
      fragmentShader: SCAN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(this.apertureValue, this.apertureValue, 1);
    mesh.position.z = -this.scanValue;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    this.scanPlane = mesh;
    return mesh;
  }

  private createSectionPlane(): THREE.Mesh {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [-1, 0, 0, 1, 0, 0, 1, 0, -1, -1, 0, -1],
        3,
      ),
    );
    geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new THREE.ShaderMaterial({
      uniforms: this.sectionUniforms,
      vertexShader: SECTION_VERTEX,
      fragmentShader: SECTION_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    this.sectionPlane = mesh;
    return mesh;
  }

  private createCage(): THREE.Mesh {
    const geometry = new THREE.CylinderGeometry(1, 1, 80, 96, 1, true);
    const material = new THREE.ShaderMaterial({
      uniforms: this.cageUniforms,
      vertexShader: CAGE_VERTEX,
      fragmentShader: CAGE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = -40;
    mesh.scale.set(this.apertureValue, 1, this.apertureValue);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.cage = mesh;
    return mesh;
  }

  private rebuildFeatures(): void {
    disposeObject(this.featureGroup);
    this.featureGroup.clear();
    this.featureMeshes = [];
    const grouped = new Map<FeatureKind, LocalFeature[]>();
    (Object.keys(KIND_RADIUS) as FeatureKind[]).forEach((kind) => grouped.set(kind, []));
    this.localFeatures.forEach((entry) => {
      grouped.get(entry.feature.kind)?.push(entry);
    });

    grouped.forEach((entries, kind) => {
      if (entries.length === 0) return;
      const geometry = this.buildTubeGeometry(entries, kind);
      const positionAttribute = geometry.getAttribute('position');
      if (!positionAttribute || positionAttribute.count === 0) {
        geometry.dispose();
        return;
      }
      const glowMaterial = new THREE.ShaderMaterial({
        uniforms: {
          ...this.sharedLineUniforms,
          uExpand: { value: KIND_GLOW[kind] },
          uOpacity: { value: 0.48 },
          uGlow: { value: 1 },
        },
        vertexShader: TUBE_VERTEX,
        fragmentShader: TUBE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const coreMaterial = new THREE.ShaderMaterial({
        uniforms: {
          ...this.sharedLineUniforms,
          uExpand: { value: 0 },
          uOpacity: { value: 0.86 },
          uGlow: { value: 0 },
        },
        vertexShader: TUBE_VERTEX,
        fragmentShader: TUBE_FRAGMENT,
        transparent: true,
        depthWrite: true,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
      });
      const glow = new THREE.Mesh(geometry, glowMaterial);
      const core = new THREE.Mesh(geometry, coreMaterial);
      glow.renderOrder = 10;
      core.renderOrder = 11;
      glow.frustumCulled = false;
      core.frustumCulled = false;
      glow.visible = this.visibleKinds.has(kind);
      core.visible = this.visibleKinds.has(kind);
      this.featureGroup.add(glow, core);
      this.featureMeshes.push({ kind, glow, core });
    });
  }

  private buildTubeGeometry(entries: LocalFeature[], kind: FeatureKind): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const progresses: number[] = [];
    const features: number[] = [];
    const seeds: number[] = [];
    const indices: number[] = [];
    const radius = KIND_RADIUS[kind];
    let vertexOffset = 0;

    entries.forEach((entry) => {
      const { points } = entry;
      if (points.length < 2) return;
      const ringCount = points.length;
      const tangent = new THREE.Vector3();
      const previous = new THREE.Vector3();
      const next = new THREE.Vector3();
      const normal2 = new THREE.Vector3();

      for (let index = 0; index < ringCount; index += 1) {
        const current = points[index];
        previous.copy(points[Math.max(0, index - 1)]);
        next.copy(points[Math.min(points.length - 1, index + 1)]);
        tangent.subVectors(next, previous);
        tangent.z *= 0.4;
        if (tangent.lengthSq() < 0.0001) tangent.set(1, 0, 0);
        tangent.normalize();
        normal2.set(-tangent.y, tangent.x, 0);
        if (normal2.lengthSq() < 0.0001) normal2.set(0, 1, 0);
        normal2.normalize();
        const progress = ringCount <= 1 ? 0 : index / (ringCount - 1);

        for (let segment = 0; segment < RADIAL_SEGMENTS; segment += 1) {
          const angle = (segment / RADIAL_SEGMENTS) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const nx = normal2.x * cos;
          const ny = normal2.y * cos;
          const nz = sin;
          positions.push(
            current.x + nx * radius,
            current.y + ny * radius,
            current.z + nz * radius,
          );
          normals.push(nx, ny, nz);
          uvs.push(segment / RADIAL_SEGMENTS, progress);
          progresses.push(progress);
          features.push(entry.index);
          seeds.push(entry.seed);
        }
      }

      for (let segment = 0; segment < ringCount - 1; segment += 1) {
        for (let side = 0; side < RADIAL_SEGMENTS; side += 1) {
          const current = vertexOffset + segment * RADIAL_SEGMENTS + side;
          const nextSide =
            vertexOffset + segment * RADIAL_SEGMENTS + ((side + 1) % RADIAL_SEGMENTS);
          const nextRing = current + RADIAL_SEGMENTS;
          const nextRingSide = nextSide + RADIAL_SEGMENTS;
          indices.push(current, nextRing, nextSide);
          indices.push(nextSide, nextRing, nextRingSide);
        }
      }
      vertexOffset += ringCount * RADIAL_SEGMENTS;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('aProgress', new THREE.Float32BufferAttribute(progresses, 1));
    geometry.setAttribute('aFeature', new THREE.Float32BufferAttribute(features, 1));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    geometry.setIndex(indices);
    return geometry;
  }

  private rebuildNodes(): void {
    if (this.nodePoints) {
      this.labelGroup.remove(this.nodePoints);
      this.nodePoints.geometry.dispose();
      (this.nodePoints.material as THREE.Material).dispose();
      this.nodePoints = undefined;
    }
    if (this.localNodes.length === 0) return;
    const positions: number[] = [];
    const depths: number[] = [];
    const seeds: number[] = [];
    const nodeIndices: number[] = [];
    this.localNodes.forEach((entry, index) => {
      positions.push(entry.x, entry.y, entry.z);
      depths.push(Math.abs(entry.node.depth));
      seeds.push(entry.seed);
      nodeIndices.push(index);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    geometry.setAttribute('aNodeIndex', new THREE.Float32BufferAttribute(nodeIndices, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: this.nodeUniforms,
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = 14;
    points.frustumCulled = false;
    this.nodePoints = points;
    this.labelGroup.add(points);
  }

  private rebuildShafts(): void {
    disposeObject(this.shaftGroup);
    this.shaftGroup.clear();
    this.shaftMaterials = [];
    const candidates = this.localNodes
      .filter((entry) => {
        const radial = Math.hypot(entry.x, entry.y);
        return radial < this.apertureValue * 0.84 && entry.node.depth < -10;
      })
      .sort((a, b) => a.node.depth - b.node.depth)
      .slice(0, 8);

    candidates.forEach((entry) => {
      const height = Math.abs(entry.node.depth);
      const [r, g, b] = depthColorRgb(height);
      const color = new THREE.Color(r / 255, g / 255, b / 255);
      const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const coreMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 0.96, 0.82),
        transparent: true,
        opacity: 0.36,
        depthWrite: true,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const glowGeometry = new THREE.CylinderGeometry(4.6, 4.6, height, 8, 1, true);
      const coreGeometry = new THREE.CylinderGeometry(1.05, 1.05, height, 6, 1, true);
      const glow = new THREE.Mesh(glowGeometry, glowMat);
      const core = new THREE.Mesh(coreGeometry, coreMat);
      [glow, core].forEach((mesh) => {
        mesh.rotation.x = Math.PI / 2;
        mesh.position.set(entry.x, entry.y, -height / 2);
        mesh.renderOrder = 8;
        mesh.frustumCulled = false;
        this.shaftGroup.add(mesh);
      });
      this.shaftMaterials.push(
        { material: glowMat, phase: entry.seed * 9, baseOpacity: 0.2, depth: height },
        { material: coreMat, phase: entry.seed * 9 + 1.6, baseOpacity: 0.36, depth: height },
      );

      const haloGeometry = new THREE.RingGeometry(7.5, 12.5, 48);
      const haloMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      halo.position.set(entry.x, entry.y, 0.55);
      halo.renderOrder = 9;
      halo.frustumCulled = false;
      this.shaftGroup.add(halo);
      this.shaftMaterials.push({
        material: haloMaterial,
        phase: entry.seed * 8,
        baseOpacity: 0.24,
        depth: 0.5,
      });
    });
  }

  private toLocal(coords: LngLat, depth: number): { x: number; y: number; z: number } {
    const mercator = mercatorFromLngLat(coords[0], coords[1]);
    return {
      x: (mercator.x - this.centerMercator.x) / this.meterScale,
      y: (this.centerMercator.y - mercator.y) / this.meterScale,
      z: depth,
    };
  }

  private projectForSize(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
  ): ProjectedPoint {
    const clip = new THREE.Vector4(x, y, z, 1).applyMatrix4(this.lastMvp);
    if (clip.w <= 0.00001) return { x: 0, y: 0, visible: false, w: clip.w };
    const ndcX = clip.x / clip.w;
    const ndcY = clip.y / clip.w;
    const visible =
      ndcX > -1.18 && ndcX < 1.18 && ndcY > -1.18 && ndcY < 1.18;
    return {
      x: (ndcX * 0.5 + 0.5) * width,
      y: (-ndcY * 0.5 + 0.5) * height,
      visible,
      w: clip.w,
    };
  }

  private projectLocal(x: number, y: number, z: number): ProjectedPoint {
    const map = this.map;
    if (!map) return { x: 0, y: 0, visible: false, w: 0 };
    const canvas = map.getCanvas();
    return this.projectForSize(
      x,
      y,
      z,
      canvas.clientWidth || canvas.width,
      canvas.clientHeight || canvas.height,
    );
  }

  private featureScreenAnchor(
    feature: SubFeature,
    index: number,
    width: number,
    height: number,
  ): { x: number; y: number } {
    const local = this.localFeatures.find((entry) => entry.index === index);
    if (!local) return { x: width / 2, y: height / 2 };
    const midpoint = local.points[Math.floor(local.points.length / 2)];
    if (!midpoint) return { x: width / 2, y: height / 2 };
    const projected = this.projectForSize(midpoint.x, midpoint.y, midpoint.z, width, height);
    return { x: projected.x, y: projected.y };
  }

  private updateLabels(): void {
    if (!this.onNodesProjected) return;
    this.onNodesProjected(this.getNodeProjections());
  }
}
