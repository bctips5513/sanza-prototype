import '../ui/style.css';
import './sensor.css';
import { fetchPeaks, type Peak } from '../peaks/overpass';
import { inverse } from '../geo/geodesic';
import { angDiff, cameraAngles, circularStats, linearStats } from './orientation';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- センサー値
interface Sample {
  t: number;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** iOS Safari のみ：コンパス方位（北から時計回り） */
  compass: number | null;
  compassAcc: number | null;
  absolute: boolean;
  screenAngle: number;
}

let latest: Sample | null = null;
const history: Sample[] = [];
let eventCount = 0;
let rateHz = 0;
let gps: GeolocationPosition | null = null;

function screenAngle(): number {
  const a = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
  return ((a % 360) + 360) % 360;
}

function onOrientation(e: DeviceOrientationEvent, absoluteEvent: boolean) {
  const anyE = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
  const s: Sample = {
    t: performance.now(),
    alpha: e.alpha,
    beta: e.beta,
    gamma: e.gamma,
    compass: typeof anyE.webkitCompassHeading === 'number' ? anyE.webkitCompassHeading : null,
    compassAcc: typeof anyE.webkitCompassAccuracy === 'number' ? anyE.webkitCompassAccuracy : null,
    absolute: absoluteEvent || e.absolute,
    screenAngle: screenAngle(),
  };
  // 絶対方位のイベント（Android）と通常のイベントが両方来る場合は絶対方位を優先
  if (!absoluteEvent && latest?.absolute && s.t - latest.t < 200) return;
  latest = s;
  eventCount++;
  history.push(s);
  while (history.length && s.t - history[0].t > 15_000) history.shift();
}

setInterval(() => {
  rateHz = eventCount;
  eventCount = 0;
}, 1000);

/** 画面に出すカメラの向き。コンパス方位は iOS の webkitCompassHeading、無ければ alpha から */
function current() {
  const s = latest;
  if (!s || s.beta === null || s.gamma === null) return null;
  const cam = cameraAngles(s.alpha ?? 0, s.beta, s.gamma, s.screenAngle);
  return { s, cam };
}

// ---------------------------------------------------------------- 開始
$('btn-start').addEventListener('click', async () => {
  const btn = $('btn-start') as HTMLButtonElement;
  btn.disabled = true;
  const msgs: string[] = [];
  try {
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission();
      if (r !== 'granted') msgs.push('向きセンサーが許可されませんでした');
    }
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (typeof DME?.requestPermission === 'function') await DME.requestPermission().catch(() => {});
  } catch (e) {
    msgs.push(`向きセンサー: ${(e as Error).message}`);
  }
  window.addEventListener('deviceorientation', (e) => onOrientation(e, false));
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', (e) => onOrientation(e as DeviceOrientationEvent, true));

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
    ($('video') as HTMLVideoElement).srcObject = stream;
  } catch (e) {
    msgs.push(`カメラ: ${(e as Error).message}`);
  }

  if (navigator.geolocation) {
    navigator.geolocation.watchPosition(
      (p) => {
        gps = p;
        $('gps-out').textContent = `現在地 ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}（±${Math.round(p.coords.accuracy)} m）`;
      },
      (err) => ($('gps-out').textContent = `位置情報: ${err.message}`),
      { enableHighAccuracy: true },
    );
  }
  $('status').textContent = msgs.length ? msgs.join(' / ') : '計測中';
  requestAnimationFrame(loop);
});

// ---------------------------------------------------------------- 表示
const chart = $('chart') as HTMLCanvasElement;

function loop() {
  const c = current();
  const hud = $('hud');
  if (c) {
    const { s, cam } = c;
    const target = targetAz();
    const head = s.compass ?? cam.headingFromAlpha;
    hud.innerHTML =
      `方位 <b>${fmt(head)}°</b>${s.compass !== null ? '（コンパス）' : s.absolute ? '（絶対alpha）' : '（相対alpha）'}` +
      (target !== null ? `　目標 ${fmt(target)}°　差 <b>${fmt(angDiff(head, target))}°</b>` : '') +
      `<br>仰角 ${fmt(cam.elev)}°　傾き ${fmt(cam.roll)}°　${rateHz} Hz` +
      (s.compassAcc !== null ? `　コンパス精度 ±${fmt(s.compassAcc, 0)}°` : '');
    $('raw').textContent =
      `alpha ${fmt(s.alpha, 2)}  beta ${fmt(s.beta, 2)}  gamma ${fmt(s.gamma, 2)}\n` +
      `webkitCompassHeading ${fmt(s.compass, 2)}  webkitCompassAccuracy ${fmt(s.compassAcc, 1)}\n` +
      `absolute ${s.absolute}  画面の向き ${s.screenAngle}°  更新 ${rateHz} Hz\n` +
      `alpha から求めたカメラ方位 ${fmt(cam.headingFromAlpha, 2)}°`;
  }
  drawChart();
  requestAnimationFrame(loop);
}

function drawChart() {
  const dpr = Math.min(devicePixelRatio || 1, 3);
  const w = chart.clientWidth;
  const h = chart.clientHeight;
  if (chart.width !== Math.round(w * dpr)) {
    chart.width = Math.round(w * dpr);
    chart.height = Math.round(h * dpr);
  }
  const g = chart.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (history.length < 2) return;
  const now = history[history.length - 1].t;
  const series = history.map((s) => {
    const cam = s.beta !== null && s.gamma !== null ? cameraAngles(s.alpha ?? 0, s.beta, s.gamma, s.screenAngle) : null;
    return { t: s.t, head: s.compass ?? cam?.headingFromAlpha ?? NaN, elev: cam?.elev ?? NaN };
  });
  // 方位は直近の平均を中心に ±10° を表示
  const mean = circularStats(series.map((p) => p.head).filter(Number.isFinite)).mean;
  const lines: [string, string, (p: (typeof series)[number]) => number][] = [
    ['#0a6cff', '方位（平均±10°）', (p) => angDiff(p.head, mean)],
    ['#ff9f0a', '仰角（±10°）', (p) => p.elev - series[series.length - 1].elev],
  ];
  g.font = '11px system-ui, sans-serif';
  lines.forEach(([color, label, f], k) => {
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    series.forEach((p, i) => {
      const x = w - ((now - p.t) / 15000) * w;
      const y = h / 2 - (f(p) / 10) * (h / 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = color;
    g.fillText(label, 6, 14 + k * 14);
  });
  g.strokeStyle = 'rgba(128,128,128,0.4)';
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
}

// ---------------------------------------------------------------- 1. 静止テスト
$('btn-still').addEventListener('click', async () => {
  const out = $('still-out');
  if (!latest) {
    out.textContent = '先に「計測開始」を押してください';
    return;
  }
  const t0 = performance.now();
  out.textContent = '計測中…（動かさないでください）';
  await new Promise((r) => setTimeout(r, 10_000));
  const xs = history.filter((s) => s.t >= t0);
  const cams = xs.filter((s) => s.beta !== null && s.gamma !== null).map((s) => cameraAngles(s.alpha ?? 0, s.beta!, s.gamma!, s.screenAngle));
  const comp = xs.map((s) => s.compass).filter((v): v is number => v !== null);
  const head = circularStats(comp.length ? comp : cams.map((c) => c.headingFromAlpha));
  const el = linearStats(cams.map((c) => c.elev));
  const ro = linearStats(cams.map((c) => c.roll));
  const accs = xs.map((s) => s.compassAcc).filter((v): v is number => v !== null);
  out.innerHTML =
    `サンプル ${xs.length} 件（${(xs.length / 10).toFixed(0)} Hz）<br>` +
    `方位のブレ（標準偏差）<b>${fmt(head.std, 2)}°</b>　仰角のブレ <b>${fmt(el.std, 2)}°</b>　傾きのブレ <b>${fmt(ro.std, 2)}°</b>` +
    (accs.length ? `<br>コンパス精度（自己申告）平均 ±${fmt(linearStats(accs).mean, 1)}°` : '');
  stillResults.push({ time: new Date().toISOString(), n: xs.length, headStd: head.std, elevStd: el.std, rollStd: ro.std });
  save();
});

// ---------------------------------------------------------------- 2. 方位の正確さ
let peaks: (Peak & { az: number; dist: number })[] = [];

$('btn-peaks').addEventListener('click', async () => {
  if (!gps) {
    $('gps-out').textContent = '現在地を取得中です。少し待ってからもう一度押してください。';
    return;
  }
  const { latitude: lat, longitude: lon } = gps.coords;
  $('gps-out').textContent = '山の一覧を取得中…（混雑時は数分）';
  try {
    const got = await fetchPeaks(lat, lon, 60_000);
    peaks = got
      .filter((p) => p.name)
      .map((p) => ({ ...p, ...inverse(lat, lon, p.lat, p.lon) }))
      .filter((p) => p.dist < 60_000)
      .sort((a, b) => a.dist - b.dist);
    renderPeaks();
    $('gps-out').textContent = `${peaks.length} 座（60 km 以内・近い順）`;
  } catch (e) {
    $('gps-out').textContent = `取得できません: ${(e as Error).message}`;
  }
});

function renderPeaks() {
  const q = ($('peak-filter') as HTMLInputElement).value.trim();
  const sel = $('sel-peak') as HTMLSelectElement;
  sel.innerHTML = peaks
    .filter((p) => !q || p.name!.includes(q))
    .slice(0, 300)
    .map(
      (p) =>
        `<option value="${p.id}">${esc(p.name!)}　${p.ele ? Math.round(p.ele) + 'm・' : ''}${(p.dist / 1000).toFixed(1)}km・方位${p.az.toFixed(1)}°</option>`,
    )
    .join('');
}
$('peak-filter').addEventListener('input', renderPeaks);

/** 選んだ山（現在地からの真方位）または直接入力の真方位 */
function targetAz(): number | null {
  const manual = parseFloat(($('in-target') as HTMLInputElement).value);
  if (Number.isFinite(manual)) return manual;
  const id = Number(($('sel-peak') as HTMLSelectElement).value);
  const p = peaks.find((x) => x.id === id);
  if (!p) return null;
  if (gps) return inverse(gps.coords.latitude, gps.coords.longitude, p.lat, p.lon).az;
  return p.az;
}

function targetName(): string {
  const manual = ($('in-target') as HTMLInputElement).value;
  if (manual) return '（直接入力）';
  const id = Number(($('sel-peak') as HTMLSelectElement).value);
  return peaks.find((x) => x.id === id)?.name ?? '';
}

interface Rec {
  time: string;
  target: string;
  trueAz: number;
  compass: number | null;
  compassAcc: number | null;
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean;
  screenAngle: number;
  headingFromAlpha: number;
  elev: number;
  roll: number;
  lat: number | null;
  lon: number | null;
  gpsAcc: number | null;
  ua: string;
}

let records: Rec[] = [];
let stillResults: { time: string; n: number; headStd: number; elevStd: number; rollStd: number }[] = [];

function save() {
  try {
    localStorage.setItem('sanza.sensor.v1', JSON.stringify({ records, stillResults }));
  } catch {
    /* ignore */
  }
}
try {
  const d = JSON.parse(localStorage.getItem('sanza.sensor.v1') ?? 'null');
  if (d) {
    records = d.records ?? [];
    stillResults = d.stillResults ?? [];
  }
} catch {
  /* ignore */
}

$('btn-record').addEventListener('click', () => {
  const c = current();
  const t = targetAz();
  if (!c) {
    $('rec-out').textContent = '先に「計測開始」を押してください';
    return;
  }
  if (t === null) {
    $('rec-out').textContent = '目標の山を選ぶか、真方位を入力してください';
    return;
  }
  // 直近0.5秒の平均（手ブレを抑える）
  const recent = history.filter((s) => c.s.t - s.t < 500 && s.beta !== null && s.gamma !== null);
  const cams = recent.map((s) => cameraAngles(s.alpha ?? 0, s.beta!, s.gamma!, s.screenAngle));
  const comp = recent.map((s) => s.compass).filter((v): v is number => v !== null);
  records.push({
    time: new Date().toISOString(),
    target: targetName(),
    trueAz: t,
    compass: comp.length ? circularStats(comp).mean : null,
    compassAcc: c.s.compassAcc,
    alpha: c.s.alpha,
    beta: c.s.beta,
    gamma: c.s.gamma,
    absolute: c.s.absolute,
    screenAngle: c.s.screenAngle,
    headingFromAlpha: circularStats(cams.map((x) => x.headingFromAlpha)).mean,
    elev: linearStats(cams.map((x) => x.elev)).mean,
    roll: linearStats(cams.map((x) => x.roll)).mean,
    lat: gps?.coords.latitude ?? null,
    lon: gps?.coords.longitude ?? null,
    gpsAcc: gps?.coords.accuracy ?? null,
    ua: navigator.userAgent,
  });
  save();
  renderRecords();
});

$('btn-undo').addEventListener('click', () => {
  records.pop();
  save();
  renderRecords();
});

function renderRecords() {
  const out = $('rec-out');
  if (!records.length) {
    out.textContent = '記録はまだありません';
    return;
  }
  const errC = records.filter((r) => r.compass !== null).map((r) => angDiff(r.compass!, r.trueAz));
  const errA = records.map((r) => angDiff(r.headingFromAlpha, r.trueAz));
  const sc = linearStats(errC);
  const sa = linearStats(errA);
  const rows = records
    .slice(-12)
    .map(
      (r) =>
        `<tr><td>${esc(r.target)}</td><td>${fmt(r.trueAz)}°</td><td>${r.compass !== null ? fmt(angDiff(r.compass, r.trueAz)) + '°' : '—'}</td><td>${fmt(angDiff(r.headingFromAlpha, r.trueAz))}°</td><td>${r.screenAngle === 0 ? '縦' : '横'}</td></tr>`,
    )
    .join('');
  out.innerHTML =
    `記録 ${records.length} 件<br>` +
    (errC.length ? `コンパス方位の誤差：平均 <b>${fmt(sc.mean)}°</b>・ばらつき ${fmt(sc.std)}°<br>` : '') +
    `alpha から求めた方位の誤差：平均 ${fmt(sa.mean)}°・ばらつき ${fmt(sa.std)}°<br>` +
    `<span class="small">（平均が −7〜−9° 前後に揃うなら磁北基準の可能性。ばらつきが小さければ、一度の補正で済む）</span>` +
    `<table class="t"><tr><th>目標</th><th>真方位</th><th>コンパス誤差</th><th>alpha誤差</th><th>持ち方</th></tr>${rows}</table>`;
}
renderRecords();

// ---------------------------------------------------------------- 3. 書き出し
$('btn-csv').addEventListener('click', () => {
  const keys: (keyof Rec)[] = ['time', 'target', 'trueAz', 'compass', 'compassAcc', 'alpha', 'beta', 'gamma', 'absolute', 'screenAngle', 'headingFromAlpha', 'elev', 'roll', 'lat', 'lon', 'gpsAcc', 'ua'];
  const lines = [keys.join(',')];
  for (const r of records) lines.push(keys.map((k) => JSON.stringify(r[k] ?? '')).join(','));
  lines.push('', 'still_time,n,headStd,elevStd,rollStd');
  for (const s of stillResults) lines.push([s.time, s.n, s.headStd, s.elevStd, s.rollStd].join(','));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sensor_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-clear').addEventListener('click', () => {
  if (!confirm('記録をすべて消去しますか？')) return;
  records = [];
  stillResults = [];
  save();
  renderRecords();
  $('still-out').textContent = '';
});
