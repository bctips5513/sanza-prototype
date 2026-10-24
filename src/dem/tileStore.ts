import { decodeDemPng, TILE_SIZE } from './decode';
import type { Layer } from './tileSource';

/** null = タイルが存在しない（404, 海域など）, undefined = 未読込 */
type TileData = Float32Array | null;

export interface TileRef {
  layer: Layer;
  x: number;
  y: number;
}

export interface TileStoreOptions {
  /** メモリ上に保持するデコード済みタイル数の上限 */
  maxTiles?: number;
  concurrency?: number;
  /** Cache Storage 名。null で無効 */
  cacheName?: string | null;
  fetchFn?: typeof fetch;
}

export interface LoadStats {
  network: number;
  cache: number;
  missing: number;
  bytes: number;
}

const tileKey = (x: number, y: number) => x * 65536 + y;

/**
 * 標高タイルの取得・キャッシュ・デコードと、同期的な標高サンプリング。
 * 計算中に必要なタイルは ensure() で事前に読み込んでおく（読み込み済みでないタイルを
 * 参照すると missRefs が増え、その画素は無効値として扱われる）。
 */
export class TileStore {
  private layers = new Map<string, Map<number, TileData>>();
  private lru = new Map<string, true>(); // 挿入順 = 古い順
  private pinned = new Set<string>();
  private inflight = new Map<string, Promise<void>>();
  private active = 0;
  private queue: (() => void)[] = [];
  private maxTiles: number;
  private concurrency: number;
  private cacheName: string | null;
  private fetchFn: typeof fetch;
  private cachePromise: Promise<Cache | null> | null = null;
  stats: LoadStats = { network: 0, cache: 0, missing: 0, bytes: 0 };
  missRefs = 0;

  constructor(opts: TileStoreOptions = {}) {
    this.maxTiles = opts.maxTiles ?? 160;
    this.concurrency = opts.concurrency ?? 8;
    this.cacheName = opts.cacheName === undefined ? 'gsi-dem-v1' : opts.cacheName;
    this.fetchFn = opts.fetchFn ?? ((...a) => fetch(...a));
  }

  private layerMap(layer: Layer): Map<number, TileData> {
    let m = this.layers.get(layer.key);
    if (!m) {
      m = new Map();
      this.layers.set(layer.key, m);
    }
    return m;
  }

  get(layer: Layer, x: number, y: number): TileData | undefined {
    return this.layerMap(layer).get(tileKey(x, y));
  }

  /** テスト用：タイルを直接登録 */
  put(layer: Layer, x: number, y: number, data: TileData): void {
    this.layerMap(layer).set(tileKey(x, y), data);
    this.touch(`${layer.key}/${x}/${y}`);
  }

  private touch(id: string) {
    this.lru.delete(id);
    this.lru.set(id, true);
    if (this.lru.size <= this.maxTiles) return;
    for (const old of this.lru.keys()) {
      if (this.lru.size <= this.maxTiles) break;
      if (this.pinned.has(old)) continue;
      this.lru.delete(old);
      const p = old.split('/');
      const key = `${p[0]}/${p[1]}`;
      this.layers.get(key)?.delete(tileKey(+p[2], +p[3]));
    }
  }

  private openCache(): Promise<Cache | null> {
    if (!this.cachePromise) {
      this.cachePromise =
        this.cacheName && typeof caches !== 'undefined'
          ? caches.open(this.cacheName).catch(() => null)
          : Promise.resolve(null);
    }
    return this.cachePromise;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    const cache = await this.openCache();
    if (cache) {
      const hit = await cache.match(url).catch(() => undefined);
      if (hit) {
        this.stats.cache++;
        if (hit.headers.get('x-sanza-empty')) return null;
        return new Uint8Array(await hit.arrayBuffer());
      }
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(url, { mode: 'cors' });
        if (res.status === 404) {
          this.stats.missing++;
          cache?.put(url, new Response('', { headers: { 'x-sanza-empty': '1' } })).catch(() => {});
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        this.stats.network++;
        this.stats.bytes += buf.byteLength;
        cache?.put(url, new Response(buf.slice(), { headers: { 'content-type': 'image/png' } })).catch(() => {});
        return buf;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw new Error(`タイル取得失敗: ${url} (${String(lastErr)})`);
  }

  private load(ref: TileRef): Promise<void> {
    const id = `${ref.layer.key}/${ref.x}/${ref.y}`;
    if (this.get(ref.layer, ref.x, ref.y) !== undefined) {
      this.touch(id);
      return Promise.resolve();
    }
    let p = this.inflight.get(id);
    if (!p) {
      p = this.slot(async () => {
        const bytes = await this.fetchBytes(ref.layer.url(ref.x, ref.y));
        const data = bytes ? decodeDemPng(bytes) : null;
        this.layerMap(ref.layer).set(tileKey(ref.x, ref.y), data);
        this.touch(id);
      }).finally(() => this.inflight.delete(id));
      this.inflight.set(id, p);
    }
    return p;
  }

  /** タイル群を読み込み、計算が終わるまで退避されないよう固定する */
  async ensure(refs: Iterable<TileRef>, onEach?: () => void): Promise<string[]> {
    const ids: string[] = [];
    const jobs: Promise<void>[] = [];
    for (const r of refs) {
      const id = `${r.layer.key}/${r.x}/${r.y}`;
      ids.push(id);
      this.pinned.add(id);
      jobs.push(this.load(r).then(() => onEach?.()));
    }
    await Promise.all(jobs);
    for (const id of ids) this.touch(id);
    this.lastLayer = null;
    return ids;
  }

  release(ids: string[]): void {
    for (const id of ids) this.pinned.delete(id);
  }

  // ---- 同期サンプリング ----

  private lastLayer: Layer | null = null;
  private lastTx = -1;
  private lastTy = -1;
  private lastTile: TileData | undefined = undefined;

  /** グローバル画素 (gi, gj) の値。タイル無し・無効値は NaN */
  pixel(layer: Layer, gi: number, gj: number): number {
    const tx = gi >> 8;
    const ty = gj >> 8;
    let t: TileData | undefined;
    if (layer === this.lastLayer && tx === this.lastTx && ty === this.lastTy) {
      t = this.lastTile;
    } else {
      t = this.get(layer, tx, ty);
      this.lastLayer = layer;
      this.lastTx = tx;
      this.lastTy = ty;
      this.lastTile = t;
    }
    if (t === undefined) {
      this.missRefs++;
      return NaN;
    }
    if (t === null) return NaN;
    return t[(gj & 255) * TILE_SIZE + (gi & 255)];
  }

  /**
   * 正規化メルカトル座標 (u, v) の標高を双線形補間で求める。
   * 画素値は画素中心の値とみなす。4近傍に無効値があれば次の層へフォールバックし、
   * 最後の層でも無効なら無効画素を 0 m（海面）として補間する。
   */
  sample(chain: Layer[], u: number, v: number): number {
    for (let li = 0; li < chain.length; li++) {
      const layer = chain[li];
      const W = TILE_SIZE * 2 ** layer.zoom;
      const gx = u * W - 0.5;
      const gy = v * W - 0.5;
      const i = Math.floor(gx);
      const j = Math.floor(gy);
      const fx = gx - i;
      const fy = gy - j;
      let a = this.pixel(layer, i, j);
      let b = this.pixel(layer, i + 1, j);
      let c = this.pixel(layer, i, j + 1);
      let d = this.pixel(layer, i + 1, j + 1);
      const ok = a === a && b === b && c === c && d === d;
      if (!ok) {
        if (li < chain.length - 1) continue;
        if (a !== a) a = 0;
        if (b !== b) b = 0;
        if (c !== c) c = 0;
        if (d !== d) d = 0;
      }
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    return 0;
  }

  /** 単一層の双線形補間。4近傍に無効値があれば NaN */
  sampleLayer(layer: Layer, u: number, v: number): number {
    const W = TILE_SIZE * 2 ** layer.zoom;
    const gx = u * W - 0.5;
    const gy = v * W - 0.5;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const a = this.pixel(layer, i, j);
    const b = this.pixel(layer, i + 1, j);
    const c = this.pixel(layer, i, j + 1);
    const d = this.pixel(layer, i + 1, j + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /** sample() が参照するタイルを集合に追加 */
  static collect(chain: Layer[], u: number, v: number, out: Map<string, TileRef>): void {
    for (const layer of chain) {
      const W = TILE_SIZE * 2 ** layer.zoom;
      const gx = u * W - 0.5;
      const gy = v * W - 0.5;
      const i = Math.floor(gx);
      const j = Math.floor(gy);
      const tx0 = i >> 8;
      const ty0 = j >> 8;
      const tx1 = (i + 1) >> 8;
      const ty1 = (j + 1) >> 8;
      for (let tx = tx0; tx <= tx1; tx++)
        for (let ty = ty0; ty <= ty1; ty++) {
          const id = `${layer.key}/${tx}/${ty}`;
          if (!out.has(id)) out.set(id, { layer, x: tx, y: ty });
        }
    }
  }
}
