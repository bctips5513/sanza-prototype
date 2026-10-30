// AR の山名：どの山を出すかの絞り込みと、山頂のすぐ近くへの配置
//
// 絞り込み：
//   ・有名な山（日本百名山・二百名山・三百名山・信州百名山）は優先して出す
//   ・近い山（NEAR_ALL 以内）は名前があればすべて候補
//   ・それより遠い山は「自分より高い山までの距離」が「観測点からの距離 × k」以上ある山（周りの主峰）だけ。
//     遠いほど比べる範囲が広がるので、遠くの山ほど主峰だけが残る
// 配置：優先度の高い順に、山頂のすぐ上（重なれば少しずつ上、上が詰まれば下）へ置き、置けない山は出さない。

import famousRaw from '../peaks/famous.json';

export interface FamousPeak {
  n: string;
  la: number;
  lo: number;
  e: number | null;
  /** 1 = 日本百名山, 2 = 二百名山, 4 = 三百名山, 8 = 信州百名山 */
  l: number;
  /** 照合した OSM の山頂の id */
  o?: number;
}
export const FAMOUS = famousRaw as FamousPeak[];
export const LIST_HYAKU = 1;
export const LIST_NIHYAKU = 2;
export const LIST_SANBYAKU = 4;
export const LIST_SHINSHU = 8;

export type Density = 'few' | 'normal' | 'many';

/** 名前があればすべて出す距離 [m] */
const NEAR_ALL = 3000;
const DOMINANCE_K: Record<Density, number> = { few: 0.08, normal: 0.04, many: 0.02 };

export interface PeakInfo {
  id: number;
  name: string;
  /** 表示する標高 [m] */
  ele: number;
  lat: number;
  lon: number;
  /** 有名な山の一覧（ビットの組） */
  lists: number;
}

export interface LabelCandidate extends PeakInfo {
  dist: number;
  /** 自分より高い山までの距離 [m]（無ければ Infinity） */
  higherDist: number;
  marginal: boolean;
}

/** 一覧の格付け（大きいほど優先） */
export function famousRank(lists: number, useShinshu: boolean): number {
  if (lists & LIST_HYAKU) return 4;
  if (lists & (LIST_NIHYAKU | LIST_SANBYAKU)) return 3;
  if (useShinshu && lists & LIST_SHINSHU) return 2;
  return 0;
}

/** 各山について、自分より高い山（名前の有無は問わない）までの距離を求める（格子で近い山だけ比べる） */
export function higherPeakDistances(peaks: { id: number; lat: number; lon: number; ele: number }[]): Map<number, number> {
  const CELL = 0.05; // 約 5 km
  const grid = new Map<string, typeof peaks>();
  const key = (a: number, b: number) => `${a}_${b}`;
  for (const p of peaks) {
    const k = key(Math.floor(p.lat / CELL), Math.floor(p.lon / CELL));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  const out = new Map<number, number>();
  const R = 6371000;
  const RAD = Math.PI / 180;
  for (const p of peaks) {
    const a0 = Math.floor(p.lat / CELL);
    const b0 = Math.floor(p.lon / CELL);
    const cos = Math.cos(p.lat * RAD);
    let best = Infinity;
    // 近い輪から探し、見つかった距離より外の輪は見ない
    for (let ring = 0; ring <= 8; ring++) {
      if (best < ring * CELL * 111_000 * cos) break;
      for (let da = -ring; da <= ring; da++)
        for (let db = -ring; db <= ring; db++) {
          if (Math.max(Math.abs(da), Math.abs(db)) !== ring) continue;
          for (const q of grid.get(key(a0 + da, b0 + db)) ?? []) {
            if (q.ele <= p.ele || q.id === p.id) continue;
            const d = Math.hypot((q.lon - p.lon) * RAD * cos, (q.lat - p.lat) * RAD) * R;
            if (d < best) best = d;
          }
        }
    }
    out.set(p.id, best);
  }
  return out;
}

/** 出す候補か（有名な山・近い山・周りの主峰） */
export function isMajor(c: LabelCandidate, density: Density, useShinshu: boolean): boolean {
  if (famousRank(c.lists, useShinshu) > 0) return true;
  if (c.dist <= NEAR_ALL * (density === 'few' ? 0.5 : density === 'many' ? 2 : 1)) return true;
  return c.higherDist >= c.dist * DOMINANCE_K[density];
}

export function labelPriority(c: LabelCandidate, useShinshu: boolean): number {
  // 一覧の格付けを最優先し、次に周りでどれだけ抜きん出ているか、近さ
  const dom = Math.min(3, Math.log10(Math.max(1, Math.min(c.higherDist, 1e6)) / Math.max(200, c.dist)) + 2);
  return famousRank(c.lists, useShinshu) * 10 + dom - c.dist / 100_000;
}

export interface ScreenLabel {
  id: number;
  /** 山頂の画面位置 */
  x: number;
  y: number;
  title: string;
  sub: string;
  priority: number;
  marginal: boolean;
  famous: boolean;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export interface LabelStyle {
  titleFont: string;
  subFont: string;
}

/**
 * 山頂の近くに山名を置いて描く。
 * top より上（画面上部の表示の下）には置かない。重なって置けない山は名前を出さず、山頂の印だけ描く。
 */
export function drawPeakLabels(ctx: CanvasRenderingContext2D, items: ScreenLabel[], W: number, top: number, bottom: number, style: LabelStyle): void {
  const LINE_H = 16;
  const GAP = 12; // 山頂の印から名前までの最小の間隔
  const STEP = 17;
  const placed: (Box & { it: ScreenLabel; above: boolean })[] = [];
  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  for (const it of sorted) {
    ctx.font = style.titleFont;
    const wt = ctx.measureText(it.title).width;
    ctx.font = style.subFont;
    const ws = it.sub ? ctx.measureText(it.sub).width + 4 : 0;
    const w = wt + ws + 6;
    const x0 = Math.min(Math.max(2, it.x - w / 2), W - w - 2);
    let done = false;
    for (const above of [true, false]) {
      for (let lvl = 0; lvl < 6 && !done; lvl++) {
        const y1 = above ? it.y - GAP - lvl * STEP : it.y + GAP + LINE_H + lvl * STEP;
        const box = { x0, y0: y1 - LINE_H, x1: x0 + w, y1 };
        if (box.y0 < top || box.y1 > bottom) continue;
        if (placed.some((p) => overlaps(p, box))) continue;
        placed.push({ ...box, it, above });
        done = true;
      }
      if (done) break;
    }
  }
  // 山頂の印
  for (const it of items) {
    ctx.beginPath();
    ctx.moveTo(it.x, it.y - 1);
    ctx.lineTo(it.x - 4.5, it.y - 9);
    ctx.lineTo(it.x + 4.5, it.y - 9);
    ctx.closePath();
    ctx.fillStyle = it.marginal ? 'rgba(255,204,0,0.55)' : '#ffcc00';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // 引き出し線と名前
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  for (const p of placed) {
    const { it } = p;
    const lx = Math.min(Math.max(it.x, p.x0 + 2), p.x1 - 2);
    ctx.beginPath();
    if (p.above) {
      ctx.moveTo(lx, p.y1 + 1);
      ctx.lineTo(it.x, it.y - 10);
    } else {
      ctx.moveTo(lx, p.y0 - 1);
      ctx.lineTo(it.x, it.y + 1);
    }
    ctx.strokeStyle = it.marginal ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const base = p.y1 - 3;
    ctx.font = style.titleFont;
    const wt = ctx.measureText(it.title).width;
    const color = it.marginal ? 'rgba(255,255,255,0.7)' : it.famous ? '#fff2b3' : '#fff';
    for (const [text, font, x] of [
      [it.title, style.titleFont, p.x0 + 3],
      [it.sub, style.subFont, p.x0 + 3 + wt + 4],
    ] as const) {
      if (!text) continue;
      ctx.font = font;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(text, x, base);
      ctx.fillStyle = color;
      ctx.fillText(text, x, base);
    }
  }
}
