import { it } from 'vitest';
import { basis, dirFromAzEl, focalPxFrom35mm, project } from '../../src/photo/camera';
import { loadCase } from './harness';

// 雲のない一様な空の写真用：空の色から外れる位置を列ごとに拾い、計算稜線を当てはめて正解姿勢を探す（正解づくり専用）
it('fitprofile', async () => {
  for (const name of (process.env.FIT ?? '').split(',').filter(Boolean)) {
    const c = await loadCase(name);
    const { w, h, rgba } = c;
    // 空の色：上端 3% の平均と標準偏差
    const rows = Math.max(5, Math.round(h * 0.03));
    const m = [0, 0, 0];
    const v = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let k = 0; k < 3; k++) m[k] += rgba[i + k];
        n++;
      }
    for (let k = 0; k < 3; k++) m[k] /= n;
    // 空は上から下へ色がなめらかに変わるので、1行上の空との差で判定する
    const edge = new Float32Array(w).fill(NaN);
    for (let x = 0; x < w; x++) {
      for (let y = rows; y < h - 3; y++) {
        const d = (yy: number) => {
          const i = (yy * w + x) * 4;
          const j = ((yy - 6) * w + x) * 4;
          return Math.abs(rgba[i] - rgba[j]) + Math.abs(rgba[i + 1] - rgba[j + 1]) + Math.abs(rgba[i + 2] - rgba[j + 2]);
        };
        if (d(y) > 30 && d(y + 1) > 30 && d(y + 2) > 30) {
          edge[x] = y;
          break;
        }
      }
    }
    void v;
    const F0 = focalPxFrom35mm(c.focal35 ?? 26, c.width, c.height) * (w / c.width);
    let best = { e: Infinity, yaw: 0, pitch: 0, roll: 0, F: F0 };
    const evalPose = (yaw: number, roll: number, F: number) => {
      // 仰角0で投影し、残差の中央値で仰角を決める（近似）
      const cam = { yaw, pitch: 0, roll, focalPx: F, width: w, height: h };
      const b = basis(yaw, 0, roll);
      const res: number[] = [];
      const half = (Math.atan(w / 2 / F) * 180) / Math.PI;
      for (let a = -half; a <= half; a += 0.1) {
        const az = yaw + a;
        const i = ((Math.round(az / c.azStep) % c.skyline.length) + c.skyline.length) % c.skyline.length;
        const p = project(cam, b, dirFromAzEl(az, c.skyline[i]));
        if (!p) continue;
        const x = Math.round(p[0]);
        if (x < 0 || x >= w || !Number.isFinite(edge[x])) continue;
        res.push(edge[x] - p[1]);
      }
      if (res.length < 20) return null;
      res.sort((a, b) => a - b);
      const med = res[res.length >> 1];
      const dev = res.map((r) => Math.abs(r - med)).sort((a, b) => a - b);
      return { e: dev[dev.length >> 1] + dev[Math.floor(dev.length * 0.8)], pitchPx: med };
    };
    for (let yaw = 0; yaw < 360; yaw += 0.25)
      for (let roll = -8; roll <= 8; roll += 1)
        for (const fs of [0.95, 1, 1.05, 1.1]) {
          const r = evalPose(yaw, roll, F0 * fs);
          if (r && r.e < best.e) best = { e: r.e, yaw, pitch: (Math.atan(r.pitchPx / (F0 * fs)) * 180) / Math.PI, roll, F: F0 * fs };
        }
    const hfov = (2 * Math.atan(w / 2 / best.F) * 180) / Math.PI;
    console.log(`${name} 当てはめ: 方位${best.yaw.toFixed(2)} 仰角(近似)${best.pitch.toFixed(2)} 傾き${best.roll} 画角${hfov.toFixed(2)} 誤差指標${best.e.toFixed(1)}px EXIF方位=${c.direction?.toFixed(1)}`);
  }
});
