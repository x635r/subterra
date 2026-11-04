import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import rawStyle from './openfreemap-dark.json';

export const BASEMAP_LABEL_ANCHOR = 'highway_name_other';
export const CITY_SHELL_LAYER = 'subterra-city-shell';
export const CITY_SHELL_EDGE = 'subterra-city-shell-edge';
export const FALLBACK_BASE_LAYER = 'subterra-esri-base';
export const FALLBACK_LABEL_LAYER = 'subterra-esri-labels';

const patchLayer = (
  layers: StyleSpecification['layers'],
  id: string,
  paint: Record<string, unknown>,
): void => {
  const layer = layers.find((entry) => entry.id === id);
  if (!layer) return;
  layer.paint = { ...(layer.paint ?? {}), ...paint } as typeof layer.paint;
};

export const buildBasemapStyle = (): StyleSpecification => {
  const style = structuredClone(rawStyle) as unknown as StyleSpecification;

  style.sources['subterra-esri-base'] = {
    type: 'raster',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    ],
    tileSize: 256,
    maxzoom: 16,
    attribution: 'Tiles © Esri',
  };
  style.sources['subterra-esri-labels'] = {
    type: 'raster',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    ],
    tileSize: 256,
    maxzoom: 16,
    attribution: 'Tiles © Esri',
  };

  patchLayer(style.layers, 'background', { 'background-color': '#04080a' });
  patchLayer(style.layers, 'water', {
    'fill-color': '#07181e',
    'fill-antialias': false,
  });
  patchLayer(style.layers, 'waterway', {
    'line-color': '#1b3d43',
    'line-opacity': 0.85,
  });
  patchLayer(style.layers, 'landuse_residential', {
    'fill-color': '#081013',
    'fill-opacity': 0.42,
  });
  const woodLayer = style.layers.find((entry) => entry.id === 'landcover_wood');
  if (woodLayer?.paint) {
    delete (woodLayer.paint as Record<string, unknown>)['fill-pattern'];
    woodLayer.paint = {
      ...woodLayer.paint,
      'fill-color': '#0a1715',
      'fill-opacity': 0.35,
    } as typeof woodLayer.paint;
  }
  patchLayer(style.layers, 'landuse_park', {
    'fill-color': '#0a1715',
    'fill-opacity': 0.4,
  });
  // The stock building layer is a flat footprint fill; the 3D shell below
  // replaces it, so keep this one only as a sub-zoom footprint hint.
  patchLayer(style.layers, 'building', {
    'fill-color': '#0a1518',
    'fill-outline-color': '#152a2d',
  });
  patchLayer(style.layers, 'highway_path', { 'line-color': '#1a2b2b' });
  patchLayer(style.layers, 'highway_minor', {
    'line-color': '#243a3b',
    'line-opacity': 0.82,
  });
  patchLayer(style.layers, 'highway_major_casing', {
    'line-color': '#050b0c',
    'line-opacity': 0.85,
  });
  patchLayer(style.layers, 'highway_major_inner', {
    'line-color': '#345454',
    'line-opacity': 0.8,
  });
  patchLayer(style.layers, 'highway_major_subtle', {
    'line-color': '#2b4747',
  });
  patchLayer(style.layers, 'highway_motorway_casing', {
    'line-color': '#050b0c',
  });
  patchLayer(style.layers, 'highway_motorway_inner', {
    'line-color': [
      'interpolate',
      ['linear'],
      ['zoom'],
      5.8,
      'rgba(132, 180, 174, 0.52)',
      6,
      '#4b7270',
    ],
  });
  patchLayer(style.layers, 'highway_motorway_subtle', {
    'line-color': '#355756',
  });
  patchLayer(style.layers, 'railway_transit', {
    'line-color': '#355459',
  });
  patchLayer(style.layers, 'railway_transit_dashline', {
    'line-color': '#0a1517',
  });
  patchLayer(style.layers, 'railway', { 'line-color': '#32484a' });
  patchLayer(style.layers, 'railway_dashline', {
    'line-color': '#081113',
  });
  patchLayer(style.layers, 'water_name', {
    'text-color': '#6f9493',
  });
  patchLayer(style.layers, 'highway_name_other', {
    'text-color': '#6f8c89',
  });
  patchLayer(style.layers, 'highway_name_motorway', {
    'text-color': '#87a9a4',
  });
  patchLayer(style.layers, 'place_other', {
    'text-color': '#829b97',
  });
  patchLayer(style.layers, 'place_suburb', {
    'text-color': '#738d89',
  });
  patchLayer(style.layers, 'place_city', {
    'text-color': '#8aa8a3',
  });
  patchLayer(style.layers, 'boundary_state', {
    'line-color': '#284443',
    'line-opacity': 0.4,
  });
  patchLayer(style.layers, 'boundary_country_z0-4', {
    'line-color': '#2f4e4c',
    'line-opacity': 0.45,
  });
  patchLayer(style.layers, 'boundary_country_z5-', {
    'line-color': '#2f4e4c',
    'line-opacity': 0.45,
  });

  const labelAnchorIndex = style.layers.findIndex(
    (entry) => entry.id === BASEMAP_LABEL_ANCHOR,
  );
  const insertAt = labelAnchorIndex >= 0 ? labelAnchorIndex : style.layers.length;

  style.layers.splice(
    1,
    0,
    {
      id: FALLBACK_BASE_LAYER,
      type: 'raster',
      source: 'subterra-esri-base',
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 1,
        'raster-contrast': 0.32,
        'raster-brightness-min': 0.04,
        'raster-brightness-max': 1,
        'raster-saturation': 0.12,
      },
    } as StyleSpecification['layers'][number],
  );

  // Global 3D massing driven straight from the OpenMapTiles building source.
  // `render_height` / `render_min_height` are pre-computed by the tile schema,
  // so this works for every city on earth without any per-city data file.
  style.layers.splice(insertAt, 0, {
    id: CITY_SHELL_LAYER,
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'render_height'], 12],
        0,
        '#2f6a70',
        24,
        '#418c8e',
        70,
        '#5fb3ac',
        160,
        '#8ad6cc',
      ],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.72,
      'fill-extrusion-vertical-gradient': true,
    },
  } as StyleSpecification['layers'][number]);

  style.layers.splice(insertAt + 1, 0, {
    id: CITY_SHELL_EDGE,
    type: 'line',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 14.5,
    paint: {
      'line-color': '#77d9cd',
      'line-opacity': 0.12,
      'line-width': 0.5,
    },
  } as StyleSpecification['layers'][number]);

  style.layers.push(
    {
      id: FALLBACK_LABEL_LAYER,
      type: 'raster',
      source: 'subterra-esri-labels',
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 0.92,
        'raster-contrast': 0.14,
      },
    } as StyleSpecification['layers'][number],
  );

  return style;
};
