// 手前の尾根の輪郭線
//
// 稜線の計算で方位ごとに拾った「輪郭点」（そこで地形が手前と奥に分かれる点）を、
// 隣の方位どうしで仰角と距離が近いものをつないで線にする。
// 短い線や、奥の地形との距離の差が小さい線（同じ斜面の小さな段差）は捨てて、主要な尾根だけを残す。

import type { SkylineResult } from './compute';

export interface Silhouette {
  /** 最初の方位の番号（方位 = i0 × azStep。i0 + j は nAz で折り返す） */
  i0: number;
  /** 方位ごとの仰角 [deg]（途中の欠けは補間済み） */
  elev: Float32Array;
  /** 距離の中央値 [m] */
  dist: number;
  /** 奥の地形までの距離 ÷ 輪郭までの距離 の中央値 */
  ratio: number;
  /** 方位の長さ [deg] */
  span: number;
  /** 目立ち具合（大きいほど主要） */
  score: number;
}

export interface SilhouetteOptions {
  /** 残す最小の方位の長さ [deg] */
  minSpan?: number;
  /** 残す最小の距離の比 */
  minRatio?: number;
  /** つなぐときに許す仰角の差 [deg / 方位1刻み] */
  tolElev?: number;
  /** つなぐときに許す距離の比の差（対数） */
  tolDist?: number;
  /** 欠けてもつなぐ方位の刻み数 */
  gap?: number;
  /** いちばん奥の稜線にこれより近い点は描かない [deg] */
  skylineClear?: number;
  /**
   * これより近い輪郭線は捨てる [m]。山頂では足元の岩（標高データに無い）の陰になって見えないことが多い
   */
  minDist?: number;
}

interface Chain {
  pts: number[]; // [ray, elev, dist, behind] の繰り返し（ray は連番。折り返し前の値）
  lastRay: number;
  lastElev: number;
  lastDist: number;
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};

export function traceSilhouettes(r: SkylineResult, opts: SilhouetteOptions = {}): Silhouette[] {
  const minSpan = opts.minSpan ?? 1.0;
  const minRatio = opts.minRatio ?? 1.3;
  const tolElev = opts.tolElev ?? 0.15;
  const tolDist = opts.tolDist ?? 0.15;
  const gap = opts.gap ?? 2;
  const clear = opts.skylineClear ?? 0.03;
  const minDist = opts.minDist ?? 1000;
  const { nAz, azStep, edgeOff, edgeElev, edgeDist, edgeBehind } = r;
  const sky = r.bandElev[r.bandElev.length - 1];
  if (!edgeOff) return [];

  // 北の継ぎ目で線が切れないよう、輪郭の少ない方位から一周する
  let start = 0;
  for (let i = 1; i < nAz; i++) if (edgeOff[i + 1] - edgeOff[i] < edgeOff[start + 1] - edgeOff[start]) start = i;

  const done: Chain[] = [];
  let active: Chain[] = [];
  for (let s = 0; s <= nAz; s++) {
    const i = (start + s) % nAz;
    const ray = start + s;
    // この方位の輪郭点（奥の稜線に近すぎる点は除く）
    const pts: number[] = [];
    if (s < nAz)
      for (let o = edgeOff[i]; o < edgeOff[i + 1]; o++) if (sky[i] - edgeElev[o] >= clear) pts.push(o);
    // つなぎ先の候補を、ずれの小さい順に1対1で割り当てる
    const pairs: [number, number, number][] = [];
    for (let c = 0; c < active.length; c++) {
      const ch = active[c];
      const steps = ray - ch.lastRay;
      for (let k = 0; k < pts.length; k++) {
        const o = pts[k];
        const de = Math.abs(edgeElev[o] - ch.lastElev) / (tolElev * steps);
        const dd = Math.abs(Math.log(edgeDist[o] / ch.lastDist)) / (tolDist * steps);
        if (de <= 1 && dd <= 1) pairs.push([de + dd, c, k]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedC = new Set<number>();
    const usedK = new Set<number>();
    for (const [, c, k] of pairs) {
      if (usedC.has(c) || usedK.has(k)) continue;
      usedC.add(c);
      usedK.add(k);
      const o = pts[k];
      const ch = active[c];
      ch.pts.push(ray, edgeElev[o], edgeDist[o], edgeBehind[o]);
      ch.lastRay = ray;
      ch.lastElev = edgeElev[o];
      ch.lastDist = edgeDist[o];
    }
    for (let k = 0; k < pts.length; k++) {
      if (usedK.has(k)) continue;
      const o = pts[k];
      active.push({ pts: [ray, edgeElev[o], edgeDist[o], edgeBehind[o]], lastRay: ray, lastElev: edgeElev[o], lastDist: edgeDist[o] });
    }
    const keep: Chain[] = [];
    for (const ch of active) (ray - ch.lastRay >= gap || s === nAz ? done : keep).push(ch);
    active = keep;
  }

  const out: Silhouette[] = [];
  for (const ch of done) {
    const n = ch.pts.length / 4;
    const r0 = ch.pts[0];
    const r1 = ch.pts[(n - 1) * 4];
    const span = (r1 - r0) * azStep;
    if (span < minSpan) continue;
    const dists: number[] = [];
    const ratios: number[] = [];
    for (let j = 0; j < n; j++) {
      dists.push(ch.pts[j * 4 + 2]);
      ratios.push(ch.pts[j * 4 + 3] / ch.pts[j * 4 + 2]);
    }
    const ratio = median(ratios);
    const dist = median(dists);
    if (ratio < minRatio || dist < minDist) continue;
    // 欠けた方位は線形補間し、3点の中央値で細かいぎざぎざを均す
    const len = r1 - r0 + 1;
    const raw = new Float32Array(len);
    for (let j = 0; j < n; j++) {
      const a = ch.pts[j * 4] - r0;
      raw[a] = ch.pts[j * 4 + 1];
      if (j > 0) {
        const pa = ch.pts[(j - 1) * 4] - r0;
        for (let q = pa + 1; q < a; q++) raw[q] = raw[pa] + ((raw[a] - raw[pa]) * (q - pa)) / (a - pa);
      }
    }
    const elev = new Float32Array(len);
    for (let q = 0; q < len; q++) {
      const a = raw[Math.max(0, q - 1)];
      const b = raw[q];
      const c = raw[Math.min(len - 1, q + 1)];
      elev[q] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    }
    out.push({ i0: r0 % nAz, elev, dist, ratio, span, score: span * Math.min(1, Math.log(ratio)) });
  }
  return out.sort((a, b) => b.score - a.score);
}
