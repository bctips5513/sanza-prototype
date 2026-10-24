/// <reference lib="webworker" />
import { TileStore, type TileRef } from '../dem/tileStore';
import { FINEST_CHAIN } from '../dem/tileSource';
import { latToV, lonToU } from '../geo/mercator';
import { SkylineEngine, pointDetail, type PeakInput, type SkylineParams } from './compute';

export type WorkerRequest =
  | { type: 'skyline'; id: number; params: SkylineParams; peaks: PeakInput[]; tolDeg: number }
  | { type: 'peaks'; id: number; peaks: PeakInput[]; tolDeg: number }
  | { type: 'ground'; id: number; lat: number; lon: number }
  | { type: 'point'; id: number; lat: number; lon: number; radius: number };

const store = new TileStore({ maxTiles: 160, concurrency: 8 });
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let lastEngine: SkylineEngine | null = null;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'skyline') {
      const before = { ...store.stats };
      const engine = new SkylineEngine(store, msg.params);
      lastEngine = engine;
      const res = await engine.run(
        msg.peaks,
        (p) => ctx.postMessage({ type: 'progress', id: msg.id, ...p, stats: store.stats }),
        msg.tolDeg,
      );
      const stats = {
        network: store.stats.network - before.network,
        cache: store.stats.cache - before.cache,
        missing: store.stats.missing - before.missing,
        bytes: store.stats.bytes - before.bytes,
        missRefs: store.missRefs,
      };
      const transfer = [...res.bandElev, ...res.bandDist, ...res.bandH].map((a) => a.buffer);
      ctx.postMessage({ type: 'result', id: msg.id, result: res, stats }, transfer);
    } else if (msg.type === 'peaks') {
      if (!lastEngine) throw new Error('先に稜線を計算してください');
      const peaks = await lastEngine.evalPeaks(msg.peaks, msg.tolDeg, (p) =>
        ctx.postMessage({ type: 'progress', id: msg.id, ...p, stats: store.stats }),
      );
      ctx.postMessage({ type: 'result', id: msg.id, result: peaks });
    } else if (msg.type === 'ground') {
      const u = lonToU(msg.lon);
      const v = latToV(msg.lat);
      const refs = new Map<string, TileRef>();
      TileStore.collect(FINEST_CHAIN, u, v, refs);
      const ids = await store.ensure(refs.values());
      const h = store.sample(FINEST_CHAIN, u, v);
      const h5a = store.sampleLayer(FINEST_CHAIN[0], u, v);
      store.release(ids);
      ctx.postMessage({ type: 'result', id: msg.id, result: { h, src: h5a === h5a ? 'DEM5A' : 'DEM10B' } });
    } else if (msg.type === 'point') {
      const rows = await pointDetail(store, msg.lat, msg.lon, msg.radius);
      ctx.postMessage({ type: 'result', id: msg.id, result: rows });
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
