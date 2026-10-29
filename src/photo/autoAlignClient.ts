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
  return runAutoAlignSource(img, fullWidth, img.naturalHeight * (fullWidth / img.naturalWidth), fullFocalPx, skyline, azStep, { yawCenter, yawRange, exifYaw }, onProgress);
}

export type AutoAlignOptions = Omit<AutoAlignInput, 'rgba' | 'width' | 'height' | 'focalPx' | 'skyline' | 'azStep'>;

/**
 * 画像（写真・カメラ映像のコマ）を幅 size に縮小して自動合わせする。
 * srcWidth/srcHeight/srcFocalPx は元画像の画素単位。結果の焦点距離も元画像の画素単位に戻す。
 */
export function runAutoAlignSource(
  src: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  srcFocalPx: number,
  skyline: Float32Array,
  azStep: number,
  opts: AutoAlignOptions,
  onProgress?: (done: number, total: number) => void,
  size = SIZE,
): Promise<AutoAlignResult> {
  const scale = size / srcWidth;
  const w = size;
  const h = Math.round(srcHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(src, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;

  if (worker) worker.terminate(); // 前回の処理が残っていれば打ち切る
  worker = new Worker(new URL('./autoAlign.worker.ts', import.meta.url), { type: 'module' });
  const id = ++seq;
  const input: AutoAlignInput = {
    ...opts,
    rgba,
    width: w,
    height: h,
    focalPx: srcFocalPx * scale,
    skyline: skyline.slice(),
    azStep,
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
          if (r.best && !r.candidates.includes(r.best)) r.best.focalPx /= scale;
          resolve(r);
        }
        else reject(new Error(m.message));
      }
    };
    wk.onerror = (e) => reject(new Error(e.message));
    wk.postMessage({ id, input }, [rgba.buffer, input.skyline.buffer]);
  });
}

/** 実行中の自動合わせを打ち切る */
export function cancelAutoAlign(): void {
  worker?.terminate();
  worker = null;
}
