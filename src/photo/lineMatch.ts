import { basis, dirFromAzEl } from './camera';

/**
 * 線の一致：計算した稜線の形が、写真の中で横に続く境目の線に一貫して沿う姿勢を探す。
 *
 * 1) 列ごとに、縦方向の変化（明るさ＋色合い）が周囲（縦41px）より際立つ位置を上位2本だけ拾う
 *    （雲と雪の境目のようにかすかでも、周りが滑らかなら拾える。模様の多い所は周囲も変化が大きく拾われにくい）
 * 2) 稜線の各点から最も近い境目までの縦のずれ（上限 8px）の平均が最小の姿勢を探す。
 *    一部だけ強い境目に重なっても、線全体が沿わなければ小さくならない
 *
 * 「空らしさ」を使わないので、霞・雲・雪で空と山の見分けがつきにくい写真を補う。
 * 晴れて稜線の上に別の線（雲の縁など）が無い写真は、従来の方法のほうが強い。
 */

export interface LineMatchInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  focalPx: number;
  skyline: Float32Array;
  azStep: number;
}

export interface LineMatchCandidate {
  yaw: number;
  pitch: number;
  roll: number;
  focalPx: number;
  /** 平均のずれ [px]（小さいほど良い） */
  cost: number;
}

const RAD = Math.PI / 180;
const K = 2;
const MIN_SALIENCE = 2.5;
const CAP = 8;
const COARSE_CAP = 16;

function angDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/** 列ごと・行ごとの「最も近い境目までの縦の距離」（上限 cap）。D[x*h + y] */
export function edgeDistance(rgba: Uint8ClampedArray, w: number, h: number, cap: number): Uint8Array {
  const n = w * h;
  const L = new Float32Array(n);
  const C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2];
    C[i] = rgba[i * 4 + 2] - rgba[i * 4];
  }
  const G = new Float32Array(n);
  for (let y = 2; y < h - 2; y++)
    for (let x = 2; x < w - 2; x++) {
      let g = 0;
      for (let dx = -2; dx <= 2; dx++) {
        const i = y * w + x + dx;
        g += Math.abs(L[i - 2 * w] - L[i + 2 * w]) + 0.7 * Math.abs(C[i - 2 * w] - C[i + 2 * w]);
      }
      G[y * w + x] = g / 5;
    }
  const D = new Uint8Array(w * h).fill(cap);
  const top = Math.max(3, Math.round(h * 0.02));
  const pre = new Float64Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + G[y * w + x];
    const cands: [number, number][] = [];
    for (let y = top; y < h - 3; y++) {
      const g = G[y * w + x];
      if (g < G[(y - 1) * w + x] || g < G[(y + 1) * w + x] || g < G[(y - 2) * w + x] || g < G[(y + 2) * w + x]) continue;
      const a = Math.max(0, y - 20);
      const b = Math.min(h, y + 21);
      const sal = g / ((pre[b] - pre[a]) / (b - a) + 3);
      if (sal >= MIN_SALIENCE) cands.push([y, sal]);
    }
    cands.sort((p, q) => q[1] - p[1]);
    const col = x * h;
    for (const [ey] of cands.slice(0, K))
      for (let d = 0; d < cap; d++) {
        if (ey - d >= 0 && D[col + ey - d] > d) D[col + ey - d] = d;
        if (ey + d < h && D[col + ey + d] > d) D[col + ey + d] = d;
      }
  }
  return D;
}

export function lineMatch(inp: LineMatchInput): LineMatchCandidate[] {
  const { rgba, width: w, height: h, skyline, azStep } = inp;
  const nAz = skyline.length;
  const Dc = edgeDistance(rgba, w, h, COARSE_CAP);
  const Df = edgeDistance(rgba, w, h, CAP);
  const dirs = new Float32Array(nAz * 3);
  for (let i = 0; i < nAz; i++) {
    const v = dirFromAzEl(i * azStep, skyline[i]);
    dirs.set(v, i * 3);
  }
  const F0 = inp.focalPx;

  const cost = (yaw: number, pitch: number, roll: number, F: number, D: Uint8Array, cap: number, spacing: number): number => {
    const { r, u, f } = basis(yaw, pitch, roll);
    const half = Math.atan(Math.hypot(w, h) / 2 / F) / RAD;
    const stride = Math.max(1, Math.round(spacing / (F * azStep * RAD)));
    let s = 0;
    let cnt = 0;
    for (let k = Math.floor((yaw - half) / azStep); k <= Math.ceil((yaw + half) / azStep); k += stride) {
      const i = (((k % nAz) + nAz) % nAz) * 3;
      const z = dirs[i] * f[0] + dirs[i + 1] * f[1] + dirs[i + 2] * f[2];
      if (z <= 0.05) continue;
      const x = Math.round(w / 2 + (F * (dirs[i] * r[0] + dirs[i + 1] * r[1] + dirs[i + 2] * r[2])) / z);
      const y = Math.round(h / 2 - (F * (dirs[i] * u[0] + dirs[i + 1] * u[1] + dirs[i + 2] * u[2])) / z);
      if (x < 0 || x >= w || y < 5 || y >= h - 5) continue;
      s += D[x * h + y];
      cnt++;
    }
    const expect = (2 * Math.atan(w / 2 / F)) / RAD / (azStep * stride);
    if (cnt < Math.max(15, expect * 0.5)) return Infinity;
    return Math.min(cap, s / cnt);
  };

  // 粗い総当たり
  const step = Math.max(0.3, Math.min(1.5, 5 / F0 / RAD));
  const perYaw: LineMatchCandidate[] = [];
  for (let yaw = 0; yaw < 360; yaw += step) {
    let b: LineMatchCandidate = { yaw, pitch: 0, roll: 0, focalPx: F0, cost: Infinity };
    for (const roll of [-6, -3, 0, 3, 6])
      for (const fs of [1, 1.05])
        for (let pitch = -30; pitch <= 25; pitch += step) {
          const v = cost(yaw, pitch, roll, F0 * fs, Dc, COARSE_CAP, 5);
          if (v < b.cost) b = { yaw, pitch, roll, focalPx: F0 * fs, cost: v };
        }
    perYaw.push(b);
  }
  perYaw.sort((a, b) => a.cost - b.cost);
  const seeds: LineMatchCandidate[] = [];
  for (const p of perYaw) {
    if (p.cost === Infinity) break;
    if (seeds.every((s) => Math.abs(angDiff(s.yaw, p.yaw)) > 4)) seeds.push(p);
    if (seeds.length >= 8) break;
  }

  // 細かく詰める
  const refined = seeds.map((s0) => {
    let s = { ...s0, cost: cost(s0.yaw, s0.pitch, s0.roll, s0.focalPx, Df, CAP, 2) };
    for (const st of [0.5, 0.2, 0.1, 0.05, 0.02])
      for (let it = 0; it < 50; it++) {
        let improved = false;
        for (const [dy, dp, dr, df] of [
          [st, 0, 0, 1],
          [-st, 0, 0, 1],
          [0, st, 0, 1],
          [0, -st, 0, 1],
          [0, 0, st * 2, 1],
          [0, 0, -st * 2, 1],
          [0, 0, 0, 1 + st * 0.04],
          [0, 0, 0, 1 - st * 0.04],
        ]) {
          const F = Math.min(F0 * 1.12, Math.max(F0 * 0.9, s.focalPx * df));
          const v = cost(s.yaw + dy, s.pitch + dp, s.roll + dr, F, Df, CAP, 2);
          if (v < s.cost - 1e-6) {
            s = { yaw: s.yaw + dy, pitch: s.pitch + dp, roll: s.roll + dr, focalPx: F, cost: v };
            improved = true;
          }
        }
        if (!improved) break;
      }
    return { ...s, yaw: ((s.yaw % 360) + 360) % 360 };
  });
  refined.sort((a, b) => a.cost - b.cost);
  const unique: LineMatchCandidate[] = [];
  for (const c of refined) if (unique.every((u) => Math.abs(angDiff(u.yaw, c.yaw)) > 2)) unique.push(c);
  return unique;
}
