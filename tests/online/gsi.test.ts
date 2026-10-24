import { describe, expect, it } from 'vitest';
import { TileStore, type TileRef } from '../../src/dem/tileStore';
import { FINEST_CHAIN } from '../../src/dem/tileSource';
import { latToV, lonToU } from '../../src/geo/mercator';
import { pointDetail } from '../../src/skyline/compute';

// 平坦な地点で、地理院タイルの補間値と地理院標高APIの値を比較する
const POINTS = [
  { name: '甲府盆地', lat: 35.6622, lon: 138.5686 },
  { name: '松本市街', lat: 36.2381, lon: 137.972 },
  { name: '皇居外苑', lat: 35.6812, lon: 139.7586 },
  { name: '大阪城公園', lat: 34.6873, lon: 135.5262 },
];

async function gsiApi(lat: number, lon: number): Promise<{ h: number; src: string }> {
  const r = await fetch(
    `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lon}&lat=${lat}&outtype=JSON`,
  );
  const j = await r.json();
  return { h: Number(j.elevation), src: j.hsrc };
}

describe('地理院タイル（実データ）', () => {
  const store = new TileStore({ cacheName: null });

  for (const p of POINTS) {
    it(`${p.name}: 標高APIと一致`, async () => {
      const u = lonToU(p.lon);
      const v = latToV(p.lat);
      const refs = new Map<string, TileRef>();
      TileStore.collect(FINEST_CHAIN, u, v, refs);
      await store.ensure(refs.values());
      const h = store.sample(FINEST_CHAIN, u, v);
      const api = await gsiApi(p.lat, p.lon);
      console.log(`${p.name}: tile=${h.toFixed(2)} m, API=${api.h} m (${api.src})`);
      expect(Math.abs(h - api.h)).toBeLessThan(1.5);
    });
  }

  it('富士山頂: ズーム別の標高（低ズームで低く出るかの検証）', async () => {
    const rows = await pointDetail(store, 35.3606, 138.7274, 150);
    for (const r of rows) console.log(`${r.label}: 中心 ${r.center.toFixed(1)} m / 半径150m内最大 ${r.max.toFixed(1)} m`);
    expect(rows[1].max).toBeGreaterThan(3700);
  });
});
