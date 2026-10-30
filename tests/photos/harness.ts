import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import exifr from 'exifr';
import { decode, encode } from 'fast-png';
import { TileStore } from '../../src/dem/tileStore';
import { SkylineEngine } from '../../src/skyline/compute';
import { DEFAULT_SETTINGS } from '../../src/settings';

export const PHOTO_DIR = join(__dirname, '../../test-photos');
const CACHE = join(__dirname, '../../.cache');

/** 地理院タイルをディスクにキャッシュする fetch */
export function cachedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const file = join(CACHE, 'tiles', url.replace(/^https?:\/\//, '').replace(/[^\w.]/g, '_'));
    if (existsSync(file)) {
      const b = readFileSync(file);
      return b.length ? new Response(b) : new Response('', { status: 404 });
    }
    const res = await fetch(url);
    mkdirSync(join(CACHE, 'tiles'), { recursive: true });
    if (res.status === 404) {
      writeFileSync(file, '');
      return new Response('', { status: 404 });
    }
    const b = Buffer.from(await res.arrayBuffer());
    if (res.ok) writeFileSync(file, b);
    return new Response(b, { status: res.status });
  }) as typeof fetch;
}

export interface PhotoCase {
  name: string;
  width: number;
  height: number;
  focal35?: number;
  direction?: number;
  lat: number;
  lon: number;
  /** 長辺 800px の RGBA */
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  skyline: Float32Array;
  azStep: number;
}

export async function loadCase(name: string): Promise<PhotoCase> {
  const path = join(PHOTO_DIR, name);
  const t = await exifr.parse(path, { tiff: true, exif: true, gps: true, xmp: false });
  // EXIF の回転（縦写真）を反映した表示上の大きさ。ブラウザも同じく回転して表示する
  const ori: number = typeof t.Orientation === 'number' ? t.Orientation : ({ 'Rotate 90 CW': 6, 'Rotate 270 CW': 8, 'Rotate 180': 3 } as Record<string, number>)[t.Orientation] ?? 1;
  const rotate = ori === 6 ? 90 : ori === 8 ? 270 : ori === 3 ? 180 : 0;
  const swap = rotate === 90 || rotate === 270;
  const width = swap ? t.ExifImageHeight : t.ExifImageWidth;
  const height = swap ? t.ExifImageWidth : t.ExifImageHeight;

  // 縮小画像（幅 800px）
  mkdirSync(CACHE, { recursive: true });
  const png = join(CACHE, `${name}.800.png`);
  if (!existsSync(png)) {
    // sips は PNG 変換時に回転情報を画素へ反映しないため、明示的に回す（HEIC も sips で読める）
    const args = rotate ? ['--rotate', String(rotate)] : [];
    execFileSync('sips', [...args, '-s', 'format', 'png', path, '--out', png]);
    execFileSync('sips', ['--resampleWidth', '800', png, '--out', png]);
    // sips の PNG には回転情報（eXIf）が残り、表示側で二重に回されるため、画素だけで書き直す
    const raw = decode(readFileSync(png));
    writeFileSync(png, encode({ width: raw.width, height: raw.height, data: raw.data, channels: raw.channels, depth: raw.depth }));
  }
  const img = decode(readFileSync(png));
  const n = img.width * img.height;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = img.data[i * img.channels + c];
    rgba[i * 4 + 3] = 255;
  }

  // 稜線（ディスクにキャッシュ）
  const skyFile = join(CACHE, `skyline_${t.latitude.toFixed(6)}_${t.longitude.toFixed(6)}.f32`);
  let skyline: Float32Array;
  if (existsSync(skyFile)) skyline = new Float32Array(readFileSync(skyFile).buffer.slice(0));
  else {
    const s = DEFAULT_SETTINGS;
    const engine = new SkylineEngine(new TileStore({ cacheName: null, fetchFn: cachedFetch(), maxTiles: 400 }), {
      lat: t.latitude,
      lon: t.longitude,
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
    skyline = r.bandElev[r.bandElev.length - 1];
    writeFileSync(skyFile, Buffer.from(skyline.buffer));
  }
  return {
    name,
    width,
    height,
    focal35: t.FocalLengthIn35mmFormat,
    direction: t.GPSImgDirection,
    lat: t.latitude,
    lon: t.longitude,
    rgba,
    w: img.width,
    h: img.height,
    skyline,
    azStep: DEFAULT_SETTINGS.azStep,
  };
}

export function loadTruth(): Record<string, { yaw: number; pitch: number; roll: number; hfov: number }> {
  const f = join(PHOTO_DIR, 'truth.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}
