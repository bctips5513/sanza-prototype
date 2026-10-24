import { basis, dirFromAzEl } from './camera';

/**
 * 自動合わせ：写真の「空と山の境目」と計算した最外稜線が最もよく重なるカメラ姿勢を探す。
 *
 * 稜線上の各点で、すぐ上（空のはず）とすぐ下（山のはず）を比べた得点の平均を最大化する。
 * - 空らしさ（明るさ + 青み）：上 − 下。晴天の空に強い
 * - きめ（局所的な明暗変化）：下 − 上。空は雲・曇天でも滑らかで、山肌は岩・雪渓・樹林で細かい。
 *   曇天で雪の山肌が空より明るく写る場合でも効く
 *
 * （境目の鋭さ＝符号なしの明暗変化も試したが、湖岸や雲の縁に引っかかり成績が落ちたため不採用）
 *
 * 1) 広い窓で方位（全周）・仰角・傾きを粗く総当たりし、方位の異なる上位候補を残す
 * 2) 候補ごとに狭い窓で、方位・仰角・傾き・焦点距離（EXIF 値の ±10%）を山登り法で詰める
 *    （iPhone の 35mm 換算焦点距離は公称値で、実際と数 % ずれるため）
 *
 * test-photos/ の実写真 6 枚（晴天・雲・曇天・雪・24〜100mm）で 5 枚正解（方位誤差 0.3° 以内）、
 * 外れた 1 枚は信頼度「低」と判定。1 枚あたり 2〜4 秒（Mac）。
 */

export interface AutoAlignInput {
  /** 縮小した写真の RGBA */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 縮小後の画像での焦点距離 [px]（EXIF からの初期値） */
  focalPx: number;
  /** 最外稜線の仰角 [deg]（方位 i·azStep） */
  skyline: Float32Array;
  azStep: number;
  /** 探索の中心方位と幅（±）[deg]。180 で全周 */
  yawCenter: number;
  yawRange: number;
  /** 得点の重み（検証用） */
  weights?: { sky: number; texture: number };
  /** 焦点距離も詰めるか（既定 true） */
  refineFocal?: boolean;
}

export interface AutoAlignCandidate {
  yaw: number;
  pitch: number;
  roll: number;
  /** 縮小後の画像での焦点距離 [px] */
  focalPx: number;
  score: number;
}

export interface AutoAlignResult {
  best: AutoAlignCandidate | null;
  candidates: AutoAlignCandidate[];
  confidence: 'high' | 'medium' | 'low';
  /** 次点（方位が 2° 以上異なる候補）との得点比 */
  margin: number;
  elapsedMs: number;
}

const RAD = Math.PI / 180;
const COARSE_WIN = 40;
const FINE_WIN = 12;
const DEFAULT_WEIGHTS = { sky: 1, texture: 1 };
/** 粗い総当たりの刻み（画像上の px）と下限 [deg]、稜線上の点の間隔 [px] */
const COARSE_STEP_PX = 6;
const COARSE_MIN_STEP = 0.5;
const COARSE_SPACING_PX = 5;
const FINE_SPACING_PX = 2;

export function angDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

export function autoAlign(inp: AutoAlignInput, onProgress?: (done: number, total: number) => void): AutoAlignResult {
  const t0 = performance.now();
  const { rgba, width: w, height: h, skyline, azStep } = inp;
  const F0 = inp.focalPx;
  const wts = inp.weights ?? DEFAULT_WEIGHTS;
  const nAz = skyline.length;
  const n = w * h;

  // 画素ごとの特徴量
  const L = new Float32Array(n);
  const S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    L[i] = 0.3 * r + 0.59 * g + 0.11 * b;
    S[i] = L[i] + 0.8 * (b - r);
  }
  const T = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      T[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
    }
  // 尺度をそろえる（空らしさは標準偏差、きめは平均で正規化）
  let sMean = 0;
  let tMean = 0;
  for (let i = 0; i < n; i++) {
    sMean += S[i];
    tMean += T[i];
  }
  sMean /= n;
  tMean /= n;
  let sVar = 0;
  for (let i = 0; i < n; i++) sVar += (S[i] - sMean) ** 2;
  const sScale = wts.sky / Math.max(1, Math.sqrt(sVar / n));
  // 平均が極端に小さい画像（単色の塗り分けなど）できめが過大に効かないよう下限を設ける
  const tScale = wts.texture / Math.max(8, tMean);

  // 列ごとの累積和（窓内の平均を O(1) で求める）。空らしさ − きめ を1つにまとめる
  // （きめを境目から離して比べる案も試したが、実写真で信頼度が下がったため不採用）
  const H1 = h + 1;
  const P = new Float32Array(w * H1);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      s += S[i] * sScale - T[i] * tScale;
      P[x * H1 + y + 1] = s;
    }
  }

  // 稜線の方向ベクトル
  const dirs = new Float32Array(nAz * 3);
  for (let i = 0; i < nAz; i++) {
    const v = dirFromAzEl(i * azStep, skyline[i]);
    dirs[i * 3] = v[0];
    dirs[i * 3 + 1] = v[1];
    dirs[i * 3 + 2] = v[2];
  }
  const cx = w / 2;
  const cy = h / 2;

  const score = (yaw: number, pitch: number, roll: number, F: number, win: number): number => {
    const { r, u, f } = basis(yaw, pitch, roll);
    const halfFov = Math.atan(Math.hypot(w, h) / 2 / F) / RAD;
    const spacing = win === FINE_WIN ? FINE_SPACING_PX : COARSE_SPACING_PX;
    const stride = Math.max(1, Math.round(spacing / (F * azStep * RAD)));
    const expected = (2 * Math.atan(w / 2 / F)) / RAD / (azStep * stride);
    const minPts = Math.max(30, expected * 0.4);
    const k0 = Math.floor((yaw - halfFov) / azStep);
    const k1 = Math.ceil((yaw + halfFov) / azStep);
    let s = 0;
    let cnt = 0;
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
      cnt++;
    }
    return cnt >= minPts ? s / cnt : -Infinity;
  };

  // 1) 粗い総当たり
  // 粗い刻みは広い窓（±40px）で拾える程度
  const yawStep = Math.max(COARSE_MIN_STEP, Math.min(1.5, COARSE_STEP_PX / F0 / RAD));
  const pitchStep = yawStep;
  const rolls = [-8, -4, 0, 4, 8];
  const nYaw = Math.ceil((2 * inp.yawRange) / yawStep) + (inp.yawRange >= 180 ? 0 : 1);
  const perYaw: AutoAlignCandidate[] = [];
  for (let iy = 0; iy < nYaw; iy++) {
    const yaw = inp.yawCenter - inp.yawRange + iy * yawStep;
    let best: AutoAlignCandidate = { yaw, pitch: 0, roll: 0, focalPx: F0, score: -Infinity };
    for (const roll of rolls)
      for (let pitch = -40; pitch <= 25; pitch += pitchStep) {
        const s = score(yaw, pitch, roll, F0, COARSE_WIN);
        if (s > best.score) best = { yaw, pitch, roll, focalPx: F0, score: s };
      }
    perYaw.push(best);
    if (onProgress && iy % 20 === 0) onProgress(iy, nYaw);
  }

  const sorted = perYaw.filter((c) => c.score > -Infinity).sort((a, b) => b.score - a.score);
  const seeds: AutoAlignCandidate[] = [];
  for (const c of sorted) {
    if (seeds.every((s) => Math.abs(angDiff(s.yaw, c.yaw)) > 5)) seeds.push(c);
    if (seeds.length >= 8) break;
  }

  // 2) 候補ごとに細かく詰める（焦点距離は EXIF 値の ±10%）
  const fMin = F0 * 0.9;
  const fMax = F0 * 1.1;
  const refineFocal = inp.refineFocal !== false;
  const refined = seeds.map((c0) => {
    let { yaw, pitch, roll } = c0;
    let F = F0;
    let bs = score(yaw, pitch, roll, F, FINE_WIN);
    for (const st of [1, 0.5, 0.2, 0.1, 0.05])
      for (let it = 0; it < 60; it++) {
        let improved = false;
        const steps: [number, number, number, number][] = [
          [st, 0, 0, 1],
          [-st, 0, 0, 1],
          [0, st, 0, 1],
          [0, -st, 0, 1],
          [0, 0, st * 2, 1],
          [0, 0, -st * 2, 1],
        ];
        if (refineFocal) steps.push([0, 0, 0, 1 + st * 0.04], [0, 0, 0, 1 - st * 0.04]);
        for (const [dy, dp, dr, df] of steps) {
          const nf = Math.min(fMax, Math.max(fMin, F * df));
          const s = score(yaw + dy, pitch + dp, roll + dr, nf, FINE_WIN);
          if (s > bs) {
            bs = s;
            yaw += dy;
            pitch += dp;
            roll += dr;
            F = nf;
            improved = true;
          }
        }
        if (!improved) break;
      }
    return { yaw: ((yaw % 360) + 360) % 360, pitch, roll, focalPx: F, score: bs };
  });

  // 同じ答えに収束した候補はまとめる
  refined.sort((a, b) => b.score - a.score);
  const unique: AutoAlignCandidate[] = [];
  for (const c of refined) {
    if (c.score === -Infinity) continue;
    if (unique.every((u) => Math.abs(angDiff(u.yaw, c.yaw)) > 2)) unique.push(c);
  }

  const best = unique[0] ?? null;
  const second = unique[1]?.score;
  const margin = best ? (second !== undefined && second > 0 ? best.score / second : best.score > 0 ? 9.99 : 0) : 0;
  let confidence: AutoAlignResult['confidence'] = 'low';
  if (best && best.score >= 1.5 && margin >= 1.25) confidence = 'high';
  else if (best && best.score >= 0.8 && margin >= 1.1) confidence = 'medium';
  onProgress?.(nYaw, nYaw);
  return { best, candidates: unique, confidence, margin, elapsedMs: performance.now() - t0 };
}
