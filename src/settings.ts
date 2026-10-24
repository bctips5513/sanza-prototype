// アプリ全体の設定値（初期値は精度優先）

export type DemSourceId = 'dem5a' | 'dem10b';

export interface DemTier {
  /** この距離帯の外側境界 [m] */
  maxDist: number;
  /** 使用するズームレベル */
  zoom: number;
  /** dem5a は z15 のみ。無効値・欠損タイルは dem_png z14 にフォールバックする */
  source: DemSourceId;
}

export interface Settings {
  /** 目の高さ [m] */
  eyeHeight: number;
  /** 大気差係数 k */
  refractionK: number;
  /** 地球半径 [m] */
  earthRadius: number;
  /** 最大距離 [m] */
  maxDist: number;
  /** 最小距離 [m]（観測点直近のDEMノイズを避ける） */
  minDist: number;
  /** 方位刻み [deg] */
  azStep: number;
  tiers: DemTier[];
  /** 多層稜線の距離帯境界 [m]（昇順・最後は maxDist 以上） */
  bands: number[];
  /** 名前なし山頂も表示する */
  showUnnamedPeaks: boolean;
  /** 見通し判定の許容値 [deg] */
  visibilityTolDeg: number;
  /** 山頂の見かけの位置に使う標高（osm = OSMのele優先、無ければDEM） */
  peakHeightSource: 'osm' | 'dem';
}

export const DEFAULT_SETTINGS: Settings = {
  eyeHeight: 1.6,
  refractionK: 0.13,
  earthRadius: 6_371_000,
  maxDist: 100_000,
  minDist: 30,
  azStep: 0.1,
  tiers: [
    { maxDist: 3_000, zoom: 15, source: 'dem5a' },
    { maxDist: 15_000, zoom: 14, source: 'dem10b' },
    { maxDist: 40_000, zoom: 13, source: 'dem10b' },
    { maxDist: 100_000, zoom: 12, source: 'dem10b' },
  ],
  bands: [2_000, 5_000, 10_000, 20_000, 40_000, 100_000],
  showUnnamedPeaks: false,
  visibilityTolDeg: 0.02,
  peakHeightSource: 'osm',
};

const KEY = 'sanza.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 保存領域が使えない場合は初期値 */
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
