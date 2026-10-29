// 画角・傾きの合わせ（第2段階）
//
// 1コマだけだと、画角を変えたときの稜線の伸び縮みを傾きや方位のずれで打ち消せてしまい、画角が決まりにくい。
// そこで向きを変えて撮った数コマを同時に合わせる。コマ同士の向きの差はジャイロで正確に分かっているので、
// 全コマで共通の補正（方位・仰角・傾き）と共通の焦点距離を1組だけ求める。
// あるコマで画面の端にある山が別のコマでは中央にある、という関係から焦点距離がほぼ直接決まり、
// 左右に離れたコマで同じ稜線が合うかどうかから傾きも決まる。

import { makeScorer, SCORE_WIN, type Scorer } from '../photo/autoAlign';
import { basis } from '../photo/camera';
import { edgeDistance } from '../photo/lineMatch';
import { wrap360, type Correction, type SensorPose } from './pose';

export interface CalibFrame {
  /** 縮小したコマの RGBA（全コマ同じ大きさ） */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** そのコマを撮ったときのセンサー姿勢 */
  sensor: SensorPose;
}

export interface CalibInput {
  frames: CalibFrame[];
  /** 今の焦点距離 [px]（コマの画素単位） */
  focalPx: number;
  skyline: Float32Array;
  azStep: number;
  /** 今の補正（第1段階の結果） */
  corr: Correction;
  /** 最後に、写真の境目の線までの距離で詰める（検証用。既定 true） */
  edgeRefine?: boolean;
  /** 探す焦点距離の倍率の範囲（既定 0.6〜1.7） */
  scaleMin?: number;
  scaleMax?: number;
}

export interface CalibResult {
  /** 求めた焦点距離 ÷ 今の焦点距離 */
  scale: number;
  focalPx: number;
  corr: Correction;
  /** 全コマの得点の平均 */
  score: number;
  /** コマごとの得点 */
  perFrame: number[];
  /** 焦点距離を ±6% 変えたときの得点の下がり（大きいほど画角がはっきり決まっている） */
  sharpness: number;
  /** コマの方位の広がり ÷ コマの横の画角 */
  spread: number;
  ok: boolean;
  elapsedMs: number;
}

/** 採用の条件（tests/photos/calibrate.test.ts で決めた） */
export const CALIB_MIN_SPREAD = 0.25;
export const CALIB_MIN_FRAME_SCORE = 1.0;
export const CALIB_MIN_SHARPNESS = 0.08;

const RAD = Math.PI / 180;

export function calibrate(inp: CalibInput): CalibResult {
  const t0 = performance.now();
  const { frames, focalPx: F0 } = inp;
  const scorers: Scorer[] = frames.map((f) => makeScorer({ rgba: f.rgba, width: f.width, height: f.height, skyline: inp.skyline, azStep: inp.azStep }));

  const perFrame = (c: Correction, F: number, win: number): number[] =>
    frames.map((f, i) => scorers[i].score(f.sensor.yaw + c.yawOff, f.sensor.pitch + c.dPitch, f.sensor.roll + c.dRoll, F, win));
  const joint = (c: Correction, F: number, win: number): number => {
    let s = 0;
    for (const v of perFrame(c, F, win)) {
      if (!Number.isFinite(v)) return -Infinity;
      s += v;
    }
    return s / frames.length;
  };

  /** 焦点距離を固定して、共通の補正を山登り法で詰める */
  const optCorr = (c0: Correction, F: number, win: number, steps: number[]): { c: Correction; s: number } => {
    let c = { ...c0 };
    let bs = joint(c, F, win);
    for (const st of steps)
      for (let it = 0; it < 40; it++) {
        let improved = false;
        for (const [dy, dp, dr] of [
          [st, 0, 0],
          [-st, 0, 0],
          [0, st, 0],
          [0, -st, 0],
          [0, 0, st * 2],
          [0, 0, -st * 2],
        ]) {
          const n = { yawOff: c.yawOff + dy, dPitch: c.dPitch + dp, dRoll: c.dRoll + dr };
          const s = joint(n, F, win);
          if (s > bs) {
            bs = s;
            c = n;
            improved = true;
          }
        }
        if (!improved) break;
      }
    return { c, s: bs };
  };

  // 1) 焦点距離の倍率を 2% 刻みで総当たり（倍率ごとに補正を詰める）
  const sMin = inp.scaleMin ?? 0.6;
  const sMax = inp.scaleMax ?? 1.7;
  let best = { scale: 1, c: inp.corr, s: -Infinity };
  for (let sc = sMin; sc <= sMax * 1.0001; sc *= 1.02) {
    const r = optCorr(inp.corr, F0 * sc, SCORE_WIN.coarse, [0.5, 0.2, 0.1]);
    if (r.s > best.s) best = { scale: sc, c: r.c, s: r.s };
  }

  // 2) 焦点距離も含めて細かく詰める
  let { scale, c } = best;
  let bs = joint(c, F0 * scale, SCORE_WIN.fine);
  if (Number.isFinite(best.s))
    for (const st of [0.2, 0.1, 0.05, 0.02]) {
      for (let it = 0; it < 30; it++) {
        const r = optCorr(c, F0 * scale, SCORE_WIN.fine, [st]);
        c = r.c;
        bs = r.s;
        let moved = false;
        for (const df of [1 + st * 0.05, 1 - st * 0.05]) {
          const s = joint(c, F0 * scale * df, SCORE_WIN.fine);
          if (s > bs) {
            bs = s;
            scale *= df;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      }
    }

  // 尖り：焦点距離を ±6% 変えて補正を詰め直しても、得点がどれだけ下がるか
  let neighbor = -Infinity;
  if (Number.isFinite(bs))
    for (const df of [1.06, 1 / 1.06]) neighbor = Math.max(neighbor, optCorr(c, F0 * scale * df, SCORE_WIN.fine, [0.2, 0.1, 0.05]).s);
  const sharpness = Number.isFinite(bs) ? bs - (Number.isFinite(neighbor) ? neighbor : 0) : 0;


  // 3) 境目の線までの距離で詰める（明暗の得点は ±12px の窓で比べるので、画素単位の精度は出にくい）
  if (inp.edgeRefine !== false && Number.isFinite(bs)) {
    const CAP = 6;
    const Ds = frames.map((f) => edgeDistance(f.rgba, f.width, f.height, CAP));
    const nAz = inp.skyline.length;
    const dirs = scorers[0].dirs;
    const edgeCost = (cc: Correction, F: number): number => {
      let tot = 0;
      for (let fi = 0; fi < frames.length; fi++) {
        const fr = frames[fi];
        const w = fr.width;
        const h = fr.height;
        const yaw = fr.sensor.yaw + cc.yawOff;
        const { r, u, f } = basis(yaw, fr.sensor.pitch + cc.dPitch, fr.sensor.roll + cc.dRoll);
        const half = Math.atan(Math.hypot(w, h) / 2 / F) / RAD;
        const stride = Math.max(1, Math.round(1.5 / (F * inp.azStep * RAD)));
        let s = 0;
        let cnt = 0;
        for (let k = Math.floor((yaw - half) / inp.azStep); k <= Math.ceil((yaw + half) / inp.azStep); k += stride) {
          const i = (((k % nAz) + nAz) % nAz) * 3;
          const z = dirs[i] * f[0] + dirs[i + 1] * f[1] + dirs[i + 2] * f[2];
          if (z <= 0.05) continue;
          const x = w / 2 + (F * (dirs[i] * r[0] + dirs[i + 1] * r[1] + dirs[i + 2] * r[2])) / z;
          const y = h / 2 - (F * (dirs[i] * u[0] + dirs[i + 1] * u[1] + dirs[i + 2] * u[2])) / z;
          const xi = Math.round(x);
          const y0 = Math.floor(y);
          if (xi < 0 || xi >= w || y0 < 5 || y0 >= h - 6) continue;
          // 縦方向は線形補間して、画素より細かい動きにも反応させる
          const a = y - y0;
          const D = Ds[fi];
          s += D[xi * h + y0] * (1 - a) + D[xi * h + y0 + 1] * a;
          cnt++;
        }
        if (cnt < 20) return Infinity;
        tot += s / cnt;
      }
      return tot / frames.length;
    };
    const c1 = c;
    const scale1 = scale;
    let ec = edgeCost(c, F0 * scale);
    for (const st of [0.1, 0.05, 0.02, 0.01])
      for (let it = 0; it < 60; it++) {
        let improved = false;
        for (const [dy, dp, dr, df] of [
          [st, 0, 0, 1],
          [-st, 0, 0, 1],
          [0, st, 0, 1],
          [0, -st, 0, 1],
          [0, 0, st * 2, 1],
          [0, 0, -st * 2, 1],
          [0, 0, 0, 1 + st * 0.1],
          [0, 0, 0, 1 - st * 0.1],
        ]) {
          const n = { yawOff: c.yawOff + dy, dPitch: c.dPitch + dp, dRoll: c.dRoll + dr };
          const v = edgeCost(n, F0 * scale * df);
          if (v < ec - 1e-6) {
            ec = v;
            c = n;
            scale *= df;
            improved = true;
          }
        }
        if (!improved) break;
      }
    // 線で詰めた答えが明暗の得点の答えから大きく離れたら、別の線に引っかかったとみなして戻す
    if (Math.abs(scale / scale1 - 1) > 0.03 || Math.abs(c.dRoll - c1.dRoll) > 1 || Math.abs(c.yawOff - c1.yawOff) > 0.5 || Math.abs(c.dPitch - c1.dPitch) > 0.5) {
      c = c1;
      scale = scale1;
    }
    bs = joint(c, F0 * scale, SCORE_WIN.fine);
  }

  const F = F0 * scale;
  const pf = perFrame(c, F, SCORE_WIN.fine);
  const yaws = frames.map((f) => f.sensor.yaw);
  let spreadDeg = 0;
  for (const a of yaws) for (const b of yaws) spreadDeg = Math.max(spreadDeg, Math.abs(((a - b + 540) % 360) - 180));
  const fov = (2 * Math.atan(frames[0].width / 2 / F)) / RAD;
  const spread = spreadDeg / fov;
  const ok =
    frames.length >= 2 &&
    spread >= CALIB_MIN_SPREAD &&
    pf.every((v) => v >= CALIB_MIN_FRAME_SCORE) &&
    sharpness >= CALIB_MIN_SHARPNESS &&
    scale > sMin * 1.01 &&
    scale < sMax / 1.01;
  return {
    scale,
    focalPx: F,
    corr: { yawOff: wrap360(c.yawOff), dPitch: c.dPitch, dRoll: c.dRoll },
    score: bs,
    perFrame: pf,
    sharpness,
    spread,
    ok,
    elapsedMs: performance.now() - t0,
  };
}
