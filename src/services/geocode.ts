import type { AreaInfo, LngLat, PlaceResult } from '../types';

/**
 * Geocoding via Photon (Komoot's OSM-backed geocoder). It is free, keyless, and
 * sends CORS headers, so the browser can call it directly. Nominatim is kept as
 * a secondary so a Photon outage does not block navigation.
 */

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

interface PhotonFeature {
  properties: {
    osm_id?: number;
    osm_type?: string;
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    postcode?: string;
    type?: string;
    osm_key?: string;
    osm_value?: string;
    extent?: [number, number, number, number];
  };
  geometry: { coordinates: [number, number] };
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

export const searchPlaces = async (
  query: string,
  signal?: AbortSignal,
): Promise<PlaceResult[]> => {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  try {
    const url = `${PHOTON}?q=${encodeURIComponent(trimmed)}&limit=8&lang=en`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
    const json = (await response.json()) as PhotonResponse;
    const results = (json.features ?? [])
      .map((feature) => toPlace(feature))
      .filter((place): place is PlaceResult => Boolean(place));
    if (results.length > 0) return results;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
  }

  return searchNominatim(trimmed, signal);
};

const toPlace = (feature: PhotonFeature): PlaceResult | null => {
  const props = feature.properties;
  const coords = feature.geometry?.coordinates;
  if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
    return null;
  }
  const name = props.name?.trim();
  if (!name) return null;
  const kind = props.type ?? props.osm_value ?? 'place';
  const context = [props.city, props.state, props.country]
    .filter((part): part is string => Boolean(part && part !== name))
    .join(' · ');
  return {
    id: `${props.osm_type ?? 'x'}${props.osm_id ?? name}`,
    name,
    context,
    kind,
    center: [coords[0], coords[1]],
    country: props.countrycode?.toUpperCase() ?? '',
    extent: props.extent ?? null,
  };
};

const searchNominatim = async (
  query: string,
  signal?: AbortSignal,
): Promise<PlaceResult[]> => {
  try {
    const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=6&addressdetails=0`;
    const response = await fetch(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const json = (await response.json()) as Array<{
      place_id: number;
      lat: string;
      lon: string;
      name?: string;
      display_name: string;
      type: string;
    }>;
    const places: Array<PlaceResult | null> = json
      .map((entry) => {
        const lat = Number(entry.lat);
        const lon = Number(entry.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        const parts = entry.display_name.split(',').map((p) => p.trim());
        const place: PlaceResult = {
          id: String(entry.place_id),
          name: entry.name || parts[0] || entry.display_name,
          context: parts.slice(1, 4).join(' · '),
          kind: entry.type,
          center: [lon, lat],
          country: '',
          extent: null,
        };
        return place;
      });
    return places.filter((place): place is PlaceResult => place !== null);
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return [];
  }
};

/**
 * Reverse geocode so a free-navigated location still gets a human name in the
 * header. Photon's reverse endpoint only accepts a point when `lang` is omitted
 * on some deployments, so Nominatim does the reverse lookup here.
 */
export const describePoint = async (
  center: LngLat,
  signal?: AbortSignal,
): Promise<AreaInfo | null> => {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${center[1]}&lon=${center[0]}&format=jsonv2&zoom=14&accept-language=en`;
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      name?: string;
      display_name?: string;
      address?: Record<string, string>;
    };
    const address = json.address ?? {};
    const name =
      address.city ||
      address.town ||
      address.village ||
      address.suburb ||
      address.county ||
      json.name ||
      json.display_name?.split(',')[0] ||
      'UNNAMED AREA';
    const context = [address.state, address.country]
      .filter((part): part is string => Boolean(part && part !== name))
      .join(' · ');
    return {
      name,
      context: context || `${center[1].toFixed(3)}°, ${center[0].toFixed(3)}°`,
      center,
      zoomHint: address.city || address.town ? 15.2 : 14.4,
    };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    return null;
  }
};
