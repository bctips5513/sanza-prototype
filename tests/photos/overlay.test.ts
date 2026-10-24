import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { basis, dirFromAzEl, focalPxFrom35mm, focalPxFromHfov, project } from '../../src/photo/camera';
import { loadCase, loadTruth } from './harness';

// 指定姿勢（既定は正解）で最外稜線を重ねた SVG を .cache に書き出す（目視確認用）
it('overlay', async () => {
  const truth = loadTruth();
  for (const spec of (process.env.OVERLAY ?? '').split(';').filter(Boolean)) {
    const [name, pose] = spec.split('@');
    const c = await loadCase(name);
    const t = truth[name];
    const [yaw, pitch, roll, hfov] = pose ? pose.split(',').map(Number) : [t.yaw, t.pitch, t.roll, t.hfov];
    const F = hfov ? focalPxFromHfov(hfov, c.w) : focalPxFrom35mm(c.focal35 ?? 26, c.width, c.height) * (c.w / c.width);
    const cam = { yaw, pitch, roll, focalPx: F, width: c.w, height: c.h };
    const b = basis(yaw, pitch, roll);
    const pts: string[] = [];
    for (let k = Math.floor((yaw - 60) / c.azStep); k <= Math.ceil((yaw + 60) / c.azStep); k++) {
      const i = ((k % c.skyline.length) + c.skyline.length) % c.skyline.length;
      const p = project(cam, b, dirFromAzEl(k * c.azStep, c.skyline[i]));
      if (p && p[0] > -20 && p[0] < c.w + 20) pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
    }
    const png = readFileSync(join(__dirname, '../../.cache', `${name}.800.png`)).toString('base64');
    const H = Math.max(c.w, c.h);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${H}" height="${H}"><rect width="${H}" height="${H}"/><g transform="translate(0,${(H - c.h) / 2})"><image href="data:image/png;base64,${png}" width="${c.w}" height="${c.h}"/><polyline points="${pts.join(' ')}" fill="none" stroke="#ff2d55" stroke-width="2"/></g></svg>`;
    const out = join(__dirname, '../../.cache', `overlay_${name}_${pose ?? 'truth'}.svg`.replace(/[,@]/g, '_'));
    writeFileSync(out, svg);
    console.log('OUT', out);
  }
});
