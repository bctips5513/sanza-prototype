import { describe, expect, it } from 'vitest';
import { apparentDrop } from '../src/geo/curvature';
import { latToV, lonToU, uToLon, vToLat } from '../src/geo/mercator';
import { direct, inverse } from '../src/geo/geodesic';
import {
  anglesFromAxes,
  basis,
  dirFromAzEl,
  focalPxFrom35mm,
  project,
  unproject,
  azElFromDir,
  type CameraParams,
} from '../src/photo/camera';
import { align2pt } from '../src/photo/align2pt';

describe('曲率・大気差', () => {
  it('100 km で約 683 m 低下（R=6371km, k=0.13）', () => {
    expect(apparentDrop(100_000, 6_371_000, 0.13)).toBeCloseTo(682.79, 1);
    expect(apparentDrop(10_000, 6_371_000, 0)).toBeCloseTo(7.848, 2);
  });
});

describe('メルカトル・測地線', () => {
  it('往復変換', () => {
    expect(vToLat(latToV(35.3606))).toBeCloseTo(35.3606, 10);
    expect(uToLon(lonToU(138.7274))).toBeCloseTo(138.7274, 10);
  });
  it('direct/inverse の整合', () => {
    const p = direct(35.36, 138.73, 47.3, 85_000);
    const inv = inverse(35.36, 138.73, p.lat, p.lon);
    expect(inv.dist).toBeCloseTo(85_000, 3);
    expect(inv.az).toBeCloseTo(47.3, 8);
  });
});

describe('カメラ投影', () => {
  const cam: CameraParams = { yaw: 123.4, pitch: 2.5, roll: -1.7, focalPx: 3000, width: 4032, height: 3024 };
  const b = basis(cam.yaw, cam.pitch, cam.roll);

  it('光軸方向は画像中心に投影される', () => {
    const p = project(cam, b, dirFromAzEl(cam.yaw, cam.pitch))!;
    expect(p[0]).toBeCloseTo(2016, 6);
    expect(p[1]).toBeCloseTo(1512, 6);
  });

  it('投影と逆投影が往復する', () => {
    const v = dirFromAzEl(140, 4);
    const p = project(cam, b, v)!;
    const w = unproject(cam, b, p[0], p[1]);
    const ae = azElFromDir(w);
    expect(ae.az).toBeCloseTo(140, 8);
    expect(ae.el).toBeCloseTo(4, 8);
  });

  it('姿勢 → 軸 → 姿勢 が往復する', () => {
    const a = anglesFromAxes(b.r, b.f);
    expect(a.yaw).toBeCloseTo(cam.yaw, 8);
    expect(a.pitch).toBeCloseTo(cam.pitch, 8);
    expect(a.roll).toBeCloseTo(cam.roll, 8);
  });

  it('roll 正（カメラが時計回り）で写真右側の水平線が上がる', () => {
    const c2 = { ...cam, pitch: 0, roll: 5 };
    const b2 = basis(c2.yaw, 0, 5);
    const right = project(c2, b2, dirFromAzEl(c2.yaw + 20, 0))!;
    expect(right[1]).toBeLessThan(c2.height / 2);
  });

  it('35mm換算 26mm・4:3 → 対角基準で水平画角 約67.3°', () => {
    const f = focalPxFrom35mm(26, 4032, 3024);
    const hfov = (2 * Math.atan(2016 / f) * 180) / Math.PI;
    expect(hfov).toBeCloseTo(67.3, 1);
  });
});

describe('2点合わせ', () => {
  it('合成データから姿勢と焦点距離を復元する', () => {
    const truth: CameraParams = { yaw: 251.3, pitch: 1.2, roll: 2.4, focalPx: 2850, width: 4000, height: 3000 };
    const b = basis(truth.yaw, truth.pitch, truth.roll);
    const d1 = dirFromAzEl(240.2, 2.1);
    const d2 = dirFromAzEl(262.8, 0.4);
    const p1 = project(truth, b, d1)!;
    const p2 = project(truth, b, d2)!;
    const r = align2pt({ px: p1[0], py: p1[1], dir: d1 }, { px: p2[0], py: p2[1], dir: d2 }, 4000, 3000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.focalPx).toBeCloseTo(2850, 3);
    expect(r.yaw).toBeCloseTo(251.3, 6);
    expect(r.pitch).toBeCloseTo(1.2, 6);
    expect(r.roll).toBeCloseTo(2.4, 6);
    // 3点目の残差もほぼ 0
    const d3 = dirFromAzEl(255, 1.5);
    const b2 = basis(r.yaw, r.pitch, r.roll);
    const q = project({ ...truth, ...r }, b2, d3)!;
    const t = project(truth, b, d3)!;
    expect(Math.hypot(q[0] - t[0], q[1] - t[1])).toBeLessThan(1e-4);
  });
});
