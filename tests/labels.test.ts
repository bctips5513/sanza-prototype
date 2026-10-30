import { describe, expect, it } from 'vitest';
import { traceSilhouettes } from '../src/skyline/silhouette';
import type { SkylineResult } from '../src/skyline/compute';
import { higherPeakDistances, isMajor, type LabelCandidate } from '../src/ar/peakLabels';

/** 方位ごとの輪郭点の列から、輪郭の部分だけを持つ稜線の計算結果を作る */
function fakeResult(perRay: [number, number, number][][], azStep = 0.1): SkylineResult {
  const nAz = perRay.length;
  const edgeOff = new Uint32Array(nAz + 1);
  for (let i = 0; i < nAz; i++) edgeOff[i + 1] = edgeOff[i] + perRay[i].length;
  const flat = perRay.flat();
  return {
    nAz,
    azStep,
    bandElev: [new Float32Array(nAz).fill(10)],
    edgeOff,
    edgeElev: Float32Array.from(flat.map((e) => e[0])),
    edgeDist: Float32Array.from(flat.map((e) => e[1])),
    edgeBehind: Float32Array.from(flat.map((e) => e[2])),
  } as unknown as SkylineResult;
}

describe('手前の尾根の輪郭線', () => {
  it('隣の方位で仰角と距離が近い点をつなぎ、短い線と段差の小さい線は捨てる', () => {
    const rays: [number, number, number][][] = Array.from({ length: 200 }, () => []);
    // 尾根A：方位 20〜79 番、5km 先、奥は 20km 先（主要）
    for (let i = 20; i < 80; i++) rays[i].push([2 + i * 0.01, 5000, 20000]);
    // 尾根B：方位 30〜89 番、3km 先、奥は 3.3km（同じ斜面の小さな段差）
    for (let i = 30; i < 90; i++) rays[i].push([1, 3000, 3300]);
    // 短い線：方位 100〜104 番
    for (let i = 100; i < 105; i++) rays[i].push([3, 8000, 30000]);
    // 足元の線：方位 120〜179 番、500m 先
    for (let i = 120; i < 180; i++) rays[i].push([-2, 500, 5000]);
    // 1 本だけ欠けた尾根C（方位 140 番が無い）
    for (let i = 130; i < 170; i++) if (i !== 140) rays[i].push([4, 10000, 40000]);
    const lines = traceSilhouettes(fakeResult(rays));
    expect(lines.map((l) => [l.i0, l.elev.length, Math.round(l.dist)])).toEqual([
      [20, 60, 5000],
      [130, 40, 10000],
    ]);
    expect(lines[1].elev[10]).toBeCloseTo(4);
  });

  it('北（方位 0）の継ぎ目をまたいでもつながる', () => {
    const rays: [number, number, number][][] = Array.from({ length: 100 }, () => []);
    for (const i of [...Array(20).keys()].map((k) => (90 + k) % 100)) rays[i].push([1, 5000, 20000]);
    const lines = traceSilhouettes(fakeResult(rays));
    expect(lines.length).toBe(1);
    expect(lines[0].i0).toBe(90);
    expect(lines[0].elev.length).toBe(20);
  });
});

describe('山名の絞り込み', () => {
  it('自分より高い山までの距離', () => {
    const d = higherPeakDistances([
      { id: 1, lat: 36, lon: 137, ele: 3000 },
      { id: 2, lat: 36.01, lon: 137, ele: 2000 },
      { id: 3, lat: 36.3, lon: 137, ele: 2500 },
    ]);
    expect(d.get(1)).toBe(Infinity);
    expect(d.get(2)).toBeCloseTo(1112, -1);
    expect(d.get(3)).toBeCloseTo(33358, -2);
  });

  it('遠い山は周りの主峰だけ、有名な山と近い山は出す', () => {
    const c = (dist: number, higherDist: number, lists = 0): LabelCandidate => ({ id: 0, name: 'x', ele: 0, lat: 0, lon: 0, lists, dist, higherDist, marginal: false });
    expect(isMajor(c(2000, 100), 'normal', true)).toBe(true); // 近い
    expect(isMajor(c(50_000, 1000), 'normal', true)).toBe(false); // 遠くの小さな峰
    expect(isMajor(c(50_000, 3000), 'normal', true)).toBe(true); // 遠くの主峰
    expect(isMajor(c(50_000, 3000), 'few', true)).toBe(false);
    expect(isMajor(c(50_000, 100, 1), 'few', true)).toBe(true); // 百名山
    expect(isMajor(c(50_000, 100, 8), 'normal', false)).toBe(false); // 信州百名山（優先しない設定）
  });
});
