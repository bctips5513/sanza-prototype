import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoAlign } from '../../src/photo/autoAlign';
import { basis, dirFromAzEl, focalPxFrom35mm, project } from '../../src/photo/camera';
import { loadCase } from './harness';

// 正解が未登録の写真で自動合わせを走らせ、上位候補を重ねた SVG を .cache に書き出す（目視で正解を決める用）
// 例: EXPLORE=sample_08.HEIC npx vitest run --config vitest.photos.config.ts tests/photos/explore.test.ts
it('explore', async () => {
  for (const name of (process.env.EXPLORE ?? '').split(',').filter(Boolean)) {
    const c = await loadCase(name);
    const F0 = focalPxFrom35mm(c.focal35 ?? 26, c.width, c.height) * (c.w / c.width);
    const r = autoAlign({ rgba: c.rgba, width: c.w, height: c.h, focalPx: F0, skyline: c.skyline, azStep: c.azStep, yawCenter: process.env.AA_CENTER ? +process.env.AA_CENTER : c.direction ?? 0, yawRange: process.env.AA_RANGE ? +process.env.AA_RANGE : 180, upMode: (process.env.AA_UP as 'local' | 'column' | 'blend' | undefined) ?? undefined, trim: process.env.AA_TRIM ? +process.env.AA_TRIM : undefined, skyModel: (process.env.AA_SKY as 'fixed' | 'adaptive' | 'both' | undefined) ?? undefined });
    console.log(`${name} 信頼度=${r.confidence} 差=${r.margin.toFixed(2)} ${(r.elapsedMs / 1000).toFixed(1)}秒 EXIF方位=${c.direction?.toFixed(1)}`);
    const colors = ['#ff2d55', '#34c759', '#0a84ff'];
    const lines: string[] = [];
    r.candidates.slice(0, 3).forEach((k, n) => {
      const hfov = (2 * Math.atan(c.w / 2 / k.focalPx) * 180) / Math.PI;
      console.log(`  候補${n + 1}: 方位${k.yaw.toFixed(2)} 仰角${k.pitch.toFixed(2)} 傾き${k.roll.toFixed(2)} 画角${hfov.toFixed(2)} 得点${k.score.toFixed(2)}`);
      const cam = { yaw: k.yaw, pitch: k.pitch, roll: k.roll, focalPx: k.focalPx, width: c.w, height: c.h };
      const b = basis(k.yaw, k.pitch, k.roll);
      const pts: string[] = [];
      for (let i = Math.floor((k.yaw - 60) / c.azStep); i <= Math.ceil((k.yaw + 60) / c.azStep); i++) {
        const j = ((i % c.skyline.length) + c.skyline.length) % c.skyline.length;
        const p = project(cam, b, dirFromAzEl(i * c.azStep, c.skyline[j]));
        if (p && p[0] > -20 && p[0] < c.w + 20) pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      lines.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${colors[n]}" stroke-width="${n ? 1.5 : 2.5}" stroke-opacity="0.9"/>`);
    });
    const png = readFileSync(join(__dirname, '../../.cache', `${name}.800.png`)).toString('base64');
    const S = Math.max(c.w, c.h);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><rect width="${S}" height="${S}"/><g transform="translate(${(S - c.w) / 2},${(S - c.h) / 2})"><image href="data:image/png;base64,${png}" width="${c.w}" height="${c.h}"/>${lines.reverse().join('')}</g></svg>`;
    const out = join(__dirname, '../../.cache', `explore_${name}.svg`);
    writeFileSync(out, svg);
    console.log('OUT', out);
  }
});
