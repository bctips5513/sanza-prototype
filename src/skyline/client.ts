import type { PeakInput, PeakResult, Progress, SkylineParams, SkylineResult } from './compute';
import type { WorkerRequest } from './worker';

export interface RunStats {
  network: number;
  cache: number;
  missing: number;
  bytes: number;
  missRefs: number;
}

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress & { stats: RunStats }) => void;
};

/** 計算用 Web Worker とのやり取り */
export class SkylineClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (ev) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m);
      else if (m.type === 'result') {
        this.pending.delete(m.id);
        p.resolve(m.stats ? { ...m.result, stats: m.stats } : m.result);
      } else if (m.type === 'error') {
        this.pending.delete(m.id);
        p.reject(new Error(m.message));
      }
    };
  }

  private call<T>(req: DistOmit<WorkerRequest, 'id'>, onProgress?: Pending['onProgress']): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  skyline(
    params: SkylineParams,
    peaks: PeakInput[],
    tolDeg: number,
    onProgress?: Pending['onProgress'],
  ): Promise<SkylineResult & { stats: RunStats }> {
    return this.call({ type: 'skyline', params, peaks, tolDeg }, onProgress);
  }

  peaks(peaks: PeakInput[], tolDeg: number, onProgress?: Pending['onProgress']): Promise<PeakResult[]> {
    return this.call({ type: 'peaks', peaks, tolDeg }, onProgress);
  }

  ground(lat: number, lon: number): Promise<{ h: number; src: string }> {
    return this.call({ type: 'ground', lat, lon });
  }

  point(lat: number, lon: number, radius: number): Promise<{ label: string; center: number; max: number }[]> {
    return this.call({ type: 'point', lat, lon, radius });
  }
}
