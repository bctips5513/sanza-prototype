import { it } from 'vitest';
import { basis, project, unproject, type CameraParams } from '../../src/photo/camera';
import { calibrate, type CalibFrame } from '../../src/ar/calibrate';
import { loadCase, loadTruth } from './harness';

// AR の画角合わせ（第2段階）の評価。
// 実写真から、正解の姿勢を少しずつ回した仮想カメラの映像（写真の中央 50% 程度の画角）を作り、
// 「カメラを左右に振って撮った数コマ」とみなす。センサーには一定のくせ（方位・仰角・傾き）と小さな雑音を足し、
// 第1段階の結果として、画角が −20〜+25% ずれ、傾きが 1° ずれた補正から始める。
const truth = loadTruth();
const RAD = Math.PI / 180;
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/** 写真（姿勢 src）を、姿勢 dst・大きさ vw×vh の仮想カメラから見た画像に描き直す（回転だけなら正確） */
function renderView(rgba: Uint8ClampedArray, w: number, h: number, src: CameraParams, dst: CameraParams): Uint8ClampedArray {
  const bs = basis(src.yaw, src.pitch, src.roll);
  const bd = basis(dst.yaw, dst.pitch, dst.roll);
  const out = new Uint8ClampedArray(dst.width * dst.height * 4);
  for (let y = 0; y < dst.height; y++)
    for (let x = 0; x < dst.width; x++) {
      const p = project(src, bs, unproject(dst, bd, x + 0.5, y + 0.5));
      const o = (y * dst.width + x) * 4;
      out[o + 3] = 255;
      if (!p) continue;
      const fx = p[0] - 0.5;
      const fy = p[1] - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const v00 = rgba[(y0 * w + x0) * 4 + c];
        const v10 = rgba[(y0 * w + x0 + 1) * 4 + c];
        const v01 = rgba[((y0 + 1) * w + x0) * 4 + c];
        const v11 = rgba[((y0 + 1) * w + x0 + 1) * 4 + c];
        out[o + c] = (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
      }
    }
  return out;
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
}

it.skipIf(Object.keys(truth).length === 0)('数コマを同時に合わせて画角と傾きを求める', async () => {
  const rows: string[] = [];
  let pass = 0;
  let total = 0;
  for (const name of Object.keys(truth)) {
    const c = await loadCase(name);
    const t = truth[name];
    const F = c.w / 2 / Math.tan((t.hfov * RAD) / 2);
    const src: CameraParams = { yaw: t.yaw, pitch: t.pitch, roll: t.roll, focalPx: F, width: c.w, height: c.h };
    // 仮想カメラ：写真の半分の大きさ（同じ焦点距離）。左右に振れるのは写真からはみ出さない範囲
    const vw = Math.round(c.w * 0.5);
    const vh = Math.round(c.h * 0.6);
    const half = Math.atan(c.w / 2 / F) / RAD;
    const vhalf = Math.atan(vw / 2 / F) / RAD;
    const swing = (half - vhalf) * 0.9;
    const bias = { yawOff: 3.2, dPitch: 0.8, dRoll: 1.2 };
    for (const nFrames of [1, 2, 3]) {
      const offs = nFrames === 1 ? [0] : nFrames === 2 ? [-swing, swing] : [-swing, 0, swing];
      const rnd = rng(7);
      const frames: CalibFrame[] = offs.map((dy) => {
        const pose = { yaw: t.yaw + dy, pitch: t.pitch, roll: t.roll };
        const rgba = renderView(c.rgba, c.w, c.h, src, { ...pose, focalPx: F, width: vw, height: vh });
        // センサー = 正解 − くせ + 雑音
        return {
          rgba,
          width: vw,
          height: vh,
          sensor: { yaw: pose.yaw - bias.yawOff + rnd() * 0.1, pitch: pose.pitch - bias.dPitch + rnd() * 0.1, roll: pose.roll - bias.dRoll + rnd() * 0.1 },
        };
      });
      for (const fErr of [0.8, 1.0, 1.25]) for (const edgeRefine of [false, true]) {
        const r = calibrate({
          edgeRefine,
          frames,
          focalPx: F * fErr,
          skyline: c.skyline,
          azStep: c.azStep,
          corr: { yawOff: bias.yawOff + 0.3, dPitch: bias.dPitch + 0.2, dRoll: bias.dRoll + 1.0 },
        });
        const fe = (r.focalPx / F - 1) * 100;
        const re = r.corr.dRoll - bias.dRoll;
        const ye = angDiff(r.corr.yawOff, bias.yawOff);
        const pe = r.corr.dPitch - bias.dPitch;
        const good = Math.abs(fe) < 3.5 && Math.abs(re) < 0.6 && Math.abs(ye) < 0.3;
        if (nFrames > 1 && edgeRefine) {
          total++;
          if (r.ok && good) pass++;
        }
        rows.push(
          `${name}\t${edgeRefine ? '線' : '　'}\t${nFrames}コマ\t画角の初期誤差${((1 / fErr - 1) * 100).toFixed(0)}%\t${r.ok ? '採用' : '見送り'}${good ? '' : '（外れ）'}\t焦点誤差=${fe.toFixed(1)}%\t傾き誤差=${re.toFixed(2)}°\t方位誤差=${ye.toFixed(2)}°\t仰角誤差=${pe.toFixed(2)}°\t尖り=${r.sharpness.toFixed(3)}\t得点=${r.perFrame.map((v) => v.toFixed(2)).join('/')}\t広がり=${r.spread.toFixed(2)}\t${r.elapsedMs.toFixed(0)}ms`,
        );
      }
    }
  }
  console.log(rows.join('\n'));
  console.log(`2コマ以上で採用かつ正確: ${pass}/${total}`);
}, 900_000);
