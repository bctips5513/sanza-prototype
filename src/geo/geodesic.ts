import { Geodesic } from 'geographiclib-geodesic';

// GRS80（地理院が採用する楕円体）
const GRS80 = new Geodesic.Geodesic(6378137, 1 / 298.257222101);

export interface LatLon {
  lat: number;
  lon: number;
}

/** 始点から方位 az [deg]・距離 s [m] 先の点 */
export function direct(lat: number, lon: number, az: number, s: number): LatLon {
  const r = GRS80.Direct(lat, lon, az, s);
  return { lat: r.lat2!, lon: r.lon2! };
}

/** 2点間の距離 [m] と方位 [deg, 0..360) */
export function inverse(lat1: number, lon1: number, lat2: number, lon2: number): { dist: number; az: number } {
  const r = GRS80.Inverse(lat1, lon1, lat2, lon2);
  let az = r.azi1!;
  if (az < 0) az += 360;
  return { dist: r.s12!, az };
}
