import type { DemSourceId } from '../settings';

/** タイル層（URL テンプレートとズームの組） */
export interface Layer {
  key: string;
  zoom: number;
  url(x: number, y: number): string;
}

const BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

export function demLayer(source: DemSourceId, zoom: number): Layer {
  const name = source === 'dem5a' ? 'dem5a_png' : 'dem_png';
  return {
    key: `${name}/${zoom}`,
    zoom,
    url: (x, y) => `${BASE}/${name}/${zoom}/${x}/${y}.png`,
  };
}

/**
 * 距離帯ごとの参照順（先頭から使い、無効値なら次へ）。
 * dem5a は z15 のみ提供のため、z15 指定時のフォールバックは dem_png z14。
 */
export function layerChain(source: DemSourceId, zoom: number): Layer[] {
  if (source === 'dem5a') return [demLayer('dem5a', 15), demLayer('dem10b', 14)];
  return [demLayer('dem10b', Math.min(zoom, 14))];
}

/** 観測点・山頂の標高取得に使う最も細かい参照順 */
export const FINEST_CHAIN: Layer[] = layerChain('dem5a', 15);

export function tileId(layer: Layer, x: number, y: number): string {
  return `${layer.key}/${x}/${y}`;
}
