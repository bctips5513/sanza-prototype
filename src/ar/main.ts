import '../ui/style.css';
import './ar.css';
import { SkylineClient } from '../skyline/client';
import { PeakStatus, type PeakResult, type SkylineResult } from '../skyline/compute';
import { fetchPeaks, type Peak } from '../peaks/overpass';
import { loadSettings } from '../settings';
import { inverse } from '../geo/geodesic';
import { basis, dirFromAzEl, project, type Basis, type CameraParams } from '../photo/camera';
import { runAutoAlignSource, cancelAutoAlign } from '../photo/autoAlignClient';
import { CALIB_MIN_SPREAD } from './calibrate';
import { cancelCalibrate, runCalibrate } from './calibrateClient';
import type { AutoAlignCandidate } from '../photo/autoAlign';
import { attachGestures, fitCanvas } from '../ui/gestures';
import { traceSilhouettes, type Silhouette } from '../skyline/silhouette';
import {
  FAMOUS,
  drawPeakLabels,
  famousRank,
  higherPeakDistances,
  isMajor,
  labelPriority,
  type Density,
  type LabelCandidate,
  type PeakInfo,
  type ScreenLabel,
} from './peakLabels';
import { angDiff, cameraAngles, declinationJapan, holdAngle, magneticHeading } from '../sensor/orientation';
import {
  alphaJump,
  applyCorrection,
  correctionFrom,
  coverScale,
  emaAngle,
  focalFromLongFov,
  hfovFrom35mm,
  isSteady,
  longFovFromFocal,
  wrap360,
  type Correction,
  type Pose,
  type SensorPose,
} from './pose';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const RAD = Math.PI / 180;

/**
 * 保存する仰角・傾きのくせの上限 [deg]（実測のくせは 1° 前後）。
 * 間違った合わせの結果を保存すると次の合わせの出発点がずれ、ずれが積み重なるので、これを超える値は保存も採用もしない
 */
const BIAS_MAX = 3;
/** 保存・採用する画角の、公称の画角からの許容幅（割合） */
const FOV_TOL = 0.15;
const biasOk = (b: { dPitch: number; dRoll: number }) => Math.abs(b.dPitch) <= BIAS_MAX && Math.abs(b.dRoll) <= BIAS_MAX;

// ---------------------------------------------------------------- 保存する設定
interface Store {
  /** 1× の35mm換算焦点距離 */
  f35: number;
  /** カメラ・ズームごとに合わせで求めた長辺の画角 [deg] */
  fov: Record<string, number>;
  /** 持ち方ごとの仰角・傾きのくせ */
  bias: Record<string, { dPitch: number; dRoll: number }>;
  autoTrack: boolean;
  /** 止めて山に向けると自動で合わせ始める */
  autoStart: boolean;
  /** 向きを変えた数コマから画角・傾きを測る */
  autoFov: boolean;
  /** カメラ・ズームごとの画角の測定値（直近 5 回。中央値を使う） */
  fovHist: Record<string, number[]>;
  /** いちばん奥の稜線の太さ [px]・濃さ・黒い縁 */
  skyWidth: number;
  skyAlpha: number;
  skyHalo: boolean;
  /** 手前の尾根の線（off = 出さない）と太さ */
  nearLines: 'off' | Density;
  nearWidth: number;
  /** 山名の数 */
  labelDensity: Density;
  /** 山名に距離も出す */
  showDist: boolean;
  /** 信州百名山を優先して出す */
  useShinshu: boolean;
}
const STORE_KEY = 'sanza.ar.v1';
const store: Store = {
  f35: 26,
  fov: {},
  bias: {},
  autoTrack: true,
  autoStart: true,
  autoFov: true,
  fovHist: {},
  skyWidth: 1.5,
  skyAlpha: 0.9,
  skyHalo: false,
  nearLines: 'normal',
  nearWidth: 2,
  labelDensity: 'normal',
  showDist: false,
  useShinshu: true,
};
try {
  Object.assign(store, JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'));
} catch {
  /* ignore */
}
// 以前の版で積み重なってしまった、ありえない大きさのくせは捨てる
for (const [k, b] of Object.entries(store.bias)) if (!biasOk(b)) delete store.bias[k];
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- センサー
interface Sample {
  t: number;
  alpha: number;
  beta: number;
  gamma: number;
  compassRaw: number | null;
  compassAcc: number | null;
  hold: number;
}
let latest: Sample | null = null;
/** 直近のセンサー姿勢（静止の判定用） */
const hist: { t: number; yaw: number; pitch: number }[] = [];
/** コンパス（真北）− alpha 由来の方位 の移動平均 */
let compassOff: number | null = null;
let compassOffAlpha = 0.05;

function uiAngle(): number {
  const a = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

/** 表示（画面の向き）に合わせたセンサーのカメラ姿勢 */
function sensorPose(s: Sample): SensorPose {
  const c = cameraAngles(s.alpha, s.beta, s.gamma, uiAngle());
  return { yaw: c.headingFromAlpha, pitch: c.elev, roll: c.roll };
}

function decl(): number {
  return gps ? declinationJapan(gps.coords.latitude, gps.coords.longitude) : 7.5;
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;
  const anyE = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
  const s: Sample = {
    t: performance.now(),
    alpha: e.alpha,
    beta: e.beta,
    gamma: e.gamma,
    compassRaw: typeof anyE.webkitCompassHeading === 'number' ? anyE.webkitCompassHeading : null,
    compassAcc: typeof anyE.webkitCompassAccuracy === 'number' ? anyE.webkitCompassAccuracy : null,
    hold: holdAngle(e.beta, e.gamma, latest?.hold),
  };
  const p = sensorPose(s);
  const prev = hist[hist.length - 1];
  // alpha の基準が飛んだら、真方位が連続になるよう補正もずらす
  if (prev) {
    const j = alphaJump(prev.yaw, p.yaw, p.pitch, s.t - prev.t);
    if (j !== null) {
      corr.yawOff = wrap360(corr.yawOff - j);
      if (compassOff !== null) compassOff = wrap360(compassOff - j);
      resetKeyframes();
      if (mode === 'locked') toast('向きの基準の飛びを補正しました');
    }
  }
  // 縦持ち・横持ちを変えたら、持ち方ごとの仰角・傾きのくせの差だけ補正を変える
  if (latest && latest.hold !== s.hold) {
    const o = biasFor(latest.hold);
    const n = biasFor(s.hold);
    corr.dPitch += n.dPitch - o.dPitch;
    corr.dRoll += n.dRoll - o.dRoll;
  }
  latest = s;
  hist.push({ t: s.t, yaw: p.yaw, pitch: p.pitch });
  while (hist.length && s.t - hist[0].t > 2000) hist.shift();

  if (s.compassRaw !== null && s.compassAcc !== null && s.compassAcc >= 0 && s.compassAcc < 40 && Math.abs(p.pitch) < 60) {
    const trueHead = magneticHeading(s.compassRaw, s.hold) - decl();
    compassOff = emaAngle(compassOff, angDiff(trueHead, p.yaw), compassOffAlpha);
  }
  if (mode === 'compass' && compassOff !== null) corr.yawOff = compassOff;
}

// ---------------------------------------------------------------- 合わせの状態
type Mode = 'compass' | 'locked';
let mode: Mode = 'compass';
let alignLabel = '';
let corr: Correction = { yawOff: 0, ...biasFor(0) };
/** 合わせたときの「補正 − コンパスの差」（画面を離れて戻ったとき、コンパスから向きを推定し直すのに使う） */
let lockedDelta = 0;

function biasFor(hold: number) {
  return store.bias[String(hold)] ?? { dPitch: 0, dRoll: 0 };
}

function lock(label: string) {
  mode = 'locked';
  alignLabel = label;
  lockedDelta = compassOff !== null ? angDiff(corr.yawOff, compassOff) : 0;
  const hold = latest?.hold ?? 0;
  if (biasOk(corr)) {
    store.bias[String(hold)] = { dPitch: corr.dPitch, dRoll: corr.dRoll };
    saveStore();
  }
}

function unlock() {
  mode = 'compass';
  alignLabel = '';
  pendingAuto = null;
  resetKeyframes();
  const b = biasFor(latest?.hold ?? 0);
  corr = { yawOff: compassOff ?? 0, ...b };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // 画面を離れると alpha の基準が変わることがある。合わせ済みならコンパスとの差を保って推定し直す
  compassOff = null;
  compassOffAlpha = 0.2;
  resetKeyframes();
  setTimeout(() => {
    compassOffAlpha = 0.05;
    if (mode === 'locked' && compassOff !== null) {
      corr.yawOff = wrap360(compassOff + lockedDelta);
      toast('戻りました：向きをコンパスから推定し直しました（ずれていれば合わせ直してください）', 3000);
    }
  }, 1500);
});

// ---------------------------------------------------------------- 位置・稜線
const settings = loadSettings();
const client = new SkylineClient();
let gps: GeolocationPosition | null = null;
let result: SkylineResult | null = null;
let peakRes: PeakResult[] = [];
/** 見えている山の山名の候補（稜線・山頂の計算が終わるたびに作り直す） */
let candidates: (LabelCandidate & { az: number; elev: number })[] = [];
/** 手前の尾根の線（量の設定ごとに作り直す） */
let silhouettes: Silhouette[] = [];
let computing = false;
let status = '';

async function compute() {
  if (!gps || computing) return;
  computing = true;
  const { latitude: lat, longitude: lon } = gps.coords;
  try {
    const peaksPromise = fetchPeaks(lat, lon, settings.maxDist).then(
      (got) => ({ ok: true as const, got }),
      (err: Error) => ({ ok: false as const, err }),
    );
    status = '稜線を計算中…';
    const res = await client.skyline(
      {
        lat,
        lon,
        eyeHeight: settings.eyeHeight,
        earthRadius: settings.earthRadius,
        refractionK: settings.refractionK,
        maxDist: settings.maxDist,
        minDist: settings.minDist,
        azStep: settings.azStep,
        tiers: settings.tiers,
        bands: settings.bands,
        peakHeightSource: settings.peakHeightSource,
      },
      [],
      settings.visibilityTolDeg,
      (p) => (status = `稜線を計算中… ${Math.round((p.done / p.total) * 100)}%（標高タイル ${p.stats.network + p.stats.cache} 枚）`),
    );
    result = res;
    peakRes = [];
    candidates = [];
    rebuildSilhouettes();
    status = '山名を取得中…';
    const pk = await peaksPromise;
    if (!pk.ok) {
      status = `山名を取得できません: ${pk.err.message}`;
      return;
    }
    const all = mergeFamous(pk.got, lat, lon);
    peakRes = await client.peaks(
      all.map(({ id, lat, lon, ele }) => ({ id, lat, lon, ele: Number.isFinite(ele) ? ele : undefined })),
      settings.visibilityTolDeg,
      (p) => (status = `山の見え方を判定中… ${p.done}/${p.total}`),
    );
    rebuildCandidates(all);
    status = '';
  } catch (e) {
    status = `計算に失敗しました: ${(e as Error).message}`;
  } finally {
    computing = false;
  }
}

/**
 * OSM の山頂に有名な山の一覧の印と標高を付ける。照合できなかった有名な山（OSM に無い山）は一覧の座標で足す（id は負）。
 * 標高は一覧の値 → OSM の ele の順に使う。
 */
function mergeFamous(osm: Peak[], lat: number, lon: number): PeakInfo[] {
  const byOsm = new Map(FAMOUS.filter((f) => f.o !== undefined).map((f) => [f.o!, f]));
  const out: PeakInfo[] = osm.map((p) => {
    const f = byOsm.get(p.id);
    // 山域の名前で載っている山（八ヶ岳など）は主峰の名前に添える：赤岳（八ヶ岳）
    const name = f && p.name && !p.name.includes(f.n.replace(/\s*\(.*\)$/, '')) ? `${p.name}（${f.n}）` : (p.name ?? f?.n ?? '');
    return { id: p.id, name, ele: f?.e ?? p.ele ?? NaN, lat: p.lat, lon: p.lon, lists: f?.l ?? 0 };
  });
  const ids = new Set(osm.map((p) => p.id));
  FAMOUS.forEach((f, i) => {
    if (f.o !== undefined && ids.has(f.o)) return;
    if (inverse(lat, lon, f.la, f.lo).dist <= settings.maxDist) out.push({ id: -(i + 1), name: f.n, ele: f.e ?? NaN, lat: f.la, lon: f.lo, lists: f.l });
  });
  return out;
}

/** 見えている名前のある山から、山名の候補を作る（自分より高い山までの距離は名前の無い山も含めて測る） */
function rebuildCandidates(all: PeakInfo[]) {
  const res = new Map(peakRes.map((r) => [r.id, r]));
  const withEle = all.map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, ele: Number.isFinite(p.ele) ? p.ele : res.get(p.id)?.hDem ?? -Infinity }));
  const higher = higherPeakDistances(withEle);
  candidates = [];
  for (const p of all) {
    const r = res.get(p.id);
    if (!r || r.status === PeakStatus.Hidden || !p.name) continue;
    candidates.push({
      ...p,
      ele: Number.isFinite(p.ele) ? p.ele : r.hDem,
      dist: r.dist,
      higherDist: higher.get(p.id) ?? Infinity,
      marginal: r.status === PeakStatus.Marginal,
      az: r.az,
      elev: r.elev,
    });
  }
}

const NEAR_OPTS = {
  few: { minSpan: 2.5, minRatio: 1.6 },
  normal: { minSpan: 1.0, minRatio: 1.3 },
  many: { minSpan: 0.6, minRatio: 1.15 },
} as const;
function rebuildSilhouettes() {
  silhouettes = result && store.nearLines !== 'off' ? traceSilhouettes(result, NEAR_OPTS[store.nearLines]) : [];
}

function movedFromResult(): number {
  if (!gps || !result) return 0;
  return inverse(result.lat, result.lon, gps.coords.latitude, gps.coords.longitude).dist;
}

// ---------------------------------------------------------------- カメラ
const video = $('video') as HTMLVideoElement;
let stream: MediaStream | null = null;
let zoom = 1;
let hwZoom = false;

// 開発用：?fake=<画像のパス>&ll=<緯度>,<経度> で、画像をカメラ映像の代わりに流す（本番のビルドには含まれない）
const devQuery = import.meta.env.DEV ? new URLSearchParams(location.search) : null;

async function startCamera(deviceId?: string) {
  stream?.getTracks().forEach((t) => t.stop());
  if (import.meta.env.DEV && devQuery?.get('fake')) {
    const { fakeStream } = await import('./devFake');
    stream = await fakeStream(devQuery, (bias) => (latest ? applyCorrection(sensorPose(latest), { yawOff: bias.yaw, dPitch: bias.pitch, dRoll: bias.roll }) : null));
    video.srcObject = stream;
    return;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
    audio: false,
  });
  video.srcObject = stream;
  await applyZoom(zoom);
}

async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('sel-camera') as HTMLSelectElement;
  const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  sel.innerHTML = devs
    .map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === current ? 'selected' : ''}>${esc(d.label || `カメラ${i + 1}`)}</option>`)
    .join('');
}

function cameraLabel(): string {
  return ($('sel-camera') as HTMLSelectElement).selectedOptions[0]?.textContent ?? 'camera';
}

async function applyZoom(z: number) {
  zoom = z;
  hwZoom = false;
  const track = stream?.getVideoTracks()[0];
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
  if (track && caps.zoom && z >= caps.zoom.min && z <= caps.zoom.max) {
    try {
      await track.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
      hwZoom = true;
    } catch {
      hwZoom = false;
    }
  }
  video.style.transform = hwZoom ? '' : `scale(${z})`;
  document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) => b.classList.toggle('active', Number(b.dataset.zoom) === z));
}

/** 画角の保存キー（カメラ側のズームはレンズが変わることがあるのでズームごと） */
function fovKey(): string {
  return `${cameraLabel()}|${hwZoom ? zoom : 1}`;
}

/**
 * 公称の長辺の画角 [deg]。
 * iPhone の「トリプルカメラ」「デュアル広角カメラ」はズーム 1 が超広角（換算で 1× の半分の焦点距離）で、
 * ズーム 2 で 1× のレンズに切り替わるので、カメラ側のズームの値を半分にして数える
 */
function nominalFov(): number {
  const z = hwZoom ? zoom : 1;
  const ultraBase = hwZoom && /トリプル|デュアル広角|Triple|Dual Wide/i.test(cameraLabel());
  return hfovFrom35mm(store.f35 * (ultraBase ? z / 2 : z));
}

/** 公称の画角から FOV_TOL 以内か */
function fovOk(fov: number): boolean {
  return Number.isFinite(fov) && Math.abs(fov / nominalFov() - 1) <= FOV_TOL;
}

/** 映像（コマ）の長辺の画角 [deg]。保存した値が公称から外れていれば捨てる */
function videoFov(): number {
  const k = fovKey();
  const v = store.fov[k];
  if (v !== undefined && !fovOk(v)) {
    delete store.fov[k];
    delete store.fovHist[k];
    saveStore();
  }
  return store.fov[k] ?? nominalFov();
}

// ---------------------------------------------------------------- 止めた画面
interface Frozen {
  canvas: HTMLCanvasElement;
  vw: number;
  vh: number;
  sensor: SensorPose;
}
let frozen: Frozen | null = null;

function grabFrame(): Frozen | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !latest) return null;
  const c = document.createElement('canvas');
  c.width = vw;
  c.height = vh;
  c.getContext('2d')!.drawImage(video, 0, 0, vw, vh);
  return { canvas: c, vw, vh, sensor: sensorPose(latest) };
}

function setFrozen(f: Frozen | null) {
  // 映像は止めずに、その上へ止めたコマを描く（映像を隠すと iOS が再生を止めることがある）
  frozen = f;
  $('btn-freeze').textContent = f ? 'ライブに戻る' : '止める';
  $('btn-freeze').setAttribute('aria-pressed', String(!!f));
}

// ---------------------------------------------------------------- 描画
const overlay = $('overlay') as HTMLCanvasElement;
const ctx = overlay.getContext('2d')!;

interface View {
  cam: CameraParams;
  b: Basis;
  pose: Pose;
  /** 映像の画素 → 画面の倍率 */
  scale: number;
  vw: number;
  vh: number;
  focalVideo: number;
}
let view: View | null = null;

function currentView(W: number, H: number): View | null {
  const vw = frozen ? frozen.vw : video.videoWidth;
  const vh = frozen ? frozen.vh : video.videoHeight;
  const sp = frozen ? frozen.sensor : latest ? sensorPose(latest) : null;
  if (!vw || !vh || !sp) return null;
  const pose = applyCorrection(sp, corr);
  const focalVideo = focalFromLongFov(videoFov(), vw, vh);
  const scale = coverScale(vw, vh, W, H, hwZoom ? 1 : zoom);
  const cam: CameraParams = { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll, focalPx: focalVideo * scale, width: W, height: H };
  return { cam, b: basis(pose.yaw, pose.pitch, pose.roll), pose, scale, vw, vh, focalVideo };
}

function draw() {
  const { w, h, dpr } = fitCanvas(overlay);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  view = currentView(w, h);
  if (!view) return;
  const { cam, b } = view;
  if (frozen) {
    const s = view.scale;
    ctx.drawImage(frozen.canvas, w / 2 - (frozen.vw * s) / 2, h / 2 - (frozen.vh * s) / 2, frozen.vw * s, frozen.vh * s);
  }
  if (result) {
    drawSkyline(cam, b);
    drawPeaks(cam, b, h);
  }
  // 画面中央の照準
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 10, h / 2);
  ctx.lineTo(w / 2 + 10, h / 2);
  ctx.moveTo(w / 2, h / 2 - 10);
  ctx.lineTo(w / 2, h / 2 + 10);
  ctx.stroke();
}

function drawSkyline(cam: CameraParams, b: Basis) {
  const r = result!;
  const half = Math.atan(Math.hypot(cam.width, cam.height) / 2 / cam.focalPx) / RAD + 2;
  const step = r.azStep;
  const k0 = Math.floor((cam.yaw - half) / step);
  const k1 = Math.ceil((cam.yaw + half) / step);
  const maxJump = Math.max(cam.width, cam.height) * 0.5;
  /** 方位の番号 k の仰角 elevAt(k) を結んだ線の道筋を作る */
  const path = (ka: number, kb: number, elevAt: (k: number) => number) => {
    let prev: [number, number] | null = null;
    for (let k = ka; k <= kb; k++) {
      const p = project(cam, b, dirFromAzEl(k * step, elevAt(k)));
      if (!p) {
        prev = null;
        continue;
      }
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < maxJump) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
      prev = p;
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 手前の尾根の線（画面に掛かる部分だけ）
  if (silhouettes.length) {
    ctx.beginPath();
    for (const l of silhouettes) {
      // 線の方位の範囲を、画面の方位の範囲 k0..k1 に合わせて（一周ずらして）重ねる
      const n = l.elev.length;
      const shift = Math.round((k0 - l.i0) / r.nAz) * r.nAz;
      for (const s0 of [shift - r.nAz, shift, shift + r.nAz]) {
        const a = Math.max(k0, l.i0 + s0);
        const z = Math.min(k1, l.i0 + s0 + n - 1);
        if (a <= z) path(a, z, (k) => l.elev[k - l.i0 - s0]);
      }
    }
    ctx.strokeStyle = 'rgba(255,143,179,0.95)';
    ctx.lineWidth = store.nearWidth;
    ctx.stroke();
  }

  // いちばん奥の稜線
  const sky = r.bandElev[r.bandElev.length - 1];
  ctx.beginPath();
  path(k0, k1, (k) => sky[((k % r.nAz) + r.nAz) % r.nAz]);
  ctx.globalAlpha = store.skyAlpha;
  if (store.skyHalo) {
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = store.skyWidth + 2;
    ctx.stroke();
  }
  ctx.strokeStyle = '#ff2d55';
  ctx.lineWidth = store.skyWidth;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawPeaks(cam: CameraParams, b: Basis, h: number) {
  const items: ScreenLabel[] = [];
  for (const c of candidates) {
    if (!isMajor(c, store.labelDensity, store.useShinshu)) continue;
    const p = project(cam, b, dirFromAzEl(c.az, c.elev));
    if (!p || p[0] < 0 || p[0] > cam.width || p[1] < 0 || p[1] > cam.height) continue;
    items.push({
      id: c.id,
      x: p[0],
      y: p[1],
      title: c.name,
      sub: `${Math.round(c.ele)}m` + (store.showDist ? ` ${(c.dist / 1000).toFixed(1)}km` : ''),
      priority: labelPriority(c, store.useShinshu),
      marginal: c.marginal,
      famous: famousRank(c.lists, store.useShinshu) > 0,
    });
  }
  drawPeakLabels(ctx, items, cam.width, Math.max(70, h * 0.1), h - 130, {
    titleFont: 'bold 13px system-ui, sans-serif',
    subFont: '11px system-ui, sans-serif',
  });
}

function renderHud() {
  const parts: string[] = [];
  if (view) {
    const p = view.pose;
    parts.push(`方位 <b>${fmt(p.yaw)}°</b>　仰角 ${fmt(p.pitch)}°　傾き ${fmt(p.roll)}°　画角 ${fmt(videoFov() / (hwZoom ? 1 : zoom))}°`);
  }
  if (mode === 'compass') {
    const acc = latest?.compassAcc;
    parts.push(
      `<span class="warn">コンパスで表示中（±10°ほどずれます）</span>` +
        (acc !== null && acc !== undefined ? `　コンパス精度 ±${fmt(acc, 0)}°` : '') +
        (acc !== null && acc !== undefined && (acc < 0 || acc >= 30) ? '　<span class="warn">8の字に振って調整を</span>' : ''),
    );
    if (store.autoStart && result && !frozen) parts.push(esc(autoInfo || '山の稜線が映る向きで少し止めると、自動で合わせます'));
  } else {
    const drift = compassOff !== null ? angDiff(corr.yawOff, compassOff) : null;
    parts.push(`<span class="ok">合わせ済み（${esc(alignLabel)}）</span>` + (drift !== null ? `　コンパスとの差 ${fmt(drift)}°` : '') + (trackInfo ? `　${esc(trackInfo)}` : ''));
    if (store.autoFov && !frozen) {
      const n = store.fovHist[fovKey()]?.length ?? 0;
      parts.push(esc(calibInfo || (n ? `画角は測定済み（${n}回）` : '画角を測るため、左右にゆっくり向きを変えては少し止めてください')));
    }
  }
  if (frozen) parts.push('<span class="warn">画面を止めています。指で稜線を合わせ、「ライブに戻る」</span>');
  if (status) parts.push(esc(status));
  else if (!result) parts.push(gps ? '稜線の計算を待っています…' : '現在地を取得中…');
  const moved = movedFromResult();
  if (moved > 300) parts.push(`<span class="warn">計算した地点から ${Math.round(moved)} m 移動しました（… → 計算し直す）</span>`);
  $('hud').innerHTML = parts.join('<br>');
}

function loop() {
  draw();
  renderHud();
  maybeAutoStart();
  maybeTrack();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 手動合わせ
/** 手で画角を変えたら、それまでの測定値は捨てて手の値から測り直す */
function setManualFov(fov: number) {
  const n = nominalFov();
  store.fov[fovKey()] = Math.min(n * (1 + FOV_TOL), Math.max(n * (1 - FOV_TOL), fov));
  delete store.fovHist[fovKey()];
  calibInfo = '';
}

function nudge(kind: string, v: number) {
  if (!view) return;
  if (kind === 'yaw') corr.yawOff = wrap360(corr.yawOff - v);
  else if (kind === 'pitch') corr.dPitch -= v;
  else if (kind === 'roll') corr.dRoll += v;
  else if (kind === 'fov') setManualFov(videoFov() * (1 + v / 100));
  lock('手動');
}

attachGestures(overlay, {
  onPan(dx, dy) {
    if (!view) return;
    // 指の動きに稜線が付いてくるよう、カメラは逆向きに回す（傾きの分だけ画面の軸を回す）
    const r = view.pose.roll * RAD;
    const ux = dx * Math.cos(r) + dy * Math.sin(r);
    const uy = -dx * Math.sin(r) + dy * Math.cos(r);
    const f = view.cam.focalPx;
    corr.yawOff = wrap360(corr.yawOff - Math.atan(ux / f) / RAD);
    corr.dPitch += Math.atan(uy / f) / RAD;
    mode = 'locked';
    alignLabel = '手動';
  },
  onPinch(scale) {
    if (!view || !Number.isFinite(scale) || scale <= 0) return;
    setManualFov(longFovFromFocal(view.focalVideo * scale, view.vw, view.vh));
    mode = 'locked';
    alignLabel = '手動';
  },
  onRotate(da) {
    corr.dRoll -= da / RAD;
    mode = 'locked';
    alignLabel = '手動';
  },
  onEnd() {
    if (mode === 'locked' && alignLabel === '手動') lock('手動');
  },
});

document.querySelectorAll<HTMLButtonElement>('[data-nudge]').forEach((b) =>
  b.addEventListener('click', () => {
    const [k, v] = b.dataset.nudge!.split(':');
    nudge(k, Number(v));
  }),
);

// ---------------------------------------------------------------- 自動合わせ
let autoBusy = false;
let trackSeq = 0;
let trackBusy = false;
let lastTrack = 0;
let trackInfo = '';

function skylineArr(): Float32Array {
  return result!.bandElev[result!.bandElev.length - 1];
}

function candPose(c: AutoAlignCandidate): Pose {
  return { yaw: c.yaw, pitch: c.pitch, roll: c.roll };
}

/** 画角がまだ測れていなければ、自動合わせで振った焦点距離を仮の画角として使う（測定値には数えない） */
function adoptCandFocal(c: AutoAlignCandidate, f: Frozen) {
  if (store.fovHist[fovKey()]?.length) return;
  const fov = longFovFromFocal(c.focalPx, f.vw, f.vh);
  if (!fovOk(fov)) return;
  store.fov[fovKey()] = fov;
  saveStore();
}

/** 自動合わせの答えが、センサーのくせ・公称の画角から見てありうるか（電線などに合ってしまった答えを捨てる） */
function candPlausible(c: AutoAlignCandidate, f: Frozen): boolean {
  return biasOk(correctionFrom(candPose(c), f.sensor)) && fovOk(longFovFromFocal(c.focalPx, f.vw, f.vh));
}

function applyCandidate(c: AutoAlignCandidate, f: Frozen, label: string) {
  adoptCandFocal(c, f);
  corr = correctionFrom(candPose(c), f.sensor);
  lock(label);
}

$('btn-auto').addEventListener('click', async () => {
  if (autoBusy) return;
  if (!result) {
    toast('稜線の計算がまだです');
    return;
  }
  const f = frozen ?? grabFrame();
  if (!f) {
    toast('カメラ映像がまだありません');
    return;
  }
  setFrozen(f);
  autoBusy = true;
  trackSeq++;
  trackBusy = false;
  hideCands();
  const btn = $('btn-auto') as HTMLButtonElement;
  btn.disabled = true;
  const prior = applyCorrection(f.sensor, corr);
  // 合わせ済みなら狭く、コンパス任せなら広く探す（実測のコンパス誤差は多くが ±10°、まれに 18°）
  // 画角は求めない：1コマでは画角を動かすと傾きとつり合って誤った値に寄ることがあるため、
  // 公称値（または測定・手で合わせて記憶した値）のまま方位・仰角・傾きだけ求める。画角は第2段階で数コマから測る
  const opts = alignOpts(prior);
  const yawRange = opts.yawRange;
  try {
    const res = await runAutoAlignSource(
      f.canvas,
      f.vw,
      f.vh,
      focalFromLongFov(videoFov(), f.vw, f.vh),
      skylineArr(),
      result.azStep,
      opts,
      (d, t) => (btn.textContent = `合わせ中 ${Math.round((d / t) * 100)}%`),
    );
    const best = res.best;
    const conf = { high: '高', medium: '中', low: '低' }[res.confidence];
    // 「中」はセンサーの仰角と 2° 以内のときだけ採用（実写真で、仰角が 3° ずれた偽の答えが「中」になった例がある）
    // 探索範囲の外まで山登りで動いた答えも採用しない
    const ok =
      best &&
      candPlausible(best, f) &&
      Math.abs(angDiff(best.yaw, prior.yaw)) <= yawRange + 0.5 &&
      (res.confidence === 'high' || (res.confidence === 'medium' && Math.abs(best.pitch - prior.pitch) <= 2));
    if (best && ok) {
      applyCandidate(best, f, `自動・信頼度${conf}`);
      addKeyframe(f);
      toast(`合わせました（信頼度 ${conf}）。ずれていれば指で直して「ライブに戻る」`, 2500);
    } else showCands(res.candidates.filter((c) => candPlausible(c, f)).slice(0, 3), f);
  } catch (e) {
    toast(`自動合わせに失敗: ${(e as Error).message}`);
  } finally {
    autoBusy = false;
    btn.disabled = false;
    btn.textContent = '自動合わせ';
  }
});

function showCands(cands: AutoAlignCandidate[], f: Frozen) {
  const box = $('cands');
  if (!cands.length) {
    toast('稜線が見つかりませんでした。山が映る向きで、指で合わせてください', 3000);
    return;
  }
  box.innerHTML = '<span>自信がありません。候補を選ぶか指で合わせてください：</span>';
  cands.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'ar-btn';
    b.textContent = `候補${i + 1}（${fmt(c.yaw)}°）`;
    b.addEventListener('click', () => {
      applyCandidate(c, f, `自動・候補${i + 1}`);
      box.querySelectorAll('button').forEach((x) => x.removeAttribute('aria-pressed'));
      b.setAttribute('aria-pressed', 'true');
    });
    box.appendChild(b);
  });
  const close = document.createElement('button');
  close.className = 'ar-btn';
  close.textContent = '閉じる';
  close.addEventListener('click', hideCands);
  box.appendChild(close);
  box.classList.remove('hidden');
}
function hideCands() {
  $('cands').classList.add('hidden');
}

/**
 * 自動合わせ（ボタン・自動で始まる合わせ）の探し方。コンパス任せなら広く、合わせ済みなら狭く。
 * 画角がまだ測れていないカメラ・ズームでは焦点距離も ±25% 振る（公称値が大きくずれていると、
 * 狭い画角で数度隣の偽の答えが「高」になりやすいため。tests/photos で偽の「高」は同程度、正しい「高」は約2倍）。
 * 画角は使わない（1コマの画角は不確か。測るのは第2段階）。
 */
function alignOpts(prior: Pose) {
  const unmeasured = !store.fovHist[fovKey()]?.length;
  return {
    yawCenter: prior.yaw,
    yawRange: mode === 'locked' ? 10 : 20,
    pitchCenter: prior.pitch,
    pitchRange: 3,
    rollCenter: prior.roll,
    rollRange: 3,
    refineFocal: unmeasured,
    focalRange: unmeasured ? 0.25 : 0,
  };
}

/** 画面中央の方位の稜線が、画面の縦の範囲に入っているか */
function skylineInView(v: View): boolean {
  const arr = skylineArr();
  const i = Math.round(wrap360(v.pose.yaw) / result!.azStep) % arr.length;
  const half = Math.atan(v.cam.height / 2 / v.cam.focalPx) / RAD;
  return Math.abs(arr[i] - v.pose.pitch) < half + 1;
}

/**
 * 自動で始まる合わせ：コンパスで表示中に、稜線が映る向きで止まったら裏で自動合わせを走らせる（画面は止めない）。
 * 誤った答えを使うのが一番困るので、信頼度「高」の答えが2回続けて同じ補正になったときだけ使う。
 */
let lastAuto = 0;
let pendingAuto: { c: Correction; t: number; focalPx: number } | null = null;
let autoInfo = '';

function maybeAutoStart() {
  if (!store.autoStart || mode !== 'compass' || frozen || autoBusy || trackBusy || !result || !latest || !view) return;
  const now = performance.now();
  if (now - lastAuto < 1200 || !isSteady(hist, now, 700, 0.3)) return;
  if (!skylineInView(view)) {
    autoInfo = '稜線が画面に入る向きに向けてください';
    return;
  }
  const f = grabFrame();
  if (!f) return;
  lastAuto = now;
  trackBusy = true;
  const seq = ++trackSeq;
  const prior = applyCorrection(f.sensor, corr);
  const opts = alignOpts(prior);
  if (!pendingAuto) autoInfo = '自動で合わせています…（そのまま止めてください）';
  runAutoAlignSource(f.canvas, f.vw, f.vh, focalFromLongFov(videoFov(), f.vw, f.vh), skylineArr(), result.azStep, opts)
    .then((res) => {
      if (seq !== trackSeq || mode !== 'compass') return;
      const best = res.best;
      // 自動で使うのは「高」で、センサーの仰角から 1.5° 以内、コンパスから 15° 以内の答えだけ
      // （実写真から作った狭い画角の映像で、偽の「高」の多くは仰角が 2〜3° ずれるか、コンパスから大きく離れていた）
      if (!best || res.confidence !== 'high' || !candPlausible(best, f) || Math.abs(angDiff(best.yaw, prior.yaw)) > 15 || Math.abs(best.pitch - prior.pitch) > 1.5) {
        autoInfo = '自動合わせ：稜線を探しています（見つからなければ「自動合わせ」か指で）';
        return;
      }
      const c = correctionFrom(candPose(best), f.sensor);
      const p = pendingAuto;
      const t = performance.now();
      if (p && t - p.t < 10_000 && Math.abs(best.focalPx / p.focalPx - 1) < 0.05 && Math.abs(angDiff(c.yawOff, p.c.yawOff)) < 0.6 && Math.abs(c.dPitch - p.c.dPitch) < 0.4 && Math.abs(c.dRoll - p.c.dRoll) < 1) {
        corr = { yawOff: wrap360(p.c.yawOff + angDiff(c.yawOff, p.c.yawOff) / 2), dPitch: (c.dPitch + p.c.dPitch) / 2, dRoll: (c.dRoll + p.c.dRoll) / 2 };
        pendingAuto = null;
        autoInfo = '';
        adoptCandFocal(best, f);
        lock('自動');
        lastTrack = t;
        toast('自動で合わせました。ずれていれば指で直せます', 2200);
        addKeyframe(f);
      } else {
        pendingAuto = { c, t, focalPx: best.focalPx };
        autoInfo = '自動合わせ：確かめています…（そのまま止めてください）';
      }
    })
    .catch(() => {})
    .finally(() => {
      if (seq === trackSeq) trackBusy = false;
    });
}

/**
 * 追従補正：合わせた後、カメラが止まっている間に映像のコマで狭く（±2°）合わせ直し、
 * ジャイロのずれを少しずつ直す。自信が高く、ずれが小さいときだけ方位・仰角を半分ずつ反映する。
 * 同じコマを画角の測定（第2段階）にも使う。
 */
function maybeTrack(force = false) {
  if ((!store.autoTrack && !store.autoFov) || mode !== 'locked' || frozen || autoBusy || trackBusy || !result || !latest) return;
  const now = performance.now();
  if (!force && (now - lastTrack < 2500 || !isSteady(hist, now, 600, 0.15))) return;
  const f = grabFrame();
  if (!f) return;
  lastTrack = now;
  if (view && skylineInView(view)) addKeyframe(f);
  if (!store.autoTrack) return;
  trackBusy = true;
  const seq = ++trackSeq;
  const prior = applyCorrection(f.sensor, corr);
  runAutoAlignSource(
    f.canvas,
    f.vw,
    f.vh,
    focalFromLongFov(videoFov(), f.vw, f.vh),
    skylineArr(),
    result.azStep,
    {
      yawCenter: prior.yaw,
      yawRange: 2,
      pitchCenter: prior.pitch,
      pitchRange: 1.5,
      rollCenter: prior.roll,
      rollRange: 1.5,
      refineFocal: false,
      useLine: false,
    },
    undefined,
    640,
  )
    .then((res) => {
      if (seq !== trackSeq || mode !== 'locked') return;
      const best = res.best;
      if (!best || res.confidence !== 'high') {
        trackInfo = '追従補正：見送り';
        return;
      }
      const dy = angDiff(best.yaw, prior.yaw);
      const dp = best.pitch - prior.pitch;
      const dr = angDiff(best.roll, prior.roll);
      if (Math.abs(dy) > 1.5 || Math.abs(dp) > 1 || Math.abs(dr) > 1.5) {
        trackInfo = '追従補正：見送り（差が大きい）';
        return;
      }
      // 傾きは直さない（1コマでは画角とつり合ってずれやすい。傾きは第2段階で数コマから求める）
      corr = { yawOff: wrap360(corr.yawOff + dy * 0.5), dPitch: corr.dPitch + dp * 0.5, dRoll: corr.dRoll };
      trackInfo = `追従補正 ${dy >= 0 ? '+' : ''}${fmt(dy, 2)}°`;
    })
    .catch(() => {})
    .finally(() => {
      if (seq === trackSeq) trackBusy = false;
    });
}

// ---------------------------------------------------------------- 画角・傾きの測定（第2段階）
// 向きを変えて止めたときのコマ（縮小）をためておき、2コマ以上で向きの差が十分あれば、
// 全コマ共通の補正と焦点距離を同時に求める（src/ar/calibrate.ts）。
const KF_WIDTH = 480;
const KF_MAX = 4;
interface KeyFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  sensor: SensorPose;
  /** 元のコマの大きさ */
  vw: number;
  vh: number;
}
let keyframes: KeyFrame[] = [];
let kfKey = '';
let calibDirty = false;
let calibBusy = false;
let calibSeq = 0;
let calibInfo = '';

function resetKeyframes() {
  keyframes = [];
  calibDirty = false;
  calibSeq++;
  cancelCalibrate();
  calibBusy = false;
}

/** コマの横の画角 [deg] */
function frameHfov(vw: number, vh: number): number {
  return (2 * Math.atan(vw / 2 / focalFromLongFov(videoFov(), vw, vh))) / RAD;
}

function addKeyframe(f: Frozen) {
  if (!store.autoFov || mode !== 'locked') return;
  const key = `${fovKey()}|${latest?.hold ?? 0}|${f.vw}x${f.vh}`;
  if (key !== kfKey) {
    resetKeyframes();
    kfKey = key;
  }
  const hf = frameHfov(f.vw, f.vh);
  // 向きがほぼ同じコマは新しいほうに入れ替える（向きの広がりは増えない）
  const near = keyframes.findIndex((k) => Math.abs(angDiff(k.sensor.yaw, f.sensor.yaw)) < hf * 0.15 && Math.abs(k.sensor.pitch - f.sensor.pitch) < hf * 0.15);
  const w = KF_WIDTH;
  const h = Math.round((f.vh * w) / f.vw);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(f.canvas, 0, 0, w, h);
  const kf: KeyFrame = { rgba: g.getImageData(0, 0, w, h).data, width: w, height: h, sensor: f.sensor, vw: f.vw, vh: f.vh };
  if (near >= 0) keyframes[near] = kf;
  else {
    keyframes.push(kf);
    if (keyframes.length > KF_MAX) keyframes.shift();
    calibDirty = true;
  }
  maybeCalibrate();
}

function keyframeSpread(): number {
  let d = 0;
  for (const a of keyframes) for (const b of keyframes) d = Math.max(d, Math.abs(angDiff(a.sensor.yaw, b.sensor.yaw)));
  return d;
}

function maybeCalibrate() {
  if (calibBusy || !calibDirty || keyframes.length < 2 || !result || mode !== 'locked') return;
  const k0 = keyframes[0];
  const hf = frameHfov(k0.vw, k0.vh);
  if (keyframeSpread() < hf * CALIB_MIN_SPREAD) {
    calibInfo = `画角の測定：もう少し左右に向きを変えてください（${keyframes.length}コマ）`;
    return;
  }
  calibDirty = false;
  calibBusy = true;
  calibInfo = `画角を測定中…（${keyframes.length}コマ）`;
  const seq = ++calibSeq;
  const fk = fovKey();
  const fovBefore = videoFov();
  const focalPx = focalFromLongFov(fovBefore, k0.vw, k0.vh) * (k0.width / k0.vw);
  runCalibrate({
    frames: keyframes.map(({ rgba, width, height, sensor }) => ({ rgba, width, height, sensor })),
    focalPx,
    skyline: skylineArr().slice(),
    azStep: result.azStep,
    corr: { ...corr },
  })
    .then((r) => {
      if (seq !== calibSeq || mode !== 'locked' || fovKey() !== fk) return;
      if (!r.ok) {
        calibInfo = `画角の測定：はっきりしないため見送り（${keyframes.length}コマ）`;
        return;
      }
      const measured = longFovFromFocal(r.focalPx, k0.width, k0.height);
      if (!fovOk(measured) || !biasOk(r.corr)) {
        calibInfo = `画角の測定：ありえない値のため見送り（${fmt(measured)}°）`;
        return;
      }
      const hist = (store.fovHist[fk] ??= []);
      hist.push(measured);
      if (hist.length > 5) hist.shift();
      const med = [...hist].sort((a, b) => a - b)[hist.length >> 1];
      store.fov[fk] = med;
      // 測った画角に合わせて、方位・仰角・傾きの補正も一緒に求めた値にする
      corr = r.corr;
      lock(alignLabel || '自動');
      const pct = (med / fovBefore - 1) * 100;
      calibInfo = `画角を測定しました（${hist.length}回目、今回 ${pct >= 0 ? '+' : ''}${fmt(pct)}%）`;
      if (Math.abs(pct) >= 1) toast(`画角を合わせました（${pct >= 0 ? '+' : ''}${fmt(pct)}%）`);
    })
    .catch(() => {})
    .finally(() => {
      if (seq === calibSeq) {
        calibBusy = false;
        maybeCalibrate();
      }
    });
}

// ---------------------------------------------------------------- ボタン
$('btn-freeze').addEventListener('click', () => {
  if (frozen) {
    if (autoBusy) {
      cancelAutoAlign();
      autoBusy = false;
      ($('btn-auto') as HTMLButtonElement).disabled = false;
      $('btn-auto').textContent = '自動合わせ';
    }
    hideCands();
    setFrozen(null);
    lastTrack = performance.now();
  } else {
    const f = grabFrame();
    if (f) setFrozen(f);
  }
});

$('btn-fine').addEventListener('click', () => {
  $('fine').classList.toggle('hidden');
  $('more').classList.add('hidden');
});
$('btn-fine-close').addEventListener('click', () => $('fine').classList.add('hidden'));
$('btn-more').addEventListener('click', () => {
  renderDiag();
  $('more').classList.toggle('hidden');
  $('fine').classList.add('hidden');
});
$('btn-more-close').addEventListener('click', () => $('more').classList.add('hidden'));

type Toggle = 'autoTrack' | 'autoStart' | 'autoFov';
const toggles: [string, Toggle, string][] = [
  ['btn-track', 'autoTrack', '追従補正'],
  ['btn-autostart', 'autoStart', '自動で合わせ始める'],
  ['btn-autofov', 'autoFov', '画角・傾きの自動測定'],
];
for (const [id, k, label] of toggles) {
  const render = () => {
    $(id).setAttribute('aria-pressed', String(store[k]));
    $(id).textContent = `${label}：${store[k] ? '入' : '切'}`;
  };
  render();
  $(id).addEventListener('click', () => {
    store[k] = !store[k];
    saveStore();
    render();
    trackInfo = '';
    autoInfo = '';
    calibInfo = '';
    if (k === 'autoFov' && !store.autoFov) resetKeyframes();
  });
}

// 表示の設定
type DisplayToggle = 'skyHalo' | 'showDist' | 'useShinshu';
const displayToggles: [string, DisplayToggle, string][] = [
  ['btn-halo', 'skyHalo', '稜線の黒い縁'],
  ['btn-dist', 'showDist', '山名に距離も出す'],
  ['btn-shinshu', 'useShinshu', '信州百名山を優先'],
];
for (const [id, k, label] of displayToggles) {
  const render = () => {
    $(id).setAttribute('aria-pressed', String(store[k]));
    $(id).textContent = `${label}：${store[k] ? '入' : '切'}`;
  };
  render();
  $(id).addEventListener('click', () => {
    store[k] = !store[k];
    saveStore();
    render();
  });
}
type DisplayRange = 'skyWidth' | 'skyAlpha' | 'nearWidth';
const displayRanges: [string, string, DisplayRange, (v: number) => string][] = [
  ['in-sky-w', 'out-sky-w', 'skyWidth', (v) => String(v)],
  ['in-sky-a', 'out-sky-a', 'skyAlpha', (v) => String(Math.round(v * 100))],
  ['in-near-w', 'out-near-w', 'nearWidth', (v) => String(v)],
];
for (const [inId, outId, k, show] of displayRanges) {
  const el = $(inId) as HTMLInputElement;
  el.value = String(store[k]);
  $(outId).textContent = show(store[k]);
  el.addEventListener('input', () => {
    store[k] = Number(el.value);
    $(outId).textContent = show(store[k]);
    saveStore();
  });
}
const selNear = $('sel-near') as HTMLSelectElement;
selNear.value = store.nearLines;
selNear.addEventListener('change', () => {
  store.nearLines = selNear.value as Store['nearLines'];
  saveStore();
  rebuildSilhouettes();
});
const selLabels = $('sel-labels') as HTMLSelectElement;
selLabels.value = store.labelDensity;
selLabels.addEventListener('change', () => {
  store.labelDensity = selLabels.value as Density;
  saveStore();
});

/** 画角がずれる原因を調べるための表示（カメラの設定・ズームの方式） */
function renderDiag() {
  const track = stream?.getVideoTracks()[0];
  const st = (track?.getSettings?.() ?? {}) as MediaTrackSettings & { zoom?: number };
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { zoom?: { min: number; max: number } };
  const hist = store.fovHist[fovKey()] ?? [];
  const nominal = nominalFov();
  $('diag').innerHTML = [
    `カメラ：${esc(cameraLabel())}　映像 ${video.videoWidth}×${video.videoHeight}`,
    `ズーム：${zoom}× ${hwZoom ? `カメラ側（設定値 ${st.zoom ?? '?'}、範囲 ${caps.zoom ? `${caps.zoom.min}〜${caps.zoom.max}` : '?'}）` : '画面の拡大'}`,
    `画角（長辺）：${fmt(videoFov(), 2)}°　公称 ${fmt(nominal, 2)}°（${fmt((videoFov() / nominal - 1) * 100)}%）`,
    `測定：${hist.length ? hist.map((v) => fmt(v, 2)).join(' / ') : 'なし'}`,
  ].join('<br>');
}
$('btn-reset').addEventListener('click', () => {
  unlock();
  trackInfo = '';
  $('more').classList.add('hidden');
  toast('コンパスの向きに戻しました');
});
$('btn-reset-all').addEventListener('click', () => {
  store.bias = {};
  store.fov = {};
  store.fovHist = {};
  saveStore();
  resetKeyframes();
  calibInfo = '';
  unlock();
  trackInfo = '';
  renderDiag();
  $('more').classList.add('hidden');
  toast('保存した補正（くせ・画角）をすべて消し、コンパスの向きに戻しました');
});
$('btn-compute').addEventListener('click', () => {
  $('more').classList.add('hidden');
  compute();
});
const inF35 = $('in-f35') as HTMLInputElement;
inF35.value = String(store.f35);
inF35.addEventListener('change', () => {
  const v = Number(inF35.value);
  if (v > 5 && v < 300) {
    store.f35 = v;
    saveStore();
  }
});
$('btn-fov-reset').addEventListener('click', () => {
  delete store.fov[fovKey()];
  delete store.fovHist[fovKey()];
  resetKeyframes();
  calibInfo = '';
  saveStore();
  renderDiag();
  toast('このカメラ・ズームの画角を初期値に戻しました');
});
document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) =>
  b.addEventListener('click', () => applyZoom(Number(b.dataset.zoom))),
);
$('sel-camera').addEventListener('change', async (e) => {
  try {
    await startCamera((e.target as HTMLSelectElement).value);
  } catch (err) {
    toast(`カメラを切り替えられません: ${(err as Error).message}`);
  }
});

let toastTimer = 0;
function toast(text: string, ms = 1800) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------- 開始
$('btn-start').addEventListener('click', async () => {
  const msgs: string[] = [];
  try {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission();
      if (r !== 'granted') msgs.push('向きセンサーが許可されませんでした');
    }
  } catch (e) {
    msgs.push(`向きセンサー: ${(e as Error).message}`);
  }
  window.addEventListener('deviceorientation', onOrientation);
  try {
    await startCamera();
    await listCameras();
  } catch (e) {
    msgs.push(`カメラ: ${(e as Error).message}`);
  }
  if (devQuery?.get('ll')) {
    const [lat, lon] = devQuery.get('ll')!.split(',').map(Number);
    gps = { coords: { latitude: lat, longitude: lon, accuracy: 5 } } as GeolocationPosition;
    compute();
  } else if (navigator.geolocation) {
    let started = false;
    const t0 = performance.now();
    navigator.geolocation.watchPosition(
      (p) => {
        gps = p;
        // 精度が 100 m 以内になるか 10 秒待ったら計算を始める
        if (!started && (p.coords.accuracy <= 100 || performance.now() - t0 > 10_000)) {
          started = true;
          compute();
        }
      },
      (err) => (status = `位置情報: ${err.message}`),
      { enableHighAccuracy: true },
    );
  } else msgs.push('位置情報が使えません');
  if (msgs.length) $('start-msg').textContent = msgs.join(' / ');
  else $('start').classList.add('hidden');
  if (msgs.length) setTimeout(() => $('start').classList.add('hidden'), 2500);
  requestAnimationFrame(loop);
});

if (import.meta.env.DEV) (window as unknown as { __ar: unknown }).__ar = { get corr() { return corr; }, set corr(c: Correction) { corr = c; }, onOrientation, store, get result() { return result; }, get frozen() { return frozen; }, get trackInfo() { return trackInfo; }, track: () => maybeTrack(true), get keyframes() { return keyframes; }, get calibInfo() { return calibInfo; }, get autoInfo() { return autoInfo; }, get mode() { return mode; }, videoFov, get candidates() { return candidates; } };
