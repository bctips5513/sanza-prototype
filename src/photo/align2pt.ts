import {
  anglesFromAxes,
  angleBetween,
  cross,
  norm,
  type Vec3,
} from './camera';

export interface AlignPoint {
  /** 写真上の画素座標 */
  px: number;
  py: number;
  /** 対応する山頂の世界方向（単位ベクトル） */
  dir: Vec3;
}

export type AlignResult =
  | { ok: true; yaw: number; pitch: number; roll: number; focalPx: number }
  | { ok: false; reason: string };

function camVec(px: number, py: number, w: number, h: number, F: number): Vec3 {
  return norm([(px - w / 2) / F, -(py - h / 2) / F, 1]);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** 2本のベクトルから直交基底（列ベクトル）を作る：二等分方向・差方向・その外積 */
function triad(a: Vec3, b: Vec3): [Vec3, Vec3, Vec3] {
  const e1 = norm(addv(a, b));
  const e2 = norm(sub(a, b));
  return [e1, e2, cross(e1, e2)];
}

/**
 * 2点合わせ：写真上の2点と山頂の方向から、yaw・pitch・roll・焦点距離を一意に求める。
 * 1) 写真上の2点のなす角 = 2山の角距離 となる焦点距離を二分法で求める
 * 2) 2組のベクトルを一致させる回転を求め、カメラ姿勢に変換する
 */
export function align2pt(p1: AlignPoint, p2: AlignPoint, width: number, height: number): AlignResult {
  const beta = angleBetween(p1.dir, p2.dir);
  if (beta < 1e-5) return { ok: false, reason: '2つの山の方向がほぼ同じです' };
  if (Math.hypot(p1.px - p2.px, p1.py - p2.py) < 3) return { ok: false, reason: '写真上の2点が近すぎます' };

  const alpha = (F: number) =>
    angleBetween(camVec(p1.px, p1.py, width, height, F), camVec(p2.px, p2.py, width, height, F));

  // α(F) は F に対して単調減少
  let lo = Math.log(1);
  let hi = Math.log(1e8);
  if (alpha(Math.exp(lo)) < beta) return { ok: false, reason: '角度が大きすぎて合わせられません' };
  if (alpha(Math.exp(hi)) > beta) return { ok: false, reason: '角度が小さすぎて合わせられません' };
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (alpha(Math.exp(mid)) > beta) lo = mid;
    else hi = mid;
  }
  const F = Math.exp((lo + hi) / 2);

  const c1 = camVec(p1.px, p1.py, width, height, F);
  const c2 = camVec(p2.px, p2.py, width, height, F);
  // カメラ座標 (右, 上, 前) → 世界 (r, u, f) は左手系（行列式 −1）なので、
  // カメラ側の基底の第3軸を反転して M = B·Aᵀ が鏡映を含むようにする
  const [a1, a2, a3c] = triad(c1, c2);
  const a3: Vec3 = [-a3c[0], -a3c[1], -a3c[2]];
  const [b1, b2, b3] = triad(p1.dir, p2.dir);
  // M = B·Aᵀ を カメラ軸 (1,0,0), (0,0,1) に適用
  const apply = (x: Vec3): Vec3 => {
    const s1 = x[0] * a1[0] + x[1] * a1[1] + x[2] * a1[2];
    const s2 = x[0] * a2[0] + x[1] * a2[1] + x[2] * a2[2];
    const s3 = x[0] * a3[0] + x[1] * a3[1] + x[2] * a3[2];
    return [
      b1[0] * s1 + b2[0] * s2 + b3[0] * s3,
      b1[1] * s1 + b2[1] * s2 + b3[1] * s3,
      b1[2] * s1 + b2[2] * s2 + b3[2] * s3,
    ];
  };
  const r = apply([1, 0, 0]);
  const f = apply([0, 0, 1]);
  const ang = anglesFromAxes(r, f);
  return { ok: true, ...ang, focalPx: F };
}

/** 追加点の残差：画素ずれと角度ずれ [deg] */
export function residual(
  projected: [number, number] | null,
  tapped: [number, number],
  dirTrue: Vec3,
  dirTapped: Vec3,
): { dx: number; dy: number; px: number; deg: number } {
  const dx = projected ? projected[0] - tapped[0] : NaN;
  const dy = projected ? projected[1] - tapped[1] : NaN;
  return { dx, dy, px: Math.hypot(dx, dy), deg: (angleBetween(dirTrue, dirTapped) * 180) / Math.PI };
}
