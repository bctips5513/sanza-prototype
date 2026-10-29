import { describe, expect, it } from 'vitest';
import { declinationJapan, holdAngle, magneticHeading } from '../src/sensor/orientation';
import {
  alphaJump,
  applyCorrection,
  correctionFrom,
  coverScale,
  emaAngle,
  focalFromLongFov,
  hfovFrom35mm,
  isSteady,
  longFovFromFocal,
} from '../src/ar/pose';

describe('持ち方と横持ちのコンパス補正', () => {
  it('縦持ち（beta≈94, gamma≈−8）は 0、右側面が上の横持ち（beta≈−178, gamma≈85）は 90', () => {
    expect(holdAngle(94.2, -8.5)).toBe(0);
    expect(holdAngle(-178.1, 85.5)).toBe(90);
    expect(holdAngle(178.4, 85.6)).toBe(90);
    expect(holdAngle(2, 85)).toBe(270);
  });

  it('境目付近では前の持ち方を保つ', () => {
    // 上方向が 50° 傾いた状態：前が縦持ちなら縦のまま
    const b = 90 - 50;
    expect(holdAngle(b, 0, 0)).toBe(0);
  });

  it('実測：横持ちの webkitCompassHeading は 90° 小さい（王ヶ頭 真方位 86.5°）', () => {
    const mag = magneticHeading(10.37, holdAngle(-178.13, 85.49));
    const t = mag - declinationJapan(36.2171, 137.9275);
    expect(Math.abs(t - 86.52)).toBeLessThan(10);
  });

  it('松本付近の磁気偏角は西偏 7° 台', () => {
    const d = declinationJapan(36.21, 137.97);
    expect(d).toBeGreaterThan(7);
    expect(d).toBeLessThan(8);
  });
});

describe('AR の姿勢の補正', () => {
  it('合わせた姿勢とセンサー姿勢から補正を求め、同じセンサー姿勢に足すと元に戻る', () => {
    const sensor = { yaw: 350.2, pitch: 2.1, roll: -0.4 };
    const truth = { yaw: 12.5, pitch: 3.0, roll: 0.3 };
    const c = correctionFrom(truth, sensor);
    const p = applyCorrection(sensor, c);
    expect(p.yaw).toBeCloseTo(12.5, 6);
    expect(p.pitch).toBeCloseTo(3.0, 6);
    expect(p.roll).toBeCloseTo(0.3, 6);
    // カメラを右へ 30° 回しても補正はそのまま効く
    expect(applyCorrection({ ...sensor, yaw: 20.2 }, c).yaw).toBeCloseTo(42.5, 6);
  });

  it('角度の移動平均は 0/360 をまたいでも正しい', () => {
    expect(emaAngle(359, 1, 0.5)).toBeCloseTo(0, 6);
  });

  it('26mm の画角は約 67°、焦点距離と相互に変換できる', () => {
    const fov = hfovFrom35mm(26);
    expect(fov).toBeCloseTo(67.3, 0);
    const f = focalFromLongFov(fov, 1440, 1920);
    expect(longFovFromFocal(f, 1920, 1440)).toBeCloseTo(fov, 6);
  });

  it('cover 表示の倍率', () => {
    expect(coverScale(1440, 1920, 390, 844)).toBeCloseTo(844 / 1920, 6);
    expect(coverScale(1920, 1440, 390, 844, 2)).toBeCloseTo((844 / 1440) * 2, 6);
  });

  it('alpha の基準の飛びは検出し、普通の動きは無視する', () => {
    expect(alphaJump(100, 101.5, 0, 16)).toBeNull();
    expect(alphaJump(100, 190, 0, 16)).toBeCloseTo(90, 6);
    expect(alphaJump(100, 190, 80, 16)).toBeNull();
  });

  it('静止の判定', () => {
    const still = Array.from({ length: 40 }, (_, i) => ({ t: i * 16, yaw: 359.95 + (i % 2) * 0.1, pitch: 1 }));
    expect(isSteady(still, 39 * 16, 600, 0.15)).toBe(true);
    const moving = still.map((h, i) => ({ ...h, yaw: h.yaw + i * 0.05 }));
    expect(isSteady(moving, 39 * 16, 600, 0.15)).toBe(false);
  });
});
