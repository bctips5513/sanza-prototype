import { basis, dirFromAzEl } from './camera';

/**
 * 自動合わせ：写真の「空と山の境目」と計算した最外稜線が最もよく重なるカメラ姿勢を探す。
 *
 * 得点 = 稜線の各点で「すぐ上の空らしさ − すぐ下の空らしさ」の平均（空らしさ = 明るさ + 青み）。
 * 1) 広い窓で方位・仰角・傾きを粗く総当たりし、方位の異なる上位候補を残す
 *    （細かい明暗だけを見ると湖岸などの輪郭に引っかかるため、広い窓で絞る）
 * 2) 候補ごとに狭い窓で山登り法により詰め、最も得点の高いものを採用する
 */

export interface AutoAlignInput {
  /** 縮小した写真の RGBA */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 縮小後の画像での焦点距離 [px] */
  focalPx: number;
  /** 最外稜線の仰角 [deg]（方位 i·azStep） */
  skyline: Float32Array;
  azStep: number;
  /** 探索の中心方位と幅（±）[deg] */
  yawCenter: number;
  yawRange: number;
}

export interface AutoAlignCandidate {
  yaw: number;
  pitch: number;
  roll: number;
  score: number;
}

export interface AutoAlignResult {
  best: AutoAlignCandidate | null;
  candidates: AutoAlignCandidate[];
  confidence: 'high' | 'medium' | 'low';
  /** 次点との得点比（大きいほど確か） */
  margin: number;
  elapsedMs: number;
}

const RAD = Math.PI / 180;
const COARSE_WIN = 40;
const FINE_WIN = 12;

export function autoAlign(inp: AutoAlignInput, onProgress?: (done: number, total: number) => void): AutoAlignResult {
  const t0 = performance.now();
  const { rgba, width: w, height: h, focalPx: F, skyline, azStep } = inp;
  const nAz = skyline.length;

  // 列ごとの「空らしさ」の累積和（窓内の平均を O(1) で求める）
  const H1 = h + 1;
  const P = new Float32Array(w * H1);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      s += 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2] + 0.8 * (rgba[i + 2] - rgba[i]);
      P[x * H1 + y + 1] = s;
    }
  }

  // 稜線の方向ベクトルを事前計算
  const dirs = new Float32Array(nAz * 3);
  for (let i = 0; i < nAz; i++) {
    const v = dirFromAzEl(i * azStep, skyline[i]);
    dirs[i * 3] = v[0];
    dirs[i * 3 + 1] = v[1];
    dirs[i * 3 + 2] = v[2];
  }

  const halfFov = Math.atan(Math.hypot(w, h) / 2 / F) / RAD;
  // 縮小画像上で約2px間隔になるよう方位を間引く
  const stride = Math.max(1, Math.round(2 / (F * azStep * RAD)));
  const expected = (2 * Math.atan(w / 2 / F)) / RAD / (azStep * stride);
  const minPts = Math.max(30, expected * 0.4);
  const cx = w / 2;
  const cy = h / 2;

  const score = (yaw: number, pitch: number, roll: number, win: number): number => {
    const { r, u, f } = basis(yaw, pitch, roll);
    const k0 = Math.floor((yaw - halfFov) / azStep);
    const k1 = Math.ceil((yaw + halfFov) / azStep);
    let s = 0;
    let n = 0;
    for (let k = k0; k <= k1; k += stride) {
      const i = (((k % nAz) + nAz) % nAz) * 3;
      const vx = dirs[i];
      const vy = dirs[i + 1];
      const vz = dirs[i + 2];
      const z = vx * f[0] + vy * f[1] + vz * f[2];
      if (z <= 0.05) continue;
      const x = Math.round(cx + (F * (vx * r[0] + vy * r[1] + vz * r[2])) / z);
      const y = Math.round(cy - (F * (vx * u[0] + vy * u[1] + vz * u[2])) / z);
      if (x < 0 || x >= w || y < 8 || y >= h - 8) continue;
      const a0 = Math.max(0, y - win);
      const b1 = Math.min(h, y + win);
      const col = x * H1;
      const up = (P[col + y - 2] - P[col + a0]) / (y - 2 - a0);
      const dn = (P[col + b1] - P[col + y + 2]) / (b1 - y - 2);
      s += up - dn;
      n++;
    }
    return n >= minPts ? s / n : -Infinity;
  };

  // 1) 粗い総当たり（方位ごとの最良を記録）
  const yawStep = Math.max(0.25, Math.min(1, (4 / F) / RAD));
  const pitchStep = yawStep;
  const rolls = [-8, -4, 0, 4, 8];
  const nYaw = Math.ceil((2 * inp.yawRange) / yawStep) + 1;
  const perYaw: AutoAlignCandidate[] = [];
  for (let iy = 0; iy < nYaw; iy++) {
    const yaw = inp.yawCenter - inp.yawRange + iy * yawStep;
    let best: AutoAlignCandidate = { yaw, pitch: 0, roll: 0, score: -Infinity };
    for (const roll of rolls)
      for (let pitch = -40; pitch <= 25; pitch += pitchStep) {
        const s = score(yaw, pitch, roll, COARSE_WIN);
        if (s > best.score) best = { yaw, pitch, roll, score: s };
      }
    perYaw.push(best);
    if (onProgress && iy % 20 === 0) onProgress(iy, nYaw);
  }

  // 方位が 5° 以上離れた上位候補
  const sorted = perYaw.filter((c) => c.score > -Infinity).sort((a, b) => b.score - a.score);
  const seeds: AutoAlignCandidate[] = [];
  for (const c of sorted) {
    if (seeds.every((s) => Math.abs(angDiff(s.yaw, c.yaw)) > 5)) seeds.push(c);
    if (seeds.length >= 5) break;
  }

  // 2) 候補ごとに細かく詰める
  const refined = seeds.map((c0) => {
    let { yaw, pitch, roll } = c0;
    let bs = score(yaw, pitch, roll, FINE_WIN);
    for (const st of [0.5, 0.2, 0.1, 0.05])
      for (let it = 0; it < 60; it++) {
        let improved = false;
        for (const [dy, dp, dr] of [
          [st, 0, 0],
          [-st, 0, 0],
          [0, st, 0],
          [0, -st, 0],
          [0, 0, st * 2],
          [0, 0, -st * 2],
        ]) {
          const s = score(yaw + dy, pitch + dp, roll + dr, FINE_WIN);
          if (s > bs) {
            bs = s;
            yaw += dy;
            pitch += dp;
            roll += dr;
            improved = true;
          }
        }
        if (!improved) break;
      }
    return { yaw: ((yaw % 360) + 360) % 360, pitch, roll, score: bs };
  });
  refined.sort((a, b) => b.score - a.score);

  const best = refined[0] && refined[0].score > -Infinity ? refined[0] : null;
  const second = refined[1]?.score ?? 0;
  const margin = best ? best.score / Math.max(1e-6, second > 0 ? second : 1e-6) : 0;
  let confidence: AutoAlignResult['confidence'] = 'low';
  if (best && best.score >= 15 && margin >= 1.2) confidence = 'high';
  else if (best && best.score >= 8 && margin >= 1.08) confidence = 'medium';
  onProgress?.(nYaw, nYaw);
  return { best, candidates: refined, confidence, margin, elapsedMs: performance.now() - t0 };
}

function angDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}
