import { basis, dirFromAzEl, project } from './camera';

/**
 * 空の境目への当てはめ（雲のない空向け）
 *
 * 列ごとに上から見て最初に色が大きく変わる位置（＝空が途切れる位置）を拾い、
 * 計算した最外稜線がそれに重なる方位・仰角・傾き・焦点距離を探す。
 * かすんだ遠くの山でも空との色の差は残るため、手前の尾根に引っかかりにくい。
 * 雲があると雲の縁を拾ってしまうので、当てはまりの悪さ（px）を信頼度として返し、
 * 小さいときだけ採用する。
 */

export interface ProfileInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  focalPx: number;
  skyline: Float32Array;
  azStep: number;
}

export interface ProfileResult {
  yaw: number;
  pitch: number;
  roll: number;
  focalPx: number;
  /** 当てはまりの悪さ [px]（中央値 + 80%点の平均的なずれ） */
  err: number;
  /** 空の境目を拾えた列の割合 */
  coverage: number;
}

const RAD = Math.PI / 180;

/** 列ごとの「空が途切れる位置」。拾えない列は NaN */
export function skyBoundary(rgba: Uint8ClampedArray, w: number, h: number): Float32Array {
  const top = Math.max(5, Math.round(h * 0.03));
  const GAP = 6;
  const TH = 30;
  const edge = new Float32Array(w).fill(NaN);
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = top; y < h - 1; y++) {
      const i = (y * w + x) * 4;
      const j = ((y - GAP) * w + x) * 4;
      const d = Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
      run = d > TH ? run + 1 : 0;
      if (run === 3) {
        edge[x] = y - 2;
        break;
      }
    }
  }
  return edge;
}

export function profileAlign(inp: ProfileInput): ProfileResult | null {
  const { rgba, width: w, height: h, skyline, azStep } = inp;
  const nAz = skyline.length;
  const edge = skyBoundary(rgba, w, h);
  let valid = 0;
  for (let x = 0; x < w; x++) if (Number.isFinite(edge[x])) valid++;
  const coverage = valid / w;
  if (coverage < 0.5) return null;

  const dirs: [number, number, number][] = [];
  for (let i = 0; i < nAz; i++) dirs.push(dirFromAzEl(i * azStep, skyline[i]));
  const res: number[] = [];

  /** 残差の中央値（仰角の補正量）と当てはまりの悪さ */
  const evalPose = (yaw: number, pitch: number, roll: number, F: number, spacing = 2): { err: number; med: number } | null => {
    const cam = { yaw, pitch, roll, focalPx: F, width: w, height: h };
    const b = basis(yaw, pitch, roll);
    const half = Math.atan(w / 2 / F) / RAD + 1;
    const stride = Math.max(1, Math.round(spacing / (F * azStep * RAD)));
    res.length = 0;
    const k0 = Math.floor((yaw - half) / azStep);
    const k1 = Math.ceil((yaw + half) / azStep);
    for (let k = k0; k <= k1; k += stride) {
      const p = project(cam, b, dirs[((k % nAz) + nAz) % nAz]);
      if (!p) continue;
      const x = Math.round(p[0]);
      if (x < 0 || x >= w || !Number.isFinite(edge[x])) continue;
      res.push(edge[x] - p[1]);
    }
    if (res.length < Math.max(20, (w / spacing) * 0.4)) return null;
    res.sort((a, b) => a - b);
    const med = res[res.length >> 1];
    const dev = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
    return { err: (dev[dev.length >> 1] + dev[Math.floor(dev.length * 0.8)]) / 2, med };
  };
  /** 仰角は残差の中央値から決め、もう一度評価する */
  const solve = (yaw: number, roll: number, F: number, pitch0 = 0, spacing = 2) => {
    const a = evalPose(yaw, pitch0, roll, F, spacing);
    if (!a) return null;
    const pitch = pitch0 + Math.atan(a.med / F) / RAD;
    const b = evalPose(yaw, pitch, roll, F, spacing);
    return b ? { err: b.err, pitch } : null;
  };

  const F0 = inp.focalPx;
  let best: ProfileResult | null = null;
  const yawStep = Math.max(0.2, Math.min(1, 3 / F0 / RAD));
  // 粗い総当たりは点の間隔を広げ、傾き・焦点距離も粗くして速くする（細かい調整は後段）
  for (let yaw = 0; yaw < 360; yaw += yawStep)
    for (let roll = -6; roll <= 6; roll += 3)
      for (const fs of [1, 1.05]) {
        const s = solve(yaw, roll, F0 * fs, 0, 6);
        if (s && (!best || s.err < best.err)) best = { yaw, pitch: s.pitch, roll, focalPx: F0 * fs, err: s.err, coverage };
      }
  if (!best) return null;

  // 細かく詰める
  let cur = best;
  for (const st of [0.5, 0.2, 0.1, 0.05, 0.02])
    for (let it = 0; it < 40; it++) {
      let improved = false;
      for (const [dy, dr, df] of [
        [st, 0, 1],
        [-st, 0, 1],
        [0, st * 2, 1],
        [0, -st * 2, 1],
        [0, 0, 1 + st * 0.04],
        [0, 0, 1 - st * 0.04],
      ]) {
        const F = Math.min(F0 * 1.12, Math.max(F0 * 0.9, cur.focalPx * df));
        const s = solve(cur.yaw + dy, cur.roll + dr, F, cur.pitch);
        if (s && s.err < cur.err - 1e-6) {
          cur = { yaw: cur.yaw + dy, pitch: s.pitch, roll: cur.roll + dr, focalPx: F, err: s.err, coverage };
          improved = true;
        }
      }
      if (!improved) break;
    }
  cur.yaw = ((cur.yaw % 360) + 360) % 360;
  return cur;
}
