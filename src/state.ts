import type { Peak } from './peaks/overpass';
import type { PeakResult, SkylineResult } from './skyline/compute';
import type { RunStats } from './skyline/client';
import type { CameraParams } from './photo/camera';
import type { PhotoMeta } from './photo/exif';
import { loadSettings, type Settings } from './settings';

export interface PhotoState {
  img: HTMLImageElement;
  url: string;
  name: string;
  meta: PhotoMeta;
  cam: CameraParams;
  /** 自動合わせの状態 */
  auto: 'waiting' | 'running' | 'done';
}

export interface AlignTap {
  px: number;
  py: number;
  peakId?: number;
}

export interface AppState {
  observer: { lat: number; lon: number } | null;
  ground: { h: number; src: string } | null;
  settings: Settings;
  peaks: Map<number, Peak>;
  result: (SkylineResult & { stats: RunStats }) | null;
  peakResults: Map<number, PeakResult>;
  photo: PhotoState | null;
  alignTaps: AlignTap[];
  /** パノラマで選択中の山頂 */
  selectedPeak: number | null;
}

type Listener = (what: string) => void;
const listeners = new Set<Listener>();

export const state: AppState = {
  observer: null,
  ground: null,
  settings: loadSettings(),
  peaks: new Map(),
  result: null,
  peakResults: new Map(),
  photo: null,
  alignTaps: [],
  selectedPeak: null,
};

export function on(fn: Listener): void {
  listeners.add(fn);
}

export function emit(what: string): void {
  for (const fn of listeners) fn(what);
}

/** 見える（またはぎりぎりの）山頂を、表示設定に従って返す */
export function visiblePeaks(): { peak: Peak; res: PeakResult }[] {
  const out: { peak: Peak; res: PeakResult }[] = [];
  for (const res of state.peakResults.values()) {
    if (res.status === 0) continue;
    const peak = state.peaks.get(res.id);
    if (!peak) continue;
    if (!peak.name && !state.settings.showUnnamedPeaks) continue;
    out.push({ peak, res });
  }
  return out;
}

export function peakLabel(peak: Peak): string {
  return peak.name ?? '（無名）';
}
