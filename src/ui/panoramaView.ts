import { state, visiblePeaks, peakLabel, on, emit } from '../state';
import { attachGestures, fitCanvas } from './gestures';
import { bandFill, drawLabels, layoutLabels, type LabelItem } from './labels';

const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];

export function dirName(az: number): string {
  return DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export interface PanoramaCallbacks {
  onPeakInfo(id: number): void;
  onSkylineInfo(az: number): void;
}

/** 360° パノラマ表示（横軸 = 方位、縦軸 = 仰角） */
export class PanoramaView {
  centerAz = 0;
  centerEl = 1;
  ppd = 20; // 1° あたりの px（横）
  vScale = 1;
  private ctx: CanvasRenderingContext2D;
  private items: LabelItem[] = [];
  private raf = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: PanoramaCallbacks,
  ) {
    this.ctx = canvas.getContext('2d')!;
    attachGestures(canvas, {
      onPan: (dx, dy) => {
        this.centerAz = mod(this.centerAz - dx / this.ppd, 360);
        this.centerEl += dy / (this.ppd * this.vScale);
        this.request();
      },
      onPinch: (s, cx) => this.zoomAt(s, cx),
      onWheel: (d, x) => this.zoomAt(Math.exp(-d * 0.002), x),
      onTap: (x, y) => this.tap(x, y),
    });
    new ResizeObserver(() => this.request()).observe(canvas);
    on((what) => {
      if (what === 'result') this.autoCenterEl();
      this.request();
    });
  }

  private zoomAt(s: number, x: number) {
    const w = this.canvas.clientWidth;
    const azAt = this.centerAz + (x - w / 2) / this.ppd;
    this.ppd = Math.min(400, Math.max(1.5, this.ppd * s));
    this.centerAz = mod(azAt - (x - w / 2) / this.ppd, 360);
    this.request();
  }

  jump(az: number) {
    this.centerAz = mod(az, 360);
    this.request();
  }

  setVScale(v: number) {
    this.vScale = v;
    this.request();
  }

  /** 表示範囲の稜線が画面中央付近に来るよう仰角を合わせる */
  autoCenterEl() {
    const r = state.result;
    if (!r) return;
    const outer = r.bandElev[r.bandElev.length - 1];
    let mx = -90;
    for (let i = 0; i < outer.length; i++) mx = Math.max(mx, outer[i]);
    this.centerEl = mx / 2;
  }

  request() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private x(az: number, w: number): number {
    let d = az - this.centerAz;
    d = mod(d + 180, 360) - 180;
    return w / 2 + d * this.ppd;
  }

  private y(el: number, h: number): number {
    return h * 0.6 - (el - this.centerEl) * this.ppd * this.vScale;
  }

  private draw() {
    const { w, h, dpr } = fitCanvas(this.canvas);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#5a8fc8');
    sky.addColorStop(1, '#cfe3f5');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const r = state.result;
    if (!r) {
      ctx.fillStyle = '#123';
      ctx.font = '15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('「地点」タブで観測地点を選び、計算してください', w / 2, h / 2);
      ctx.textAlign = 'start';
      return;
    }
    const nB = r.bands.length;
    const step = r.azStep;
    const azL = this.centerAz - w / 2 / this.ppd;
    const kL = Math.floor(azL / step) - 1;
    const kR = Math.ceil((azL + w / this.ppd) / step) + 1;

    // 遠い帯から塗る
    for (let b = nB - 1; b >= 0; b--) {
      const arr = r.bandElev[b];
      ctx.beginPath();
      ctx.moveTo(w / 2 + (kL * step - this.centerAz) * this.ppd, h);
      for (let k = kL; k <= kR; k++) {
        const x = w / 2 + (k * step - this.centerAz) * this.ppd;
        ctx.lineTo(x, this.y(arr[mod(k, r.nAz)], h));
      }
      ctx.lineTo(w / 2 + (kR * step - this.centerAz) * this.ppd, h);
      ctx.closePath();
      ctx.fillStyle = bandFill(b, nB);
      ctx.fill();
    }
    // 手前の尾根の輪郭（外側の帯と重ならない部分だけ）
    for (let b = nB - 2; b >= 0; b--) {
      const arr = r.bandElev[b];
      const next = r.bandElev[b + 1];
      ctx.beginPath();
      let pen = false;
      for (let k = kL; k <= kR; k++) {
        const i = mod(k, r.nAz);
        const x = w / 2 + (k * step - this.centerAz) * this.ppd;
        if (arr[i] < next[i] - 0.005) {
          const yy = this.y(arr[i], h);
          if (pen) ctx.lineTo(x, yy);
          else ctx.moveTo(x, yy);
          pen = true;
        } else pen = false;
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // 最外稜線
    {
      const arr = r.bandElev[nB - 1];
      ctx.beginPath();
      for (let k = kL; k <= kR; k++) {
        const x = w / 2 + (k * step - this.centerAz) * this.ppd;
        const yy = this.y(arr[mod(k, r.nAz)], h);
        if (k === kL) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    this.drawGrid(ctx, w, h);

    // 山名
    const items: LabelItem[] = [];
    for (const { peak, res } of visiblePeaks()) {
      const x = this.x(res.az, w);
      if (x < -50 || x > w + 50) continue;
      items.push({
        id: res.id,
        x,
        y: this.y(res.elev, h),
        title: peakLabel(peak),
        sub: `${Math.round(res.hUsed)}m ${(res.dist / 1000).toFixed(1)}km`,
        priority: res.hUsed - res.dist / 200,
        named: !!peak.name,
        marginal: res.status === 1,
      });
    }
    this.items = items;
    const rowH = 30;
    const maxRows = Math.max(1, Math.floor((h * 0.45) / rowH));
    const placed = layoutLabels(ctx, items, maxRows, 'bold 12px system-ui, sans-serif', '10px system-ui, sans-serif');
    drawLabels(ctx, items, placed, 6, rowH, {
      titleFont: 'bold 12px system-ui, sans-serif',
      subFont: '10px system-ui, sans-serif',
      color: '#fff',
      halo: 'rgba(0,0,0,0.75)',
      selected: state.selectedPeak,
    });
  }

  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    // 方位目盛り
    const span = w / this.ppd;
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];
    const tick = nice.find((t) => t * this.ppd >= 64) ?? 90;
    const azL = this.centerAz - span / 2;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, h - 20, w, 20);
    for (let a = Math.ceil(azL / tick) * tick; a <= azL + span; a += tick) {
      const x = this.x(a, w);
      const az = mod(a, 360);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(x, h - 20);
      ctx.lineTo(x, h - 15);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      const azr = +az.toFixed(1) % 360;
      const label = azr % 45 === 0 ? `${dirName(azr)} ${azr}°` : `${azr}°`;
      ctx.fillText(label, x, h - 4);
    }
    // 仰角目盛り
    const ppdV = this.ppd * this.vScale;
    const et = nice.find((t) => t * ppdV >= 36) ?? 90;
    const elTop = this.centerEl + (h * 0.6) / ppdV;
    const elBot = this.centerEl - (h * 0.4) / ppdV;
    ctx.textAlign = 'left';
    for (let e = Math.ceil(elBot / et) * et; e <= elTop; e += et) {
      const y = this.y(e, h);
      ctx.strokeStyle = Math.abs(e) < 1e-9 ? 'rgba(255,60,60,0.7)' : 'rgba(255,255,255,0.25)';
      ctx.setLineDash(Math.abs(e) < 1e-9 ? [6, 4] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(`${+e.toFixed(1)}°`, 3, y - 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${+e.toFixed(1)}°`, 3, y - 2);
      ctx.lineWidth = 1;
    }
  }

  private tap(x: number, y: number) {
    const r = state.result;
    if (!r) return;
    let best: LabelItem | null = null;
    let bd = 18;
    for (const it of this.items) {
      const d = Math.hypot(it.x - x, it.y - 5 - y);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    if (best) {
      state.selectedPeak = best.id;
      this.cb.onPeakInfo(best.id);
      emit('select');
      return;
    }
    const az = mod(this.centerAz + (x - this.canvas.clientWidth / 2) / this.ppd, 360);
    this.cb.onSkylineInfo(az);
  }
}
