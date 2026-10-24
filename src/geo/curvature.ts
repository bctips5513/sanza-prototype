/** 地球の丸みと大気差による見かけの低下量 [m] = d²/(2R)·(1−k) */
export function apparentDrop(d: number, R: number, k: number): number {
  return ((d * d) / (2 * R)) * (1 - k);
}

/** 観測者から距離 d にある標高 h の点の見かけの仰角 [rad] */
export function apparentElevation(h: number, hObs: number, d: number, R: number, k: number): number {
  return Math.atan2(h - hObs - apparentDrop(d, R, k), d);
}
