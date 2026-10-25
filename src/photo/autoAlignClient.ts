import type { AutoAlignInput, AutoAlignResult } from './autoAlign';

const SIZE = 800;
let worker: Worker | null = null;
let seq = 0;

/**
 * 写真を縮小して自動合わせ用の Worker に渡す（写真データは端末内の Worker に渡すだけで外部送信しない）
 */
export function runAutoAlign(
  img: HTMLImageElement,
  fullWidth: number,
  fullFocalPx: number,
  skyline: Float32Array,
  azStep: number,
  yawCenter: number,
  yawRange: number,
  exifYaw: number | undefined,
  onProgress?: (done: number, total: number) => void,
): Promise<AutoAlignResult> {
  const scale = SIZE / fullWidth;
  const w = SIZE;
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;

  if (worker) worker.terminate(); // 前回の処理が残っていれば打ち切る
  worker = new Worker(new URL('./autoAlign.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const input: AutoAlignInput = {
    rgba,
    width: w,
    height: h,
    focalPx: fullFocalPx * scale,
    skyline: skyline.slice(),
    azStep,
    yawCenter,
    yawRange,
    exifYaw,
  };
  return new Promise((resolve, reject) => {
    const wk = worker!;
    wk.onmessage = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.done, m.total);
      else {
        wk.terminate();
        if (worker === wk) worker = null;
        if (m.type === 'result') {
          // 焦点距離を元画像の画素単位に戻す
          const r = m.result as AutoAlignResult;
          for (const c of r.candidates) c.focalPx /= scale;
          resolve(r);
        }
        else reject(new Error(m.message));
      }
    };
    wk.onerror = (e) => reject(new Error(e.message));
    wk.postMessage({ id, input }, [rgba.buffer, input.skyline.buffer]);
  });
}
