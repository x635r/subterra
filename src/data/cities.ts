import type { LngLat } from '../types';

/**
 * A handful of cities that ship as one-click entry points. They are only
 * convenience shortcuts — the map works anywhere on earth — so the list stays
 * short and is not treated as the set of supported locations.
 */
export interface PresetCity {
  id: string;
  name: string;
  nameZh: string;
  country: string;
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

export const PRESET_CITIES: PresetCity[] = [
  {
    id: 'chongqing',
    name: 'Chongqing',
    nameZh: '重庆',
    country: 'CN',
    center: [106.5311, 29.5882],
    zoom: 15.4,
    bearing: -24,
    pitch: 58,
  },
  {
    id: 'shanghai',
    name: 'Shanghai',
    nameZh: '上海',
    country: 'CN',
    center: [121.4737, 31.2304],
    zoom: 15.2,
    bearing: -12,
    pitch: 58,
  },
  {
    id: 'beijing',
    name: 'Beijing',
    nameZh: '北京',
    country: 'CN',
    center: [116.4074, 39.9042],
    zoom: 15.0,
    bearing: 8,
    pitch: 56,
  },
  {
    id: 'london',
    name: 'London',
    nameZh: '伦敦',
    country: 'GB',
    center: [-0.1064, 51.5142],
    zoom: 15.5,
    bearing: 18,
    pitch: 60,
  },
  {
    id: 'paris',
    name: 'Paris',
    nameZh: '巴黎',
    country: 'FR',
    center: [2.3522, 48.8566],
    zoom: 15.2,
    bearing: 0,
    pitch: 58,
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    nameZh: '东京',
    country: 'JP',
    center: [139.7014, 35.658],
    zoom: 15.6,
    bearing: -8,
    pitch: 60,
  },
  {
    id: 'newyork',
    name: 'New York',
    nameZh: '纽约',
    country: 'US',
    center: [-73.9855, 40.758],
    zoom: 15.3,
    bearing: 28,
    pitch: 58,
  },
  {
    id: 'moscow',
    name: 'Moscow',
    nameZh: '莫斯科',
    country: 'RU',
    center: [37.6173, 55.7558],
    zoom: 15.1,
    bearing: -6,
    pitch: 56,
  },
  {
    id: 'singapore',
    name: 'Singapore',
    nameZh: '新加坡',
    country: 'SG',
    center: [103.8516, 1.2897],
    zoom: 15.4,
    bearing: -18,
    pitch: 58,
  },
  {
    id: 'seoul',
    name: 'Seoul',
    nameZh: '首尔',
    country: 'KR',
    center: [126.9784, 37.5665],
    zoom: 15.3,
    bearing: 12,
    pitch: 58,
  },
];

export const DEFAULT_CITY = PRESET_CITIES[0];
