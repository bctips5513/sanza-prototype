import { it } from 'vitest';
import { autoAlign } from '../../src/photo/autoAlign';
import { focalPxFrom35mm } from '../../src/photo/camera';
import { loadCase, loadTruth } from './harness';

// AR を想定：センサーの向き（コンパス誤差 ±12°・仰角 −1.1°・傾き 0）の近くだけを探したときの成功率
const truth = loadTruth();
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

it.skipIf(Object.keys(truth).length === 0)('センサーの向きを手がかりに狭く探す', async () => {
  const rows: string[] = [];
  for (const name of Object.keys(truth)) {
    const c = await loadCase(name);
    const t = truth[name];
    const fFull = focalPxFrom35mm(c.focal35 ?? 26, c.width, c.height);
    for (const err of [-12, 8]) {
      const r = autoAlign({
        rgba: c.rgba,
        width: c.w,
        height: c.h,
        focalPx: fFull * (c.w / c.width),
        skyline: c.skyline,
        azStep: c.azStep,
        yawCenter: t.yaw + err,
        yawRange: 20,
        pitchCenter: t.pitch - 1.1,
        pitchRange: 3,
        rollCenter: 0,
        rollRange: 3,
      });
      const b = r.best!;
      const dy = angDiff(b.yaw, t.yaw);
      const ok = Math.abs(dy) < 0.5 && Math.abs(b.pitch - t.pitch) < 0.5;
      rows.push(`${name}\tコンパス誤差${err}°\t${ok ? '成功' : '失敗'}\t信頼度=${r.confidence}\t方法=${r.method}\t方位誤差=${dy.toFixed(2)}°\t仰角誤差=${(b.pitch - t.pitch).toFixed(2)}°\t${(r.elapsedMs / 1000).toFixed(1)}秒`);
    }
  }
  console.log(rows.join('\n'));
}, 600_000);
