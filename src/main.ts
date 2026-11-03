import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { PRESET_CITIES, DEFAULT_CITY, type PresetCity } from './data/cities';
import { describePoint, searchPlaces } from './services/geocode';
import { fetchAreaUnderground } from './services/tiles';
import { applyTaggedDepths, fetchTaggedDepths } from './services/overpass';
import { SubsurfaceLayer, type NodeProjection } from './map/SubsurfaceLayer';
import {
  CITY_SHELL_EDGE,
  CITY_SHELL_LAYER,
  TERRAIN_HILLSHADE_LAYER,
  FALLBACK_BASE_LAYER,
  FALLBACK_LABEL_LAYER,
  TERRAIN_SOURCE,
  buildBasemapStyle,
} from './map/basemap';
import { depthColor } from './map/palette';
import type { AreaInfo, FeatureKind, LngLat, PlaceResult, SiteDataset, SubFeature } from './types';

type FeedState = 'idle' | 'loading' | 'tile' | 'enriched' | 'empty' | 'error';

/**
 * Strata a user descends through with PageDown. Each step is one "floor" of the
 * city: surface, shallow utilities, storm drainage, metro, deep bores, bedrock.
 */
const STRATA = [
  { depth: 0, label: 'SURFACE', zh: '地表' },
  { depth: 10, label: 'SHALLOW UTILITY', zh: '浅层市政' },
  { depth: 20, label: 'DRAINAGE', zh: '排水暗渠' },
  { depth: 32, label: 'METRO L1', zh: '地铁浅层' },
  { depth: 46, label: 'METRO L2', zh: '地铁深层' },
  { depth: 60, label: 'DEEP BORE', zh: '深层隧道' },
  { depth: 72, label: 'BEDROCK ZONE', zh: '基岩层' },
] as const;

const $ = <T extends Element = HTMLElement>(selector: string, parent: ParentNode = document): T => {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
};

const $$ = <T extends Element = HTMLElement>(selector: string, parent: ParentNode = document): T[] =>
  Array.from(parent.querySelectorAll<T>(selector));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const distanceMeters = (a: LngLat, b: LngLat): number => {
  const lat = ((a[1] + b[1]) * Math.PI) / 360;
  return Math.hypot((a[0] - b[0]) * 111_320 * Math.cos(lat), (a[1] - b[1]) * 110_574);
};

const lineLengthKm = (coords: LngLat[]): number => {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const d = distanceMeters(coords[i - 1], coords[i]);
    if (Number.isFinite(d)) total += d;
  }
  return total / 1000;
};

const KIND_LABEL: Record<FeatureKind, { en: string; zh: string }> = {
  subway: { en: 'METRO', zh: '地铁隧道' },
  tunnel: { en: 'TUNNEL', zh: '隧道' },
  water: { en: 'WATER', zh: '水脉暗渠' },
  utility: { en: 'UTILITY', zh: '市政管廊' },
};

const NODE_LABEL: Record<string, string> = {
  station: 'STATION',
  junction: 'JUNCTION',
  shaft: 'SHAFT',
  outfall: 'OUTFALL',
};

const formatDepth = (depth: number): string => `−${Math.abs(depth).toFixed(1)} M`;

const formatClock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const formatCoordinate = (coords: LngLat): string => {
  const lat = coords[1] >= 0 ? 'N' : 'S';
  const lng = coords[0] >= 0 ? 'E' : 'W';
  return `${Math.abs(coords[1]).toFixed(5)}° ${lat} / ${Math.abs(coords[0]).toFixed(5)}° ${lng}`;
};

const EMPTY_DATASET: SiteDataset = {
  features: [],
  nodes: [],
  source: 'live',
  updatedAt: Date.now(),
};

const state = {
  center: DEFAULT_CITY.center as LngLat,
  area: null as AreaInfo | null,
  dataset: EMPTY_DATASET,
  scan: 0,
  aperture: 760,
  autoScan: false,
  selectedIndex: null as number | null,
  visibleKinds: { subway: true, tunnel: true, water: true, utility: true } as Record<FeatureKind, boolean>,
  // Terrain and 3D building massing fight each other in MapLibre: with a DEM
  // attached, most extrusion tiles get culled because OpenMapTiles buildings
  // carry no min/max elevation metadata. They are mutually exclusive.
  scene: { terrain: true, buildings: false },
  feedState: 'idle' as FeedState,
  elapsed: 0,
  buildingCount: 0,
  loading: false,
  loadedZoom: 13.4,
};

setWorkerUrl(maplibreWorkerUrl);

let map: MapLibreMap;
try {
  map = new MapLibreMap({
    container: 'map',
    style: buildBasemapStyle(),
    center: state.center,
    zoom: 13.4,
    pitch: 40,
    bearing: DEFAULT_CITY.bearing,
    minZoom: 2,
    maxZoom: 18.2,
    maxPitch: 76,
    attributionControl: false,
    renderWorldCopies: false,
    canvasContextAttributes: {
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
      desynchronized: false,
    },
  });
} catch (error) {
  const bootLog = $('#bootLog');
  bootLog.textContent = 'WEBGL CONTEXT UNAVAILABLE';
  $('#bootSubline').textContent = 'THIS TERMINAL REQUIRES HARDWARE-ACCELERATED WEBGL2';
  throw error;
}

const layer = new SubsurfaceLayer(state.center);
layer.onNodesProjected = updateFloatingScene;

// ---------------------------------------------------------------- DOM refs
const app = $('#app');
const boot = $('#boot');
const bootProgress = $('#bootProgress');
const bootPercent = $('#bootPercent');
const bootLog = $('#bootLog');
const bootSubline = $('#bootSubline');
const bootNetwork = $('#bootNetwork');
const siteTags = $('#siteTags');
const depthRuler = $('#depthRuler');
const targetReticle = $('#targetReticle');
const reticleDepth = $('#reticleDepth');
const feedPill = $('#feedPill');
const feedPillLabel = $('#feedPillLabel');
const feedPillLight = $('#feedPillLight');
const feedStatus = $('#feedStatus');
const feedDot = $('#feedDot');
const dataSource = $('#dataSource');
const dataCount = $('#dataCount');
const dataMeta = $('#dataMeta');
const feedTimestamp = $('#feedTimestamp');
const queryElapsed = $('#queryElapsed');
const feedMeter = $('#feedMeter');
const retryFeedButton = $('#retryFeed');
const hoverCard = $('#hoverCard');
const hoverType = $('#hoverType');
const hoverName = $('#hoverName');
const hoverDepth = $('#hoverDepth');
const contactDrawer = $('#contactDrawer');
const profileSvg = $('#depthProfile') as unknown as SVGSVGElement;
const registryList = $('#registryList');
const depthSlider = $('#depthSlider') as HTMLInputElement;
const apertureSlider = $('#apertureSlider') as HTMLInputElement;
const depthFill = $('#depthFill');
const depthValue = $('#depthValue');
const depthMode = $('#depthMode');
const apertureValue = $('#apertureValue');
const autoScanButton = $('#autoScan');
const profileSlice = $('#profileSlice');
const citySearch = $('#citySearch') as HTMLInputElement;
const searchResults = $('#searchResults');
const levelLadder = $('#levelLadder');

let tagEntries: Array<{ nodeId: string; element: HTMLDivElement }> = [];
let bootReady = false;
let bootProgressValue = 0;
let bootInterval = 0;
let bootStartedAt = 0;
let areaRequest = 0;
let areaAbort: AbortController | null = null;
let searchAbort: AbortController | null = null;
let autoAnimation = 0;
let autoDirection = 1;
let lastAutoTime = 0;
let lastHoverPick = 0;
let hoverFrame = 0;
let lastSceneOpen = -1;
let layerReady = false;
let basemapReady = false;
let fallbackBasemap = false;
let tileErrorCount = 0;
let fallbackNoticeShown = false;
let introFlightStarted = false;
let firstAreaStarted = false;

const showToast = (message: string, tone: 'info' | 'warning' | 'success' = 'info', duration = 4200): void => {
  const region = $('#toastRegion');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.innerHTML = `<span class="toast__mark"></span><span>${escapeHtml(message)}</span>`;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 320);
  }, duration);
  while (region.children.length > 3) region.firstElementChild?.remove();
};

// ---------------------------------------------------------------- boot
const BOOT_MESSAGES = [
  ['MOUNTING SUBSURFACE VOLUME', 'CALIBRATING DEPTH STENCIL / 0.0 — 80.0 M'],
  ['WIRING GLOBAL VECTOR TILE READER', 'RESOLVING PLANET TILEJSON / ANY CITY ON EARTH'],
  ['ARMING TUNNEL EXTRACTOR', 'TRANSPORTATION · WATERWAY · BUILDING SOURCES'],
  ['INITIALIZING THREE.JS CUSTOM LAYER', 'SYNCING MAPLIBRE PROJECTION MATRIX'],
];

const setBootProgress = (value: number, label?: string, subline?: string): void => {
  bootProgressValue = clamp(value, 0, 100);
  bootProgress.style.width = `${bootProgressValue}%`;
  bootPercent.textContent = String(Math.round(bootProgressValue)).padStart(2, '0');
  if (label) bootLog.textContent = label;
  if (subline) bootSubline.textContent = subline;
};

const startBootSequence = (): void => {
  bootStartedAt = performance.now();
  setBootProgress(6, BOOT_MESSAGES[0][0], BOOT_MESSAGES[0][1]);
  let step = 1;
  bootInterval = window.setInterval(() => {
    if (bootReady) return;
    const next = Math.min(84, bootProgressValue + 4 + Math.random() * 6);
    const message = BOOT_MESSAGES[Math.min(step, BOOT_MESSAGES.length - 1)];
    setBootProgress(next, message[0], message[1]);
    step += 1;
  }, 380);
};

const finishBoot = (): void => {
  if (bootReady) return;
  bootReady = true;
  window.clearInterval(bootInterval);
  setBootProgress(100, 'SUBSURFACE VOLUME ONLINE', 'READY / SEARCH ANY CITY TO EXCAVATE');
  bootNetwork.textContent = 'GLOBAL TILES';
  const remaining = Math.max(0, 1150 - (performance.now() - bootStartedAt));
  window.setTimeout(() => {
    app.classList.remove('is-booting');
    app.classList.add('is-ready');
    boot.classList.add('is-done');
    window.setTimeout(() => boot.remove(), 900);
  }, remaining + 260);
};

// ---------------------------------------------------------------- area loading
const loadArea = async (center: LngLat, options: { label?: string; zoom?: number; quiet?: boolean } = {}): Promise<void> => {
  const serial = ++areaRequest;
  areaAbort?.abort();
  const controller = new AbortController();
  areaAbort = controller;

  state.center = center;
  state.loadedZoom = map.getZoom();
  state.loading = true;
  // Keep a name on screen immediately; the reverse geocoder refines it later.
  if (options.label && (!state.area || state.area.name !== options.label)) {
    state.area = {
      name: options.label,
      context: state.area?.context ?? '',
      center,
      zoomHint: map.getZoom(),
    };
  }
  setFeedUI('loading', 'Resolving vector tiles for this area…');
  // A background reload (caused by panning) must not silently kill a running
  // auto-sweep; only an explicit new destination should reset the interaction.
  if (!options.quiet) stopAutoScan();
  clearSelection();
  clearHoverCard();

  // Fetch a radius that matches what the camera can actually see, so the whole
  // visible city gets populated — the aperture only controls how much of it is
  // exposed by the cut. Kept modest: every tile here competes with the basemap
  // for sockets, and z14 tiles are large.
  const viewRadius = (): number => {
    const canvas = map.getCanvas();
    const metersPerPixel = (156543.03392 * Math.cos((center[1] * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    const visible = Math.max(canvas.clientWidth, canvas.clientHeight) * metersPerPixel;
    return clamp(visible * 0.42, 700, 2600);
  };
  const radius = state.aperture / 2;
  const fetchRadius = viewRadius();

  // Re-anchor the Three.js scene on the new centre before the data arrives, so
  // geometry is never drawn relative to the previous city.
  layer.setSite(center);
  // Anchor the volume to the ground under this new centre. DEM tiles load
  // asynchronously, so re-check once the map settles.
  layer.setGroundElevation(groundElevationAt(center));
  // The cut must always cover what was actually loaded, otherwise the overview
  // would mask away every line outside a small cylinder.
  layer.setAperture(Math.max(radius, fetchRadius * 1.05));
  layer.setDataset({ ...EMPTY_DATASET, features: [], nodes: [] });
  console.info(
    '[SubTerra] area load',
    { center, fetchRadius: Math.round(fetchRadius), aperture: Math.round(Math.max(radius, fetchRadius * 1.05)) },
  );

  try {
    const started = performance.now();
    const result = await fetchAreaUnderground({ center, radiusMeters: fetchRadius });
    if (serial !== areaRequest) return;

    let dataset: SiteDataset = {
      features: result.features,
      nodes: result.nodes,
      source: 'live',
      updatedAt: Date.now(),
      note: 'Extracted live from OpenMapTiles vector tiles.',
    };
    state.buildingCount = result.buildingCount;
    state.elapsed = performance.now() - started;

    // Tiles are fetched by index, so the returned geometry always overshoots
    // the requested radius. Size the cut to the data we actually got, or the
    // outer lines would be clipped away by the aperture shader.
    const dataReach = result.features.reduce((max, feature) => {
      let far = max;
      for (const coords of feature.coords) {
        const d = distanceMeters(coords, center);
        if (d > far) far = d;
      }
      return far;
    }, 0);
    if (dataReach > 0) {
      layer.setAperture(Math.max(state.aperture / 2, dataReach * 1.02));
    }

    if (result.features.length === 0) {
      if (serial !== areaRequest) return;
      state.dataset = dataset;
      state.loading = false;
      setFeedUI('empty', 'No mapped underground infrastructure in this area.');
      layer.setDataset(dataset);
      renderAll();
      updateAreaHeader(options.label);
      return;
    }

    applyDataset(dataset);
    setFeedUI('tile');
    renderAll();
    updateAreaHeader(options.label);

    if (!options.quiet) {
      showToast(`${result.features.length} UNDERGROUND CONTACTS EXTRACTED`, 'success', 3000);
    }

    if (options.zoom !== undefined) {
      map.flyTo({
        center,
        zoom: options.zoom,
        pitch: DEFAULT_CITY.pitch,
        bearing: map.getBearing(),
        duration: 1900,
        curve: 1.32,
        essential: true,
      });
    }

    // Depth enrichment is optional; it never blocks the primary dataset.
    void fetchTaggedDepths(center, radius, controller.signal).then((probe) => {
      if (!probe || serial !== areaRequest || probe.depths.length === 0) return;
      const enriched = applyTaggedDepths(state.dataset, probe);
      if (enriched === state.dataset) return;
      state.dataset = enriched;
      layer.setDataset(enriched);
      setFeedUI('enriched');
      renderAll();
      showToast(`${probe.depths.length} SURVEYED DEPTHS MERGED FROM OSM`, 'success', 3400);
    });

    // Reverse geocode for a human-readable area name.
    if (!options.label) {
      void describePoint(center, controller.signal).then((info) => {
        if (!info || serial !== areaRequest) return;
        state.area = info;
        updateAreaHeader();
      });
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;
    if (serial !== areaRequest) return;
    state.loading = false;
    setFeedUI('error', 'Tile extraction failed. Pan the map or try again.');
    showToast('TILE EXTRACTION FAILED / CHECK CONNECTION', 'warning', 5000);
  }
};

const applyDataset = (dataset: SiteDataset): void => {
  const previousId = state.selectedIndex !== null ? state.dataset.features[state.selectedIndex]?.id : undefined;
  state.dataset = dataset;
  state.loading = false;
  layer.setDataset(dataset);
  state.selectedIndex = previousId ? dataset.features.findIndex((f) => f.id === previousId) : null;
  if (state.selectedIndex !== null && state.selectedIndex < 0) state.selectedIndex = null;
  if (state.selectedIndex === null) {
    layer.setSelectedFeature(null);
    contactDrawer.hidden = true;
    contactDrawer.classList.remove('is-open');
  } else {
    layer.setSelectedFeature(state.selectedIndex);
    const feature = dataset.features[state.selectedIndex];
    if (feature) openContactDrawer(feature);
  }
};

const renderAll = (): void => {
  rebuildTags();
  renderDepthProfile();
  updateProfileSelection();
  renderRegistry();
  updateStats();
  updateFeedDetails();
  updateKindCounts();
  updateSceneOpacity();
};

const updateAreaHeader = (label?: string): void => {
  const area = state.area;
  const name = label ?? area?.name ?? 'UNNAMED AREA';
  const context = area?.context || `${state.center[1].toFixed(3)}°, ${state.center[0].toFixed(3)}°`;
  $('#areaName').textContent = name.toUpperCase();
  $('#areaContext').textContent = context.toUpperCase();
  $('#areaTitle').textContent = name.toUpperCase();
  $('#areaSubtitle').textContent = context;
  $('#intelTitle').textContent = name.toUpperCase();
  $('#intelSub').textContent = context;
  $('#mobileSiteName').textContent = name;
  $('#areaIndex').textContent = String(state.dataset.features.length > 0 ? 1 : 0).padStart(2, '0');
  document.title = `SubTerra · ${name} 地下透视`;
  const summary = $('#areaSummary');
  const count = state.dataset.features.length;
  if (count === 0) {
    summary.textContent =
      '这一区域在 OpenStreetMap 中没有已测绘的地下设施。换个位置或搜索其他城市，地下结构会随地图移动实时重建。';
  } else {
    summary.textContent = `从矢量瓦片实时提取到 ${count} 条地下设施：地铁、隧道、暗渠与管廊按真实深度分层展开。拖动底部滑块或按 PageDown 逐层下潜。`;
  }
};

// ---------------------------------------------------------------- feed UI
const setFeedUI = (feed: FeedState, message?: string): void => {
  state.feedState = feed;
  const pillLabels: Record<FeedState, string> = {
    idle: 'IDLE',
    loading: 'SCANNING',
    tile: 'TILES LIVE',
    enriched: 'TILES + OSM',
    empty: 'NO CONTACTS',
    error: 'OFFLINE',
  };
  const sourceLabels: Record<FeedState, string> = {
    idle: 'AWAITING AREA',
    loading: 'READING TILES',
    tile: 'VECTOR TILES',
    enriched: 'VECTOR TILES + OSM',
    empty: 'NO MAPPED DATA',
    error: 'CHANNEL FAULT',
  };
  const statusLabels: Record<FeedState, string> = {
    idle: 'IDLE',
    loading: 'SCANNING',
    tile: 'LIVE',
    enriched: 'ENRICHED',
    empty: 'EMPTY',
    error: 'FAILED',
  };
  feedPill.dataset.state = feed === 'enriched' ? 'live' : feed === 'tile' ? 'live' : feed;
  feedPillLabel.textContent = pillLabels[feed];
  feedPillLight.dataset.state = feed === 'enriched' || feed === 'tile' ? 'live' : feed;
  feedStatus.textContent = statusLabels[feed];
  feedDot.dataset.state = feed === 'enriched' || feed === 'tile' ? 'live' : feed;
  dataSource.textContent = sourceLabels[feed];
  retryFeedButton.hidden = feed !== 'error' && feed !== 'empty';
  feedPill.classList.toggle('is-syncing', feed === 'loading');
  $('#intelFeed').textContent = statusLabels[feed];
  if (message) dataMeta.textContent = message;
  if (feed === 'loading') queryElapsed.textContent = 'SCANNING';
};

const updateFeedDetails = (): void => {
  const dataset = state.dataset;
  const visible = dataset.features.filter((f) => state.visibleKinds[f.kind]).length;
  dataCount.textContent = `${String(dataset.features.length).padStart(2, '0')} LINES`;
  feedTimestamp.textContent = formatClock(dataset.updatedAt);
  feedMeter.style.width = `${Math.min(100, (visible / 40) * 100)}%`;
  queryElapsed.textContent =
    state.feedState === 'loading'
      ? 'SCANNING'
      : state.elapsed > 0
        ? state.elapsed > 9.9
          ? '>10 S'
          : `${state.elapsed.toFixed(1)} S`
        : 'OFFLINE';
  $('#buildingCount').innerHTML = `${String(state.buildingCount).padStart(2, '0')}<small>BLK</small>`;
  if (!state.loading && state.feedState !== 'loading') {
    if (state.feedState === 'enriched') {
      dataMeta.textContent = dataset.note ?? 'Vector tiles with explicit OSM depth tags merged.';
    } else if (state.feedState === 'tile') {
      dataMeta.textContent = 'Extracted live from OpenMapTiles vector tiles. Depths inferred from layer tags.';
    } else if (state.feedState === 'empty') {
      dataMeta.textContent = 'OpenStreetMap has no mapped subsurface infrastructure registered here.';
    }
  }
};

const updateKindCounts = (): void => {
  const counts: Record<FeatureKind, number> = { subway: 0, tunnel: 0, water: 0, utility: 0 };
  state.dataset.features.forEach((f) => { counts[f.kind] += 1; });
  $('#countSubway').textContent = String(counts.subway).padStart(2, '0');
  $('#countTunnel').textContent = String(counts.tunnel).padStart(2, '0');
  $('#countWater').textContent = String(counts.water).padStart(2, '0');
  $('#countUtility').textContent = String(counts.utility).padStart(2, '0');
};

// ---------------------------------------------------------------- floating tags
const buildTagElement = (nodeId: string, name: string, kind: string, depth: number): HTMLDivElement => {
  const element = document.createElement('div');
  element.className = 'site-tag';
  element.dataset.nodeId = nodeId;
  element.style.setProperty('--tag-color', depthColor(Math.abs(depth)));
  const dot = document.createElement('span');
  dot.className = 'site-tag__dot';
  const stem = document.createElement('span');
  stem.className = 'site-tag__stem';
  const copy = document.createElement('span');
  copy.className = 'site-tag__copy';
  const meta = document.createElement('span');
  meta.className = 'site-tag__meta';
  meta.textContent = `${NODE_LABEL[kind] ?? 'CONTACT'} / ${formatDepth(depth)}`;
  const label = document.createElement('b');
  label.textContent = name;
  copy.append(meta, label);
  element.append(dot, stem, copy);
  return element;
};

const rebuildTags = (): void => {
  tagEntries.forEach((entry) => entry.element.remove());
  tagEntries = [];
  const center = state.center;
  const radius = state.aperture / 2;
  const priority: Record<string, number> = { station: 0, outfall: 1, junction: 2, shaft: 3 };
  const candidates = [...state.dataset.nodes]
    .filter((n) => distanceMeters(n.coords, center) <= radius * 0.97)
    .sort((a, b) => {
      const d = (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9);
      if (d !== 0) return d;
      return distanceMeters(a.coords, center) - distanceMeters(b.coords, center);
    })
    .slice(0, 5);
  const seen = new Set<string>();
  candidates.forEach((node) => {
    const key = node.name.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const element = buildTagElement(node.id, node.name, node.kind, Math.abs(node.depth));
    siteTags.appendChild(element);
    tagEntries.push({ nodeId: node.id, element });
  });
};

function updateFloatingScene(nodes: NodeProjection[]): void {
  if (!map) return;
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const projections = new Map(nodes.map((n) => [n.node.id, n]));
  const compact = width < 720;
  const acceptedAnchors: Array<{ x: number; y: number }> = [];
  const acceptedBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  tagEntries.forEach((entry, index) => {
    const projection = projections.get(entry.nodeId);
    const isExtra = compact && index > 2;
    const flipped = projection ? projection.x > width - 220 : false;
    const labelBox = projection
      ? flipped
        ? { left: projection.x - 208, right: projection.x - 26, top: projection.y - 26, bottom: projection.y + 16 }
        : { left: projection.x + 26, right: projection.x + 208, top: projection.y - 26, bottom: projection.y + 16 }
      : null;
    const overlaps =
      projection &&
      (acceptedAnchors.some((p) => Math.abs(p.x - projection.x) < 56 && Math.abs(p.y - projection.y) < 32) ||
        (labelBox &&
          acceptedBoxes.some(
            (box) =>
              labelBox.left < box.right && labelBox.right > box.left && labelBox.top < box.bottom && labelBox.bottom > box.top,
          )));
    const safe =
      projection && projection.visible && !isExtra && !overlaps &&
      projection.x > 16 && projection.x < width - 18 &&
      projection.y > 112 && projection.y < height - 186;
    if (!projection || !safe) {
      entry.element.classList.remove('is-visible');
      return;
    }
    acceptedAnchors.push({ x: projection.x, y: projection.y });
    if (labelBox) acceptedBoxes.push(labelBox);
    entry.element.style.transform = `translate3d(${projection.x.toFixed(1)}px, ${projection.y.toFixed(1)}px, 0)`;
    entry.element.classList.toggle('is-flipped', flipped);
    entry.element.classList.add('is-visible');
    entry.element.style.setProperty('--tag-color', depthColor(Math.abs(projection.depth)));
  });

  const center = layer.projectCenter();
  const showReticle = center.visible && state.scan > 4 && center.x > 0 && center.y > 0;
  targetReticle.classList.toggle('is-visible', showReticle);
  if (showReticle) {
    targetReticle.style.transform = `translate3d(${center.x.toFixed(1)}px, ${center.y.toFixed(1)}px, 0) translate(-50%, -50%)`;
  }
  reticleDepth.textContent = formatDepth(state.scan);

  const depthScale = layer.getDepthScale([0, 20, 40, 60, 80]);
  const showRuler = state.scan > 5;
  const ticks = $$<HTMLDivElement>('.depth-ruler__tick', depthRuler);
  ticks.forEach((element, index) => {
    const point = depthScale[index];
    if (!point) return;
    const blocked = width > 1020 && point.x < 364;
    const visible = showRuler && point.visible && !blocked && point.x > 0 && point.x < width - 8 && point.y > 90 && point.y < height - 150;
    element.classList.toggle('is-visible', Boolean(visible));
    if (visible) {
      element.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
    }
  });
}

const DEPTH_AXIS = [0, 20, 40, 60, 80];

const buildDepthRuler = (): void => {
  depthRuler.innerHTML = '';
  DEPTH_AXIS.forEach((depth) => {
    const element = document.createElement('div');
    element.className = 'depth-ruler__tick';
    element.style.setProperty('--tick-color', depthColor(depth));
    const label = document.createElement('span');
    label.className = 'depth-ruler__label';
    label.textContent = depth === 0 ? '0 M' : `−${depth} M`;
    const bar = document.createElement('i');
    bar.className = 'depth-ruler__bar';
    element.append(label, bar);
    depthRuler.appendChild(element);
  });
};

// ---------------------------------------------------------------- depth profile
const yForDepth = (depth: number): number => 18 + (clamp(Math.abs(depth), 0, 80) / 80) * 113;

const renderDepthProfile = (): void => {
  const features = state.dataset.features.slice(0, 60);
  const plotLeft = 34;
  const plotRight = 302;
  const bands = ['SURFACE', 'UPPER STRATA', 'LOWER STRATA', 'BEDROCK'];
  const bandHeight = 113 / bands.length;
  let svg = `
    <defs>
      <linearGradient id="profileFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#7dfff0" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#7dfff0" stop-opacity=".015"/>
      </linearGradient>
      <filter id="profileGlow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="1.8" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect x="0" y="0" width="320" height="154" fill="rgba(3,9,11,.32)"/>
    <line x1="${plotLeft}" y1="18" x2="${plotRight}" y2="18" stroke="rgba(205,255,247,.55)" stroke-width="1"/>
    <line x1="${plotLeft}" y1="132" x2="${plotRight}" y2="132" stroke="rgba(173,240,229,.12)" stroke-width="1"/>
  `;
  bands.forEach((band, index) => {
    const top = 18 + index * bandHeight;
    const opacity = 0.022 + index * 0.004;
    svg += `<rect x="${plotLeft}" y="${top}" width="${plotRight - plotLeft}" height="${bandHeight}" fill="rgba(126,255,226,${opacity})"/>`;
    svg += `<line x1="${plotLeft}" y1="${top}" x2="${plotRight}" y2="${top}" stroke="rgba(134,234,220,.08)" stroke-width=".5"/>`;
    svg += `<text x="${plotRight - 4}" y="${top + bandHeight - 4}" text-anchor="end" font-size="5.2" fill="rgba(196,241,234,.26)" font-family="IBM Plex Mono, monospace">${escapeHtml(band)}</text>`;
  });
  [0, 20, 40, 60, 80].forEach((depth) => {
    const y = yForDepth(depth);
    svg += `<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${plotRight}" y2="${y.toFixed(2)}" stroke="rgba(151,232,219,.075)" stroke-width=".45" stroke-dasharray="1.5 4"/>`;
    svg += `<text x="${plotLeft - 7}" y="${y + 2.2}" text-anchor="end" font-size="5.6" fill="rgba(195,236,231,.38)" font-family="IBM Plex Mono, monospace">${depth === 0 ? '0' : `−${depth}`}</text>`;
    svg += `<line x1="${plotLeft - 2.5}" y1="${y}" x2="${plotLeft}" y2="${y}" stroke="rgba(195,236,231,.26)" stroke-width=".55"/>`;
  });
  if (features.length === 0) {
    svg += `<text x="168" y="80" text-anchor="middle" font-size="7" fill="rgba(198,244,235,.38)" font-family="IBM Plex Mono, monospace">NO MAPPED CONTACT</text>`;
  }
  features.forEach((feature, index) => {
    const seed = (feature.id.length * 37 + index * 61 + Math.round(Math.abs(feature.depth) * 13)) % 190;
    const start = plotLeft + 16 + (seed % 58);
    const end = Math.min(plotRight - 12, start + 48 + (seed % 92));
    const y = yForDepth(feature.depth);
    const selected = state.selectedIndex === index ? ' is-selected' : '';
    const color = depthColor(Math.abs(feature.depth));
    svg += `<g class="profile-contact${selected}" data-index="${index}" filter="url(#profileGlow)">
      <line x1="${start}" y1="${y.toFixed(2)}" x2="${end}" y2="${y.toFixed(2)}" stroke="${color}" stroke-width="${state.selectedIndex === index ? 1.8 : 1}" stroke-opacity="${state.selectedIndex === index ? 1 : 0.72}"/>
      <circle cx="${end}" cy="${y.toFixed(2)}" r="${state.selectedIndex === index ? 2 : 1.2}" fill="${color}" fill-opacity=".9"/>
      <title>${escapeHtml(feature.name)} / ${formatDepth(feature.depth)}</title>
    </g>`;
  });
  svg += `
    <g id="profileScanGroup">
      <line id="profileScanGlow" x1="${plotLeft}" y1="${yForDepth(state.scan).toFixed(2)}" x2="${plotRight}" y2="${yForDepth(state.scan).toFixed(2)}" stroke="#ff9b5f" stroke-width="4" stroke-opacity=".1"/>
      <line id="profileScanLine" x1="${plotLeft}" y1="${yForDepth(state.scan).toFixed(2)}" x2="${plotRight}" y2="${yForDepth(state.scan).toFixed(2)}" stroke="#ff9b5f" stroke-width="1" stroke-dasharray="4 3" stroke-opacity=".9"/>
      <rect id="profileScanTag" x="${plotRight - 36}" y="${(yForDepth(state.scan) - 7).toFixed(2)}" width="36" height="10" fill="#ff9b5f" fill-opacity=".92"/>
      <text id="profileScanText" x="${plotRight - 3}" y="${(yForDepth(state.scan) + 0.6).toFixed(2)}" text-anchor="end" font-size="5.2" font-family="IBM Plex Mono, monospace" fill="#06100f" font-weight="600">SLICE</text>
    </g>
    <line x1="${plotRight}" y1="12" x2="${plotRight}" y2="132" stroke="rgba(126,255,226,.18)" stroke-width=".5"/>
  `;
  profileSvg.innerHTML = svg;
  profileSvg.querySelectorAll<SVGGElement>('.profile-contact').forEach((element) => {
    element.style.cursor = 'pointer';
    element.addEventListener('click', () => {
      const index = Number(element.dataset.index);
      if (Number.isFinite(index)) selectFeature(index, true);
    });
  });
  updateProfileScan();
};

const updateProfileScan = (): void => {
  const y = yForDepth(state.scan);
  const line = profileSvg.querySelector<SVGLineElement>('#profileScanLine');
  const glow = profileSvg.querySelector<SVGLineElement>('#profileScanGlow');
  const tag = profileSvg.querySelector<SVGRectElement>('#profileScanTag');
  const text = profileSvg.querySelector<SVGTextElement>('#profileScanText');
  line?.setAttribute('y1', y.toFixed(2));
  line?.setAttribute('y2', y.toFixed(2));
  glow?.setAttribute('y1', y.toFixed(2));
  glow?.setAttribute('y2', y.toFixed(2));
  tag?.setAttribute('y', (y - 7).toFixed(2));
  text?.setAttribute('y', (y + 0.6).toFixed(2));
};

const updateProfileSelection = (): void => {
  profileSvg.querySelectorAll<SVGGElement>('.profile-contact').forEach((element) => {
    const index = Number(element.dataset.index);
    const selected = state.selectedIndex === index;
    element.classList.toggle('is-selected', selected);
    const line = element.querySelector('line');
    const circle = element.querySelector('circle');
    line?.setAttribute('stroke-width', selected ? '1.8' : '1');
    line?.setAttribute('stroke-opacity', selected ? '1' : '0.72');
    circle?.setAttribute('r', selected ? '2' : '1.2');
  });
};

// ---------------------------------------------------------------- registry
const renderRegistry = (): void => {
  const visible = [...state.dataset.features]
    .filter((f) => state.visibleKinds[f.kind])
    .sort((a, b) => Math.abs(a.depth) - Math.abs(b.depth));
  const all = [...state.dataset.features].sort((a, b) => Math.abs(a.depth) - Math.abs(b.depth));
  const features = (visible.length > 0 ? visible : all).slice(0, 30);
  $('#registryMeta').textContent = `TOP ${String(features.length).padStart(2, '0')} / ${String(state.dataset.features.length).padStart(2, '0')}`;
  if (features.length === 0) {
    registryList.innerHTML = `<div class="registry-empty"><span>NO CONTACTS</span><b>Search another city or widen the aperture.</b></div>`;
    return;
  }
  registryList.innerHTML = features
    .map((feature) => {
      const index = state.dataset.features.indexOf(feature);
      const selected = state.selectedIndex === index ? ' is-selected' : '';
      const muted = state.visibleKinds[feature.kind] ? '' : ' is-muted';
      return `<button class="registry-item${selected}${muted}" type="button" data-index="${index}" role="listitem">
        <span class="registry-item__swatch" style="--swatch:${depthColor(Math.abs(feature.depth))}"></span>
        <span class="registry-item__copy">
          <strong>${escapeHtml(feature.name)}</strong>
          <small>${KIND_LABEL[feature.kind].en} <i>/</i> OSM</small>
        </span>
        <span class="registry-item__depth">−${Math.abs(feature.depth).toFixed(1)}<small>M</small></span>
      </button>`;
    })
    .join('');
};

const updateRegistrySelection = (): void => {
  registryList.querySelectorAll<HTMLButtonElement>('.registry-item').forEach((button) => {
    const selected = Number(button.dataset.index) === state.selectedIndex;
    button.classList.toggle('is-selected', selected);
    if (selected) button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
};

const updateStats = (): void => {
  const features = state.dataset.features;
  const maxDepth = features.reduce((max, f) => (Number.isFinite(f.depth) ? Math.max(max, Math.abs(f.depth)) : max), 0);
  const length = features.reduce((total, f) => total + lineLengthKm(f.coords), 0);
  $('#profileContacts').textContent = String(features.length).padStart(2, '0');
  $('#maxDepth').innerHTML = `−${maxDepth.toFixed(1)}<small>M</small>`;
  $('#networkLength').innerHTML = `${length.toFixed(1)}<small>KM</small>`;
  $('#buildingCount').innerHTML = `${String(state.buildingCount).padStart(2, '0')}<small>BLK</small>`;
  const kicker = $('#intelFacts');
  const subway = features.filter((f) => f.kind === 'subway').length;
  const water = features.filter((f) => f.kind === 'water').length;
  const deepest = features.reduce<SubFeature | null>((best, f) => (!best || Math.abs(f.depth) > Math.abs(best.depth) ? f : best), null);
  kicker.innerHTML = `
    <span class="intel-fact"><i>01 / DEEPEST</i><b>${deepest ? formatDepth(deepest.depth) : '—'}</b></span>
    <span class="intel-fact"><i>02 / TRANSIT</i><b>${String(subway).padStart(2, '0')} BORES</b></span>
    <span class="intel-fact"><i>03 / COVERED WATER</i><b>${String(water).padStart(2, '0')} RUNS</b></span>`;
};

// ---------------------------------------------------------------- aperture / depth UI
const updateApertureUI = (): void => {
  apertureSlider.value = String(state.aperture);
  apertureValue.textContent = `Ø ${state.aperture} M`;
  const progress = ((state.aperture - 280) / (1500 - 280)) * 100;
  apertureSlider.style.setProperty('--aperture-progress', `${progress.toFixed(2)}%`);
};

const updateDepthUI = (): void => {
  const scan = Math.round(state.scan);
  depthSlider.value = String(scan);
  depthValue.textContent = String(scan).padStart(2, '0');
  $('#mobileDepth').textContent = state.scan < 1 ? '0 M' : `−${scan} M`;
  depthFill.style.width = `${(state.scan / 80) * 100}%`;
  profileSlice.textContent = formatDepth(state.scan);
  const stratum = currentStratum();
  depthMode.textContent = state.scan < 4 ? 'SURFACE / 地表模式' : `${stratum.label} / ${stratum.zh}`;
  depthSlider.setAttribute('aria-valuetext', `${scan} meters below surface`);
  updateProfileScan();
  updateSceneOpacity();
  updateLadderActive();
};

type Stratum = (typeof STRATA)[number];

const currentStratum = (): Stratum => {
  let chosen: Stratum = STRATA[0];
  for (const entry of STRATA) {
    if (state.scan >= entry.depth - 0.5) chosen = entry;
  }
  return chosen;
};

const updateSceneOpacity = (): void => {
  // Every style mutation throws until the style has finished loading, and those
  // throws would silently abort whatever called us.
  if (!map.isStyleLoaded()) return;
  const style = map.getStyle?.();
  if (!style?.layers?.some((entry) => entry.id === CITY_SHELL_LAYER)) {
    ensureCityShell();
    return;
  }
  const open = smoothstep(0, 42, state.scan);
  if (Math.abs(open - lastSceneOpen) < 0.012) return;
  lastSceneOpen = open;
  // At the surface the city reads as a solid skyline; as the cut descends it
  // fades so the buried network shows through. This is the core
  // "City Skylines -> PageDown -> underground" transition.
  try {
    const base = state.scene.buildings ? 0.62 : 0;
    map.setPaintProperty(CITY_SHELL_LAYER, 'fill-extrusion-opacity', base - open * base * 0.8);
    if (fallbackBasemap) {
      if (map.getLayer(FALLBACK_BASE_LAYER)) map.setPaintProperty(FALLBACK_BASE_LAYER, 'raster-opacity', 1 - open * 0.14);
      if (map.getLayer(FALLBACK_LABEL_LAYER)) map.setPaintProperty(FALLBACK_LABEL_LAYER, 'raster-opacity', 0.92 - open * 0.22);
    }
  } catch {}
};

/**
 * Re-inserts the 3D massing layer if it is missing. MapLibre drops custom
 * additions whenever the style is reloaded, which can happen after a long
 * intercontinental jump.
 */
/**
 * Turns on real 3D relief. MapLibre reads the DEM tiles and renders the ground
 * mesh; our Three.js layer then queries the same DEM so tunnels sit at their true
 * depth below the *local* surface rather than below sea level. In Chongqing that
 * difference is the whole point: the city climbs 200 m from the river to the
 * ridge, so a flat reference plane hides the vertical structure entirely.
 */
let terrainEnabled = false;

const enableTerrain = (): void => {
  if (terrainEnabled) return;
  try {
    if (!map.getSource(TERRAIN_SOURCE)) return;
    // `setTerrain` before the first paint forces MapLibre to build the DEM
    // pipeline inside the initial style cycle, which stalls `style.load`
    // indefinitely on some networks. Turn it on only once the map is idle.
    map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1 });
    terrainEnabled = true;
    syncGroundElevation();
  } catch {}
};

/** Defers terrain until the map has finished its first render pass. */
const scheduleTerrain = (): void => {
  if (terrainEnabled) return;
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    enableTerrain();
  };
  map.once('idle', () => window.setTimeout(go, 400));
  window.setTimeout(go, 12_000);
};

/**
 * DEM tiles arrive after `style.load`, so the first elevation query usually
 * returns null. Re-run on idle (and once more on a short delay) until the
 * surface height is actually known, then lift the volume onto it.
 */
const syncGroundElevation = (): void => {
  const apply = (): boolean => {
    if (!terrainEnabled) return false;
    const elevation = groundElevationAt(state.center);
    if (Number.isFinite(elevation) && elevation !== 0) {
      layer.setGroundElevation(elevation);
      return true;
    }
    return false;
  };
  if (apply()) return;
  // Poll briefly instead of hooking `idle`: registering extra `idle` listeners
  // during startup competes with the initial style/paint cycle.
  let tries = 0;
  const tick = (): void => {
    if (apply() || tries >= 15) return;
    tries += 1;
    window.setTimeout(tick, 700);
  };
  window.setTimeout(tick, 700);
};

/** Local ground elevation in metres, or 0 when the DEM is unavailable. */
const groundElevationAt = (coords: LngLat): number => {
  try {
    if (!terrainEnabled) return 0;
    const value = map.queryTerrainElevation(coords);
    return Number.isFinite(value as number) ? (value as number) : 0;
  } catch {
    return 0;
  }
};

const ensureCityShell = (): void => {
  try {
    if (map.getLayer(CITY_SHELL_LAYER)) return;
    const style = map.getStyle?.();
    if (!style?.sources?.openmaptiles) return;
    map.addLayer({
      id: CITY_SHELL_LAYER,
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 12],
          0, '#3a7a80', 24, '#4d9a9c', 70, '#67c2ba', 160, '#8ee6d8',
        ],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.42,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    lastSceneOpen = -1;
  } catch {}
};

// ---------------------------------------------------------------- layer switches
const updateLayerButtons = (): void => {
  $$('.layer-row').forEach((row) => {
    const kind = (row as HTMLElement).dataset.kind as FeatureKind;
    const active = state.visibleKinds[kind];
    row.setAttribute('aria-checked', String(active));
    row.classList.toggle('is-off', !active);
    layer.setKindVisible(kind, active);
  });
  updateKindCounts();
  updateFeedDetails();
  renderRegistry();
  updateProfileSelection();
  updateStats();
};

// ---------------------------------------------------------------- scene modes
/**
 * Applies the terrain / building selection. Only one can be active: enabling
 * terrain hides the massing because MapLibre culls extrusion tiles that lack
 * elevation metadata, which would leave the city half-drawn.
 */
const applySceneMode = (): void => {
  const wantTerrain = state.scene.terrain;
  const wantBuildings = state.scene.buildings;

  try {
    if (wantTerrain && !terrainEnabled) {
      enableTerrain();
    } else if (!wantTerrain && terrainEnabled) {
      map.setTerrain(null);
      terrainEnabled = false;
    }
  } catch {}

  if (map.getLayer(CITY_SHELL_LAYER)) {
    map.setLayoutProperty(CITY_SHELL_LAYER, 'visibility', wantBuildings ? 'visible' : 'none');
  }
  if (map.getLayer(CITY_SHELL_EDGE)) {
    map.setLayoutProperty(CITY_SHELL_EDGE, 'visibility', wantBuildings ? 'visible' : 'none');
  }
  // The hillshade overlay only makes sense without the massing covering it.
  if (map.getLayer(TERRAIN_HILLSHADE_LAYER)) {
    map.setLayoutProperty(TERRAIN_HILLSHADE_LAYER, 'visibility', wantTerrain ? 'visible' : 'none');
  }

  $$('.layer-row--terrain').forEach((row) => {
    const key = (row as HTMLElement).dataset.scene as 'terrain' | 'buildings';
    row.setAttribute('aria-checked', String(state.scene[key]));
    row.classList.toggle('is-off', !state.scene[key]);
  });
  if (wantTerrain) {
    syncGroundElevation();
  } else {
    layer.setGroundElevation(0);
  }
};

// ---------------------------------------------------------------- scan control
const setScanValue = (value: number, options: { fromAuto?: boolean } = {}): void => {
  state.scan = clamp(value, 0, 80);
  layer.setScanDepth(state.scan);
  if (!options.fromAuto) stopAutoScan();
  updateDepthUI();
};

/** PageDown / PageUp: step through named strata rather than raw metres. */
const stepStratum = (direction: 1 | -1): void => {
  const current = state.scan;
  let target: number;
  if (direction > 0) {
    const next = STRATA.find((s) => s.depth > current + 1.5);
    target = next ? next.depth : 78;
  } else {
    const previous = [...STRATA].reverse().find((s) => s.depth < current - 1.5);
    target = previous ? previous.depth : 0;
  }
  stopAutoScan();
  setScanValue(target);
  const stratum = currentStratum();
  if (target > 0) {
    showToast(`${stratum.label} / ${stratum.zh} · ${formatDepth(target)}`, 'info', 2000);
  } else {
    showToast('SURFACE RESTORED / 返回地表', 'info', 2000);
  }
};

const selectFeature = (index: number, revealIfNeeded = false): void => {
  const feature = state.dataset.features[index];
  if (!feature) return;
  if (revealIfNeeded && Math.abs(feature.depth) > state.scan + 7) {
    setScanValue(Math.ceil(Math.abs(feature.depth) + 4));
  }
  state.selectedIndex = index;
  layer.setSelectedFeature(index);
  layer.setHoveredFeature(null);
  clearHoverCard();
  updateRegistrySelection();
  updateProfileSelection();
  openContactDrawer(feature);
};

const clearSelection = (): void => {
  state.selectedIndex = null;
  layer.setSelectedFeature(null);
  contactDrawer.hidden = true;
  contactDrawer.classList.remove('is-open');
  updateRegistrySelection();
  updateProfileSelection();
};

const openContactDrawer = (feature: SubFeature): void => {
  $('#selectedId').textContent = feature.id.replaceAll('-', ' / ').toUpperCase();
  $('#selectedName').textContent = feature.name;
  $('#selectedNote').textContent = feature.note ?? 'Depth inferred from OSM layer tags and infrastructure class.';
  $('#selectedDepth').innerHTML = `−${Math.abs(feature.depth).toFixed(1)}<small>M</small>`;
  $('#selectedKind').textContent = `${KIND_LABEL[feature.kind].en} / ${KIND_LABEL[feature.kind].zh}`;
  $('#selectedSource').textContent = 'OPENMAPTILES';
  $('#selectedRange').textContent = `${formatDepth(feature.depthRange[0])} — ${formatDepth(feature.depthRange[1])}`;
  $('#selectedCoord').textContent = formatCoordinate(feature.coords[0]);
  contactDrawer.hidden = false;
  requestAnimationFrame(() => contactDrawer.classList.add('is-open'));
};

const clearHoverCard = (): void => {
  hoverCard.classList.remove('is-visible');
};

const updateHover = (clientX: number, clientY: number, pointX: number, pointY: number): void => {
  const canvas = map.getCanvas();
  const result = layer.pick(pointX, pointY, canvas.clientWidth, canvas.clientHeight);
  if (!result) {
    layer.setHoveredFeature(null);
    clearHoverCard();
    canvas.style.cursor = '';
    return;
  }
  layer.setHoveredFeature(result.featureIndex);
  canvas.style.cursor = 'pointer';
  hoverType.textContent = `${KIND_LABEL[result.feature.kind].en} / OSM`;
  hoverName.textContent = result.feature.name;
  hoverDepth.textContent = formatDepth(result.feature.depth);
  hoverCard.style.setProperty('--hover-color', depthColor(Math.abs(result.feature.depth)));
  const offset = 18;
  const width = hoverCard.offsetWidth || 220;
  const height = hoverCard.offsetHeight || 70;
  const x = clamp(clientX + offset, 12, window.innerWidth - width - 12);
  const y = clamp(clientY + offset, 12, window.innerHeight - height - 12);
  hoverCard.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  hoverCard.classList.add('is-visible');
};

const focusSelectedFeature = (): void => {
  if (state.selectedIndex === null) return;
  const feature = state.dataset.features[state.selectedIndex];
  if (!feature) return;
  const middle = feature.coords[Math.floor(feature.coords.length / 2)];
  if (Math.abs(feature.depth) > state.scan + 6) setScanValue(Math.ceil(Math.abs(feature.depth) + 5));
  map.flyTo({
    center: middle,
    zoom: Math.max(map.getZoom(), 16.1),
    pitch: Math.max(map.getPitch(), 55),
    duration: 1500,
    essential: true,
  });
};

const stopAutoScan = (): void => {
  if (!state.autoScan && !autoAnimation) return;
  state.autoScan = false;
  autoScanButton.classList.remove('is-active');
  autoScanButton.setAttribute('aria-pressed', 'false');
  cancelAnimationFrame(autoAnimation);
  autoAnimation = 0;
};

const autoTick = (time: number): void => {
  if (!state.autoScan) return;
  if (!lastAutoTime) lastAutoTime = time;
  const delta = Math.min(0.1, (time - lastAutoTime) / 1000);
  lastAutoTime = time;
  let next = state.scan + autoDirection * delta * 12;
  if (next >= 78) {
    next = 78;
    autoDirection = -1;
  } else if (next <= 2) {
    // 0 is a meaningful stop (the surface view), so the sweep runs all the way
    // up rather than bouncing around a mid-depth band.
    next = 2;
    autoDirection = 1;
  }
  setScanValue(next, { fromAuto: true });
  autoAnimation = requestAnimationFrame(autoTick);
};

const toggleAutoScan = (): void => {
  state.autoScan = !state.autoScan;
  autoScanButton.classList.toggle('is-active', state.autoScan);
  autoScanButton.setAttribute('aria-pressed', String(state.autoScan));
  if (state.autoScan) {
    autoDirection = state.scan > 72 ? -1 : 1;
    lastAutoTime = 0;
    autoAnimation = requestAnimationFrame(autoTick);
  } else {
    stopAutoScan();
  }
};

const dive = (): void => {
  stopAutoScan();
  setScanValue(74);
  map.flyTo({
    center: state.center,
    zoom: Math.max(map.getZoom(), 15.6),
    pitch: Math.max(60, map.getPitch()),
    bearing: map.getBearing(),
    duration: 2200,
    curve: 1.45,
    essential: true,
  });
  showToast('BORE PROFILE OPEN / 74 METRES BELOW SURFACE', 'success', 2800);
};

const surface = (): void => {
  stopAutoScan();
  setScanValue(0);
  map.easeTo({ center: state.center, zoom: Math.max(map.getZoom() - 0.1, 13.6), pitch: 28, duration: 1500, essential: true });
};

const resetView = (): void => {
  stopAutoScan();
  state.aperture = 760;
  updateApertureUI();
  layer.setAperture(380);
  (Object.keys(state.visibleKinds) as FeatureKind[]).forEach((k) => { state.visibleKinds[k] = true; });
  updateLayerButtons();
  setScanValue(46);
  map.flyTo({ center: state.center, zoom: 15.2, pitch: 58, bearing: map.getBearing(), duration: 1600, essential: true });
  clearSelection();
};

// ---------------------------------------------------------------- level ladder
const buildLevelLadder = (): void => {
  levelLadder.innerHTML = STRATA.map(
    (stratum, index) => `
    <button class="level-ladder__row" type="button" data-depth="${stratum.depth}" data-index="${index}">
      <span class="level-ladder__bar" style="--level-color:${depthColor(stratum.depth)}"></span>
      <span class="level-ladder__copy">
        <b>${stratum.label}</b>
        <small>${stratum.zh} · −${stratum.depth} M</small>
      </span>
    </button>`,
  ).join('');
  levelLadder.querySelectorAll<HTMLButtonElement>('.level-ladder__row').forEach((row) => {
    row.addEventListener('click', () => {
      stopAutoScan();
      setScanValue(Number(row.dataset.depth));
    });
  });
};

const updateLadderActive = (): void => {
  const active = currentStratum();
  levelLadder.querySelectorAll<HTMLButtonElement>('.level-ladder__row').forEach((row) => {
    row.classList.toggle('is-active', Number(row.dataset.depth) === active.depth);
  });
};

// ---------------------------------------------------------------- search
const renderSearchResults = (places: PlaceResult[]): void => {
  if (places.length === 0) {
    searchResults.hidden = true;
    return;
  }
  searchResults.innerHTML = places
    .map(
      (place, index) => `
      <button class="search-result" type="button" role="option" data-index="${index}">
        <span class="search-result__mark">${escapeHtml((place.country || '··').slice(0, 2))}</span>
        <span class="search-result__copy">
          <b>${escapeHtml(place.name)}</b>
          <small>${escapeHtml(place.context || place.kind)}</small>
        </span>
        <span class="search-result__kind">${escapeHtml(place.kind)}</span>
      </button>`,
    )
    .join('');
  searchResults.hidden = false;
  citySearch.setAttribute('aria-expanded', 'true');
  searchResults.querySelectorAll<HTMLButtonElement>('.search-result').forEach((button) => {
    button.addEventListener('click', () => {
      const place = places[Number(button.dataset.index)];
      if (!place) return;
      choosePlace(place);
    });
  });
};

const choosePlace = (place: PlaceResult): void => {
  searchResults.hidden = true;
  citySearch.setAttribute('aria-expanded', 'false');
  citySearch.value = place.name;
  citySearch.blur();
  state.area = {
    name: place.name,
    context: place.context,
    center: place.center,
    zoomHint: 15.2,
  };
  const span = place.extent
    ? Math.max(
        distanceMeters([place.extent[0], place.extent[1]], [place.extent[2], place.extent[3]]) / 1.4,
        900,
      )
    : 1100;
  state.aperture = clamp(Math.round(span / 10) * 10, 400, 1500);
  updateApertureUI();
  layer.setAperture(state.aperture / 2);
  updateAreaHeader(place.name);
  const zoom = place.extent ? Math.min(15.4, Math.max(13.2, 17 - Math.log2(span / 150))) : 15.2;
  void loadArea(place.center, { label: place.name, zoom });
};

let searchTimer = 0;
const onSearchInput = (): void => {
  const value = citySearch.value;
  window.clearTimeout(searchTimer);
  if (value.trim().length < 2) {
    searchResults.hidden = true;
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    try {
      const places = await searchPlaces(value, controller.signal);
      if (controller.signal.aborted) return;
      renderSearchResults(places);
    } catch {}
  }, 260);
};

// ---------------------------------------------------------------- basemap health
const activateBasemapFallback = (): void => {
  if (fallbackBasemap) return;
  fallbackBasemap = true;
  try {
    const keep = new Set(['background', layer.id, FALLBACK_BASE_LAYER, FALLBACK_LABEL_LAYER, CITY_SHELL_LAYER]);
    map.getStyle().layers?.forEach((entry) => {
      if (keep.has(entry.id)) return;
      if (map.getLayer(entry.id)) map.setLayoutProperty(entry.id, 'visibility', 'none');
    });
    map.setLayoutProperty(FALLBACK_BASE_LAYER, 'visibility', 'visible');
    map.setLayoutProperty(FALLBACK_LABEL_LAYER, 'visibility', 'visible');
    lastSceneOpen = -1;
    basemapReady = true;
    layer.setSurfaceRevealed(true);
    updateSceneOpacity();
    if (!fallbackNoticeShown) {
      fallbackNoticeShown = true;
      showToast('PRIMARY TILE FEED OFFLINE / FALLBACK DARK BASEMAP ENGAGED', 'warning', 5000);
    }
  } catch {}
};

const startBasemapWatchdog = (): void => {
  let misses = 0;
  const reveal = (): void => {
    if (basemapReady) return;
    basemapReady = true;
    layer.setSurfaceRevealed(true);
  };
  const timer = window.setInterval(() => {
    if (fallbackBasemap) {
      window.clearInterval(timer);
      reveal();
      return;
    }
    if (!map.isStyleLoaded()) return;
    let featureCount = 0;
    try {
      featureCount = map.queryRenderedFeatures({
        layers: ['water', 'building', 'highway_minor', 'highway_major_inner', 'railway'],
      }).length;
    } catch {}
    if (featureCount > 0) {
      misses = 0;
      reveal();
      window.clearInterval(timer);
      return;
    }
    // Only give up after a sustained failure; tiles routinely take several
    // seconds on a cold cache and switching to raster would be a downgrade.
    misses += 1;
    if (misses >= 25) {
      window.clearInterval(timer);
      activateBasemapFallback();
      reveal();
    }
  }, 800);
  // Never leave the excavation hidden: show it even if the probe is confused.
  window.setTimeout(reveal, 4_000);
};

// ---------------------------------------------------------------- map events
const updateCompassAndReadout = (): void => {
  const center = map.getCenter();
  const lat = center.lat >= 0 ? 'N' : 'S';
  const lng = center.lng >= 0 ? 'E' : 'W';
  $('#cursorCoords').innerHTML = `${Math.abs(center.lat).toFixed(5)}° ${lat}&nbsp;&nbsp;${Math.abs(center.lng).toFixed(5)}° ${lng}`;
  const bearing = ((map.getBearing() % 360) + 360) % 360;
  $('#compassNeedle').style.transform = `rotate(${bearing}deg)`;
  $('#bearingValue').textContent = `${String(Math.round(bearing)).padStart(3, '0')}°`;
  const metersPerPixel = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
  const choices = [25, 50, 100, 250, 500, 1000, 2000, 5000, 10000];
  let chosen = choices[choices.length - 1];
  for (const candidate of choices) {
    const pixels = candidate / metersPerPixel;
    if (pixels >= 56 && pixels <= 150) { chosen = candidate; break; }
  }
  const width = clamp(chosen / metersPerPixel, 34, 140);
  $('#mapScaleLabel').textContent = chosen >= 1000 ? `${chosen / 1000} KM` : `${chosen} M`;
  ($('.map-scale__bar') as HTMLElement).style.width = `${width.toFixed(0)}px`;
};

const registerMapEvents = (): void => {
  map.on('move', updateCompassAndReadout);
  map.on('zoom', updateCompassAndReadout);

  map.on('error', (event) => {
    const sourceId = (event as unknown as { sourceId?: string }).sourceId ?? '';
    if (sourceId === 'openmaptiles' || sourceId === 'ne2_shaded') {
      tileErrorCount += 1;
      if (tileErrorCount >= 8) activateBasemapFallback();
      return;
    }
    const message = (event as unknown as { error?: Error }).error?.message;
    if (message && /webgl|context/i.test(message)) {
      showToast('RENDER CONTEXT FAULT / RELOAD TERMINAL', 'warning', 6000);
    }
  });

  map.on('mousemove', (event) => {
    if ((event.originalEvent as MouseEvent).buttons) return;
    const now = performance.now();
    if (now - lastHoverPick < 48) return;
    lastHoverPick = now;
    if (hoverFrame) cancelAnimationFrame(hoverFrame);
    const clientX = (event.originalEvent as MouseEvent).clientX;
    const clientY = (event.originalEvent as MouseEvent).clientY;
    hoverFrame = requestAnimationFrame(() => {
      updateHover(clientX, clientY, event.point.x, event.point.y);
      hoverFrame = 0;
    });
  });

  map.on('mouseout', () => {
    layer.setHoveredFeature(null);
    clearHoverCard();
    map.getCanvas().style.cursor = '';
  });

  map.on('dragstart', () => {
    stopAutoScan();
    clearHoverCard();
    layer.setHoveredFeature(null);
  });

  map.on('click', (event) => {
    const canvas = map.getCanvas();
    const result = layer.pick(event.point.x, event.point.y, canvas.clientWidth, canvas.clientHeight);
    if (result) selectFeature(result.featureIndex, false);
    else clearSelection();
  });

  // Panning or zooming somewhere materially new silently reloads that area.
  map.on('moveend', () => {
    if (!layerReady) return;
    // A long jump can drop runtime layers; restore before anything else.
    if (!map.getLayer(CITY_SHELL_LAYER) || !map.getLayer(layer.id)) {
      ensureCityShell();
      if (!map.getLayer(layer.id)) addCustomLayer();
      lastSceneOpen = -1;
      updateSceneOpacity();
    }
    if (state.loading) return;
    const center = map.getCenter();
    const zoomDelta = Math.abs(map.getZoom() - state.loadedZoom);
    const moved = distanceMeters(state.center, [center.lng, center.lat]);
    if (moved < 420 && zoomDelta < 0.75) return;
    state.area = null;
    void loadArea([center.lng, center.lat], { quiet: true });
  });
};

// ---------------------------------------------------------------- UI binding
const bindUI = (): void => {
  $('#cityChips').innerHTML = PRESET_CITIES.map(
    (city: PresetCity) => `
    <button class="city-chip" type="button" data-city="${city.id}" role="listitem">
      <b>${escapeHtml(city.nameZh)}</b>
      <small>${escapeHtml(city.name)}</small>
    </button>`,
  ).join('');
  $$<HTMLButtonElement>('.city-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const city = PRESET_CITIES.find((c) => c.id === chip.dataset.city);
      if (!city) return;
      state.area = { name: city.name, context: city.country, center: city.center, zoomHint: city.zoom };
      updateAreaHeader(city.name);
      void loadArea(city.center, { label: city.name, zoom: city.zoom });
      closeMobilePanels();
    });
  });

  $$('.layer-row').forEach((row) => {
    row.addEventListener('click', () => {
      const element = row as HTMLElement;
      const sceneKey = element.dataset.scene as 'terrain' | 'buildings' | undefined;
      if (sceneKey) {
        // Terrain and massing are mutually exclusive, so enabling one clears
        // the other rather than letting the user build an unreadable scene.
        const next = !state.scene[sceneKey];
        state.scene[sceneKey] = next;
        if (next) state.scene[sceneKey === 'terrain' ? 'buildings' : 'terrain'] = false;
        applySceneMode();
        showToast(
          next
            ? sceneKey === 'terrain'
              ? '3D RELIEF ON / 建筑体块已隐藏'
              : 'CITY MASSING ON / 三维地形已关闭'
            : sceneKey === 'terrain'
              ? '3D RELIEF OFF / 返回平面底图'
              : 'CITY MASSING OFF / 建筑体块已隐藏',
          'info',
          2400,
        );
        return;
      }
      const kind = element.dataset.kind as FeatureKind;
      if (!kind) return;
      state.visibleKinds[kind] = !state.visibleKinds[kind];
      updateLayerButtons();
    });
  });

  depthSlider.addEventListener('input', () => {
    stopAutoScan();
    setScanValue(Number(depthSlider.value));
  });

  apertureSlider.addEventListener('input', () => {
    state.aperture = Number(apertureSlider.value);
    updateApertureUI();
    layer.setAperture(state.aperture / 2);
  });

  apertureSlider.addEventListener('change', () => {
    rebuildTags();
    const center = state.center;
    void loadArea(center, { quiet: true });
  });

  $$('.depth-quick button').forEach((button) => {
    button.addEventListener('click', () => {
      stopAutoScan();
      setScanValue(Number((button as HTMLElement).dataset.depth));
    });
  });

  $('#levelDown').addEventListener('click', () => stepStratum(1));
  $('#levelUp').addEventListener('click', () => stepStratum(-1));

  autoScanButton.addEventListener('click', toggleAutoScan);
  $('#diveButton').addEventListener('click', dive);
  $('#resetView').addEventListener('click', resetView);

  registryList.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.registry-item');
    if (!button) return;
    const index = Number(button.dataset.index);
    if (Number.isFinite(index)) selectFeature(index, true);
  });

  $('#closeContact').addEventListener('click', clearSelection);
  $('#focusContact').addEventListener('click', focusSelectedFeature);

  citySearch.addEventListener('input', onSearchInput);
  citySearch.addEventListener('focus', () => {
    if (citySearch.value.trim().length >= 2) onSearchInput();
  });
  citySearch.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchResults.hidden = true;
      citySearch.blur();
    }
    if (event.key === 'Enter') {
      const first = searchResults.querySelector<HTMLButtonElement>('.search-result');
      first?.click();
    }
  });
  document.addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.search-shell')) {
      searchResults.hidden = true;
    }
  });

  const helpModal = $('#helpModal');
  const openHelp = (): void => {
    helpModal.hidden = false;
    requestAnimationFrame(() => helpModal.classList.add('is-open'));
    $('#helpClose').focus();
  };
  const closeHelp = (): void => {
    helpModal.classList.remove('is-open');
    window.setTimeout(() => { helpModal.hidden = true; }, 260);
  };

  $('#helpButton').addEventListener('click', openHelp);
  $('#helpClose').addEventListener('click', closeHelp);
  $$('[data-close-help]').forEach((element) => element.addEventListener('click', closeHelp));

  $('#fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      showToast('FULLSCREEN MODE IS UNAVAILABLE IN THIS BROWSER', 'warning');
    }
  });

  const backdrop = $('#panelBackdrop');
  backdrop.addEventListener('click', closeMobilePanels);
  $('#sitesToggle').addEventListener('click', () => toggleMobilePanel('left'));
  $('#intelToggle').addEventListener('click', () => toggleMobilePanel('right'));
  $('#intelClose').addEventListener('click', closeMobilePanels);
  $('#sitesClose').addEventListener('click', closeMobilePanels);

  retryFeedButton.addEventListener('click', () => {
    void loadArea(state.center, { quiet: true });
  });

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const isFormField =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement;

    if (event.key === 'Escape') {
      if (!helpModal.hidden) { closeHelp(); return; }
      if (!searchResults.hidden) { searchResults.hidden = true; return; }
      if (!contactDrawer.hidden) { clearSelection(); return; }
      closeMobilePanels();
      return;
    }

    // PageDown / PageUp work even from a form field, matching how a slide
    // deck or an elevation viewer behaves.
    if (event.key === 'PageDown') {
      event.preventDefault();
      stepStratum(1);
      return;
    }
    if (event.key === 'PageUp') {
      event.preventDefault();
      stepStratum(-1);
      return;
    }

    if (isFormField) return;
    const key = event.key.toLowerCase();
    if (key === '?' || (event.shiftKey && key === '/')) {
      event.preventDefault();
      openHelp();
    } else if (key === 'f') {
      event.preventDefault();
      citySearch.focus();
      citySearch.select();
    } else if (key === 'd') {
      dive();
    } else if (key === 's') {
      surface();
    } else if (key === 'a') {
      toggleAutoScan();
    } else if (key === 'r') {
      resetView();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      stopAutoScan();
      setScanValue(state.scan + (event.key === 'ArrowUp' ? -4 : 4));
    }
  });

  window.addEventListener('resize', () => {
    // MapLibre only observes the container, which does not always update when
    // the viewport changes (mobile orientation, devtools docking).
    map.resize();
    updateCompassAndReadout();
    closeMobilePanels();
  });

  // A ResizeObserver catches every container change the window event misses,
  // including programmatic viewport resizes and layout shifts. MapLibre defers
  // its own resize to the next frame, so re-assert ours the same way.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        map.resize();
        updateCompassAndReadout();
      });
    });
    observer.observe($('#map'));
  }

  // Last-resort guard: some embedded webviews resize the viewport without
  // dispatching `resize` or notifying observers, which leaves the canvas at a
  // stale size. Comparing the drawing buffer against the viewport is cheap.
  let lastViewport = `${window.innerWidth}x${window.innerHeight}`;
  window.setInterval(() => {
    const next = `${window.innerWidth}x${window.innerHeight}`;
    if (next === lastViewport) return;
    lastViewport = next;
    map.resize();
    updateCompassAndReadout();
  }, 800);
};

const toggleMobilePanel = (side: 'left' | 'right'): void => {
  const panel = side === 'left' ? $('#leftPanel') : $('#rightPanel');
  const other = side === 'left' ? $('#rightPanel') : $('#leftPanel');
  const backdrop = $('#panelBackdrop');
  const isOpen = panel.classList.contains('is-open');
  other.classList.remove('is-open');
  if (isOpen) {
    panel.classList.remove('is-open');
    backdrop.classList.remove('is-visible');
  } else {
    panel.classList.add('is-open');
    backdrop.classList.add('is-visible');
  }
};

const closeMobilePanels = (): void => {
  if (window.innerWidth > 900) return;
  $('#leftPanel').classList.remove('is-open');
  $('#rightPanel').classList.remove('is-open');
  $('#panelBackdrop').classList.remove('is-visible');
};

const addCustomLayer = (): boolean => {
  try {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
    map.triggerRepaint();
    return true;
  } catch {
    return false;
  }
};

let layerAttempts = 0;
const ensureCustomLayer = (): void => {
  if (layerReady) return;
  if (addCustomLayer()) {
    layerReady = true;
    lastSceneOpen = -1;
    updateSceneOpacity();
    return;
  }
  layerAttempts += 1;
  if (layerAttempts < 240) window.setTimeout(ensureCustomLayer, 180);
};

let visualsStarted = false;
const startVisuals = (): void => {
  if (visualsStarted) return;
  visualsStarted = true;
  ensureCustomLayer();
  finishBoot();
  if (!introFlightStarted) {
    introFlightStarted = true;
    map.flyTo({
      center: DEFAULT_CITY.center,
      zoom: DEFAULT_CITY.zoom,
      pitch: DEFAULT_CITY.pitch,
      bearing: DEFAULT_CITY.bearing,
      duration: 2600,
      curve: 1.3,
      essential: true,
    });
  }
  if (!firstAreaStarted) {
    firstAreaStarted = true;
    state.area = {
      name: DEFAULT_CITY.name,
      context: DEFAULT_CITY.country,
      center: DEFAULT_CITY.center,
      zoomHint: DEFAULT_CITY.zoom,
    };
    // The basemap and the extractor share the same connection pool, so the
    // basemap must reach a painted state first. Waiting for a quiet `idle`
    // (rather than just the first `sourcedata`) is what stops the map from
    // coming up blank on a cold cache.
    let begun = false;
    const begin = (): void => {
      if (begun) return;
      begun = true;
      void loadArea(DEFAULT_CITY.center, { label: DEFAULT_CITY.name, quiet: true });
    };
    map.once('idle', () => window.setTimeout(begin, 500));
    // Hard fallback so a never-idle map cannot block extraction forever.
    window.setTimeout(begin, 9_000);
  }
};

const configureMap = (): void => {
  startBootSequence();
  window.setTimeout(startBasemapWatchdog, 900);
  bindUI();
  buildDepthRuler();
  buildLevelLadder();
  updateApertureUI();
  updateDepthUI();
  setFeedUI('idle', 'Search a city or pan the map to load its subsurface.');
  updateAreaHeader(DEFAULT_CITY.name);
  renderAll();
  registerMapEvents();
  updateCompassAndReadout();
  map.once('style.load', () => {
    // The container may still be at its pre-layout size when the map is first
    // built, which would bake a wrong drawing buffer into the canvas.
    map.resize();
    ensureCustomLayer();
    applySceneMode();
    scheduleTerrain();
  });
  // A style reload (which a long intercontinental flyTo can trigger) drops every
  // layer added at runtime. Polling is the only reliable guard: `style.load`
  // fires again but the custom layer is re-added asynchronously afterwards.
  window.setInterval(() => {
    try {
      const style = map.getStyle?.();
      if (!style?.layers) return;
      let repaired = false;
      if (!map.getLayer(CITY_SHELL_LAYER)) {
        ensureCityShell();
        repaired = true;
      }
      if (!map.getLayer(layer.id)) {
        addCustomLayer();
        repaired = true;
      }
      if (!layerReady) layerReady = true;
      if (repaired) {
        // A freshly constructed layer starts hidden; restore the state the user
        // was looking at so switching cities never blanks the excavation.
        layer.setSurfaceRevealed(basemapReady);
        layer.setScanDepth(state.scan);
        layer.setSite(state.center);
        lastSceneOpen = -1;
        updateSceneOpacity();
      }
    } catch {}
  }, 1_000);
  window.setTimeout(startVisuals, 90);
};

configureMap();

if (import.meta.env.DEV) {
  Object.assign(window, {
    __subterra: {
      layer,
      map,
      state,
      loadArea,
      projections: () => layer.getNodeProjections(),
      center: () => layer.projectCenter(),
    },
  });
}
