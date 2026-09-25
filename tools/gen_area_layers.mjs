// 预处理 objmap-totk ecosystem 多边形数据 → TOTKmap 区域轮廓图层
// 输入：E:\WorkSpace\BOTWroms\objmap-totk\src\public\game_files\ecosystem\*.json
// 输出：data/area_cave.js / area_sky.js / area_depths.js
//
// 处理：
//   1) 坐标翻转 [x,z] → [z,x]（Leaflet latlng=(Z,X)）
//   2) 洞穴多边形用 bbox 中心点最近的 markers.js 洞穴入口点匹配中文名
//   3) MinusField.json 用 Douglas-Peucker 抽稀（容差 1.5）
//
// 用法：node tools/gen_area_layers.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ECO = 'E:/WorkSpace/BOTWroms/objmap-totk/src/public/game_files/ecosystem';

// ---------- 读 markers.js，建洞穴入口坐标索引 ----------
const markersSrc = fs.readFileSync(path.join(ROOT, 'data/markers.js'), 'utf8')
  .replace(/^window\.TOTK_MARKERS\s*=\s*/, '').replace(/;\s*$/, '');
const markers = JSON.parse(markersSrc);

// cat=69 地洞入口, 70 洞穴入口, 82 井
const cavePoints = markers.filter(m => m.cat === 69 || m.cat === 70 || m.cat === 82)
  .map(m => ({ x: m.x, y: m.y, name: m.name, cat: m.cat }));
console.log(`markers: ${markers.length}, cave points: ${cavePoints.length}`);

function nearestCaveName(x, z) {
  let best = null, bestD = Infinity;
  for (const p of cavePoints) {
    const dx = p.x - x, dz = p.y - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return { name: best && Math.sqrt(bestD) < 600 ? best.name : null, dist: best ? Math.sqrt(bestD) : Infinity };
}

// 坐标匹配未命中的特殊地点手动中文名（TOTK 官方简体译名）
const MANUAL_NAME = {
  'Deepback Bay Cave': '深邃海湾的洞窟',
  'Dronocs Pass Well': '德罗诺库斯关口的井',
  'Eventide Island Cave': '日落岛的洞窟',
  'Gerudo Great Skeleton': '格鲁德大化石',
  'Gerudo Sanctuary': '格鲁德圣地',
  'Icefall Foothills Cave': '冰瀑山麓的洞窟',
  'Lake Kilsie Cave': '基尔西湖的洞窟',
  'Mapla Point Cave': '马普拉海岬的洞窟',
  'Meadelas Mantle Cave': '梅德拉地幔的洞窟',
  'North Akkala Beach Cave': '北阿卡莱海滨的洞窟',
  'North Biron Snowshelf Cave': '北拜朗雪架的洞窟',
  'Ploymus Mountain Cave': '波里莫斯山的洞窟',
  'Pristine Sanctum': '纯净圣所',
  'Reservoir Lakefront Cave': '储水湖畔的洞窟',
  'Statue of the Eighth Heroine Cave': '第八位英雄雕像的洞窟',
  'Sturnida Springs Cave': '斯图尔尼达温泉的洞窟',
  'Tamio River Downstream Cave': '塔米奥河下游的洞窟',
  'Tarm Point Cave': '塔姆海岬的洞窟',
  'Toto Lake': '托托湖',
  'Ulria Grotto East Cave': '乌尔里亚洞窟东洞',
  'Ulria Grotto South Cave': '乌尔里亚洞窟南洞',
  'Valley of Silent Statues': '寂静雕像之谷',
  'West Gerudo Underground Ruins': '西格鲁德地下遗迹',
  'West Lake Totori Cave': '托托里西湖的洞窟',
};

// ---------- Douglas-Peucker ----------
function dp(points, tol) {
  if (points.length < 3) return points;
  const sq = tol * tol;
  // 递归
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0, idx = -1;
    const a = points[first], b = points[last];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz || 1e-9;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      // 点到线段距离平方
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq;
      let px, pz;
      if (t < 0) { px = a[0]; pz = a[1]; }
      else if (t > 1) { px = b[0]; pz = b[1]; }
      else { px = a[0] + t * dx; pz = a[1] + t * dz; }
      const ex = p[0] - px, ez = p[1] - pz;
      const ds = ex * ex + ez * ez;
      if (ds > maxSq) { maxSq = ds; idx = i; }
    }
    if (maxSq > sq) {
      keep[idx] = true;
      stack.push([first, idx], [idx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  // 保证闭合（首尾相同）
  if (out.length > 1 && (out[0][0] !== out[out.length-1][0] || out[0][1] !== out[out.length-1][1])) {
    out.push(out[0].slice());
  }
  return out;
}

// 坐标翻转：[x,z] → [z,x]
function flipRing(ring) {
  return ring.map(([x, z]) => [+z.toFixed(1), +x.toFixed(1)]);
}

// ---------- 1) cave_polys_detail → area_cave.js（地表层） ----------
{
  const geo = JSON.parse(fs.readFileSync(path.join(ECO, 'cave_polys_detail.json'), 'utf8'));
  const out = [];
  let matched = 0, unmatched = 0;
  const unmatchedNames = new Set();
  for (const f of geo.features) {
    // 自己从 geometry 算 bbox 中心点（detail 版没有预置 xmin/xmax）
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const ring of f.geometry.coordinates) {
      for (const [x, z] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const { name, dist } = nearestCaveName(cx, cz);
    const baseEn = f.properties.Area.replace(/[\s\-]?\d+\.?\d*.*$/, '').trim();
    const cn = name || MANUAL_NAME[baseEn];
    if (cn) matched++; else { unmatched++; unmatchedNames.add(f.properties.Area); }
    const rings = f.geometry.coordinates.map(ring => flipRing(dp(ring, 1.0)));
    out.push({ name: cn || f.properties.Area, rings, en: f.properties.Area });
  }
  fs.writeFileSync(path.join(ROOT, 'data/area_cave.js'),
    `// 洞穴地表轮廓（来自 objmap-totk cave_polys_detail.json）\n` +
    `// 坐标已翻转 [z,x]，已抽稀（容差1.0），中文名为坐标匹配 markers.js 洞穴入口点\n` +
    `window.TOTK_AREA_CAVE=${JSON.stringify(out)};\n`, 'utf8');
  console.log(`area_cave: ${out.length} polys, matched ${matched}, unmatched ${unmatched}`);
  if (unmatchedNames.size) console.log('  unmatched samples:', [...unmatchedNames].slice(0, 10));
}

// ---------- 2) sky_polys → area_sky.js（天空层） ----------
{
  const geo = JSON.parse(fs.readFileSync(path.join(ECO, 'sky_polys.json'), 'utf8'));
  const out = [];
  for (const f of geo.features) {
    const rings = f.geometry.coordinates.map(ring => flipRing(dp(ring, 1.5)));
    out.push({ group: f.properties.group, rings });
  }
  fs.writeFileSync(path.join(ROOT, 'data/area_sky.js'),
    `// 空岛分区轮廓（来自 objmap-totk sky_polys.json）\n` +
    `// 坐标已翻转 [z,x]，已抽稀（容差1.5）\n` +
    `window.TOTK_AREA_SKY=${JSON.stringify(out)};\n`, 'utf8');
  console.log(`area_sky: ${out.length} polys`);
}

// ---------- 3) MinusField.json → area_depths.js（地底层） ----------
{
  const raw = JSON.parse(fs.readFileSync(path.join(ECO, 'MinusField.json'), 'utf8'));
  const out = [];
  for (const f of raw.features) {
    // MultiPolygon: coordinates = [ [ring, ring, ...], [ring, ...], ... ]
    const polys = f.geometry.coordinates.map(poly =>
      poly.map(ring => flipRing(dp(ring, 2.0)))
    );
    out.push({ area: f.properties.Area, polys });
  }
  fs.writeFileSync(path.join(ROOT, 'data/area_depths.js'),
    `// 地底可走地面轮廓（来自 objmap-totk MinusField.json）\n` +
    `// 坐标已翻转 [z,x]，已抽稀（容差2.0）\n` +
    `window.TOTK_AREA_DEPTHS=${JSON.stringify(out)};\n`, 'utf8');
  console.log(`area_depths: ${out.length} multi-polys`);
}

console.log('done.');
