export interface SunRegion {
  id: string;
  /** Accessible Japanese label, also shown on screen. */
  label: string;
  latitude: number;
  longitude: number;
  /** IANA zone whose civil day the sun times are expressed in. */
  timeZone: string;
}

/** Small built-in list: manual choice needs no permission and no network. */
export const SUN_REGIONS: readonly SunRegion[] = [
  { id: 'sapporo', label: '札幌', latitude: 43.1, longitude: 141.4, timeZone: 'Asia/Tokyo' },
  { id: 'tokyo', label: '東京', latitude: 35.7, longitude: 139.7, timeZone: 'Asia/Tokyo' },
  { id: 'osaka', label: '大阪', latitude: 34.7, longitude: 135.5, timeZone: 'Asia/Tokyo' },
  { id: 'naha', label: '那覇', latitude: 26.2, longitude: 127.7, timeZone: 'Asia/Tokyo' },
  { id: 'honolulu', label: 'ホノルル', latitude: 21.3, longitude: -157.9, timeZone: 'Pacific/Honolulu' },
  { id: 'los-angeles', label: 'ロサンゼルス', latitude: 34.1, longitude: -118.2, timeZone: 'America/Los_Angeles' },
  { id: 'new-york', label: 'ニューヨーク', latitude: 40.7, longitude: -74.0, timeZone: 'America/New_York' },
  { id: 'london', label: 'ロンドン', latitude: 51.5, longitude: -0.1, timeZone: 'Europe/London' },
  { id: 'tromso', label: 'トロムソ（ノルウェー）', latitude: 69.6, longitude: 18.9, timeZone: 'Europe/Oslo' },
  { id: 'sydney', label: 'シドニー', latitude: -33.9, longitude: 151.2, timeZone: 'Australia/Sydney' },
  { id: 'auckland', label: 'オークランド', latitude: -36.8, longitude: 174.8, timeZone: 'Pacific/Auckland' },
];

export function findSunRegion(id: string): SunRegion | undefined {
  return SUN_REGIONS.find((region) => region.id === id);
}
