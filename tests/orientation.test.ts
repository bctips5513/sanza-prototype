import { describe, expect, it } from 'vitest';
import { angDiff, cameraAngles, circularStats } from '../src/sensor/orientation';

describe('端末の姿勢 → カメラの向き', () => {
  it('縦持ちで正面（beta=90）：方位 = 360 − alpha、仰角 0、傾き 0', () => {
    const c = cameraAngles(30, 90, 0);
    expect(c.headingFromAlpha).toBeCloseTo(330, 6);
    expect(c.elev).toBeCloseTo(0, 6);
    expect(c.roll).toBeCloseTo(0, 6);
  });

  it('縦持ちで上に10°向ける（beta=100）と仰角 +10°', () => {
    expect(cameraAngles(0, 100, 0).elev).toBeCloseTo(10, 6);
  });

  it('机に置いた状態（beta=0）はカメラが真下', () => {
    expect(cameraAngles(0, 0, 0).elev).toBeCloseTo(-90, 6);
  });

  it('縦持ちで北を向き、画面に垂直な軸まわりに時計回り5°傾ける：傾き +5°', () => {
    // この姿勢は ZXY オイラー角で alpha=−90, beta=85, gamma=90 になる（端末の上端が東へ5°倒れる）
    const c = cameraAngles(-90, 85, 90);
    expect(angDiff(c.headingFromAlpha, 0)).toBeCloseTo(0, 6);
    expect(c.elev).toBeCloseTo(0, 6);
    expect(c.roll).toBeCloseTo(5, 6);
  });

  it('横持ち（画面の向き 90°）でも正面なら仰角 0・傾き 0', () => {
    // 端末を反時計回りに90°倒した横持ちで正面を向く：gamma = −90 付近
    const c = cameraAngles(0, 0, -90, 90);
    expect(c.elev).toBeCloseTo(0, 6);
    expect(c.roll).toBeCloseTo(0, 6);
  });
});

describe('統計', () => {
  it('0°をまたぐ方位の円周平均', () => {
    const s = circularStats([358, 359, 1, 2]);
    expect(Math.abs(angDiff(s.mean, 0))).toBeLessThan(1e-9);
    expect(s.std).toBeLessThan(2);
  });
});
