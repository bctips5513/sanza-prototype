// 有名な山の一覧（日本百名山・二百名山・三百名山・信州百名山）を作って src/peaks/famous.json に書き出す。
//   node scripts/build-famous-peaks.mjs
//
// 出典：
//   日本百名山        … Wikidata（日本百名山の一部 P361 = Q1156761）の名前・座標
//   二百名山・三百名山 … ja.wikipedia「日本二百名山」「日本三百名山」の一覧（百名山を除く分）の座標・標高
//   信州百名山        … ja.wikipedia「信州百名山」の一覧の座標・標高
// 一覧の座標の近く（3km 以内）にある OSM の山頂（natural=peak/volcano）と名前で照合し、照合できた山は OSM の id を持たせる。
// 山域の名前で載っている山（八ヶ岳・白山など）は主峰（MAIN_PEAK）で照合する。
// アプリは取得した OSM の山頂にこの id で印を付け、照合できなかった山は一覧の座標で山頂を足す。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const UA = 'sanza-prototype/0.1 (personal research; famous peak list)';
const OUT = join(import.meta.dirname, '../src/peaks/famous.json');
const LIST = { hyaku: 1, nihyaku: 2, sanbyaku: 4, shinshu: 8 };

async function get(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${u}`);
  return res.json();
}

async function wikitext(page) {
  const j = await get('https://ja.wikipedia.org/w/api.php', { action: 'parse', page, prop: 'wikitext', format: 'json', formatversion: '2' });
  return j.parse.wikitext;
}

/** 「{{Module|山岳一覧|」の行：名前/よみ[/記事名],経度/緯度,画像,標高,都道府県 */
function parseModuleList(text) {
  const start = text.indexOf('{{Module|山岳一覧|');
  const end = text.indexOf('\n}}', start);
  const out = [];
  for (const line of text.slice(start, end).split('\n')) {
    if (!line.startsWith('\t')) continue;
    const f = line.trim().split(',');
    const [lon, lat] = f[1].split('/').map(Number);
    out.push({ name: f[0].split('/')[0], lat, lon, ele: Number(f[f.length - 2]) });
  }
  return out;
}

/** 信州百名山の {{mtlist_number ...}} */
function parseMtlist(text) {
  const out = [];
  for (const block of text.split('{{mtlist_number\n').slice(1)) {
    const field = (k) => block.match(new RegExp(`\\|${k}=([^|\\n]*)`))?.[1]?.trim();
    // 山名は [[記事名|表示名]] の形があるので、行末まで取る
    const t = block.match(/^\s*\|t=(.*)$/m)?.[1]?.trim() ?? '';
    const name = t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
    const lat = Number(field('lat'));
    const lon = Number(field('lon'));
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ name, lat, lon, ele: Number(field('h')) });
  }
  return out;
}

async function hyakumeizan() {
  const q = `SELECT ?m ?name ?coord ?ele WHERE { ?m wdt:P361 wd:Q1156761 . ?m rdfs:label ?name FILTER(LANG(?name)="ja") ?m wdt:P625 ?coord . OPTIONAL { ?m wdt:P2044 ?ele } }`;
  const j = await get('https://query.wikidata.org/sparql', { query: q, format: 'json' });
  const byItem = new Map();
  for (const b of j.results.bindings) {
    const id = b.m.value;
    if (byItem.has(id)) continue;
    const [lon, lat] = b.coord.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number);
    byItem.set(id, { name: b.name.value.replace(/\s*\(.*\)$/, ''), lat, lon, ele: b.ele ? Math.round(Number(b.ele.value)) : NaN });
  }
  return [...byItem.values()];
}

const norm = (s) =>
  (s ?? '')
    .replace(/\s*[（(].*[)）]$/, '')
    .replace(/[ヶケケが]/g, 'ケ')
    .replace(/[ノの之]/g, 'ノ')
    .replace(/ッ/g, 'ツ')
    .replace(/\s/g, '');

function distM(a, b) {
  const R = 6371000;
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.hypot(x, y) * R;
}

/** 一覧の山の近くにある名前のある山頂を取る（25 山ずつ。結果は .cache に保存して使い回す） */
async function nearbyPeaks(entries) {
  const file = join(import.meta.dirname, '../.cache/osm-peaks-famous.json');
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  const radiusOf = (e) => (MAIN_PEAK[e.name] ? 10000 : 3000);
  const keyOf = (e) => `${e.name}@${e.lat.toFixed(3)},${e.lon.toFixed(3)}@${radiusOf(e)}`;
  const todo = entries.filter((e) => !cache[keyOf(e)]);
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const parts = batch.map((e) => `node(around:${radiusOf(e)},${e.lat},${e.lon})["natural"~"^(peak|volcano)$"]["name"];`).join('');
    const body = new URLSearchParams({ data: `[out:json][timeout:180];(${parts});out body;` });
    let els;
    for (let attempt = 0; !els; attempt++) {
      if (attempt >= 8) throw new Error('overpass に接続できません');
      const url = urls[attempt % urls.length];
      try {
        const res = await fetch(url, { method: 'POST', body, headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(200_000) });
        if (!res.ok) throw new Error(String(res.status));
        els = (await res.json()).elements.map((e) => ({ id: e.id, lat: e.lat, lon: e.lon, tags: e.tags }));
      } catch (e) {
        console.warn('overpass', url, e.message);
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    for (const e of batch) cache[keyOf(e)] = els.filter((p) => distM(e, p) <= radiusOf(e) + 100);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
    console.log('OSM', Math.min(todo.length, i + 25), '/', todo.length);
  }
  return [...new Map(entries.flatMap((e) => cache[keyOf(e)]).map((p) => [p.id, p])).values()];
}

/** 山域の名前で載っている山 → 照合に使う主峰の名前（OSM の名前） */
const MAIN_PEAK = {
  蔵王連峰: '熊野岳',
  穂高岳: '奥穂高岳',
  大雪山: '旭岳',
  八甲田山: '大岳',
  白山: '御前峰',
  吾妻山: '西吾妻山',
  天城山: '万三郎岳',
  大台ヶ原山: '日出ヶ岳',
  霧ヶ峰: '車山',
  大峰山: '八経ヶ岳',
  美ヶ原: '王ヶ頭',
  越後駒ヶ岳: '駒ヶ岳',
  九重山: '中岳',
  鳳凰山: '観音岳',
  八ヶ岳: '赤岳',
  谷川岳: 'オキの耳',
  妙義山: '相馬岳',
  箱根山: '神山',
  医王山: '奥医王山',
  高隈山: '大箆柄岳',
  三ッ峠山: '開運山',
  国師岳: '国師ヶ岳',
  阿寒岳: '雌阿寒岳',
  富士見台高原: '富士見台',
  鳳凰山: '観音ヶ岳',
  横岳: '北横岳',
  高社山: '高杜山',
  篭ノ登山: '東篭の塔山',
  烏帽子岳: '烏帽子山',
  白石山: '和名倉山',
};

/** 一覧の座標が粗い山（Wikidata の座標が山域の中心など）は、主峰の近くの座標に置き換えてから照合する */
const COORD_FIX = {
  白山: { lat: 36.155, lon: 136.771 },
  大台ヶ原山: { lat: 34.186, lon: 136.11 },
};

const lists = [
  ['hyaku', await hyakumeizan()],
  ['nihyaku', parseModuleList(await wikitext('日本二百名山'))],
  ['sanbyaku', parseModuleList(await wikitext('日本三百名山'))],
  ['shinshu', parseMtlist(await wikitext('信州百名山'))],
];
for (const [k, l] of lists) console.log(k, l.length);

// 同じ山（名前が同じで 2km 以内）をまとめる
const entries = [];
for (const [k, l] of lists)
  for (const e of l) {
    const same = entries.find((x) => norm(x.name) === norm(e.name) && distM(x, e) < 2000);
    if (same) {
      same.lists |= LIST[k];
      if (!Number.isFinite(same.ele) && Number.isFinite(e.ele)) same.ele = e.ele;
    } else entries.push({ ...e, lists: LIST[k] });
  }
for (const e of entries) Object.assign(e, COORD_FIX[e.name] ?? {});
console.log('合計', entries.length);

const peaks = await nearbyPeaks(entries);
console.log('OSM 山頂', peaks.length);
const names = (p) => [p.tags?.['name:ja'], p.tags?.name, ...(p.tags?.alt_name ?? '').split(';')].filter(Boolean).map(norm);

const out = [];
const unmatched = [];
for (const e of entries) {
  // 名前で照合（一覧の座標から 3 km 以内。山域の名前なら主峰の名前で 10 km 以内）
  let hit = null;
  for (const [want, radius] of [
    [e.name, 3000],
    [MAIN_PEAK[e.name], 10000],
  ]) {
    if (!want) continue;
    const near = peaks.filter((p) => distM(e, p) <= radius);
    hit = near.filter((p) => names(p).includes(norm(want))).sort((a, b) => distM(e, a) - distM(e, b))[0];
    // 「谷川岳 オキノ耳」「塩見岳 東峰」のように峰ごとに分かれている山は、いちばん高い峰
    hit ??= near
      .filter((p) => names(p).some((n) => n.startsWith(norm(want))))
      .sort((a, b) => (parseFloat(b.tags?.ele) || 0) - (parseFloat(a.tags?.ele) || 0))[0];
    if (hit) break;
  }
  if (!hit) unmatched.push(e.name);
  out.push({
    n: e.name.replace(/\s*[（(].*[)）]$/, ''),
    la: +(hit?.lat ?? e.lat).toFixed(6),
    lo: +(hit?.lon ?? e.lon).toFixed(6),
    e: Number.isFinite(e.ele) ? Math.round(e.ele) : null,
    l: e.lists,
    ...(hit ? { o: hit.id } : {}),
  });
}
console.log(`OSM と照合できなかった山 ${unmatched.length}：${unmatched.join('、')}`);
out.sort((a, b) => a.n.localeCompare(b.n, 'ja'));
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log('書き出し', OUT, out.length);
