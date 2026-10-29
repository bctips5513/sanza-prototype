import '../ui/style.css';
import './ar.css';
import { SkylineClient } from '../skyline/client';
import { PeakStatus, type PeakResult, type SkylineResult } from '../skyline/compute';
import { fetchPeaks, type Peak } from '../peaks/overpass';
import { loadSettings } from '../settings';
import { inverse } from '../geo/geodesic';
import { basis, dirFromAzEl, project, type Basis, type CameraParams } from '../photo/camera';
import { runAutoAlignSource, cancelAutoAlign } from '../photo/autoAlignClient';
import type { AutoAlignCandidate } from '../photo/autoAlign';
import { attachGestures, fitCanvas } from '../ui/gestures';
import { bandLine, drawLabels, layoutLabels, type LabelItem } from '../ui/labels';
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

// ---------------------------------------------------------------- 保存する設定
interface Store {
  /** 1× の35mm換算焦点距離 */
  f35: number;
  /** カメラ・ズームごとに合わせで求めた長辺の画角 [deg] */
  fov: Record<string, number>;
  /** 持ち方ごとの仰角・傾きのくせ */
  bias: Record<string, { dPitch: number; dRoll: number }>;
  autoTrack: boolean;
}
const STORE_KEY = 'sanza.ar.v1';
const store: Store = { f35: 26, fov: {}, bias: {}, autoTrack: true };
try {
  Object.assign(store, JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'));
} catch {
  /* ignore */
}
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
  store.bias[String(hold)] = { dPitch: corr.dPitch, dRoll: corr.dRoll };
  saveStore();
}

function unlock() {
  mode = 'compass';
  alignLabel = '';
  const b = biasFor(latest?.hold ?? 0);
  corr = { yawOff: compassOff ?? 0, ...b };
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // 画面を離れると alpha の基準が変わることがある。合わせ済みならコンパスとの差を保って推定し直す
  compassOff = null;
  compassOffAlpha = 0.2;
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
let peaks = new Map<number, Peak>();
let peakRes: PeakResult[] = [];
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
    status = '山名を取得中…';
    const pk = await peaksPromise;
    if (!pk.ok) {
      status = `山名を取得できません: ${pk.err.message}`;
      return;
    }
    peaks = new Map(pk.got.map((p) => [p.id, p]));
    peakRes = await client.peaks(
      pk.got.map(({ id, lat, lon, ele }) => ({ id, lat, lon, ele })),
      settings.visibilityTolDeg,
      (p) => (status = `山の見え方を判定中… ${p.done}/${p.total}`),
    );
    status = '';
  } catch (e) {
    status = `計算に失敗しました: ${(e as Error).message}`;
  } finally {
    computing = false;
  }
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
  if (devQuery?.get('fake')) {
    const img = new Image();
    img.src = devQuery.get('fake')!;
    await new Promise((r) => (img.onload = r));
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    stream = c.captureStream(5);
    setInterval(() => c.getContext('2d')!.drawImage(img, 0, 0), 200);
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

/** 映像（コマ）の長辺の画角 [deg] */
function videoFov(): number {
  return store.fov[fovKey()] ?? hfovFrom35mm(store.f35 * (hwZoom ? zoom : 1));
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
  const nB = r.bands.length;
  const half = Math.atan(Math.hypot(cam.width, cam.height) / 2 / cam.focalPx) / RAD + 2;
  const step = r.azStep;
  const k0 = Math.floor((cam.yaw - half) / step);
  const k1 = Math.ceil((cam.yaw + half) / step);
  const maxJump = Math.max(cam.width, cam.height) * 0.5;
  const strokeBand = (bi: number, mask: ((i: number) => boolean) | null, style: string, width: number, halo: boolean) => {
    const arr = r.bandElev[bi];
    ctx.beginPath();
    let prev: [number, number] | null = null;
    for (let k = k0; k <= k1; k++) {
      const i = ((k % r.nAz) + r.nAz) % r.nAz;
      if (mask && !mask(i)) {
        prev = null;
        continue;
      }
      const p = project(cam, b, dirFromAzEl(k * step, arr[i]));
      if (!p) {
        prev = null;
        continue;
      }
      if (prev && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < maxJump) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
      prev = p;
    }
    if (halo) {
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = width + 2;
      ctx.stroke();
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  for (let bi = nB - 2; bi >= 0; bi--) {
    const arr = r.bandElev[bi];
    const next = r.bandElev[bi + 1];
    strokeBand(bi, (i) => arr[i] < next[i] - 0.005, bandLine(bi, nB), 1, false);
  }
  strokeBand(nB - 1, null, '#ff2d55', 2, true);
}

function drawPeaks(cam: CameraParams, b: Basis, h: number) {
  const items: LabelItem[] = [];
  for (const res of peakRes) {
    if (res.status === PeakStatus.Hidden) continue;
    const peak = peaks.get(res.id);
    if (!peak || (!peak.name && !settings.showUnnamedPeaks)) continue;
    const p = project(cam, b, dirFromAzEl(res.az, res.elev));
    if (!p || p[0] < 0 || p[0] > cam.width || p[1] < 0 || p[1] > cam.height) continue;
    items.push({
      id: res.id,
      x: p[0],
      y: p[1],
      title: peak.name ?? '（無名）',
      sub: `${Math.round(res.hUsed)}m ${(res.dist / 1000).toFixed(1)}km`,
      priority: res.hUsed - res.dist / 200,
      named: !!peak.name,
      marginal: res.status === PeakStatus.Marginal,
    });
  }
  const rowH = 30;
  const top = Math.max(70, h * 0.1);
  const maxRows = Math.max(1, Math.floor((h * 0.3) / rowH));
  const placed = layoutLabels(ctx, items, maxRows, 'bold 13px system-ui, sans-serif', '10px system-ui, sans-serif');
  drawLabels(ctx, items, placed, top, rowH, {
    titleFont: 'bold 13px system-ui, sans-serif',
    subFont: '10px system-ui, sans-serif',
    color: '#fff',
    halo: 'rgba(0,0,0,0.85)',
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
  } else {
    const drift = compassOff !== null ? angDiff(corr.yawOff, compassOff) : null;
    parts.push(`<span class="ok">合わせ済み（${esc(alignLabel)}）</span>` + (drift !== null ? `　コンパスとの差 ${fmt(drift)}°` : '') + (trackInfo ? `　${esc(trackInfo)}` : ''));
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
  maybeTrack();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 手動合わせ
function nudge(kind: string, v: number) {
  if (!view) return;
  if (kind === 'yaw') corr.yawOff = wrap360(corr.yawOff - v);
  else if (kind === 'pitch') corr.dPitch -= v;
  else if (kind === 'roll') corr.dRoll += v;
  else if (kind === 'fov') store.fov[fovKey()] = videoFov() * (1 + v / 100);
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
    const f = view.focalVideo * scale;
    store.fov[fovKey()] = longFovFromFocal(f, view.vw, view.vh);
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

function applyCandidate(c: AutoAlignCandidate, f: Frozen, label: string) {
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
  const yawRange = mode === 'locked' ? 10 : 20;
  // 画角は求めない：実写真の映像で試すと、画角を動かすと傾きとつり合って誤った値に寄ることがあり、
  // 公称値（またはピンチで合わせて記憶した値）のまま方位・仰角・傾きだけ求めるほうが正確だった
  try {
    const res = await runAutoAlignSource(
      f.canvas,
      f.vw,
      f.vh,
      focalFromLongFov(videoFov(), f.vw, f.vh),
      skylineArr(),
      result.azStep,
      { yawCenter: prior.yaw, yawRange, pitchCenter: prior.pitch, pitchRange: 3, rollCenter: prior.roll, rollRange: 3, refineFocal: false },
      (d, t) => (btn.textContent = `合わせ中 ${Math.round((d / t) * 100)}%`),
    );
    const best = res.best;
    const conf = { high: '高', medium: '中', low: '低' }[res.confidence];
    // 「中」はセンサーの仰角と 2° 以内のときだけ採用（実写真で、仰角が 3° ずれた偽の答えが「中」になった例がある）
    // 探索範囲の外まで山登りで動いた答えも採用しない
    const ok =
      best &&
      Math.abs(angDiff(best.yaw, prior.yaw)) <= yawRange + 0.5 &&
      (res.confidence === 'high' || (res.confidence === 'medium' && Math.abs(best.pitch - prior.pitch) <= 2));
    if (best && ok) {
      applyCandidate(best, f, `自動・信頼度${conf}`);
      toast(`合わせました（信頼度 ${conf}）。ずれていれば指で直して「ライブに戻る」`, 2500);
    } else showCands(res.candidates.slice(0, 3), f);
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
 * 追従補正：合わせた後、カメラが止まっている間に映像のコマで狭く（±2°）合わせ直し、
 * ジャイロのずれを少しずつ直す。自信が高く、ずれが小さいときだけ半分ずつ反映する。
 */
function maybeTrack(force = false) {
  if (!store.autoTrack || mode !== 'locked' || frozen || autoBusy || trackBusy || !result || !latest) return;
  const now = performance.now();
  if (!force && (now - lastTrack < 2500 || !isSteady(hist, now, 600, 0.15))) return;
  const f = grabFrame();
  if (!f) return;
  lastTrack = now;
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
      corr = { yawOff: wrap360(corr.yawOff + dy * 0.5), dPitch: corr.dPitch + dp * 0.5, dRoll: corr.dRoll + dr * 0.5 };
      trackInfo = `追従補正 ${dy >= 0 ? '+' : ''}${fmt(dy, 2)}°`;
    })
    .catch(() => {})
    .finally(() => {
      if (seq === trackSeq) trackBusy = false;
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
  $('more').classList.toggle('hidden');
  $('fine').classList.add('hidden');
});
$('btn-more-close').addEventListener('click', () => $('more').classList.add('hidden'));

function renderTrackBtn() {
  $('btn-track').setAttribute('aria-pressed', String(store.autoTrack));
  $('btn-track').textContent = `追従補正：${store.autoTrack ? '入' : '切'}`;
}
renderTrackBtn();
$('btn-track').addEventListener('click', () => {
  store.autoTrack = !store.autoTrack;
  saveStore();
  renderTrackBtn();
  trackInfo = '';
});
$('btn-reset').addEventListener('click', () => {
  unlock();
  trackInfo = '';
  $('more').classList.add('hidden');
  toast('コンパスの向きに戻しました');
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
  saveStore();
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

if (import.meta.env.DEV) (window as unknown as { __ar: unknown }).__ar = { get corr() { return corr; }, set corr(c: Correction) { corr = c; }, onOrientation, store, get result() { return result; }, get frozen() { return frozen; }, get trackInfo() { return trackInfo; }, track: () => maybeTrack(true) };
