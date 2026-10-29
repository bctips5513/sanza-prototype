// ピンホールカメラモデル（レンズ歪みなし・主点は画像中心）
// 世界座標: 東(E)・北(N)・上(U)。方位は北から時計回り。

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export interface CameraParams {
  /** 光軸の方位 [deg] */
  yaw: number;
  /** 光軸の仰角 [deg] */
  pitch: number;
  /** 傾き [deg]（正 = カメラが時計回りに傾き、写真の水平線は反時計回りに傾く） */
  roll: number;
  /** 焦点距離 [px] */
  focalPx: number;
  width: number;
  height: number;
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** 方位・仰角 [deg] → 単位ベクトル */
export function dirFromAzEl(az: number, el: number): Vec3 {
  const a = az * RAD;
  const e = el * RAD;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

export function azElFromDir(v: Vec3): { az: number; el: number } {
  let az = Math.atan2(v[0], v[1]) / RAD;
  if (az < 0) az += 360;
  return { az, el: Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD };
}

export interface Basis {
  r: Vec3;
  u: Vec3;
  f: Vec3;
}

export function basis(yaw: number, pitch: number, roll: number): Basis {
  const y = yaw * RAD;
  const p = pitch * RAD;
  const q = roll * RAD;
  const f: Vec3 = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  const r0: Vec3 = [Math.cos(y), -Math.sin(y), 0];
  const u0 = cross(r0, f);
  const r = sub(scale(r0, Math.cos(q)), scale(u0, Math.sin(q)));
  const u = add(scale(r0, Math.sin(q)), scale(u0, Math.cos(q)));
  return { r, u, f };
}

/** 世界方向 → 画素座標。カメラの後方なら null */
export function project(cam: CameraParams, b: Basis, v: Vec3): [number, number] | null {
  const z = dot(v, b.f);
  if (z <= 1e-6) return null;
  const x = dot(v, b.r);
  const y = dot(v, b.u);
  return [cam.width / 2 + (cam.focalPx * x) / z, cam.height / 2 - (cam.focalPx * y) / z];
}

/** 画素座標 → 世界方向（単位ベクトル） */
export function unproject(cam: CameraParams, b: Basis, px: number, py: number): Vec3 {
  const a = (px - cam.width / 2) / cam.focalPx;
  const c = -(py - cam.height / 2) / cam.focalPx;
  return norm(add(add(scale(b.r, a), scale(b.u, c)), b.f));
}

/** カメラ軸（世界座標）から yaw/pitch/roll を求める */
export function anglesFromAxes(r: Vec3, f: Vec3): { yaw: number; pitch: number; roll: number } {
  const { az: yaw, el: pitch } = azElFromDir(f);
  const y = yaw * RAD;
  const r0: Vec3 = [Math.cos(y), -Math.sin(y), 0];
  const u0 = cross(r0, f);
  const roll = Math.atan2(-dot(r, u0), dot(r, r0)) / RAD;
  return { yaw, pitch, roll };
}

/** 35mm換算焦点距離（対角 43.27mm 基準）→ 焦点距離 [px] */
export function focalPxFrom35mm(f35: number, width: number, height: number): number {
  return (Math.hypot(width, height) * f35) / Math.hypot(36, 24);
}

export function hfovDeg(cam: Pick<CameraParams, 'focalPx' | 'width'>): number {
  return (2 * Math.atan(cam.width / 2 / cam.focalPx)) / RAD;
}

export function focalPxFromHfov(hfov: number, width: number): number {
  return width / 2 / Math.tan((hfov * RAD) / 2);
}

export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
}

/** 探索の範囲（中心 ± 幅）[deg]。センサーで向きが分かっているときに使う */
export interface PoseWindow {
  yawCenter: number;
  yawRange: number;
  pitchCenter: number;
  pitchRange: number;
  rollCenter: number;
  rollRange: number;
}

/** 範囲 c ± r を step 刻みで（端を含む） */
export function spanSteps(c: number, r: number, step: number): number[] {
  const n = Math.max(1, Math.round((2 * r) / step));
  return Array.from({ length: n + 1 }, (_, i) => c - r + (2 * r * i) / n);
}

/** a から b まで step 刻み（b を超えない。従来の for ループと同じ並び） */
export function stepRange(a: number, b: number, step: number, inclusive = true): number[] {
  const out: number[] = [];
  for (let v = a; inclusive ? v <= b : v < b; v += step) out.push(v);
  return out;
}
