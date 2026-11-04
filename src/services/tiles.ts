import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { FeatureKind, LngLat, SubFeature, SubNode } from '../types';

/**
 * Tile-driven subsurface extraction.
 *
 * Every OpenMapTiles vector tile carries `transportation` features with a
 * `brunnel` field (`tunnel` / `bridge` / none), a `class` (`transit`, `rail`,
 * `motorway`, `minor`, ...), a `subclass` and a `layer` integer. That makes the
 * whole planet's mapped underground network reachable from the same tile CDN
 * the basemap already uses — no per-city data preparation, no API quota.
 *
 * `waterway` carries `brunnel` too, so covered rivers and culverts surface as
 * well. `building` carries `render_height` / `render_min_height`, which is what
 * feeds the above-ground massing.
 */

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const TILE_CACHE = new Map<string, Promise<DecodedTile>>();

/** A named roadway/tunnel line, used to label nearby tunnel geometry. */
interface RawName {
  coords: LngLat[];
  name: string;
  klass: string;
}

interface DecodedTile {
  features: RawUnderground[];
  nodes: RawNode[];
  buildings: RawBuilding[];
  names: RawName[];
  pois: RawUndergroundPoi[];
}

export interface RawUnderground {
  id: string;
  coords: LngLat[];
  kind: FeatureKind;
  depth: number;
  name?: string;
  layer?: number;
  klass: string;
  subclass?: string;
  service?: string;
  /** Stable OSM way id, used as the depth-jitter seed across tile seams. */
  wayKey: string;
  depthResolved?: boolean;
}

export interface RawNode {
  id: string;
  coords: LngLat;
  kind: SubNode['kind'];
  name: string;
  depth: number;
  /** POI category, when the node came from a real mapped point of interest. */
  className?: string;
}

/** A mapped point of interest that OSM records below ground level. */
export interface RawUndergroundPoi {
  id: string;
  coords: LngLat;
  name: string;
  className: string;
  level: number;
  depth: number;
}

export interface RawBuilding {
  id: string;
  ring: LngLat[];
  height: number;
  minHeight: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const tileX = (lng: number, z: number): number =>
  Math.floor(((lng + 180) / 360) * Math.pow(2, z));

const tileY = (lat: number, z: number): number => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, z),
  );
};

const tileToLngLat = (
  x: number,
  y: number,
  z: number,
  tileXIndex: number,
  tileYIndex: number,
  extent: number,
): LngLat => {
  const size = Math.pow(2, z);
  // `loadGeometry()` returns coordinates *within this tile* (0..extent), so the
  // tile's own index has to be added before converting to world space.
  const worldX = (tileXIndex + x / extent) / size;
  const worldY = (tileYIndex + y / extent) / size;
  const lngDeg = worldX * 360 - 180;
  const n = Math.PI - 2 * Math.PI * worldY;
  const latDeg = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lngDeg, latDeg];
};

const decodeRing = (
  geometry: Array<{ x: number; y: number }>,
  z: number,
  tx: number,
  ty: number,
  extent: number,
): LngLat[] =>
  geometry.map((point) => tileToLngLat(point.x, point.y, z, tx, ty, extent));

const hash = (value: string): number => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
};

/**
 * Depth inference. Explicit OSM `layer` values (negative integers) map to a
 * plausible depth band; everything else falls back to a per-class prior plus a
 * stable jitter keyed on the feature id, so the same tube always lands at the
 * same depth across reloads and re-queries.
 */
/**
 * Depth inference.
 *
 * The OSM `layer` tag is a *relative stacking order*, not a distance in metres —
 * the OSM wiki is explicit about this. Treating it as metres (the previous
 * `layer * 8.5 + 4`) put the New York subway at 38 m when it actually runs
 * 4–15 m below grade, because it is mostly cut-and-cover.
 *
 * So `layer` is used as an ordinal signal only: each step down adds a modest,
 * mode-appropriate increment on top of a realistic base. The bases below are
 * drawn from published running-tunnel depths for the major systems:
 *
 *   NYC 4–15 m (cut-and-cover) · Paris 5–20 · Tokyo 15–35 · Shanghai 10–25
 *   Beijing 10–20 · Seoul 15–30 · London deep tube 20–40 · Moscow 20–50
 *   Chongqing 20–60 (mountain city, deep mined bores)
 *
 * A median around 14 m plus ~4 m per layer step lands inside all of those
 * bands. The residual jitter is deliberately small (±3 m): it exists to keep
 * parallel bores from z-fighting, not to invent a 34 m spread.
 */
const BASE_DEPTH: Record<FeatureKind, number> = {
  subway: 14,
  tunnel: 15,
  water: 3,
  utility: 5,
};

/** Extra metres per negative `layer` step, per kind. */
const LAYER_STEP: Record<FeatureKind, number> = {
  subway: 4,
  tunnel: 5,
  water: 2,
  utility: 2.5,
};

const MAX_DEPTH: Record<FeatureKind, number> = {
  subway: 55,
  tunnel: 70,
  water: 18,
  utility: 30,
};

/** Mode-specific offset: light rail and monorail run nearer the surface. */
const MODE_OFFSET: Record<string, number> = {
  subway: 0,
  monorail: -5,
  light_rail: -6,
  tram: -8,
  rail: 2,
};

/**
 * A realistic running-tunnel depth band per kind. The lower bound is the
 * shallowest a bore of that type normally sits; the upper bound is the deepest
 * plausible one.
 */
const DEPTH_BAND: Record<FeatureKind, [number, number]> = {
  subway: [8, 42],
  tunnel: [6, 60],
  water: [2, 16],
  utility: [3, 26],
};

/**
 * Maps an OSM `layer` value onto a position inside the band.
 *
 * `layer` is a *relative stacking order*, and its range differs wildly by city:
 * Shanghai uses -10…-1 while Chongqing only uses -4…-2. Multiplying by a fixed
 * metres-per-layer therefore produces absurd depths in Shanghai (85 m) and
 * compressed ones in Chongqing. Normalising by the range actually present in
 * the area being loaded keeps every city inside its realistic band.
 */
interface LayerRange {
  min: number; // most negative layer seen (deepest stacking level)
  max: number; // shallowest negative layer (closest to -1)
}

const inferDepth = (
  kind: FeatureKind,
  layer: number | undefined,
  seed: string,
  subclass?: string,
  range?: LayerRange,
): number => {
  const [lo, hi] = DEPTH_BAND[kind];
  const modeShift = MODE_OFFSET[subclass ?? ''] ?? 0;

  // +-1.2 m of stable jitter separates parallel bores without inventing bands.
  const jitter = (hash(seed) - 0.5) * 2.4;

  let depth: number;
  if (typeof layer === 'number' && layer < 0) {
    if (range && range.min < -1) {
      // 0 = shallowest level (layer -1), 1 = deepest level seen in this area.
      const span = Math.max(1, Math.abs(range.min) - Math.abs(range.max));
      const t = clamp((Math.abs(layer) - Math.abs(range.max)) / span, 0, 1);
      depth = lo + (hi - lo) * t;
    } else {
      // Only one level present: sit in the shallow third of the band.
      depth = lo + (hi - lo) * 0.3;
    }
  } else {
    // No stacking information at all: assume a typical shallow bore.
    depth = lo + (hi - lo) * 0.25;
  }

  return -clamp(depth + modeShift + jitter, 2, hi + 4);
};

/** The most and least negative `layer` present in a set of features. */
const layerRangeOf = (features: RawUnderground[]): LayerRange | undefined => {
  let min = 0;
  let max = -1;
  let seen = false;
  for (const entry of features) {
    if (typeof entry.layer !== 'number' || entry.layer >= 0) continue;
    seen = true;
    if (entry.layer < min) min = entry.layer;
    if (entry.layer > max) max = entry.layer;
  }
  return seen ? { min, max } : undefined;
};

const classify = (
  klass: string,
  subclass: string | undefined,
  brunnel: string | undefined,
  layer: number | undefined,
): FeatureKind | null => {
  const tunnelled = brunnel === 'tunnel' || brunnel === 'both';
  // A negative `layer` is the strongest signal OSM offers: it means the way is
  // below the reference surface. Many metro lines carry `layer` but no
  // `brunnel`, so relying on brunnel alone silently drops them.
  const belowGrade = tunnelled || (typeof layer === 'number' && layer < 0);

  const isRailMode =
    klass === 'transit' || klass === 'rail' ||
    subclass === 'subway' || subclass === 'light_rail' ||
    subclass === 'tram' || subclass === 'monorail';

  if (isRailMode) {
    if (!belowGrade) return null;
    if (klass === 'rail') return 'tunnel';
    return 'subway';
  }

  // Pedestrian, service and track ways are never subsurface infrastructure,
  // even when a mapper marked a footbridge `tunnel`.
  if (klass === 'path' || klass === 'service' || klass === 'track') return null;
  if (!belowGrade) return null;
  if (klass === 'motorway' || klass === 'trunk' || klass === 'primary' || klass === 'secondary' || klass === 'tertiary' || klass === 'minor') {
    return 'tunnel';
  }
  return null;
};

const KIND_WEIGHT: Record<FeatureKind, number> = {
  subway: 3,
  tunnel: 2,
  water: 1.5,
  utility: 1,
};

const simplify = (coords: LngLat[], maxPoints = 90): LngLat[] => {
  if (coords.length <= maxPoints) return coords;
  const step = (coords.length - 1) / (maxPoints - 1);
  const out: LngLat[] = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const point = coords[Math.round(i * step)];
    if (point) out.push(point);
  }
  return out;
};

const parseTile = (
  buffer: ArrayBuffer,
  z: number,
  tx: number,
  ty: number,
): DecodedTile => {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const features: RawUnderground[] = [];
  const nodes: RawNode[] = [];
  const buildings: RawBuilding[] = [];
  const names: RawName[] = [];
  const pois: RawUndergroundPoi[] = [];

  // Road and tunnel names live in their own layer, so collect them first and
  // match by proximity once the tunnel geometry is known.
  const nameLayer = tile.layers.transportation_name;
  if (nameLayer) {
    const extent = nameLayer.extent ?? 4096;
    for (let i = 0; i < nameLayer.length; i += 1) {
      const feature = nameLayer.feature(i);
      if (feature.type !== 2) continue;
      const props = feature.properties as Record<string, unknown>;
      const name =
        (typeof props['name:zh'] === 'string' && props['name:zh']) ||
        (typeof props['name:en'] === 'string' && props['name:en']) ||
        (typeof props.name === 'string' && props.name) ||
        (typeof props.name_en === 'string' && props.name_en) ||
        '';
      if (!name) continue;
      for (const part of feature.loadGeometry() as Array<Array<{ x: number; y: number }>>) {
        const coords = decodeRing(part, z, tx, ty, extent);
        if (coords.length < 2) continue;
        names.push({
          coords,
          name: name.slice(0, 80),
          klass: typeof props.class === 'string' ? props.class : '',
        });
      }
    }
  }

  const transport = tile.layers.transportation;
  if (transport) {
    const extent = transport.extent ?? 4096;
    for (let i = 0; i < transport.length; i += 1) {
      const feature = transport.feature(i);
      const props = feature.properties as Record<string, unknown>;
      const brunnel = typeof props.brunnel === 'string' ? props.brunnel : undefined;
      const klass = typeof props.class === 'string' ? props.class : '';
      const subclass = typeof props.subclass === 'string' ? props.subclass : undefined;
      const layerProp = props.layer;
      const layer = typeof layerProp === 'number' ? layerProp : undefined;
      const kind = classify(klass, subclass, brunnel, layer);
      if (!kind) continue;
      if (feature.type !== 2) continue; // only LineString
      const raw = feature.loadGeometry() as Array<Array<{ x: number; y: number }>>;
      // The vector tile carries a stable OSM way id. Using it (rather than a
      // tile-local counter) is what keeps one physical tunnel at one depth
      // across tile seams — otherwise the hash-driven jitter differs per tile
      // and the line visibly steps.
      const wayId = typeof feature.id === 'number' ? String(feature.id) : `${z}-${tx}-${ty}-${i}`;
      for (let part = 0; part < raw.length; part += 1) {
        const coords = decodeRing(raw[part], z, tx, ty, extent);
        if (coords.length < 2) continue;
        const id = `way-${wayId}-${part}`;
        features.push({
          id,
          coords: simplify(coords),
          kind,
          depth: 0, // filled in after the tile's layer range is known
          wayKey: wayId,
          name: typeof props.name === 'string' ? props.name : undefined,
          layer,
          klass,
          subclass,
          service: typeof props.service === 'string' ? props.service : undefined,
        });
      }
    }
  }

  const waterway = tile.layers.waterway;
  if (waterway) {
    const extent = waterway.extent ?? 4096;
    for (let i = 0; i < waterway.length; i += 1) {
      const feature = waterway.feature(i);
      if (feature.type !== 2) continue;
      const props = feature.properties as Record<string, unknown>;
      const brunnel = typeof props.brunnel === 'string' ? props.brunnel : undefined;
      // Only covered water reads as subsurface; open streams stay on the surface.
      if (brunnel !== 'tunnel' && brunnel !== 'culvert' && brunnel !== 'covered') {
        continue;
      }
      const raw = feature.loadGeometry() as Array<Array<{ x: number; y: number }>>;
      for (let part = 0; part < raw.length; part += 1) {
        const coords = decodeRing(raw[part], z, tx, ty, extent);
        if (coords.length < 2) continue;
        const wayId = typeof feature.id === 'number' ? String(feature.id) : `${z}-${tx}-${ty}-${i}`;
        const id = `water-${wayId}-${part}`;
        const layerProp = props.layer;
        const layer = typeof layerProp === 'number' ? layerProp : undefined;
        features.push({
          id,
          coords: simplify(coords),
          kind: 'water',
          depth: 0, // filled in after the tile's layer range is known
          wayKey: wayId,
          name:
            (typeof props['name:zh'] === 'string' && props['name:zh']) ||
            (typeof props['name:en'] === 'string' && props['name:en']) ||
            (typeof props.name === 'string' ? props.name : undefined) ||
            undefined,
          layer,
          klass: typeof props.class === 'string' ? props.class : 'waterway',
        });
      }
    }
  }

  const building = tile.layers.building;
  if (building) {
    const extent = building.extent ?? 4096;
    for (let i = 0; i < building.length; i += 1) {
      const feature = building.feature(i);
      if (feature.type !== 3) continue; // Polygon
      const props = feature.properties as Record<string, unknown>;
      if (props.hide_3d === true) continue;
      const heightRaw = props.render_height;
      const minRaw = props.render_min_height;
      const height = typeof heightRaw === 'number' ? heightRaw : 12;
      if (height <= 0) continue;
      const minHeight = typeof minRaw === 'number' ? minRaw : 0;
      const raw = feature.loadGeometry() as Array<Array<{ x: number; y: number }>>;
      const outer = raw[0];
      if (!outer || outer.length < 3) continue;
      buildings.push({
        id: `b-${z}-${tx}-${ty}-${i}`,
        ring: outer.map((p) => tileToLngLat(p.x, p.y, z, tx, ty, extent)),
        height,
        minHeight,
      });
    }
  }

  // Underground points of interest: shops, stations, car parks and amenities
  // that OSM records on a negative floor. Tokyo and London map hundreds of
  // these, and they are the only tile data that describes what actually *occupies*
  // the subsurface rather than what passes through it.
  const poiLayer = tile.layers.poi;
  if (poiLayer) {
    for (let i = 0; i < poiLayer.length; i += 1) {
      const feature = poiLayer.feature(i);
      if (feature.type !== 1) continue; // points only
      const props = feature.properties as Record<string, unknown>;
      const levelProp = props.level;
      const level = typeof levelProp === 'number' ? levelProp : Number.parseInt(String(levelProp ?? ''), 10);
      if (!Number.isFinite(level) || level >= 0) continue;
      const name =
        (typeof props['name:zh'] === 'string' && props['name:zh']) ||
        (typeof props['name:en'] === 'string' && props['name:en']) ||
        (typeof props.name === 'string' && props.name) ||
        '';
      if (!name) continue;
      const geometry = feature.loadGeometry() as Array<Array<{ x: number; y: number }>>;
      const point = geometry[0]?.[0];
      if (!point) continue;
      const coords = tileToLngLat(point.x, point.y, z, tx, ty, poiLayer.extent ?? 4096);
      const className = typeof props.class === 'string' ? props.class : 'amenity';
      const wayId = typeof feature.id === 'number' ? String(feature.id) : `${z}-${tx}-${ty}-${i}`;
      pois.push({
        id: `poi-${wayId}`,
        coords,
        name: name.slice(0, 60),
        className,
        level,
        // One building storey is conventionally ~3.5 m below grade.
        depth: -(Math.abs(level) * 3.5 + 3),
      });
    }
  }

  // Depth is resolved at the *area* level, not per tile: the same OSM way can
  // appear in several tiles, and a per-tile layer range would give its segments
  // different depths — the exact seam that produced visible gaps.

  return { features, nodes, buildings, names, pois };
};

const loadTileJson = async (): Promise<string> => {
  const response = await fetch(TILEJSON_URL);
  if (!response.ok) throw new Error(`TileJSON HTTP ${response.status}`);
  const json = (await response.json()) as { tiles?: string[] };
  const template = json.tiles?.[0];
  if (!template) throw new Error('TileJSON has no tile template');
  return template;
};

let tileTemplate: string | null = null;

const getTile = async (z: number, x: number, y: number): Promise<DecodedTile> => {
  const key = `${z}/${x}/${y}`;
  const cached = TILE_CACHE.get(key);
  if (cached) return cached;
  const promise = (async () => {
    // Yield to the renderer: the basemap needs the same connection pool, and
    // flooding it with 100 parallel extractor requests starves MapLibre's own
    // tiles until they are cancelled.
    await tileBudget();
    try {
      if (!tileTemplate) tileTemplate = await loadTileJson();
      const url = tileTemplate!
        .replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Tile HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      return parseTile(buffer, z, x, y);
    } finally {
      releaseTile();
    }
  })();
  TILE_CACHE.set(key, promise);
  promise.catch(() => TILE_CACHE.delete(key));
  return promise;
};

/**
 * Small concurrency gate so extraction never monopolises the network. The
 * basemap is what the user sees first, so it always wins the race for sockets.
 */
const MAX_PARALLEL_TILES = 4;
let activeTiles = 0;
const waiting: Array<() => void> = [];

const tileBudget = (): Promise<void> =>
  new Promise<void>((resolve) => {
    const run = (): void => {
      activeTiles += 1;
      resolve();
    };
    if (activeTiles < MAX_PARALLEL_TILES) {
      run();
    } else {
      waiting.push(run);
    }
  });

const releaseTile = (): void => {
  activeTiles = Math.max(0, activeTiles - 1);
  const next = waiting.shift();
  if (next) next();
};

export interface AreaQuery {
  center: LngLat;
  /** Half-size of the searched box, in metres. */
  radiusMeters: number;
  maxFeatures?: number;
  /** Zoom used to read tiles. 14 carries the full transportation schema. */
  zoom?: number;
}

/**
 * Collects the underground network covering a square area around `center`,
 * reading every tile the area touches at the deepest zoom that still returns
 * line data.
 */
export const fetchAreaUnderground = async (
  query: AreaQuery,
): Promise<{
  features: SubFeature[];
  nodes: SubNode[];
  buildingCount: number;
  pois: SubNode[];
}> => {
  const { center, radiusMeters, maxFeatures = 900, zoom = 14 } = query;
  const z = zoom;
  const latSpan = radiusMeters / 111_320;
  // Convert the metre radius into tile indices at z.
  const corners: LngLat[] = [
    [center[0], center[1]],
    [center[0] + (radiusMeters / (111_320 * Math.cos((center[1] * Math.PI) / 180))), center[1] + latSpan],
    [center[0] - (radiusMeters / (111_320 * Math.cos((center[1] * Math.PI) / 180))), center[1] - latSpan],
  ];
  const xs = corners.map((c) => tileX(c[0], z));
  const ys = corners.map((c) => tileY(c[1], z));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const jobs: Array<Promise<DecodedTile>> = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      jobs.push(getTile(z, x, y));
    }
  }

  const tiles = await Promise.allSettled(jobs);
  const raw: RawUnderground[] = [];
  const names: RawName[] = [];
  const rawPois: RawUndergroundPoi[] = [];
  let buildingCount = 0;
  for (const result of tiles) {
    if (result.status !== 'fulfilled') continue;
    raw.push(...result.value.features);
    names.push(...result.value.names);
    rawPois.push(...result.value.pois);
    buildingCount += result.value.buildings.length;
  }

  // Resolve depths once, over the whole loaded area, so one physical way always
  // lands at one depth no matter which tile its segments came from.
  const areaRange = layerRangeOf(raw);
  for (const entry of raw) {
    entry.depth = inferDepth(entry.kind, entry.layer, entry.wayKey, entry.subclass, areaRange);
  }

  // Only road tunnels get a snapped street name. The name layer holds zero
  // transit entries, so borrowing a name for a metro bore would be wrong.
  const named = raw.map((entry) => {
    if (entry.name) return entry;
    if (entry.kind === 'subway' || entry.kind === 'utility') return entry;
    if (entry.klass !== 'motorway' && entry.klass !== 'trunk' &&
        entry.klass !== 'primary' && entry.klass !== 'secondary' && entry.klass !== 'tertiary') {
      return entry;
    }
    const best = nearestName(entry.coords, names);
    return best ? { ...entry, name: best } : entry;
  });

  // Rank by how load-bearing the infrastructure is, then trim.
  const ranked = named
    .map((entry) => {
      let score = KIND_WEIGHT[entry.kind];
      if (entry.kind === 'subway') score += 2;
      if (typeof entry.layer === 'number' && entry.layer < 0) score += 0.8;
      return { entry, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFeatures)
    .map(({ entry }) => entry);

  const features: SubFeature[] = ranked.map((entry) => ({
    id: entry.id,
    name: entry.name || labelFor(entry),
    kind: entry.kind,
    coords: entry.coords,
    depth: Number(entry.depth.toFixed(1)),
    depthRange: [
      Number((entry.depth - spreadFor(entry.kind)).toFixed(1)),
      Number((entry.depth + spreadFor(entry.kind)).toFixed(1)),
    ],
    source: 'osm',
    tags: {
      class: entry.klass,
      ...(entry.subclass ? { subclass: entry.subclass } : {}),
      ...(typeof entry.layer === 'number' ? { layer: String(entry.layer) } : {}),
    },
    note:
      typeof entry.layer === 'number' && entry.layer < 0
        ? `OSM layer ${entry.layer} · depth inferred`
        : 'Depth inferred from OpenMapTiles brunnel classification',
  }));

  const nodes = deriveNodes(features);

  // Surface the underground POIs as nodes so they get the same floating labels
  // and click-to-inspect treatment as derived junctions.
  const seenPoi = new Set<string>();
  const poiNodes: SubNode[] = [];
  for (const poi of rawPois) {
    const key = poi.name.trim().toLowerCase();
    if (seenPoi.has(key)) continue;
    seenPoi.add(key);
    poiNodes.push({
      id: poi.id,
      coords: poi.coords,
      kind: 'poi',
      name: poi.name,
      depth: Number(poi.depth.toFixed(1)),
      source: 'preset',
      detail: `POI / ${poi.className.toUpperCase()} / L${poi.level}`,
      className: poi.className,
    });
    if (poiNodes.length >= 24) break;
  }

  return { features, nodes, buildingCount, pois: poiNodes };
};

/**
 * Attaches a name to a tunnel. The tiles only carry names for roads, so a
 * subway bore must never borrow the street name above it — that produced
 * confidently wrong labels like "泰山大道西段" on a metro tunnel. Rail geometry
 * gets a classification-based label instead, and road tunnels keep their real
 * street name.
 */
const nearestName = (coords: LngLat[], names: RawName[]): string | null => {
  if (names.length === 0) return null;
  const step = Math.max(1, Math.floor(coords.length / 6));
  let best = 22; // metres; beyond this the match is probably a parallel street
  let bestName: string | null = null;
  for (let i = 0; i < coords.length; i += step) {
    const point = coords[i];
    for (const candidate of names) {
      const inner = Math.max(1, Math.floor(candidate.coords.length / 6));
      for (let j = 0; j < candidate.coords.length; j += inner) {
        const distance = haversineMeters(point, candidate.coords[j]);
        if (distance < best) {
          best = distance;
          bestName = candidate.name;
        }
      }
    }
  }
  return bestName;
};

const haversineMeters = (a: LngLat, b: LngLat): number => {
  const lat = ((a[1] + b[1]) * Math.PI) / 360;
  return Math.hypot((a[0] - b[0]) * 111_320 * Math.cos(lat), (a[1] - b[1]) * 110_574);
};

const spreadFor = (kind: FeatureKind): number => {  switch (kind) {
    case 'subway':
      return 1.6;
    case 'tunnel':
      return 1.4;
    case 'water':
      return 1.1;
    default:
      return 0.8;
  }
};

const KIND_LABEL: Record<FeatureKind, string> = {
  subway: 'Metro bore',
  tunnel: 'Tunnel',
  water: 'Covered water',
  utility: 'Utility',
};

const MODE_LABEL: Record<string, string> = {
  subway: 'Metro bore',
  monorail: 'Monorail bore',
  light_rail: 'Light rail bore',
  tram: 'Tram bore',
  rail: 'Rail bore',
};

const labelFor = (entry: RawUnderground): string => {
  if (entry.kind === 'subway') {
    const mode = MODE_LABEL[entry.subclass ?? ''] ?? 'Transit bore';
    const service = entry.service;
    if (service === 'siding') return `${mode} · siding`;
    if (service === 'yard') return `${mode} · depot`;
    // The layer number is the only stable per-bore identity the tiles carry, so
    // surface it instead of inventing a street name.
    if (typeof entry.layer === 'number') return `${mode} · L${entry.layer}`;
    return mode;
  }
  if (entry.klass === 'rail') {
    return entry.subclass ? `Rail tunnel · ${entry.subclass}` : 'Rail tunnel';
  }
  if (entry.klass === 'motorway') return 'Road tunnel · motorway';
  if (entry.klass === 'trunk') return 'Road tunnel · trunk';
  return `${KIND_LABEL[entry.kind]}${entry.klass ? ` · ${entry.klass}` : ''}`;
};

/**
 * Stations and shafts are not separately tagged in the vector tiles, so nodes
 * are derived where several bores converge — that is where interchanges
 * actually sit, and it keeps the floating labels meaningful.
 */
const deriveNodes = (features: SubFeature[]): SubNode[] => {
  const bores = features.filter((f) => f.kind === 'subway' || f.kind === 'tunnel');
  if (bores.length === 0) return [];

  type Cell = { x: number; y: number; count: number; depth: number; kinds: Set<FeatureKind> };
  const cells = new Map<string, Cell>();
  const gridSize = 0.0016; // roughly 170 m at mid latitudes

  bores.forEach((feature) => {
    feature.coords.forEach((coords, index) => {
      if (index % 3 !== 0) return; // subsample for speed
      const gx = Math.floor(coords[0] / gridSize);
      const gy = Math.floor(coords[1] / gridSize);
      const key = `${gx}:${gy}`;
      const cell = cells.get(key);
      if (cell) {
        cell.count += 1;
        cell.depth += feature.depth;
        cell.kinds.add(feature.kind);
      } else {
        cells.set(key, {
          x: coords[0],
          y: coords[1],
          count: 1,
          depth: feature.depth,
          kinds: new Set([feature.kind]),
        });
      }
    });
  });

  return [...cells.values()]
    .filter((cell) => cell.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((cell, index) => ({
      id: `n-${index}`,
      coords: [cell.x, cell.y] as LngLat,
      kind: cell.kinds.has('subway') ? 'station' : 'junction',
      name: cell.kinds.has('subway')
        ? `Interchange cluster · ${cell.count} bores`
        : `Tunnel junction · ${cell.count} lines`,
      depth: Number((cell.depth / cell.count).toFixed(1)),
      source: 'osm' as const,
      detail: 'DERIVED / CONVERGENCE',
    }));
};

/** Reads building massing for the area, used by the above-ground shell. */
export const fetchAreaBuildings = async (
  center: LngLat,
  radiusMeters: number,
): Promise<RawBuilding[]> => {
  const z = 15;
  const latSpan = radiusMeters / 111_320;
  const lngSpan = radiusMeters / (111_320 * Math.cos((center[1] * Math.PI) / 180));
  const xs = [
    tileX(center[0] - lngSpan, z),
    tileX(center[0] + lngSpan, z),
  ];
  const ys = [tileY(center[1] - latSpan, z), tileY(center[1] + latSpan, z)];
  const jobs: Array<Promise<DecodedTile>> = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) {
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) {
      jobs.push(getTile(z, x, y));
    }
  }
  const results = await Promise.allSettled(jobs);
  const buildings: RawBuilding[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') buildings.push(...result.value.buildings);
  }
  // Highest first so the skyline reads correctly under a vertex budget.
  return buildings.sort((a, b) => b.height - a.height).slice(0, 2400);
};

export const resetTileCache = (): void => {
  TILE_CACHE.clear();
};
