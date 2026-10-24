import { describe, expect, it } from 'vitest';
import { TileStore } from '../src/dem/tileStore';
import { SkylineEngine, PeakStatus } from '../src/skyline/compute';
import { direct, inverse } from '../src/geo/geodesic';
import { apparentDrop } from '../src/geo/curvature';
import { fakeFetch } from './helpers';

const OBS = { lat: 35.5, lon: 138.5 };
const R = 6_371_000;
const K = 0.13;

// 円錐形の山（傾斜 1:5）
const cones = [
  { ...direct(OBS.lat, OBS.lon, 0, 20_000), h: 1000, name: 'A' }, // 北 20km
  { ...direct(OBS.lat, OBS.lon, 0.5, 40_000), h: 1200, name: 'B' }, // A の背後 40km（隠れる）
  { ...direct(OBS.lat, OBS.lon, 90, 30_000), h: 500, name: 'C' }, // 東 30km（見える）
];
function terrain(lat: number, lon: number): number {
  let h = 0;
  for (const c of cones) {
    const r = inverse(c.lat, c.lon, lat, lon).dist;
    h = Math.max(h, c.h - 0.2 * r);
  }
  return h;
}

describe('スカイライン計算（合成地形）', () => {
  it('山頂の仰角・距離・見通し判定', async () => {
    const counter = { n: 0 };
    const store = new TileStore({ cacheName: null, fetchFn: fakeFetch(terrain, counter), maxTiles: 400 });
    const engine = new SkylineEngine(store, {
      ...OBS,
      eyeHeight: 1.6,
      earthRadius: R,
      refractionK: K,
      maxDist: 45_000,
      minDist: 30,
      azStep: 0.1,
      tiers: [
        { maxDist: 3_000, zoom: 15, source: 'dem5a' },
        { maxDist: 45_000, zoom: 12, source: 'dem10b' },
      ],
      bands: [10_000, 30_000, 45_000],
      peakHeightSource: 'dem',
    });
    const peaks = cones.map((c, i) => ({ id: i, lat: c.lat, lon: c.lon, name: c.name, ele: c.h }));
    const res = await engine.run(peaks);
    expect(store.missRefs).toBe(0);
    expect(res.hGround).toBeCloseTo(0, 1);

    const expectA = (Math.atan((1000 - 1.6 - apparentDrop(20_000, R, K)) / 20_000) * 180) / Math.PI;
    const full = res.bandElev[res.bandElev.length - 1];
    // z12（約31m画素）で円錐頂部が平滑化される分を許容
    expect(full[0]).toBeGreaterThan(expectA - 0.05);
    expect(full[0]).toBeLessThan(expectA + 0.005);
    expect(res.bandDist[2][0]).toBeGreaterThan(19_800);
    expect(res.bandDist[2][0]).toBeLessThan(20_200);
    // 10km 以内には山がないので、近距離帯の稜線は低い
    expect(res.bandElev[0][0]).toBeLessThan(0);

    const byName = Object.fromEntries(res.peaks.map((p) => [cones[p.id].name, p]));
    expect(byName.A.status).toBe(PeakStatus.Visible);
    expect(byName.B.status).toBe(PeakStatus.Hidden);
    expect(byName.C.status).toBe(PeakStatus.Visible);
    expect(byName.C.az).toBeCloseTo(90, 6);
  }, 120_000);
});
