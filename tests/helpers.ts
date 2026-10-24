import { encode } from 'fast-png';
import { uToLon, vToLat } from '../src/geo/mercator';

/** 標高 [m] → 地理院PNGのRGB */
export function elevationToRgb(h: number): [number, number, number] {
  if (Number.isNaN(h)) return [128, 0, 0];
  let x = Math.round(h * 100);
  if (x < 0) x += 16777216;
  return [(x >> 16) & 255, (x >> 8) & 255, x & 255];
}

/** 解析関数から地理院形式のタイルPNGを作る（画素中心で評価） */
export function makeTile(z: number, tx: number, ty: number, f: (lat: number, lon: number) => number): Uint8Array {
  const W = 256 * 2 ** z;
  const data = new Uint8Array(256 * 256 * 3);
  for (let j = 0; j < 256; j++)
    for (let i = 0; i < 256; i++) {
      const lon = uToLon((tx * 256 + i + 0.5) / W);
      const lat = vToLat((ty * 256 + j + 0.5) / W);
      const [r, g, b] = elevationToRgb(f(lat, lon));
      const o = (j * 256 + i) * 3;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  return encode({ width: 256, height: 256, data, channels: 3, depth: 8 });
}

/** URL を解析して合成タイルを返す fetch。dem5a は 404 を返してフォールバックを試す */
export function fakeFetch(f: (lat: number, lon: number) => number, counter?: { n: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const m = url.match(/\/(dem5a_png|dem_png)\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) throw new Error('bad url ' + url);
    if (counter) counter.n++;
    if (m[1] === 'dem5a_png') return new Response('', { status: 404 });
    const bytes = makeTile(+m[2], +m[3], +m[4], f);
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as typeof fetch;
}
