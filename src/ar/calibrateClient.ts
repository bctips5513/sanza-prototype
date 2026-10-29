import type { CalibInput, CalibResult } from './calibrate';

let worker: Worker | null = null;
let seq = 0;

/** 画角・傾きの合わせを Worker で行う（コマの画素は端末内の Worker に渡すだけ） */
export function runCalibrate(input: CalibInput): Promise<CalibResult> {
  if (worker) worker.terminate();
  worker = new Worker(new URL('./calibrate.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const wk = worker;
  return new Promise((resolve, reject) => {
    wk.onmessage = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      wk.terminate();
      if (worker === wk) worker = null;
      if (m.type === 'result') resolve(m.result as CalibResult);
      else reject(new Error(m.message));
    };
    wk.onerror = (e) => reject(new Error(e.message));
    // コマの画素は使い回すので転送せずに複製して渡す
    wk.postMessage({ id, input });
  });
}

export function cancelCalibrate(): void {
  worker?.terminate();
  worker = null;
}
