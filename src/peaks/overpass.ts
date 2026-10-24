import type { PeakInput } from '../skyline/compute';

export interface Peak extends PeakInput {
  name?: string;
  /** OSM の ele タグ（数値化できたもの） */
  ele?: number;
  eleRaw?: string;
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** キャッシュ格子の大きさ [deg] */
const CELL = 1;
const TTL_MS = 30 * 24 * 3600 * 1000;
const DB_NAME = 'sanza-peaks';
const STORE = 'cells';

interface CellRecord {
  key: string;
  fetchedAt: number;
  peaks: Peak[];
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<CellRecord | undefined> {
  return new Promise((resolve) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}

function idbPut(db: IDBDatabase, rec: CellRecord): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearPeakCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function parseEle(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  let v = parseFloat(m[0]);
  if (/ft|feet/i.test(raw)) v *= 0.3048;
  return isFinite(v) ? v : undefined;
}

async function queryOverpass(s: number, w: number, n: number, e: number): Promise<Peak[]> {
  const q = `[out:json][timeout:180];node["natural"="peak"](${s},${w},${n},${e});out body;`;
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        signal: AbortSignal.timeout(200_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.elements as any[]).map((el) => {
        const tags = el.tags ?? {};
        const name: string | undefined = tags['name:ja'] || tags.name || undefined;
        return { id: el.id, lat: el.lat, lon: el.lon, name, eleRaw: tags.ele, ele: parseEle(tags.ele) };
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Overpass API に接続できません (${String(lastErr)})`);
}

/**
 * 観測点から半径 radius [m] を覆う範囲の山頂を取得。
 * 1°格子ごとに IndexedDB へキャッシュし、未取得の格子はまとめて1回のクエリで取る。
 */
export async function fetchPeaks(
  lat: number,
  lon: number,
  radius: number,
  onStatus?: (text: string) => void,
): Promise<Peak[]> {
  const dLat = radius / 111_000;
  const dLon = radius / (111_000 * Math.cos((lat * Math.PI) / 180));
  const a0 = Math.floor((lat - dLat) / CELL);
  const a1 = Math.floor((lat + dLat) / CELL);
  const b0 = Math.floor((lon - dLon) / CELL);
  const b1 = Math.floor((lon + dLon) / CELL);
  const db = await openDb();
  const result = new Map<number, Peak>();
  const missing: [number, number][] = [];
  for (let a = a0; a <= a1; a++)
    for (let b = b0; b <= b1; b++) {
      const rec = db ? await idbGet(db, `${a}_${b}`) : undefined;
      if (rec && Date.now() - rec.fetchedAt <= TTL_MS) for (const p of rec.peaks) result.set(p.id, p);
      else missing.push([a, b]);
    }
  if (missing.length) {
    const s = Math.min(...missing.map((m) => m[0])) * CELL;
    const n = (Math.max(...missing.map((m) => m[0])) + 1) * CELL;
    const w = Math.min(...missing.map((m) => m[1])) * CELL;
    const e = (Math.max(...missing.map((m) => m[1])) + 1) * CELL;
    onStatus?.(`OSM 山頂データを取得中（${missing.length} 区画・混雑時は数分かかります）`);
    const peaks = await queryOverpass(s, w, n, e);
    const now = Date.now();
    for (const [a, b] of missing) {
      const inCell = peaks.filter(
        (p) => Math.floor(p.lat / CELL) === a && Math.floor(p.lon / CELL) === b,
      );
      if (db) await idbPut(db, { key: `${a}_${b}`, fetchedAt: now, peaks: inCell });
      for (const p of inCell) result.set(p.id, p);
    }
  }
  return [...result.values()];
}
