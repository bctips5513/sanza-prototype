import { describe, expect, it } from 'vitest';
import { autoAlign } from '../src/photo/autoAlign';
import { align1pt } from '../src/photo/align2pt';
import { azElFromDir, basis, dirFromAzEl, project, unproject, type CameraParams } from '../src/photo/camera';

// 不規則な稜線（方位 0.1° 刻み）
const AZ_STEP = 0.1;
const N = 3600;
const skyline = new Float32Array(N);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const bumps = Array.from({ length: 60 }, () => ({ c: rnd() * 360, w: 1 + rnd() * 6, h: rnd() * 2.5 }));
for (let i = 0; i < N; i++) {
  const az = i * AZ_STEP;
  let e = -0.5;
  for (const b of bumps) {
    const d = ((az - b.c + 540) % 360) - 180;
    e = Math.max(e, b.h * Math.max(0, 1 - Math.abs(d) / b.w) - 0.5);
  }
  skyline[i] = e;
}
const skyAt = (az: number) => skyline[Math.round((((az % 360) + 360) % 360) / AZ_STEP) % N];

/** 真のカメラで「空=明るい青、山=暗い緑、手前に白い帯（湖岸のような紛らわしい輪郭）」の画像を作る */
function render(cam: CameraParams): Uint8ClampedArray {
  const b = basis(cam.yaw, cam.pitch, cam.roll);
  const out = new Uint8ClampedArray(cam.width * cam.height * 4);
  for (let y = 0; y < cam.height; y++)
    for (let x = 0; x < cam.width; x++) {
      const { az, el } = azElFromDir(unproject(cam, b, x + 0.5, y + 0.5));
      const o = (y * cam.width + x) * 4;
      let c: number[];
      if (el > skyAt(az)) c = [150, 190, 235];
      else if (el < -8 && el > -8.6) c = [230, 230, 230];
      else c = [60, 90, 60];
      out.set([...c, 255], o);
    }
  return out;
}

describe('自動合わせ', () => {
  it('EXIF方位が34°ずれていても、稜線の形から姿勢を復元する', () => {
    const truth: CameraParams = { yaw: 123.4, pitch: -6.2, roll: -3.1, focalPx: 560, width: 800, height: 600 };
    const r = autoAlign({
      rgba: render(truth),
      width: 800,
      height: 600,
      focalPx: truth.focalPx,
      skyline,
      azStep: AZ_STEP,
      yawCenter: truth.yaw - 34,
      yawRange: 90,
    });
    expect(r.best).not.toBeNull();
    expect(r.confidence).not.toBe('low');
    expect(Math.abs(r.best!.yaw - truth.yaw)).toBeLessThan(0.3);
    // 合成画像は単色の塗り分けで、境目の明暗変化を「下側のきめ」として数えるため仰角が数px上に寄る（実写真では0.2°程度）
    expect(Math.abs(r.best!.pitch - truth.pitch)).toBeLessThan(0.5);
    expect(Math.abs(r.best!.roll - truth.roll)).toBeLessThan(0.6);
  }, 60_000);

  it('稜線のない画像（空だけ）は信頼度「低」', () => {
    const rgba = new Uint8ClampedArray(800 * 600 * 4).fill(200);
    const r = autoAlign({ rgba, width: 800, height: 600, focalPx: 560, skyline, azStep: AZ_STEP, yawCenter: 0, yawRange: 30 });
    expect(r.confidence).toBe('low');
  }, 60_000);
});

describe('1点合わせ', () => {
  it('タップ位置に山頂が来るよう方位・仰角を合わせ、傾き・焦点距離は変えない', () => {
    const cam: CameraParams = { yaw: 267.4, pitch: 0, roll: -2, focalPx: 3960, width: 5712, height: 4284 };
    const dir = dirFromAzEl(301.5, 1.2);
    const r = align1pt(cam, 2345, 1007, dir);
    const c2 = { ...cam, ...r };
    const p = project(c2, basis(c2.yaw, c2.pitch, c2.roll), dir)!;
    expect(p[0]).toBeCloseTo(2345, 3);
    expect(p[1]).toBeCloseTo(1007, 3);
  });
});
