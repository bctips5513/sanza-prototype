import { it } from 'vitest';
import { basis, project, unproject, type CameraParams } from '../../src/photo/camera';
import { autoAlign } from '../../src/photo/autoAlign';
import { loadCase, loadTruth } from './harness';
// AR の自動で始まる合わせの評価：実写真の中央 50% を仮想カメラの映像とし、画角（焦点距離）が −20〜+25% ずれ、
// コンパスが −9°/+6° ずれた状態で狭く探す。fr0 = 焦点距離を固定、fr0.25 = ±25% 振る。
// 「★誤」は信頼度「高」なのに方位が 1° 以上ずれた答え（AR では仰角 1.5°・コンパス 15° の条件でさらに除く）
const RAD = Math.PI / 180;
function renderView(rgba: Uint8ClampedArray, w: number, h: number, src: CameraParams, dst: CameraParams) {
  const bs = basis(src.yaw, src.pitch, src.roll), bd = basis(dst.yaw, dst.pitch, dst.roll);
  const out = new Uint8ClampedArray(dst.width * dst.height * 4);
  for (let y = 0; y < dst.height; y++) for (let x = 0; x < dst.width; x++) {
    const p = project(src, bs, unproject(dst, bd, x + 0.5, y + 0.5)); const o = (y * dst.width + x) * 4; out[o + 3] = 255;
    if (!p) continue; const xi = Math.floor(p[0]), yi = Math.floor(p[1]); if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
    for (let c = 0; c < 3; c++) out[o + c] = rgba[(yi * w + xi) * 4 + c];
  }
  return out;
}
it('画角がずれたまま狭く探したときの偽の「高」', async () => {
  const truth = loadTruth();
  const rows: string[] = [];
  for (const name of Object.keys(truth)) {
    const c = await loadCase(name); const t = truth[name];
    const F = c.w / 2 / Math.tan((t.hfov * RAD) / 2);
    const src: CameraParams = { yaw: t.yaw, pitch: t.pitch, roll: t.roll, focalPx: F, width: c.w, height: c.h };
    const vw = Math.round(c.w * 0.5), vh = Math.round(vw * 0.75);
    const rgba = renderView(c.rgba, c.w, c.h, src, { yaw: t.yaw, pitch: t.pitch, roll: t.roll, focalPx: F, width: vw, height: vh });
    for (const fs of [0.8, 0.87, 1, 1.15, 1.25]) for (const cerr of [-9, 6]) for (const fr of [0, 0.25]) {
      const r = autoAlign({ rgba, width: vw, height: vh, focalPx: F * fs, skyline: c.skyline, azStep: c.azStep, yawCenter: t.yaw + cerr, yawRange: 20, pitchCenter: t.pitch, pitchRange: 3, rollCenter: t.roll - 1, rollRange: 3, refineFocal: fr > 0, focalRange: fr });
      const b = r.best; if (!b) { rows.push(`${name}\tF×${fs}\tnone`); continue; }
      const dy = ((b.yaw - t.yaw + 540) % 360) - 180;
      rows.push(`${name}\tF×${fs}\tcompass${cerr}\tfr${fr}\t${r.confidence}\t${r.method}\tdy=${dy.toFixed(2)}\tdp=${(b.pitch - t.pitch).toFixed(2)}\tmargin=${r.margin.toFixed(2)}\tscore=${b.score.toFixed(2)}\tfoc=${(b.focalPx / F).toFixed(3)}\t${r.elapsedMs.toFixed(0)}ms\t${Math.abs(dy) > 1 && r.confidence === 'high' ? '★誤' : ''}`);
    }
  }
  console.log(rows.join('\n'));
}, 900000);
