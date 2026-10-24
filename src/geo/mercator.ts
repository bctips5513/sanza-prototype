// Webメルカトル（地理院タイル）座標。u,v は zoom 非依存の正規化座標 [0,1)。
// グローバルピクセル座標 = u * 256 * 2^z

export function lonToU(lon: number): number {
  return (lon + 180) / 360;
}

export function latToV(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2;
}

export function uToLon(u: number): number {
  return u * 360 - 180;
}

export function vToLat(v: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
}

export function worldPixels(z: number): number {
  return 256 * 2 ** z;
}

/** 緯度における zoom z の 1ピクセルの地上距離 [m]（概算） */
export function groundPixelSize(lat: number, z: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / worldPixels(z);
}
