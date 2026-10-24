import { decode, convertIndexedToRgb } from 'fast-png';

export const TILE_SIZE = 256;

/**
 * 地理院標高タイルの1画素値 → 標高 [m]。無効値は NaN。
 * x = R·65536 + G·256 + B
 *   x < 2^23  : x × 0.01 m
 *   x = 2^23  : 無効値
 *   x > 2^23  : (x − 2^24) × 0.01 m
 */
export function rgbToElevation(r: number, g: number, b: number): number {
  const x = r * 65536 + g * 256 + b;
  if (x < 8388608) return x * 0.01;
  if (x === 8388608) return NaN;
  return (x - 16777216) * 0.01;
}

/**
 * PNG バイト列を 256×256 の標高配列（Float32, 無効値 NaN）に変換。
 * Canvas を経由すると色管理で RGB が変わる恐れがあるため、純JSでデコードする。
 */
export function decodeDemPng(bytes: Uint8Array): Float32Array {
  const png = decode(bytes);
  let data: ArrayLike<number> = png.data;
  let ch = png.channels;
  if (png.palette) {
    data = convertIndexedToRgb(png);
    ch = png.transparency ? 4 : 3;
  }
  if (png.depth !== 8 && !png.palette) throw new Error(`未対応のビット深度: ${png.depth}`);
  const n = png.width * png.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    // アルファ 0 の画素は無効値として扱う
    if (ch === 4 && data[o + 3] === 0) {
      out[i] = NaN;
      continue;
    }
    out[i] = rgbToElevation(data[o], data[o + 1], data[o + 2]);
  }
  return out;
}
