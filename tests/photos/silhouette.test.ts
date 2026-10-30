import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { basis, dirFromAzEl, focalPxFromHfov, project } from '../../src/photo/camera';
import { SkylineEngine } from '../../src/skyline/compute';
import { traceSilhouettes } from '../../src/skyline/silhouette';
import { TileStore } from '../../src/dem/tileStore';
import { DEFAULT_SETTINGS } from '../../src/settings';
import { cachedFetch, loadCase, loadTruth } from './harness';

// 手前の尾根の輪郭線を、正解の姿勢でテスト写真に重ねた画像を .cache に書き出す（目視確認用）
//   PHOTOS=sample_01.JPG;sample_03.JPG で写真を絞れる
it('手前の尾根の輪郭線を写真に重ねる', async () => {
  const truth = loadTruth();
  const names = (process.env.PHOTOS ?? Object.keys(truth).join(';')).split(';').filter(Boolean);
  for (const name of names) {
    const c = await loadCase(name);
    const t = truth[name];
    const s = DEFAULT_SETTINGS;
    const engine = new SkylineEngine(new TileStore({ cacheName: null, fetchFn: cachedFetch(), maxTiles: 400 }), {
      lat: c.lat,
      lon: c.lon,
      eyeHeight: s.eyeHeight,
      earthRadius: s.earthRadius,
      refractionK: s.refractionK,
      maxDist: s.maxDist,
      minDist: s.minDist,
      azStep: s.azStep,
      tiers: s.tiers,
      bands: s.bands,
    });
    const r = await engine.run([]);
    const sil = traceSilhouettes(r);
    const F = focalPxFromHfov(t.hfov, c.w);
    const cam = { yaw: t.yaw, pitch: t.pitch, roll: t.roll, focalPx: F, width: c.w, height: c.h };
    const b = basis(t.yaw, t.pitch, t.roll);
    const poly = (az0: number, elevs: ArrayLike<number>) => {
      const pts: string[] = [];
      for (let j = 0; j < elevs.length; j++) {
        const p = project(cam, b, dirFromAzEl(az0 + j * r.azStep, elevs[j]));
        if (p && p[0] > -50 && p[0] < c.w + 50) pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      return pts.join(' ');
    };
    const half = Math.atan(Math.hypot(c.w, c.h) / 2 / F) / (Math.PI / 180);
    const inView = sil.filter((l) => {
      const a0 = l.i0 * r.azStep;
      const d = ((a0 + l.span / 2 - t.yaw + 540) % 360) - 180;
      return Math.abs(d) < half + l.span / 2;
    });
    const sky = r.bandElev[r.bandElev.length - 1];
    const k0 = Math.floor((t.yaw - half) / r.azStep);
    const skyEl: number[] = [];
    for (let k = k0; k <= k0 + (2 * half) / r.azStep; k++) skyEl.push(sky[((k % r.nAz) + r.nAz) % r.nAz]);
    const png = readFileSync(join(__dirname, '../../.cache', `${name}.800.png`)).toString('base64');
    const lines = inView
      .map((l) => `<polyline points="${poly(l.i0 * r.azStep, l.elev)}" fill="none" stroke="#ff8fb3" stroke-width="2"><title>${(l.dist / 1000).toFixed(1)}km 比${l.ratio.toFixed(2)} ${l.span.toFixed(1)}°</title></polyline>`)
      .join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${c.w}" height="${c.h}"><image href="data:image/png;base64,${png}" width="${c.w}" height="${c.h}"/><polyline points="${poly(k0 * r.azStep, skyEl)}" fill="none" stroke="#ff2d55" stroke-width="1.5"/>${lines}</svg>`;
    const out = join(__dirname, '../../.cache', `silhouette_${name}.svg`);
    writeFileSync(out, svg);
    if (existsSync('/usr/bin/qlmanage')) execFileSync('qlmanage', ['-t', '-s', '1200', '-o', join(__dirname, '../../.cache'), out], { stdio: 'ignore' });
    console.log(`${name}\t輪郭線 ${sil.length} 本（画面内 ${inView.length} 本）\t輪郭点 ${r.edgeElev.length}\t${r.elapsedMs.toFixed(0)}ms\t${out}`);
  }
}, 900_000);
