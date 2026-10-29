// AR の姿勢：センサー（ジャイロ＋コンパス）の向きに、合わせで求めた補正を足して使う。
//
// iOS の alpha は起動ごとに基準が変わる相対方位だが、ジャイロ由来で滑らか・安定している。
// そこで「真方位 = alpha から求めた方位 + yawOff」とし、yawOff を
//   - 合わせる前：コンパス（持ち方・磁気偏角を補正）との差の移動平均
//   - 合わせた後：自動合わせ・手動合わせで決めた値に固定
// とする。仰角・傾きは端末ごと・持ち方ごとの一定のくせ（実測で 0.7〜1°）を dPitch/dRoll で補う。

import { angDiff } from '../sensor/orientation';

export interface Correction {
  /** 真方位 − alpha 由来の方位 [deg] */
  yawOff: number;
  /** 仰角の補正 [deg] */
  dPitch: number;
  /** 傾きの補正 [deg] */
  dRoll: number;
}

export interface SensorPose {
  /** alpha 由来の方位（iOS では相対） */
  yaw: number;
  pitch: number;
  roll: number;
}

export interface Pose {
  yaw: number;
  pitch: number;
  roll: number;
}

export function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

export function applyCorrection(s: SensorPose, c: Correction): Pose {
  return { yaw: wrap360(s.yaw + c.yawOff), pitch: s.pitch + c.dPitch, roll: s.roll + c.dRoll };
}

/** 合わせた結果（真の姿勢）と、そのときのセンサー姿勢から補正を求める */
export function correctionFrom(truth: Pose, s: SensorPose): Correction {
  return { yawOff: angDiff(truth.yaw, s.yaw), dPitch: truth.pitch - s.pitch, dRoll: angDiff(truth.roll, s.roll) };
}

/** 角度の指数移動平均（円周上） */
export function emaAngle(prev: number | null, v: number, a: number): number {
  if (prev === null) return wrap360(v);
  return wrap360(prev + a * angDiff(v, prev));
}

/** 35mm換算焦点距離 → 長辺の画角 [deg]（4:3 センサー：長辺 = 対角 43.27mm × 0.8 = 34.6mm） */
export function hfovFrom35mm(f35: number): number {
  return (2 * Math.atan(34.62 / 2 / f35) * 180) / Math.PI;
}

/** 長辺の画角 [deg] → 焦点距離 [px] */
export function focalFromLongFov(fov: number, w: number, h: number): number {
  return Math.max(w, h) / 2 / Math.tan((fov * Math.PI) / 360);
}

export function longFovFromFocal(f: number, w: number, h: number): number {
  return (2 * Math.atan(Math.max(w, h) / 2 / f) * 180) / Math.PI;
}

/**
 * 映像を object-fit: cover で W×H に表示し、さらに中央から zoom 倍に拡大したときの
 * 映像の画素 → 画面の倍率
 */
export function coverScale(vw: number, vh: number, W: number, H: number, zoom = 1): number {
  return Math.max(W / vw, H / vh) * zoom;
}

/**
 * alpha の基準の飛び（iOS で起きることがある）を検出する。
 * 60 Hz 前後の連続したイベントで方位が maxJump 以上変わるのは手の動きではありえない。
 * 真上・真下に近いと方位そのものが不安定なので見ない。
 */
export function alphaJump(prevYaw: number, yaw: number, pitch: number, dtMs: number, maxJump = 20): number | null {
  if (Math.abs(pitch) > 60 || dtMs > 100) return null;
  const d = angDiff(yaw, prevYaw);
  return Math.abs(d) >= maxJump ? d : null;
}

/** 直近 windowMs の姿勢のばらつきが tol 以下なら「静止」 */
export function isSteady(hist: { t: number; yaw: number; pitch: number }[], now: number, windowMs: number, tol: number): boolean {
  const xs = hist.filter((h) => now - h.t <= windowMs);
  if (xs.length < 5 || now - xs[0].t < windowMs * 0.8) return false;
  const y0 = xs[0].yaw;
  let ymin = 0;
  let ymax = 0;
  let pmin = Infinity;
  let pmax = -Infinity;
  for (const h of xs) {
    const d = angDiff(h.yaw, y0);
    ymin = Math.min(ymin, d);
    ymax = Math.max(ymax, d);
    pmin = Math.min(pmin, h.pitch);
    pmax = Math.max(pmax, h.pitch);
  }
  return ymax - ymin <= tol && pmax - pmin <= tol;
}
