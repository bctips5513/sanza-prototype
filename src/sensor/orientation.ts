// DeviceOrientation（W3C: alpha/beta/gamma, Z-X'-Y'' 順）から背面カメラの向きを求める。
// 地球座標: x = 東, y = 北, z = 上（alpha が絶対方位のとき）。端末座標: x = 右, y = 上（画面の上端）, z = 画面から手前。
// 背面カメラは端末座標の −z 方向を向く。

const RAD = Math.PI / 180;

export type V3 = [number, number, number];

/** 端末座標のベクトルを地球座標へ（R = Rz(alpha)·Rx(beta)·Ry(gamma)） */
export function deviceToWorld(alpha: number, beta: number, gamma: number, v: V3): V3 {
  const a = alpha * RAD;
  const b = beta * RAD;
  const g = gamma * RAD;
  // Ry
  let x = Math.cos(g) * v[0] + Math.sin(g) * v[2];
  let y = v[1];
  let z = -Math.sin(g) * v[0] + Math.cos(g) * v[2];
  // Rx
  const y2 = Math.cos(b) * y - Math.sin(b) * z;
  const z2 = Math.sin(b) * y + Math.cos(b) * z;
  y = y2;
  z = z2;
  // Rz
  const x3 = Math.cos(a) * x - Math.sin(a) * y;
  const y3 = Math.sin(a) * x + Math.cos(a) * y;
  return [x3, y3, z];
}

export interface CameraAngles {
  /** alpha を絶対方位とみなしたときのカメラ方位 [deg, 0..360) */
  headingFromAlpha: number;
  /** カメラの仰角 [deg] */
  elev: number;
  /** 画面の傾き [deg]（正 = 時計回りに傾く。山座同定アプリの roll と同じ向き） */
  roll: number;
}

/**
 * 背面カメラの方位・仰角・傾き。screenAngle は画面の向き（screen.orientation.angle: 0/90/180/270）。
 */
export function cameraAngles(alpha: number, beta: number, gamma: number, screenAngle = 0): CameraAngles {
  const f = deviceToWorld(alpha, beta, gamma, [0, 0, -1]);
  const t = screenAngle * RAD;
  // 画面の右方向（端末座標）：画面の向きに応じて端末の x/y を回す
  const right = deviceToWorld(alpha, beta, gamma, [Math.cos(t), -Math.sin(t), 0]);
  let heading = Math.atan2(f[0], f[1]) / RAD;
  if (heading < 0) heading += 360;
  const elev = Math.asin(Math.max(-1, Math.min(1, f[2]))) / RAD;
  // 画面右端が下がる＝時計回り＝正
  const roll = -Math.asin(Math.max(-1, Math.min(1, right[2]))) / RAD;
  return { headingFromAlpha: heading, elev, roll };
}

export function angDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180;
}

/** 方位の円周平均と円周標準偏差 [deg] */
export function circularStats(deg: number[]): { mean: number; std: number } {
  if (deg.length === 0) return { mean: NaN, std: NaN };
  let s = 0;
  let c = 0;
  for (const d of deg) {
    s += Math.sin(d * RAD);
    c += Math.cos(d * RAD);
  }
  s /= deg.length;
  c /= deg.length;
  let mean = Math.atan2(s, c) / RAD;
  if (mean < 0) mean += 360;
  const R = Math.min(1, Math.hypot(s, c));
  return { mean, std: Math.sqrt(-2 * Math.log(R)) / RAD };
}

export function linearStats(v: number[]): { mean: number; std: number } {
  if (v.length === 0) return { mean: NaN, std: NaN };
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: m, std: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) };
}
