import { TileStore, type TileRef } from '../dem/tileStore';
import { FINEST_CHAIN, demLayer, layerChain, type Layer } from '../dem/tileSource';
import { direct, inverse } from '../geo/geodesic';
import { apparentDrop } from '../geo/curvature';
import { groundPixelSize, latToV, lonToU } from '../geo/mercator';
import type { DemTier } from '../settings';

export interface SkylineParams {
  lat: number;
  lon: number;
  eyeHeight: number;
  earthRadius: number;
  refractionK: number;
  maxDist: number;
  minDist: number;
  azStep: number;
  tiers: DemTier[];
  bands: number[];
  /** サンプル間隔 = 画素サイズ × この係数 */
  stepFactor?: number;
  /** 山頂の見かけの位置に使う標高: 'osm' = OSM の ele 優先（無ければDEM）, 'dem' = DEM */
  peakHeightSource?: 'osm' | 'dem';
}

export interface PeakInput {
  id: number;
  lat: number;
  lon: number;
  name?: string;
  ele?: number;
}

export const enum PeakStatus {
  Hidden = 0,
  Marginal = 1,
  Visible = 2,
}

export interface PeakResult {
  id: number;
  az: number;
  dist: number;
  /** その距離帯のDEMで山頂付近の最大値 [m] */
  hDem: number;
  /** 見かけの位置に使った標高 [m] */
  hUsed: number;
  /** 見かけの仰角 [deg] */
  elev: number;
  /** 手前の地形の最大仰角 [deg] */
  block: number;
  status: PeakStatus;
}

export interface SkylineResult {
  lat: number;
  lon: number;
  nAz: number;
  azStep: number;
  bands: number[];
  /** bandElev[b][i] = 距離 bands[b] 以内の地形による方位 i の最大仰角 [deg] */
  bandElev: Float32Array[];
  bandDist: Float32Array[];
  bandH: Float32Array[];
  hGround: number;
  hObs: number;
  peaks: PeakResult[];
  samplesPerRay: number;
  elapsedMs: number;
}

export interface Progress {
  phase: string;
  done: number;
  total: number;
}

const KNOT = 2000; // 測地線上の節点間隔 [m]（節点間はメルカトル座標で線形補間）
const SECTOR_RAYS = 50;
const RAD = Math.PI / 180;

export class SkylineEngine {
  readonly p: Required<SkylineParams>;
  private chains: Layer[][];
  private dist!: Float64Array;
  private invD!: Float64Array;
  private drop!: Float64Array;
  private tierOf!: Uint8Array;
  private bandOf!: Uint8Array;
  private hObs = 0;

  constructor(
    private store: TileStore,
    params: SkylineParams,
  ) {
    this.p = { stepFactor: 0.8, peakHeightSource: 'osm', ...params };
    this.chains = this.p.tiers.map((t) => layerChain(t.source, t.zoom));
    this.buildSamples();
  }

  private tierIndex(d: number): number {
    const t = this.p.tiers;
    for (let i = 0; i < t.length; i++) if (d <= t[i].maxDist) return i;
    return t.length - 1;
  }

  private bandIndex(d: number): number {
    const b = this.p.bands;
    for (let i = 0; i < b.length; i++) if (d <= b[i]) return i;
    return b.length - 1;
  }

  /** 全方位で共通のサンプル距離列（距離帯の画素サイズに合わせて間隔を変える） */
  private buildSamples() {
    const { lat, minDist, maxDist, earthRadius: R, refractionK: k, stepFactor } = this.p;
    const ds: number[] = [];
    let d = minDist;
    while (d <= maxDist) {
      ds.push(d);
      const t = this.p.tiers[this.tierIndex(d)];
      d += groundPixelSize(lat, t.zoom) * stepFactor;
    }
    const n = ds.length;
    this.dist = new Float64Array(ds);
    this.invD = new Float64Array(n);
    this.drop = new Float64Array(n);
    this.tierOf = new Uint8Array(n);
    this.bandOf = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.invD[i] = 1 / ds[i];
      this.drop[i] = apparentDrop(ds[i], R, k);
      this.tierOf[i] = this.tierIndex(ds[i]);
      this.bandOf[i] = this.bandIndex(ds[i]);
    }
  }

  get samplesPerRay(): number {
    return this.dist.length;
  }

  /** 方位 az の測地線上の節点（正規化メルカトル u,v の組） */
  private knots(az: number, dmax: number): Float64Array {
    const n = Math.ceil(dmax / KNOT) + 2;
    const k = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const q = i === 0 ? { lat: this.p.lat, lon: this.p.lon } : direct(this.p.lat, this.p.lon, az, i * KNOT);
      k[i * 2] = lonToU(q.lon);
      k[i * 2 + 1] = latToV(q.lat);
    }
    return k;
  }

  private static uv(knots: Float64Array, d: number): [number, number] {
    const f = d / KNOT;
    const i = Math.floor(f);
    const t = f - i;
    const o = i * 2;
    return [knots[o] + (knots[o + 2] - knots[o]) * t, knots[o + 1] + (knots[o + 3] - knots[o + 1]) * t];
  }

  private collectRay(knots: Float64Array, dmax: number, out: Map<string, TileRef>) {
    const { dist, tierOf } = this;
    for (let i = 0; i < dist.length && dist[i] <= dmax; i++) {
      const [u, v] = SkylineEngine.uv(knots, dist[i]);
      TileStore.collect(this.chains[tierOf[i]], u, v, out);
    }
  }

  /** 山頂付近の最大標高を探すオフセット（画素単位） */
  private static PEAK_OFFS = [-1.5, -0.75, 0, 0.75, 1.5];

  private peakSamplePoints(pk: PeakInput, tier: number): [number, number][] {
    const z = this.p.tiers[tier].zoom;
    const W = 256 * 2 ** z;
    const u0 = lonToU(pk.lon);
    const v0 = latToV(pk.lat);
    const pts: [number, number][] = [];
    for (const ox of SkylineEngine.PEAK_OFFS)
      for (const oy of SkylineEngine.PEAK_OFFS) pts.push([u0 + ox / W, v0 + oy / W]);
    return pts;
  }

  private peakExclusion(tier: number): number {
    return Math.max(100, 3 * groundPixelSize(this.p.lat, this.p.tiers[tier].zoom));
  }

  async run(peaks: PeakInput[], onProgress?: (p: Progress) => void, tolDeg = 0.02): Promise<SkylineResult> {
    const t0 = performance.now();
    const { lat, lon, azStep, maxDist, bands } = this.p;
    const nAz = Math.round(360 / azStep);
    const nB = bands.length;

    // 観測点の地表標高（最も細かいDEM）
    const u0 = lonToU(lon);
    const v0 = latToV(lat);
    const obsRefs = new Map<string, TileRef>();
    TileStore.collect(FINEST_CHAIN, u0, v0, obsRefs);
    const obsIds = await this.store.ensure(obsRefs.values());
    const hGround = this.store.sample(FINEST_CHAIN, u0, v0);
    this.store.release(obsIds);
    this.hObs = hGround + this.p.eyeHeight;

    const bandElev = Array.from({ length: nB }, () => new Float32Array(nAz));
    const bandDist = Array.from({ length: nB }, () => new Float32Array(nAz));
    const bandH = Array.from({ length: nB }, () => new Float32Array(nAz));

    // 山頂を方位・距離で前処理
    const pk = peaks
      .map((p) => {
        const inv = inverse(lat, lon, p.lat, p.lon);
        return { p, az: inv.az, dist: inv.dist, tier: this.tierIndex(inv.dist) };
      })
      .filter((x) => x.dist > this.p.minDist * 2 && x.dist <= maxDist)
      .sort((a, b) => a.az - b.az);
    const peakResults: PeakResult[] = [];

    const nSec = Math.ceil(nAz / SECTOR_RAYS);
    let pkCursor = 0;

    type Prepared = {
      ids: Promise<string[]>;
      rays: { i: number; knots: Float64Array }[];
      peaks: { item: (typeof pk)[number]; knots: Float64Array }[];
    };

    const prepare = (s: number): Prepared => {
      const i0 = s * SECTOR_RAYS;
      const i1 = Math.min(nAz, i0 + SECTOR_RAYS);
      const refs = new Map<string, TileRef>();
      const rays = [];
      for (let i = i0; i < i1; i++) {
        const knots = this.knots(i * azStep, maxDist);
        this.collectRay(knots, maxDist, refs);
        rays.push({ i, knots });
      }
      const az1 = i1 * azStep - azStep / 2;
      const secPeaks = [];
      while (pkCursor < pk.length && (pk[pkCursor].az < az1 || s === nSec - 1)) {
        const item = pk[pkCursor++];
        const knots = this.knots(item.az, item.dist);
        this.collectRay(knots, item.dist, refs);
        for (const [u, v] of this.peakSamplePoints(item.p, item.tier))
          TileStore.collect(this.chains[item.tier], u, v, refs);
        secPeaks.push({ item, knots });
      }
      return { ids: this.store.ensure(refs.values()), rays, peaks: secPeaks };
    };

    let next = prepare(0);
    for (let s = 0; s < nSec; s++) {
      const cur = next;
      const ids = await cur.ids;
      if (s + 1 < nSec) next = prepare(s + 1);

      for (const { i, knots } of cur.rays) {
        this.castSkyline(knots, i, bandElev, bandDist, bandH);
      }
      for (const { item, knots } of cur.peaks) {
        peakResults.push(this.evalPeak(item.p, item.az, item.dist, item.tier, knots, tolDeg));
      }
      this.store.release(ids);
      onProgress?.({ phase: '稜線計算', done: s + 1, total: nSec });
    }

    return {
      lat,
      lon,
      nAz,
      azStep,
      bands,
      bandElev,
      bandDist,
      bandH,
      hGround,
      hObs: this.hObs,
      peaks: peakResults,
      samplesPerRay: this.dist.length,
      elapsedMs: performance.now() - t0,
    };
  }

  /**
   * run() の後で山頂の見通し判定だけを行う（山頂データが稜線計算より後に届いた場合用）。
   * 方位順に小分けにして、必要なタイルだけを読み込む。
   */
  async evalPeaks(peaks: PeakInput[], tolDeg = 0.02, onProgress?: (p: Progress) => void): Promise<PeakResult[]> {
    const { lat, lon, maxDist } = this.p;
    const pk = peaks
      .map((p) => {
        const inv = inverse(lat, lon, p.lat, p.lon);
        return { p, az: inv.az, dist: inv.dist, tier: this.tierIndex(inv.dist) };
      })
      .filter((x) => x.dist > this.p.minDist * 2 && x.dist <= maxDist)
      .sort((a, b) => a.az - b.az);
    const out: PeakResult[] = [];
    const CHUNK = 60;
    for (let c = 0; c < pk.length; c += CHUNK) {
      const items = pk.slice(c, c + CHUNK).map((item) => ({ item, knots: this.knots(item.az, item.dist) }));
      const refs = new Map<string, TileRef>();
      for (const { item, knots } of items) {
        this.collectRay(knots, item.dist, refs);
        for (const [u, v] of this.peakSamplePoints(item.p, item.tier))
          TileStore.collect(this.chains[item.tier], u, v, refs);
      }
      const ids = await this.store.ensure(refs.values());
      for (const { item, knots } of items)
        out.push(this.evalPeak(item.p, item.az, item.dist, item.tier, knots, tolDeg));
      this.store.release(ids);
      onProgress?.({ phase: '見通し判定', done: Math.min(pk.length, c + CHUNK), total: pk.length });
    }
    return out;
  }

  private castSkyline(
    knots: Float64Array,
    ray: number,
    bandElev: Float32Array[],
    bandDist: Float32Array[],
    bandH: Float32Array[],
  ) {
    const { dist, invD, drop, tierOf, bandOf, chains, store, hObs } = this;
    const n = dist.length;
    const nB = bandElev.length;
    let maxT = -Infinity;
    let maxD = 0;
    let maxH = 0;
    let band = 0;
    for (let i = 0; i < n; i++) {
      const bi = bandOf[i];
      while (band < bi) {
        bandElev[band][ray] = Math.atan(maxT) / RAD;
        bandDist[band][ray] = maxD;
        bandH[band][ray] = maxH;
        band++;
      }
      const d = dist[i];
      const f = d / KNOT;
      const k = Math.floor(f);
      const t = f - k;
      const o = k * 2;
      const u = knots[o] + (knots[o + 2] - knots[o]) * t;
      const v = knots[o + 1] + (knots[o + 3] - knots[o + 1]) * t;
      const h = store.sample(chains[tierOf[i]], u, v);
      const tan = (h - hObs - drop[i]) * invD[i];
      if (tan > maxT) {
        maxT = tan;
        maxD = d;
        maxH = h;
      }
    }
    for (; band < nB; band++) {
      bandElev[band][ray] = Math.atan(maxT) / RAD;
      bandDist[band][ray] = maxD;
      bandH[band][ray] = maxH;
    }
  }

  private evalPeak(
    p: PeakInput,
    az: number,
    dPeak: number,
    tier: number,
    knots: Float64Array,
    tolDeg: number,
  ): PeakResult {
    const { dist, invD, drop, tierOf, chains, store, hObs } = this;
    const chain = chains[tier];
    let hDem = -Infinity;
    for (const [u, v] of this.peakSamplePoints(p, tier)) hDem = Math.max(hDem, store.sample(chain, u, v));
    const hUsed = this.p.peakHeightSource === 'osm' && p.ele !== undefined && isFinite(p.ele) ? p.ele : hDem;

    const dEnd = dPeak - this.peakExclusion(tier);
    let maxT = -Infinity;
    for (let i = 0; i < dist.length && dist[i] < dEnd; i++) {
      const [u, v] = SkylineEngine.uv(knots, dist[i]);
      const tan = (store.sample(chains[tierOf[i]], u, v) - hObs - drop[i]) * invD[i];
      if (tan > maxT) maxT = tan;
    }
    const R = this.p.earthRadius;
    const elev = Math.atan2(hUsed - hObs - apparentDrop(dPeak, R, this.p.refractionK), dPeak) / RAD;
    const block = maxT === -Infinity ? -90 : Math.atan(maxT) / RAD;
    const diff = elev - block;
    const status = diff >= 0 ? PeakStatus.Visible : diff >= -tolDeg ? PeakStatus.Marginal : PeakStatus.Hidden;
    return { id: p.id, az, dist: dPeak, hDem, hUsed, elev, block, status };
  }
}

/** 指定地点の標高を複数のズームで比較（低ズームで山頂が低く出る問題の検証用） */
export async function pointDetail(
  store: TileStore,
  lat: number,
  lon: number,
  radiusM: number,
): Promise<{ label: string; center: number; max: number }[]> {
  const u0 = lonToU(lon);
  const v0 = latToV(lat);
  const cases: { label: string; chain: Layer[] }[] = [
    { label: 'DEM5A z15', chain: [demLayer('dem5a', 15)] },
    { label: 'DEM10B z14', chain: [demLayer('dem10b', 14)] },
    { label: 'z13', chain: [demLayer('dem10b', 13)] },
    { label: 'z12', chain: [demLayer('dem10b', 12)] },
    { label: 'z11', chain: [demLayer('dem10b', 11)] },
  ];
  const out: { label: string; center: number; max: number }[] = [];
  for (const c of cases) {
    const z = c.chain[0].zoom;
    const px = groundPixelSize(lat, z);
    const W = 256 * 2 ** z;
    const r = Math.max(1, Math.ceil(radiusM / px));
    const pts: [number, number][] = [];
    for (let ox = -r; ox <= r; ox++)
      for (let oy = -r; oy <= r; oy++) if (ox * ox + oy * oy <= r * r) pts.push([u0 + ox / W, v0 + oy / W]);
    const refs = new Map<string, TileRef>();
    for (const [u, v] of pts) TileStore.collect(c.chain, u, v, refs);
    const ids = await store.ensure(refs.values());
    let max = -Infinity;
    for (const [u, v] of pts) {
      const h = store.sampleLayer(c.chain[0], u, v);
      if (h > max) max = h;
    }
    out.push({ label: c.label, center: store.sampleLayer(c.chain[0], u0, v0), max });
    store.release(ids);
  }
  return out;
}
