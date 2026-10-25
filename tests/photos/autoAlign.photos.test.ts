import { describe, expect, it } from 'vitest';
import { autoAlign } from '../../src/photo/autoAlign';
import { focalPxFrom35mm } from '../../src/photo/camera';
import { loadCase, loadTruth } from './harness';

const truth = loadTruth();
const names = Object.keys(truth);
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

describe.skipIf(names.length === 0)('実写真での自動合わせ', () => {
  const rows: string[] = [];
  for (const name of names) {
    it(name, async () => {
      const c = await loadCase(name);
      const t = truth[name];
      const fFull = focalPxFrom35mm(c.focal35 ?? 26, c.width, c.height);
      const r = autoAlign({
        rgba: c.rgba,
        width: c.w,
        height: c.h,
        focalPx: fFull * (c.w / c.width),
        skyline: c.skyline,
        azStep: c.azStep,
        yawCenter: c.direction ?? 0,
        yawRange: 180,
        upMode: (process.env.AA_UP as 'local' | 'column' | 'blend' | undefined) ?? undefined,
        trim: process.env.AA_TRIM ? +process.env.AA_TRIM : undefined,
        useProfile: process.env.AA_PROFILE !== '0',
        exifYaw: c.direction,
        skyModel: (process.env.AA_SKY as 'fixed' | 'adaptive' | 'both' | undefined) ?? undefined,
        weights: process.env.AA_W ? { sky: +process.env.AA_W.split(',')[0], texture: +process.env.AA_W.split(',')[1] } : undefined,
      });
      const b = r.best!;
      const dy = angDiff(b.yaw, t.yaw);
      const ok = Math.abs(dy) < 1 && Math.abs(b.pitch - t.pitch) < 1;
      const hfov = (2 * Math.atan(c.w / 2 / (b.focalPx ?? fFull * (c.w / c.width))) * 180) / Math.PI;
      rows.push(
        `${name}\t${ok ? '成功' : '失敗'}\t信頼度=${r.confidence}\t方法=${r.method}\t当てはめ=${r.profileErr?.toFixed(1) ?? '—'}px\t上のきめ比=${r.aboveRatio.toFixed(2)}\t差=${r.margin.toFixed(2)}\t方位誤差=${dy.toFixed(2)}°\t仰角誤差=${(b.pitch - t.pitch).toFixed(2)}°\t傾き誤差=${(b.roll - t.roll).toFixed(2)}°\t画角=${hfov.toFixed(2)}°(正解${t.hfov})\t${(r.elapsedMs / 1000).toFixed(1)}秒\t得点=${b.score.toFixed(2)}/${(r.candidates[1]?.score ?? 0).toFixed(2)}\t正解の順位=${r.candidates.findIndex((x) => Math.abs(angDiff(x.yaw, t.yaw)) < 1) + 1}\t候補=${r.candidates.map((x) => `${x.yaw.toFixed(1)}:${x.score.toFixed(2)}`).join(' ')}`,
      );
      console.log(rows[rows.length - 1]);
      // 失敗するなら「信頼度 低」で知らせられていること（誤った姿勢を高信頼で出さない）
      if (!ok) expect(r.confidence).toBe('low');
    });
  }
});
