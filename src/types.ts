export type FeatureKind = 'subway' | 'tunnel' | 'water' | 'utility';

export type NodeKind = 'station' | 'junction' | 'shaft' | 'outfall' | 'poi';

export type DataSource = 'live' | 'preset' | 'hybrid';

export type LngLat = [number, number];

export interface SubFeature {
  id: string;
  name: string;
  kind: FeatureKind;
  coords: LngLat[];
  depth: number;
  depthRange: [number, number];
  source: 'osm' | 'preset';
  tags?: Record<string, string>;
  note?: string;
}

export interface SubNode {
  id: string;
  name: string;
  kind: NodeKind;
  coords: LngLat;
  depth: number;
  source: 'osm' | 'preset';
  detail?: string;
  /** POI category for nodes that came from a mapped point of interest. */
  className?: string;
}

export interface SiteDataset {
  features: SubFeature[];
  nodes: SubNode[];
  source: DataSource;
  updatedAt: number;
  note?: string;
}

/** A place returned by the geocoder, used to fly the camera somewhere new. */
export interface PlaceResult {
  id: string;
  name: string;
  context: string;
  kind: string;
  center: LngLat;
  country: string;
  extent: [number, number, number, number] | null;
}

/** The area currently loaded, which replaces the old fixed "site" concept. */
export interface AreaInfo {
  name: string;
  context: string;
  center: LngLat;
  zoomHint: number;
}

export interface SiteFact {
  label: string;
  value: string;
}

export interface SubsurfaceStats {
  featureCount: number;
  nodeCount: number;
  maxDepth: number;
  totalLengthKm: number;
  byKind: Record<FeatureKind, number>;
  buildingCount: number;
}
