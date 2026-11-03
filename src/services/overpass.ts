import type { FeatureKind, LngLat, SiteDataset, SubFeature, SubNode } from '../types';

/**
 * Optional depth enrichment via the Overpass API.
 *
 * The vector tiles already give global coverage of *where* infrastructure runs
 * and roughly how deep (via `layer`). What tiles cannot give is an explicit
 * `tunnel:depth` in metres, which a small minority of OSM ways carry. This
 * module fetches those tags for the loaded area and merges them in, so cities
 * with good OSM depth tagging get surveyed numbers instead of inferred ones.
 *
 * It is strictly additive: if every mirror is unreachable (common on restricted
 * networks) the tile-derived dataset stands on its own.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

type OverpassElement = {
  type: 'way' | 'node';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

export interface DepthProbeResult {
  /** Explicitly tagged depths keyed by rounded coordinate, to match tile geometry. */
  depths: Array<{ coords: LngLat[]; depth: number; name?: string }>;
  endpoint: string;
  elapsed: number;
  taggedCount: number;
}

const parseMeters = (value: string | undefined): number | null => {
  if (!value) return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const meters = Number(match[0]);
  return Number.isFinite(meters) && meters > 0 ? meters : null;
};

export const buildDepthQuery = (center: LngLat, radiusMeters: number): string => {
  const r = Math.round(radiusMeters);
  const bbox = `(around:${r},${center[1]},${center[0]})`;
  return `[out:json][timeout:20];
(
  way["tunnel:depth"]${bbox};
  way["depth:below_surface"]${bbox};
  way["layer"~"^-[1-9]"]["tunnel"]${bbox};
);
out body geom 200;`;
};

const toFeature = (element: OverpassElement): DepthProbeResult['depths'][number] | null => {
  if (!element.geometry || element.geometry.length < 2) return null;
  const tags = element.tags ?? {};
  const depth =
    parseMeters(tags['tunnel:depth']) ??
    parseMeters(tags['depth:below_surface']);
  let resolved = depth;
  if (resolved === null) {
    const layer = Number.parseInt(tags.layer ?? '', 10);
    if (!Number.isFinite(layer) || layer >= 0) return null;
    resolved = Math.abs(layer) * 8.5 + 4;
  }
  const coords = element.geometry
    .map((p) => [p.lon, p.lat] as LngLat)
    .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[1]) <= 85);
  if (coords.length < 2) return null;
  return {
    coords,
    depth: -Math.min(78, Math.max(3, resolved)),
    name: tags['name:zh'] || tags['name:en'] || tags.name,
  };
};

export const fetchTaggedDepths = async (
  center: LngLat,
  radiusMeters: number,
  signal?: AbortSignal,
): Promise<DepthProbeResult | null> => {
  if (signal?.aborted) return null;
  const query = buildDepthQuery(center, radiusMeters);
  const started = performance.now();
  const controllers = new Set<AbortController>();

  const attempts = ENDPOINTS.map(
    (endpoint) =>
      new Promise<DepthProbeResult>((resolve, reject) => {
        const controller = new AbortController();
        controllers.add(controller);
        const abortFromCaller = (): void => controller.abort();
        signal?.addEventListener('abort', abortFromCaller, { once: true });
        const timer = window.setTimeout(() => controller.abort(), 9_000);
        const cleanup = (): void => {
          window.clearTimeout(timer);
          signal?.removeEventListener('abort', abortFromCaller);
          controllers.delete(controller);
        };

        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
          cache: 'no-store',
        })
          .then(async (response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('HTML error page');
            const json = JSON.parse(text) as { elements?: OverpassElement[]; remark?: string };
            if (!Array.isArray(json.elements)) throw new Error('Malformed response');
            const depths = json.elements
              .map(toFeature)
              .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
            resolve({
              depths,
              endpoint,
              elapsed: performance.now() - started,
              taggedCount: depths.length,
            });
          })
          .catch(reject)
          .finally(cleanup);
      }),
  );

  let hardTimeout = 0;
  const timeout = new Promise<never>((_, reject) => {
    hardTimeout = window.setTimeout(() => {
      controllers.forEach((c) => c.abort());
      reject(new Error('Overpass network timed out'));
    }, 10_500);
  });

  try {
    return await Promise.race([Promise.any(attempts), timeout]);
  } catch {
    return null;
  } finally {
    window.clearTimeout(hardTimeout);
    controllers.forEach((c) => c.abort());
  }
};

/**
 * Overrides inferred depths wherever Overpass returned a surveyed value for
 * geometry that passes close to the same place.
 */
export const applyTaggedDepths = (
  dataset: SiteDataset,
  probe: DepthProbeResult,
): SiteDataset => {
  if (probe.depths.length === 0) return dataset;
  let modified = 0;
  const features: SubFeature[] = dataset.features.map((feature) => {
    const anchor = feature.coords[Math.floor(feature.coords.length / 2)];
    if (!anchor) return feature;
    let best: { depth: number; name?: string; distance: number } | null = null;
    for (const tagged of probe.depths) {
      for (const point of tagged.coords) {
        const distance = haversine(anchor, point);
        if (distance > 45) continue;
        if (!best || distance < best.distance) {
          best = { depth: tagged.depth, name: tagged.name, distance };
        }
      }
    }
    if (!best) return feature;
    modified += 1;
    const range: [number, number] = [
      Number((best.depth - 1.2).toFixed(1)),
      Number((best.depth + 1.2).toFixed(1)),
    ];
    return {
      ...feature,
      depth: Number(best.depth.toFixed(1)),
      depthRange: range,
      name: best.name || feature.name,
      note: 'Depth from explicit OSM tunnel/depth tags (Overpass)',
    };
  });
  if (modified === 0) return dataset;
  return {
    ...dataset,
    features,
    source: 'hybrid',
    note: `${modified} contact${modified === 1 ? '' : 's'} carry explicitly tagged OSM depth.`,
  };
};

const haversine = (a: LngLat, b: LngLat): number => {
  const lat = ((a[1] + b[1]) * Math.PI) / 360;
  const dx = (a[0] - b[0]) * 111_320 * Math.cos(lat);
  const dy = (a[1] - b[1]) * 110_574;
  return Math.hypot(dx, dy);
};
