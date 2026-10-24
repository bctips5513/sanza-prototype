import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { decodeDemPng, rgbToElevation } from '../src/dem/decode';
import { elevationToRgb } from './helpers';

describe('地理院PNG標高デコード', () => {
  it('仕様どおりの換算', () => {
    expect(rgbToElevation(0, 0, 0)).toBe(0);
    expect(rgbToElevation(0, 0, 1)).toBeCloseTo(0.01, 10);
    // 3776.24 m → x = 377624 = 0x05 C3 18
    expect(rgbToElevation(0x05, 0xc3, 0x18)).toBeCloseTo(3776.24, 6);
    // 2^23 は無効値
    expect(rgbToElevation(128, 0, 0)).toBeNaN();
    // 2^23 超は負値：x = 2^24 - 1 → -0.01 m
    expect(rgbToElevation(255, 255, 255)).toBeCloseTo(-0.01, 10);
    // 2^23 - 1 は最大の正値 83886.07 m
    expect(rgbToElevation(127, 255, 255)).toBeCloseTo(83886.07, 6);
  });

  it('PNGのデコード（RGB）で値がビット単位で保たれる', () => {
    const vals = [0, 0.01, 123.45, 3776.24, -5.67, NaN];
    const data = new Uint8Array(256 * 256 * 3);
    for (let i = 0; i < 256 * 256; i++) data.set(elevationToRgb(vals[i % vals.length]), i * 3);
    const png = encode({ width: 256, height: 256, data, channels: 3, depth: 8 });
    const out = decodeDemPng(png);
    for (let i = 0; i < 12; i++) {
      const v = vals[i % vals.length];
      if (Number.isNaN(v)) expect(out[i]).toBeNaN();
      else expect(out[i]).toBeCloseTo(v, 2);
    }
  });
});
