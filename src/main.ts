import 'leaflet/dist/leaflet.css';
import './ui/style.css';
import L from 'leaflet';
import { state, emit, on, visiblePeaks, peakLabel, type AlignTap } from './state';
import { SkylineClient } from './skyline/client';
import { fetchPeaks, clearPeakCache } from './peaks/overpass';
import { PanoramaView, dirName } from './ui/panoramaView';
import { PhotoView, type PhotoMode } from './ui/photoView';
import { readPhotoMeta } from './photo/exif';
import {
  basis,
  dirFromAzEl,
  focalPxFrom35mm,
  focalPxFromHfov,
  hfovDeg,
  project,
  unproject,
} from './photo/camera';
import { align1pt, align2pt, residual } from './photo/align2pt';
import { runAutoAlign } from './photo/autoAlignClient';
import { direct, inverse } from './geo/geodesic';
import { DEFAULT_SETTINGS, saveSettings, type DemTier } from './settings';
import { PeakStatus } from './skyline/compute';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const client = new SkylineClient();
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- ステータス
function setStatus(text: string, progress?: number) {
  $('status').textContent = text;
  $('progress-bar').style.width = progress === undefined ? '0' : `${Math.round(progress * 100)}%`;
}

// ---------------------------------------------------------------- タブ
const tabButtons = document.querySelectorAll<HTMLButtonElement>('.tabs button');
function showTab(name: string) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
  if (name === 'place') setTimeout(() => map.invalidateSize(), 0);
  emit('tab');
}
tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));

// ---------------------------------------------------------------- 地図
const map = L.map('map', { zoomControl: true }).setView([35.5, 138.6], 9);
L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">地理院タイル</a>',
}).addTo(map);
const obsIcon = L.divIcon({ className: '', html: '<div class="obs-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
let obsMarker: L.Marker | null = null;
const camLayer = L.layerGroup().addTo(map);
const peakLayer = L.layerGroup().addTo(map);

map.on('click', (e: L.LeafletMouseEvent) => setObserver(e.latlng.lat, e.latlng.lng));

function setObserver(lat: number, lon: number, opts: { pan?: boolean } = {}) {
  state.observer = { lat, lon };
  state.ground = null;
  ($('in-lat') as HTMLInputElement).value = lat.toFixed(6);
  ($('in-lon') as HTMLInputElement).value = lon.toFixed(6);
  if (!obsMarker) {
    obsMarker = L.marker([lat, lon], { icon: obsIcon, draggable: true }).addTo(map);
    obsMarker.on('dragend', () => {
      const p = obsMarker!.getLatLng();
      setObserver(p.lat, p.lng);
    });
  } else obsMarker.setLatLng([lat, lon]);
  if (opts.pan) map.setView([lat, lon], Math.max(map.getZoom(), 12));
  history.replaceState(null, '', `#ll=${lat.toFixed(6)},${lon.toFixed(6)}`);
  $('out-gsiapi').textContent = '';
  updateGround();
  emit('observer');
}

let groundSeq = 0;
async function updateGround() {
  const o = state.observer;
  if (!o) return;
  const seq = ++groundSeq;
  $('out-ground').textContent = '取得中…';
  try {
    const g = await client.ground(o.lat, o.lon);
    if (seq !== groundSeq) return;
    state.ground = g;
  } catch (e) {
    $('out-ground').textContent = `取得失敗: ${(e as Error).message}`;
    return;
  }
  renderGround();
}

function renderGround() {
  const g = state.ground;
  if (!g) return;
  $('out-ground').textContent = `${fmt(g.h, 2)} m（${g.src}）`;
  $('out-obs').textContent = `${fmt(g.h + state.settings.eyeHeight, 2)} m`;
}

$('btn-setll').addEventListener('click', () => {
  const lat = parseFloat(($('in-lat') as HTMLInputElement).value);
  const lon = parseFloat(($('in-lon') as HTMLInputElement).value);
  if (Number.isFinite(lat) && Number.isFinite(lon)) setObserver(lat, lon, { pan: true });
});
$('btn-geo').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('この端末では位置情報が使えません');
  setStatus('現在地を取得中…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      setObserver(p.coords.latitude, p.coords.longitude, { pan: true });
      setStatus(`現在地を設定（精度 ±${Math.round(p.coords.accuracy)} m）`);
    },
    (err) => setStatus(`現在地を取得できません: ${err.message}`),
    { enableHighAccuracy: true, timeout: 20000 },
  );
});
const eyeInput = $('in-eye') as HTMLInputElement;
eyeInput.value = String(state.settings.eyeHeight);
eyeInput.addEventListener('change', () => {
  const v = parseFloat(eyeInput.value);
  if (!Number.isFinite(v)) return;
  state.settings.eyeHeight = v;
  saveSettings(state.settings);
  renderGround();
  renderSettings();
});

$('btn-gsiapi').addEventListener('click', async () => {
  const o = state.observer;
  if (!o) return;
  const out = $('out-gsiapi');
  out.textContent = '地理院標高APIに問い合わせ中…';
  try {
    const r = await fetch(
      `https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${o.lon}&lat=${o.lat}&outtype=JSON`,
    );
    const j = await r.json();
    const api = Number(j.elevation);
    const diff = state.ground ? state.ground.h - api : NaN;
    out.textContent = `標高API: ${j.elevation} m（${j.hsrc}）／ タイル補間値との差: ${fmt(diff, 2)} m`;
  } catch (e) {
    out.textContent = `標高APIに接続できません: ${(e as Error).message}`;
  }
});

// ---------------------------------------------------------------- 計算
let runSeq = 0;
$('btn-compute').addEventListener('click', () => compute());

async function compute() {
  const o = state.observer;
  if (!o) {
    alert('先に観測地点を選んでください');
    return;
  }
  const seq = ++runSeq;
  const s = state.settings;
  const btn = $('btn-compute') as HTMLButtonElement;
  btn.disabled = true;
  try {
    // 山頂データ（Overpass）は時間がかかることがあるため、稜線計算と並行して取得する
    let peakStatus = '';
    const peaksPromise = fetchPeaks(o.lat, o.lon, s.maxDist, (t) => (peakStatus = t)).then(
      (got) => ({ ok: true as const, got }),
      (err: Error) => ({ ok: false as const, err }),
    );
    setStatus('稜線を計算中…', 0.01);
    const t0 = performance.now();
    const res = await client.skyline(
      {
        lat: o.lat,
        lon: o.lon,
        eyeHeight: s.eyeHeight,
        earthRadius: s.earthRadius,
        refractionK: s.refractionK,
        maxDist: s.maxDist,
        minDist: s.minDist,
        azStep: s.azStep,
        tiers: s.tiers,
        bands: s.bands,
        peakHeightSource: s.peakHeightSource,
      },
      [],
      s.visibilityTolDeg,
      (p) =>
        setStatus(
          `${p.phase} ${p.done}/${p.total}・タイル 通信${p.stats.network}枚(${(p.stats.bytes / 1e6).toFixed(1)}MB) キャッシュ${p.stats.cache}枚`,
          p.done / p.total,
        ),
    );
    if (seq !== runSeq) return;
    state.result = res;
    state.peakResults = new Map();
    state.ground = { h: res.hGround, src: state.ground?.src ?? 'DEM' };
    renderGround();
    const skyText = `稜線 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    $('pano-stats').textContent =
      `観測高 ${fmt(res.hObs, 2)} m・1方位あたり ${res.samplesPerRay} サンプル × ${res.nAz} 方位・` +
      `計算 ${(res.elapsedMs / 1000).toFixed(1)} 秒・タイル 通信 ${res.stats.network} 枚（${(res.stats.bytes / 1e6).toFixed(1)} MB）／キャッシュ ${res.stats.cache} 枚／欠損 ${res.stats.missing} 枚` +
      (res.stats.missRefs ? `・未読込参照 ${res.stats.missRefs}（不具合の可能性）` : '');
    emit('result');
    if (!document.querySelector('#tab-photo.active')) showTab('pano');

    setStatus(`${skyText}・${peakStatus || '山頂データを取得中…'}`);
    const pk = await peaksPromise;
    if (seq !== runSeq) return;
    if (!pk.ok) {
      setStatus(`${skyText}・山頂データを取得できません: ${pk.err.message}`);
      return;
    }
    state.peaks = new Map(pk.got.map((p) => [p.id, p]));
    const pres = await client.peaks(
      pk.got.map(({ id, lat, lon, ele }) => ({ id, lat, lon, ele })),
      s.visibilityTolDeg,
      (p) => setStatus(`${skyText}・${p.phase} ${p.done}/${p.total}`, p.done / p.total),
    );
    if (seq !== runSeq) return;
    state.peakResults = new Map(pres.map((p) => [p.id, p]));
    const nVis = pres.filter((p) => p.status !== PeakStatus.Hidden).length;
    setStatus(`計算完了・${skyText}・見える山頂 ${nVis}/${pres.length}（全体 ${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    emit('result');
    renderMapPeaks();
  } catch (e) {
    setStatus(`計算に失敗しました: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderMapPeaks() {
  peakLayer.clearLayers();
  for (const { peak, res } of visiblePeaks()) {
    if (!peak.name) continue;
    L.circleMarker([peak.lat, peak.lon], {
      radius: 4,
      color: res.status === PeakStatus.Visible ? '#e67e00' : '#999',
      weight: 2,
      fillOpacity: 0.8,
    })
      .bindTooltip(`${esc(peakLabel(peak))} ${Math.round(res.hUsed)}m`)
      .addTo(peakLayer);
  }
}

// ---------------------------------------------------------------- パノラマ
const sheet = $('sheet');
function openSheet(title: string, html: string) {
  $('sheet-title').textContent = title;
  $('sheet-content').innerHTML = html;
  sheet.classList.remove('hidden');
}
function closeSheet() {
  sheet.classList.add('hidden');
}
$('sheet-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) closeSheet();
});

const statusText = ['隠れている', 'ぎりぎり（許容値内）', '見える'];

function peakInfoHtml(id: number): string {
  const peak = state.peaks.get(id);
  const res = state.peakResults.get(id);
  if (!peak || !res) return '';
  return `<strong>${esc(peakLabel(peak))}</strong>
    <table class="t">
      <tr><th>OSM 標高</th><td>${peak.eleRaw ? esc(peak.eleRaw) + ' m' : '—'}</td></tr>
      <tr><th>DEM 標高（距離帯のズーム）</th><td>${fmt(res.hDem, 1)} m</td></tr>
      <tr><th>位置計算に使用</th><td>${fmt(res.hUsed, 1)} m</td></tr>
      <tr><th>距離</th><td>${fmt(res.dist / 1000, 2)} km</td></tr>
      <tr><th>方位</th><td>${fmt(res.az, 2)}°（${dirName(res.az)}）</td></tr>
      <tr><th>見かけの仰角</th><td>${fmt(res.elev, 3)}°</td></tr>
      <tr><th>手前の最大仰角</th><td>${fmt(res.block, 3)}°</td></tr>
      <tr><th>判定</th><td>${statusText[res.status]}</td></tr>
      <tr><th>座標</th><td>${peak.lat.toFixed(5)}, ${peak.lon.toFixed(5)}</td></tr>
    </table>
    <div class="row"><button data-zoomcmp="${id}">ズーム別の標高を比較</button>
    <a href="https://www.openstreetmap.org/node/${id}" target="_blank" rel="noopener" class="small">OSMで見る</a></div>
    <div id="zoomcmp"></div>`;
}

const pano = new PanoramaView($('pano') as HTMLCanvasElement, {
  onPeakInfo(id) {
    $('pano-info').innerHTML = peakInfoHtml(id);
  },
  onSkylineInfo(az) {
    const r = state.result!;
    const i = Math.round(az / r.azStep) % r.nAz;
    const azr = i * r.azStep;
    const nB = r.bands.length;
    const d = r.bandDist[nB - 1][i];
    const p = direct(r.lat, r.lon, azr, d);
    const rows = r.bands
      .map(
        (b, k) =>
          `<tr><td>〜${b / 1000} km</td><td>${fmt(r.bandElev[k][i], 3)}°</td><td>${fmt(r.bandDist[k][i] / 1000, 2)} km</td><td>${fmt(r.bandH[k][i], 0)} m</td></tr>`,
      )
      .join('');
    $('pano-info').innerHTML = `<strong>方位 ${azr.toFixed(1)}°（${dirName(azr)}）の稜線</strong>：
      仰角 ${fmt(r.bandElev[nB - 1][i], 3)}°・距離 ${fmt(d / 1000, 2)} km・標高 ${fmt(r.bandH[nB - 1][i], 0)} m
      （${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}）
      <table class="t"><tr><th>距離帯</th><th>仰角</th><th>距離</th><th>標高</th></tr>${rows}</table>`;
  },
});

document.addEventListener('click', async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-zoomcmp]');
  if (!t) return;
  const peak = state.peaks.get(Number(t.dataset.zoomcmp));
  if (!peak) return;
  const box = document.getElementById('zoomcmp')!;
  box.textContent = '取得中…';
  try {
    const rows = await client.point(peak.lat, peak.lon, 100);
    box.innerHTML = `<table class="t"><tr><th>DEM</th><th>中心</th><th>半径100m内の最大</th></tr>${rows
      .map((r) => `<tr><td>${r.label}</td><td>${fmt(r.center, 1)} m</td><td>${fmt(r.max, 1)} m</td></tr>`)
      .join('')}</table><p class="small">低ズームほど平滑化で山頂が低く出るかを確認できます。</p>`;
  } catch (err) {
    box.textContent = `失敗: ${(err as Error).message}`;
  }
});

document.querySelectorAll<HTMLButtonElement>('[data-jump]').forEach((b) =>
  b.addEventListener('click', () => pano.jump(Number(b.dataset.jump))),
);
($('sel-vscale') as HTMLSelectElement).addEventListener('change', (e) =>
  pano.setVScale(Number((e.target as HTMLSelectElement).value)),
);

// ---------------------------------------------------------------- CSV
function download(name: string, text: string) {
  const blob = new Blob(['﻿' + text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => {
  const o = state.observer!;
  return `${o.lat.toFixed(5)}_${o.lon.toFixed(5)}`;
};
$('btn-csv-sky').addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const nB = r.bands.length;
  const head = ['azimuth_deg', 'elev_deg', 'dist_m', 'height_m', 'lat', 'lon', ...r.bands.map((b) => `elev_within_${b / 1000}km`)];
  const lines = [
    `# observer ${r.lat},${r.lon} ground=${r.hGround.toFixed(2)} obs=${r.hObs.toFixed(2)} k=${state.settings.refractionK} R=${state.settings.earthRadius}`,
    head.join(','),
  ];
  for (let i = 0; i < r.nAz; i++) {
    const az = i * r.azStep;
    const d = r.bandDist[nB - 1][i];
    const p = direct(r.lat, r.lon, az, d);
    lines.push(
      [az.toFixed(1), r.bandElev[nB - 1][i].toFixed(4), d.toFixed(0), r.bandH[nB - 1][i].toFixed(1), p.lat.toFixed(6), p.lon.toFixed(6), ...r.bands.map((_, k) => r.bandElev[k][i].toFixed(4))].join(','),
    );
  }
  download(`skyline_${stamp()}.csv`, lines.join('\n'));
});
$('btn-csv-peaks').addEventListener('click', () => {
  const r = state.result;
  if (!r) return;
  const lines = ['osm_id,name,ele_osm,h_dem,h_used,azimuth_deg,dist_m,elev_deg,block_deg,status,lat,lon'];
  for (const res of r.peaks) {
    const p = state.peaks.get(res.id);
    if (!p) continue;
    const name = (p.name ?? '').replace(/"/g, '""');
    lines.push(
      [res.id, `"${name}"`, p.ele ?? '', res.hDem.toFixed(1), res.hUsed.toFixed(1), res.az.toFixed(3), res.dist.toFixed(0), res.elev.toFixed(4), res.block.toFixed(4), ['hidden', 'marginal', 'visible'][res.status], p.lat, p.lon].join(','),
    );
  }
  download(`peaks_${stamp()}.csv`, lines.join('\n'));
});

// ---------------------------------------------------------------- 写真
const photoView = new PhotoView($('photo') as HTMLCanvasElement, {
  onCamChange: () => {
    refreshCamControls();
    renderAlignPanel();
    renderCamWedge();
  },
  onAlignTap: (px, py) => {
    state.alignTaps.push({ px, py });
    renderAlignPanel();
    photoView.request();
    choosePeak(state.alignTaps.length - 1);
  },
});

$('in-photo').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await loadPhoto(file);
  (e.target as HTMLInputElement).value = '';
});

async function loadPhoto(file: File) {
  const meta = await readPhotoMeta(file);
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    alert('この写真形式はブラウザで表示できません（HEICの場合はJPEGに変換してください）');
    return;
  }
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const notes: string[] = [];
  let focalPx: number;
  if (meta.focal35) focalPx = focalPxFrom35mm(meta.focal35, W, H);
  else {
    focalPx = focalPxFromHfov(60, W);
    notes.push('35mm換算焦点距離がないため、水平画角60°を仮に設定しました。画角を手入力してください。');
  }
  let yaw = pano.centerAz;
  if (meta.direction !== undefined) {
    yaw = meta.direction;
    if (meta.directionRef === 'M') notes.push('撮影方位は磁北基準です（真北との差＝偏角 約7〜9°）。');
    notes.push('EXIFの撮影方位は数十度ずれることがあるため、稜線の形による自動合わせで補正します。');
  } else notes.push('撮影方位がないため、現在のパノラマ中心の方位を初期値にしました。');
  state.photo = {
    img,
    url,
    name: file.name,
    meta,
    cam: { yaw, pitch: 0, roll: 0, focalPx, width: W, height: H },
    auto: 'waiting',
  };
  autoMessage('');
  state.alignTaps = [];

  const m = meta;
  const parts = [
    `<strong>${esc(file.name)}</strong>（${W}×${H}）${m.model ? '・' + esc(m.model) : ''}${m.date ? '・' + m.date.toLocaleString('ja-JP') : ''}`,
    m.lat !== undefined && m.lon !== undefined
      ? `撮影位置: ${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}${m.gpsAlt !== undefined ? `（GPS高度 ${m.gpsAlt.toFixed(1)} m・計算には不使用）` : ''}`
      : '撮影位置: なし（iPhoneでは写真選択時に「オプション」→「位置情報」をオンにするか、「ファイル」から選ぶと残ります）',
    `焦点距離: ${m.focal35 ? `35mm換算 ${m.focal35} mm` : '—'}${m.focal ? `（実 ${m.focal.toFixed(2)} mm）` : ''}・水平画角 ${fmt(hfovDeg({ focalPx, width: W }), 1)}°`,
    `撮影方位: ${m.direction !== undefined ? `${m.direction.toFixed(1)}°（${m.directionRef === 'M' ? '磁北' : '真北'}）` : '—'}`,
    ...notes.map((n) => `※ ${esc(n)}`),
  ];
  $('photo-meta').innerHTML = parts.join('<br>');
  photoView.fit();
  buildCamControls();
  renderAlignPanel();
  renderCamWedge();
  emit('photo');

  if (m.lat !== undefined && m.lon !== undefined) {
    const o = state.observer;
    const far = !o || inverse(o.lat, o.lon, m.lat, m.lon).dist > 10;
    if (far) setObserver(m.lat, m.lon, { pan: true });
    // 撮影地点の稜線がまだ無ければ計算する（計算後に自動合わせが走る）
    if (far || !resultMatchesPhoto()) {
      compute();
      return;
    }
  }
  maybeAutoAlign();
}

// ---------------------------------------------------------------- 自動合わせ
function autoMessage(html: string) {
  $('auto-info').innerHTML = html;
}

/** 稜線の計算結果がこの写真の撮影地点のものか */
function resultMatchesPhoto(): boolean {
  const ph = state.photo;
  const r = state.result;
  if (!ph || !r) return false;
  const { lat, lon } = ph.meta;
  if (lat === undefined || lon === undefined) return true;
  return inverse(r.lat, r.lon, lat, lon).dist <= 10;
}

let autoSeq = 0;
async function maybeAutoAlign(force = false) {
  const ph = state.photo;
  if (!ph || !state.result) return;
  if (!force && ph.auto !== 'waiting') return;
  if (!resultMatchesPhoto()) {
    if (force) autoMessage('撮影地点の稜線を計算してから実行してください。');
    return;
  }
  const r = state.result;
  const seq = ++autoSeq;
  ph.auto = 'running';
  // EXIF の撮影方位は数十〜90°以上ずれることがあるため、常に全方位を探す
  const center = ph.meta.direction ?? ph.cam.yaw;
  autoMessage('自動合わせ中…（全方位を探索）');
  try {
    const res = await runAutoAlign(
      ph.img,
      ph.cam.width,
      ph.cam.focalPx,
      r.bandElev[r.bandElev.length - 1],
      r.azStep,
      center,
      180,
      (d, t) => autoMessage(`自動合わせ中… ${Math.round((d / t) * 100)}%`),
    );
    if (seq !== autoSeq || state.photo !== ph) return;
    ph.auto = 'done';
    const b = res.best;
    const conf = { high: '高', medium: '中', low: '低' }[res.confidence];
    if (!b || res.confidence === 'low') {
      const cands = res.candidates.slice(0, 3);
      autoMessage(
        `自動で決めきれませんでした（信頼度 ${conf}）。候補を試すか、2点合わせを使ってください。` +
          cands
            .map((c, i) => ` <button data-auto-cand="${i}">候補${i + 1}：方位 ${c.yaw.toFixed(1)}°</button>`)
            .join(''),
      );
      document.querySelectorAll<HTMLButtonElement>('[data-auto-cand]').forEach((bt) =>
        bt.addEventListener('click', () => {
          const c = cands[Number(bt.dataset.autoCand)];
          applyAuto(c, conf, res.elapsedMs, `候補${Number(bt.dataset.autoCand) + 1}を適用：`);
          // 他の候補にも切り替えられるよう、ボタンは残す
          $('auto-info').append(
            ...cands.map((cc, i) => {
              const btn = document.createElement('button');
              btn.textContent = `候補${i + 1}：方位 ${cc.yaw.toFixed(1)}°`;
              btn.addEventListener('click', () => applyAuto(cc, conf, res.elapsedMs, `候補${i + 1}を適用：`));
              return btn;
            }),
          );
        }),
      );
      return;
    }
    // 自動合わせ中にユーザーが2点合わせを始めていたら上書きしない
    if (state.alignTaps.some((t) => t.peakId !== undefined)) {
      autoMessage(`自動合わせの候補：方位 ${b.yaw.toFixed(1)}°（2点合わせを優先したため未適用）`);
      return;
    }
    applyAuto(b, conf, res.elapsedMs);
  } catch (e) {
    if (seq !== autoSeq) return;
    ph.auto = 'done';
    autoMessage(`自動合わせに失敗しました: ${esc((e as Error).message)}`);
  }
}

function applyAuto(
  b: { yaw: number; pitch: number; roll: number; focalPx: number },
  conf: string,
  ms: number,
  prefix = '自動合わせ：',
) {
  const ph = state.photo;
  if (!ph) return;
  const exif = ph.meta.direction;
  Object.assign(ph.cam, { yaw: b.yaw, pitch: b.pitch, roll: b.roll, focalPx: b.focalPx });
  const diff = exif !== undefined ? ((b.yaw - exif + 540) % 360) - 180 : NaN;
  autoMessage(
    `${prefix}方位 ${b.yaw.toFixed(1)}°・仰角 ${b.pitch.toFixed(1)}°・傾き ${b.roll.toFixed(1)}°・水平画角 ${hfovDeg(ph.cam).toFixed(1)}°（信頼度 ${conf}・${(ms / 1000).toFixed(1)} 秒）` +
      (Number.isFinite(diff) ? `・EXIF方位との差 ${diff > 0 ? '+' : ''}${diff.toFixed(1)}°` : ''),
  );
  refreshCamControls();
  renderAlignPanel();
  renderCamWedge();
  photoView.request();
}

$('btn-auto').addEventListener('click', () => {
  if (!state.photo) return;
  maybeAutoAlign(true);
});

// カメラ調整コントロール
interface Ctl {
  get(): number;
  set(v: number): void;
  input: HTMLInputElement;
  range: HTMLInputElement;
  digits: number;
}
let ctls: Ctl[] = [];

function buildCamControls() {
  const box = $('cam-controls');
  box.innerHTML = '';
  ctls = [];
  const ph = state.photo;
  if (!ph) return;
  const cam = ph.cam;
  const mk = (name: string, min: number, max: number, steps: number[], digits: number, get: () => number, set: (v: number) => void) => {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<span class="name">${name}</span><input type="range" min="${min}" max="${max}" step="${steps[0]}"><input class="val" type="number" step="${steps[0]}" inputmode="decimal"><div class="btns">${steps
      .flatMap((s) => [-s, s])
      .sort((a, b) => a - b)
      .map((s) => `<button data-d="${s}">${s > 0 ? '+' : '−'}${Math.abs(s)}</button>`)
      .join('')}</div>`;
    const range = row.querySelector<HTMLInputElement>('input[type=range]')!;
    const input = row.querySelector<HTMLInputElement>('input.val')!;
    const apply = (v: number) => {
      set(v);
      refreshCamControls();
      renderAlignPanel();
      renderCamWedge();
      photoView.request();
    };
    range.addEventListener('input', () => apply(parseFloat(range.value)));
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) apply(v);
    });
    row.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => apply(get() + Number(b.dataset.d))),
    );
    box.appendChild(row);
    ctls.push({ get, set, input, range, digits });
  };
  mk('方位 [°]', 0, 360, [0.05, 0.5, 5], 2, () => cam.yaw, (v) => (cam.yaw = ((v % 360) + 360) % 360));
  mk('仰角 [°]', -30, 30, [0.02, 0.2, 2], 2, () => cam.pitch, (v) => (cam.pitch = v));
  mk('傾き [°]', -30, 30, [0.05, 0.5], 2, () => cam.roll, (v) => (cam.roll = v));
  mk('水平画角 [°]', 1, 120, [0.05, 0.5, 5], 2, () => hfovDeg(cam), (v) => (cam.focalPx = focalPxFromHfov(Math.min(170, Math.max(0.5, v)), cam.width)));
  refreshCamControls();
}

function refreshCamControls() {
  for (const c of ctls) {
    const v = c.get();
    c.range.value = String(v);
    if (document.activeElement !== c.input) c.input.value = v.toFixed(c.digits);
  }
}

// モード切替
document.querySelectorAll<HTMLButtonElement>('#seg-mode button').forEach((b) =>
  b.addEventListener('click', () => {
    photoView.mode = b.dataset.mode as PhotoMode;
    document.querySelectorAll('#seg-mode button').forEach((x) => x.classList.toggle('active', x === b));
    $('align-panel').classList.toggle('hidden', photoView.mode !== 'align');
    renderAlignPanel();
  }),
);
($('in-opacity') as HTMLInputElement).addEventListener('input', (e) => {
  photoView.opacity = parseFloat((e.target as HTMLInputElement).value);
  photoView.request();
});
($('chk-bands') as HTMLInputElement).addEventListener('change', (e) => {
  photoView.showBands = (e.target as HTMLInputElement).checked;
  photoView.request();
});
($('chk-labels') as HTMLInputElement).addEventListener('change', (e) => {
  photoView.showLabels = (e.target as HTMLInputElement).checked;
  photoView.request();
});
$('btn-fit').addEventListener('click', () => photoView.fit());

// 2点合わせ
function peakDir(id: number) {
  const r = state.peakResults.get(id);
  return r ? dirFromAzEl(r.az, r.elev) : null;
}

function choosePeak(index: number) {
  const ph = state.photo;
  const tap = state.alignTaps[index];
  if (!ph || !tap) return;
  if (!state.result) {
    openSheet('山頂を選択', '<p>先に稜線を計算してください。</p>');
    return;
  }
  const b = basis(ph.cam.yaw, ph.cam.pitch, ph.cam.roll);
  const list = visiblePeaks()
    .map(({ peak, res }) => {
      const p = project(ph.cam, b, dirFromAzEl(res.az, res.elev));
      const dpx = p ? Math.hypot(p[0] - tap.px, p[1] - tap.py) : Infinity;
      return { peak, res, dpx };
    })
    .sort((a, b2) => a.dpx - b2.dpx || a.res.az - b2.res.az);
  const html = `<p class="small">点${index + 1}に対応する山頂を選んでください（現在の重ね合わせで近い順）。</p>
    <input type="text" id="peak-filter" placeholder="山名で絞り込み">
    <div class="peak-list">${list
      .map(
        ({ peak, res, dpx }) =>
          `<button data-pick="${res.id}" data-name="${esc(peak.name ?? '')}">${peak.name ? '▲' : '・'} ${esc(peakLabel(peak))}　${Math.round(res.hUsed)} m・${(res.dist / 1000).toFixed(1)} km・方位 ${res.az.toFixed(1)}°${Number.isFinite(dpx) ? `・${Math.round(dpx)} px` : ''}${res.status === PeakStatus.Marginal ? '（ぎりぎり）' : ''}</button>`,
      )
      .join('')}</div>`;
  openSheet(`点${index + 1}の山頂`, html);
  const filter = document.getElementById('peak-filter') as HTMLInputElement;
  filter.addEventListener('input', () => {
    const q = filter.value.trim();
    document.querySelectorAll<HTMLButtonElement>('.peak-list button').forEach((bt) => {
      bt.style.display = !q || (bt.dataset.name ?? '').includes(q) ? '' : 'none';
    });
  });
  document.querySelectorAll<HTMLButtonElement>('.peak-list button').forEach((bt) =>
    bt.addEventListener('click', () => {
      tap.peakId = Number(bt.dataset.pick);
      closeSheet();
      tryAlign();
    }),
  );
}

let alignMessage = '';
function tryAlign() {
  const ph = state.photo;
  const [a, b] = state.alignTaps;
  alignMessage = '';
  if (ph && a?.peakId !== undefined && b?.peakId === undefined) {
    // 1点目だけ選んだ段階：方位・仰角だけを合わせ、2点目の候補が正しい順に並ぶようにする
    const da = peakDir(a.peakId);
    if (da) {
      Object.assign(ph.cam, align1pt(ph.cam, a.px, a.py, da));
      alignMessage = `1点目で方位・仰角を合わせました（方位 ${ph.cam.yaw.toFixed(2)}°・仰角 ${ph.cam.pitch.toFixed(2)}°）。2点目をタップすると傾きと画角も合わせます。`;
      refreshCamControls();
      renderCamWedge();
    }
  }
  if (ph && a?.peakId !== undefined && b?.peakId !== undefined) {
    const da = peakDir(a.peakId);
    const db = peakDir(b.peakId);
    if (da && db) {
      const r = align2pt({ px: a.px, py: a.py, dir: da }, { px: b.px, py: b.py, dir: db }, ph.cam.width, ph.cam.height);
      if (r.ok) {
        Object.assign(ph.cam, { yaw: r.yaw, pitch: r.pitch, roll: r.roll, focalPx: r.focalPx });
        alignMessage = `2点合わせ完了：方位 ${r.yaw.toFixed(2)}°・仰角 ${r.pitch.toFixed(2)}°・傾き ${r.roll.toFixed(2)}°・水平画角 ${hfovDeg(ph.cam).toFixed(2)}°`;
        refreshCamControls();
        renderCamWedge();
      } else alignMessage = `合わせられません：${r.reason}`;
    }
  }
  renderAlignPanel();
  photoView.request();
}

function renderAlignPanel() {
  const box = $('align-panel');
  const ph = state.photo;
  if (!ph) {
    box.innerHTML = '写真を選択してください。';
    return;
  }
  const b = basis(ph.cam.yaw, ph.cam.pitch, ph.cam.roll);
  const rows = state.alignTaps
    .map((t: AlignTap, i) => {
      const peak = t.peakId !== undefined ? state.peaks.get(t.peakId) : undefined;
      const dir = t.peakId !== undefined ? peakDir(t.peakId) : null;
      let res = '';
      if (dir) {
        const r = residual(project(ph.cam, b, dir), [t.px, t.py], dir, unproject(ph.cam, b, t.px, t.py));
        res = `${fmt(r.px, 1)} px / ${fmt(r.deg, 3)}°`;
      }
      return `<tr><td>${i + 1}${i < 2 ? '（基準）' : '（検証）'}</td><td>${peak ? esc(peakLabel(peak)) : '未選択'}</td><td>${res}</td>
        <td><button data-repick="${i}">選択</button> <button data-del="${i}">削除</button></td></tr>`;
    })
    .join('');
  box.innerHTML = `写真上の既知の山頂をタップし、対応する山を選びます。1・2点目で向きと倍率を合わせ、3点目以降は合わせに使わず残差（ズレ）を表示します。
    ${alignMessage ? `<br><strong>${esc(alignMessage)}</strong>` : ''}
    ${rows ? `<table class="t"><tr><th>点</th><th>山頂</th><th>残差</th><th></th></tr>${rows}</table>` : ''}
    <div class="row"><button id="btn-align-reset">リセット</button></div>`;
  box.querySelector('#btn-align-reset')?.addEventListener('click', () => {
    state.alignTaps = [];
    alignMessage = '';
    renderAlignPanel();
    photoView.request();
  });
  box.querySelectorAll<HTMLButtonElement>('[data-repick]').forEach((bt) =>
    bt.addEventListener('click', () => choosePeak(Number(bt.dataset.repick))),
  );
  box.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((bt) =>
    bt.addEventListener('click', () => {
      state.alignTaps.splice(Number(bt.dataset.del), 1);
      tryAlign();
    }),
  );
}

/** 地図上に写真の画角を描く */
function renderCamWedge() {
  camLayer.clearLayers();
  const ph = state.photo;
  const o = state.observer;
  if (!ph || !o) return;
  const half = hfovDeg(ph.cam) / 2;
  if (!Number.isFinite(half) || !Number.isFinite(ph.cam.yaw)) return;
  const L1 = 15_000;
  const pts: [number, number][] = [[o.lat, o.lon]];
  for (let a = -half; a <= half + 1e-9; a += half / 8) {
    const p = direct(o.lat, o.lon, ph.cam.yaw + a, L1);
    pts.push([p.lat, p.lon]);
  }
  L.polygon(pts, { color: '#0a6cff', weight: 1, fillOpacity: 0.12 }).addTo(camLayer);
}

// ---------------------------------------------------------------- 設定
function renderSettings() {
  const s = state.settings;
  const zoomOpts = (t: DemTier) =>
    [
      ['dem5a:15', 'DEM5A z15（→z14）'],
      ['dem10b:14', 'z14（DEM10B）'],
      ['dem10b:13', 'z13'],
      ['dem10b:12', 'z12'],
      ['dem10b:11', 'z11'],
      ['dem10b:10', 'z10'],
    ]
      .map(([v, l]) => `<option value="${v}" ${v === `${t.source}:${t.zoom}` ? 'selected' : ''}>${l}</option>`)
      .join('');
  $('settings-form').innerHTML = `
    <div class="settings-group"><h3>観測・補正</h3>
      <div class="row"><label>目の高さ [m]<input type="number" id="s-eye" step="0.1" value="${s.eyeHeight}"></label>
      <label>大気差係数 k<input type="number" id="s-k" step="0.01" value="${s.refractionK}"></label></div>
      <div class="row"><label>地球半径 R [km]<input type="number" id="s-r" step="1" value="${s.earthRadius / 1000}"></label>
      <label>方位刻み [°]<input type="number" id="s-az" step="0.05" min="0.05" value="${s.azStep}"></label></div>
      <div class="row"><label>最大距離 [km]<input type="number" id="s-max" step="1" value="${s.maxDist / 1000}"></label>
      <label>最小距離 [m]<input type="number" id="s-min" step="1" value="${s.minDist}"></label></div>
      <p class="small">見かけの低下量 = d²/(2R)×(1−k)</p>
    </div>
    <div class="settings-group"><h3>距離帯と標高タイル</h3>
      ${s.tiers
        .map(
          (t, i) => `<div class="row"><label>〜 [km]<input type="number" data-tier-d="${i}" step="0.5" value="${t.maxDist / 1000}"></label>
          <label>タイル<select data-tier-z="${i}">${zoomOpts(t)}</select></label></div>`,
        )
        .join('')}
      <p class="small">DEM5A は z15 のみ。無効値・未整備の場所は z14（DEM10B）にフォールバックします。</p>
    </div>
    <div class="settings-group"><h3>手前の尾根（多層稜線）</h3>
      <label>距離帯の境界 [km]（カンマ区切り）<input type="text" id="s-bands" value="${s.bands.map((b) => b / 1000).join(', ')}"></label>
    </div>
    <div class="settings-group"><h3>山頂</h3>
      <label class="check"><input type="checkbox" id="s-unnamed" ${s.showUnnamedPeaks ? 'checked' : ''}> 名前のない山頂も表示（小さな点）</label>
      <div class="row"><label>見通し判定の許容値 [°]<input type="number" id="s-tol" step="0.005" value="${s.visibilityTolDeg}"></label>
      <label>山頂位置に使う標高<select id="s-hsrc">
        <option value="osm" ${s.peakHeightSource === 'osm' ? 'selected' : ''}>OSMのele優先</option>
        <option value="dem" ${s.peakHeightSource === 'dem' ? 'selected' : ''}>DEM</option></select></label></div>
    </div>
    <div class="row"><button id="s-save" class="primary">保存して再計算</button><button id="s-reset">初期値に戻す</button></div>
    <div class="settings-group"><h3>キャッシュ</h3>
      <p class="small" id="s-usage"></p>
      <div class="row"><button id="s-clear-dem">標高タイルのキャッシュを削除</button><button id="s-clear-peaks">山頂データのキャッシュを削除</button></div>
    </div>`;

  ($('s-unnamed') as HTMLInputElement).addEventListener('change', (e) => {
    state.settings.showUnnamedPeaks = (e.target as HTMLInputElement).checked;
    saveSettings(state.settings);
    emit('settings');
  });
  $('s-save').addEventListener('click', () => {
    const num = (id: string) => parseFloat(($(id) as HTMLInputElement).value);
    const n = structuredClone(state.settings);
    n.eyeHeight = num('s-eye');
    n.refractionK = num('s-k');
    n.earthRadius = num('s-r') * 1000;
    n.azStep = Math.max(0.05, num('s-az'));
    n.maxDist = num('s-max') * 1000;
    n.minDist = Math.max(1, num('s-min'));
    n.visibilityTolDeg = num('s-tol');
    n.peakHeightSource = ($('s-hsrc') as HTMLSelectElement).value as 'osm' | 'dem';
    n.tiers = s.tiers.map((_, i) => {
      const d = parseFloat((document.querySelector(`[data-tier-d="${i}"]`) as HTMLInputElement).value) * 1000;
      const [src, z] = (document.querySelector(`[data-tier-z="${i}"]`) as HTMLSelectElement).value.split(':');
      return { maxDist: d, zoom: Number(z), source: src as DemTier['source'] };
    });
    n.bands = ($('s-bands') as HTMLInputElement).value
      .split(/[,\s、]+/)
      .map((v) => parseFloat(v) * 1000)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const bad = [n.eyeHeight, n.refractionK, n.earthRadius, n.maxDist, n.visibilityTolDeg].some((v) => !Number.isFinite(v));
    if (bad || n.bands.length === 0 || n.tiers.some((t) => !(t.maxDist > 0))) return alert('入力値を確認してください');
    state.settings = n;
    saveSettings(n);
    eyeInput.value = String(n.eyeHeight);
    renderSettings();
    renderGround();
    if (state.observer) compute();
  });
  $('s-reset').addEventListener('click', () => {
    state.settings = structuredClone(DEFAULT_SETTINGS);
    saveSettings(state.settings);
    eyeInput.value = String(state.settings.eyeHeight);
    renderSettings();
    emit('settings');
  });
  $('s-clear-dem').addEventListener('click', async () => {
    if (typeof caches !== 'undefined') await caches.delete('gsi-dem-v1');
    updateUsage();
  });
  $('s-clear-peaks').addEventListener('click', async () => {
    await clearPeakCache();
    updateUsage();
  });
  updateUsage();
}

async function updateUsage() {
  const el = document.getElementById('s-usage');
  if (!el) return;
  try {
    const e = await navigator.storage?.estimate?.();
    el.textContent = e ? `使用量 約 ${((e.usage ?? 0) / 1e6).toFixed(1)} MB` : '';
  } catch {
    el.textContent = '';
  }
}

on((what) => {
  if (what === 'settings') renderMapPeaks();
  if (what === 'result') maybeAutoAlign();
});

// ---------------------------------------------------------------- 起動
renderSettings();
renderAlignPanel();
const m = location.hash.match(/ll=(-?[\d.]+),(-?[\d.]+)/);
if (m) setObserver(parseFloat(m[1]), parseFloat(m[2]), { pan: true });

// 開発時のみ：検証用に内部状態を公開
if (import.meta.env.DEV) (window as unknown as { __sanza: unknown }).__sanza = { state };
