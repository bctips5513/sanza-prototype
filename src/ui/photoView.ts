import { state, visiblePeaks, peakLabel, on } from '../state';
import { basis, dirFromAzEl, project, type Basis, type CameraParams } from '../photo/camera';
import { attachGestures, fitCanvas } from './gestures';
import { bandLine, drawLabels, layoutLabels, type LabelItem } from './labels';

export type PhotoMode = 'adjust' | 'view' | 'align';

const RAD = Math.PI / 180;

/** 写真と計算稜線の重ね合わせ表示 */
export class PhotoView {
  mode: PhotoMode = 'adjust';
  opacity = 0.85;
  showBands = true;
  showLabels = true;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private fitted: string | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: { onCamChange(): void; onAlignTap(px: number, py: number): void },
  ) {
    this.ctx = canvas.getContext('2d')!;
    attachGestures(canvas, {
      onPan: (dx, dy) => {
        const ph = state.photo;
        if (!ph) return;
        if (this.mode === 'adjust') {
          const F = ph.cam.focalPx;
          ph.cam.yaw = (((ph.cam.yaw - Math.atan(dx / this.scale / F) / RAD) % 360) + 360) % 360;
          ph.cam.pitch += Math.atan(dy / this.scale / F) / RAD;
          this.cb.onCamChange();
        } else {
          this.ox += dx;
          this.oy += dy;
        }
        this.request();
      },
      onPinch: (s, cx, cy, dx, dy) => {
        const ph = state.photo;
        if (!ph) return;
        if (this.mode === 'adjust') {
          ph.cam.focalPx *= s;
          this.cb.onCamChange();
        } else {
          this.zoomAt(s, cx, cy);
          this.ox += dx;
          this.oy += dy;
        }
        this.request();
      },
      onWheel: (d, x, y) => {
        this.zoomAt(Math.exp(-d * 0.002), x, y);
        this.request();
      },
      onTap: (x, y) => {
        if (this.mode !== 'align' || !state.photo) return;
        const px = (x - this.ox) / this.scale;
        const py = (y - this.oy) / this.scale;
        if (!Number.isFinite(px) || !Number.isFinite(py)) return;
        if (px < 0 || py < 0 || px > state.photo.cam.width || py > state.photo.cam.height) return;
        this.cb.onAlignTap(px, py);
      },
    });
    new ResizeObserver(() => {
      this.fitted = null;
      this.request();
    }).observe(canvas);
    on(() => this.request());
  }

  private zoomAt(s: number, x: number, y: number) {
    const ns = Math.min(8, Math.max(0.02, this.scale * s));
    const k = ns / this.scale;
    this.ox = x - (x - this.ox) * k;
    this.oy = y - (y - this.oy) * k;
    this.scale = ns;
  }

  fit() {
    const ph = state.photo;
    if (!ph) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return; // 非表示中は表示されたときに合わせ直す
    this.scale = Math.min(w / ph.cam.width, h / ph.cam.height);
    this.ox = (w - ph.cam.width * this.scale) / 2;
    this.oy = (h - ph.cam.height * this.scale) / 2;
    this.fitted = ph.url;
    this.request();
  }

  request() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /** 画像座標 → 画面座標 */
  toScreen(p: [number, number]): [number, number] {
    return [this.ox + p[0] * this.scale, this.oy + p[1] * this.scale];
  }

  private draw() {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    const ph = state.photo;
    if (!ph) {
      ctx.fillStyle = '#aaa';
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('写真を選択してください（端末内で処理し、送信しません）', w / 2, h / 2);
      ctx.textAlign = 'start';
      return;
    }
    if (this.fitted !== ph.url) this.fit();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ph.img, this.ox, this.oy, ph.cam.width * this.scale, ph.cam.height * this.scale);

    const cam = ph.cam;
    const b = basis(cam.yaw, cam.pitch, cam.roll);
    ctx.save();
    ctx.globalAlpha = this.opacity;
    if (state.result) this.drawSkyline(ctx, cam, b);
    if (this.showLabels && state.result) this.drawPeaks(ctx, cam, b, h);
    ctx.restore();
    this.drawAlign(ctx, cam, b);
  }

  private drawSkyline(ctx: CanvasRenderingContext2D, cam: CameraParams, b: Basis) {
    const r = state.result!;
    const nB = r.bands.length;
    const half = Math.atan(Math.hypot(cam.width, cam.height) / 2 / cam.focalPx) / RAD + 2;
    const step = r.azStep;
    const k0 = Math.floor((cam.yaw - half) / step);
    const k1 = Math.ceil((cam.yaw + half) / step);
    const maxJump = Math.max(cam.width, cam.height) * this.scale * 0.5;

    const strokeBand = (bi: number, mask: ((i: number) => boolean) | null, style: string, width: number, halo: boolean) => {
      const arr = r.bandElev[bi];
      ctx.beginPath();
      let prev: [number, number] | null = null;
      for (let k = k0; k <= k1; k++) {
        const i = ((k % r.nAz) + r.nAz) % r.nAz;
        if (mask && !mask(i)) {
          prev = null;
          continue;
        }
        const p = project(cam, b, dirFromAzEl(k * step, arr[i]));
        if (!p) {
          prev = null;
          continue;
        }
        const s = this.toScreen(p);
        if (prev && Math.hypot(s[0] - prev[0], s[1] - prev[1]) < maxJump) ctx.lineTo(s[0], s[1]);
        else ctx.moveTo(s[0], s[1]);
        prev = s;
      }
      if (halo) {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = width + 2;
        ctx.stroke();
      }
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    if (this.showBands) {
      for (let bi = nB - 2; bi >= 0; bi--) {
        const arr = r.bandElev[bi];
        const next = r.bandElev[bi + 1];
        strokeBand(bi, (i) => arr[i] < next[i] - 0.005, bandLine(bi, nB), 1.2, false);
      }
    }
    strokeBand(nB - 1, null, '#ff2d55', 2, true);
  }

  private drawPeaks(ctx: CanvasRenderingContext2D, cam: CameraParams, b: Basis, h: number) {
    const items: LabelItem[] = [];
    for (const { peak, res } of visiblePeaks()) {
      const p = project(cam, b, dirFromAzEl(res.az, res.elev));
      if (!p || p[0] < 0 || p[0] > cam.width || p[1] < -cam.height || p[1] > cam.height * 2) continue;
      const [x, y] = this.toScreen(p);
      items.push({
        id: res.id,
        x,
        y,
        title: peakLabel(peak),
        sub: `${Math.round(res.hUsed)}m ${(res.dist / 1000).toFixed(1)}km`,
        priority: res.hUsed - res.dist / 200,
        named: !!peak.name,
        marginal: res.status === 1,
      });
    }
    const rowH = 30;
    const top = Math.max(4, this.oy + 4);
    const maxRows = Math.max(1, Math.floor((h * 0.4) / rowH));
    const placed = layoutLabels(ctx, items, maxRows, 'bold 12px system-ui, sans-serif', '10px system-ui, sans-serif');
    drawLabels(ctx, items, placed, top, rowH, {
      titleFont: 'bold 12px system-ui, sans-serif',
      subFont: '10px system-ui, sans-serif',
      color: '#fff',
      halo: 'rgba(0,0,0,0.8)',
      selected: state.selectedPeak,
    });
  }

  private drawAlign(ctx: CanvasRenderingContext2D, cam: CameraParams, b: Basis) {
    state.alignTaps.forEach((t, n) => {
      const [x, y] = this.toScreen([t.px, t.py]);
      const color = n < 2 ? '#34c759' : '#ff9f0a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 12);
      ctx.lineTo(x, y + 12);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(String(n + 1), x + 6, y - 6);
      const res = t.peakId !== undefined ? state.peakResults.get(t.peakId) : undefined;
      if (res) {
        const p = project(cam, b, dirFromAzEl(res.az, res.elev));
        if (p) {
          const [qx, qy] = this.toScreen(p);
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(qx, qy);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(qx, qy, 4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    });
  }
}
