#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
天空岛材料提取器 v1
只扫 Banc/MainField/Sky/*.bcett.byml.zs（天空岛的专属摆放目录）
复用现有 materials.js 的 中文名/类别 映射，按 encyclopedia entry 聚合坐标与数量。
"""
import sys, os, json, csv
sys.path.insert(0, r'D:\dev\pylibs')
import zstandard as zstd
import byml

ROM = r'G:\YUZU\Switch Games\TOTKroms'
SKY_DIR = os.path.join(ROM, 'Banc', 'MainField', 'Sky')
MATS_JS = r'E:\WorkSpace\TOTKmap\data\materials.js'
OUT_JSON = r'E:\WorkSpace\TOTKmap\data\materials_sky.json'
OUT_CSV = r'E:\WorkSpace\TOTKmap\data\materials_sky.csv'
OUT_MD = r'E:\WorkSpace\TOTKmap\data\materials_sky_报告.md'

# ── 解压字典（与 build_materials_data.py 完全一致）──
_d = open(os.path.join(ROM, 'Pack', 'ZsDic.pack.zs'), 'rb').read()
_raw = zstd.ZstdDecompressor().decompress(_d, max_output_size=64 * 1024 * 1024)
BCETT_DIC = _raw[0x20088:0x20088 + 0x20000]
_dec = zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(BCETT_DIC))

# ── actor 全量中文名（Doubao 提取的 MSBT）──
ZH_JSON = r'C:\Users\Administrator\Doubao\chats\2026-09-25\new-chat-1\zh_actor_msgs.json'
try:
    ZH = json.load(open(ZH_JSON, encoding='utf-8'))
except Exception:
    ZH = {}

MANUAL_ZH = {
    'Obj_MineralGrain_A_01': '散落的岩盐', 'Obj_MineralGrain_A_02': '散落的打火石',
    'Obj_MineralGrain_A_03': '散落的琥珀', 'Obj_MineralGrain_A_04': '散落的蛋白石',
    'Obj_MineralGrain_A_05': '散落的黄玉', 'Obj_MineralBury_A_01': '埋藏的矿床',
    'Obj_Mineral_B_02': '稀有矿床',
    'Item_PlantGet_B': '生命小萝卜', 'Item_PlantGet_C': '生命大萝卜',
    'Item_MushroomGet_O': '毅力蘑菇', 'Item_FishGet_B': '生命鲈鱼',
}

# ── 现有 materials.js 的中文名/类别 映射 + 现有 layer 分布 ──
def load_existing():
    txt = open(MATS_JS, encoding='utf-8').read().strip()
    if txt.startswith('var '):
        txt = txt[txt.index('=') + 1:].rstrip().rstrip(';')
    data = json.loads(txt)
    m = {it['entry']: (it.get('cn'), it.get('cat')) for it in data['materials']}
    # 现有 points 里 layer=20（天空）的数量
    sky_in_old = sum(1 for i in range(3, len(data['points']), 4) if data['points'][i] == 20)
    return m, sky_in_old, data['meta']
EXIST, SKY_IN_OLD, OLD_META = load_existing()

# ── 与 build 脚本一致的归类/归一化 ──
def normalize_entry(g):
    if g.startswith('Item_PlantGet_'): return g
    if g.startswith('Item_Plant_'): return 'Item_PlantGet_' + g[len('Item_Plant_'):]
    if g.startswith('Item_MushroomGet_'): return g
    if g.startswith('Item_Mushroom_'): return 'Item_MushroomGet_' + g[len('Item_Mushroom_'):]
    if g.startswith('Item_FishGet_'): return g
    if g.startswith('Animal_Fish_'): return 'Item_FishGet_' + g[len('Animal_Fish_'):]
    if g == 'Animal_Insect_EP': return 'Animal_Insect_E'
    if g == 'ConfusionFruit_Static': return 'ConfusionFruit'
    return g

def categorize(g):
    if g.startswith('Item_Plant'): return '植物'
    if g.startswith('Item_Mushroom'): return '蘑菇'
    if g.startswith('Item_Fruit'): return '水果'
    if g in ('BombFruit', 'FireFruit', 'IceFruit', 'ElectricalFruit', 'WaterFruit',
             'LightFruit', 'ConfusionFruit_Static', 'ConfusionFruit'): return '水果'
    if g.startswith('Animal_Insect'): return '昆虫'
    if g.startswith('Animal_Fish') or g.startswith('Item_FishGet'): return '鱼'
    if g.startswith('Obj_Mineral') or g.startswith('Obj_MineRock'): return '矿岩'
    if g.startswith('Item_Ore'): return '矿岩'
    return None

def is_material(g):
    if not isinstance(g, str): return False
    if any(k in g for k in ('OwnedByNpc', 'Temporary', 'GoronDisplay', 'Kakariko')): return False
    return categorize(g) is not None

def cn_for(entry):
    if entry in EXIST: return EXIST[entry][0]
    if entry in MANUAL_ZH: return MANUAL_ZH[entry]
    # 尝试 MSBT label（与 build 脚本同规则）
    for lbl in [entry + '_Name', (entry.replace('Get_', '_') + '_Name') if 'Get_' in entry else entry + '_Name']:
        if lbl in ZH: return ZH[lbl]
    return entry

# ── 扫描天空岛目录 ──
result = {}
files = sorted(f for f in os.listdir(SKY_DIR) if f.endswith('.bcett.byml.zs'))
total_actors = mat_actors = 0
for fn in files:
    try:
        raw = _dec.decompress(open(os.path.join(SKY_DIR, fn), 'rb').read(),
                              max_output_size=256 * 1024 * 1024)
        root = byml.Byml(raw).parse()
    except Exception as e:
        print('FAIL', fn, e); continue
    actors = root.get('Actors') if isinstance(root, dict) else None
    if not actors: continue
    for a in actors:
        total_actors += 1
        g = a.get('Gyaml') if isinstance(a, dict) else None
        if not is_material(g): continue
        tr = a.get('Translate')
        if not tr or len(tr) < 3: continue
        x, y, z = float(tr[0]), float(tr[1]), float(tr[2])
        mat_actors += 1
        entry = normalize_entry(g)
        result.setdefault(entry, {'cn': cn_for(entry), 'cat': categorize(entry) or '?', 'points': []})
        result[entry]['points'].append((round(x, 1), round(y, 1), round(z, 1)))

# 去重 + 排序
mats = []
for entry, info in sorted(result.items(), key=lambda kv: (-len(kv[1]['points']), kv[1]['cat'])):
    seen, uniq = set(), []
    for p in info['points']:
        if p in seen: continue
        seen.add(p); uniq.append(p)
    mats.append({'entry': entry, 'cn': info['cn'], 'cat': info['cat'],
                 'count': len(uniq), 'points': uniq})

# ── 输出 JSON ──
out = {'meta': {
    'source': 'Banc/MainField/Sky bcett (天空岛专属摆放目录)',
    'files_scanned': len(files), 'total_actors': total_actors,
    'material_actors': mat_actors, 'sky_material_kinds': len(mats),
    'total_spawn_points': sum(m['count'] for m in mats),
    'old_materials_js_sky_layer_points': SKY_IN_OLD,
}, 'materials': mats}
json.dump(out, open(OUT_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ── 输出 CSV ──
with open(OUT_CSV, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['类别', '中文名', 'entry', '数量', '坐标(x,y,z)'])
    for m in mats:
        coords = ' | '.join(f'({p[0]},{p[1]},{p[2]})' for p in m['points'])
        w.writerow([m['cat'], m['cn'], m['entry'], m['count'], coords])

# ── 输出 Markdown 报告 ──
cat_order = ['植物', '蘑菇', '水果', '昆虫', '鱼', '矿岩']
lines = ['# 天空岛材料清单（Banc/MainField/Sky）', '',
         f'- 扫描文件数：{len(files)}，物体总数：{total_actors}，材料物体：{mat_actors}',
         f'- 天空岛材料种类：{len(mats)}，刷点总数：{sum(m["count"] for m in mats)}',
         f'- 现有 materials.js 中 layer=20(天空) 残留点：{SKY_IN_OLD}（说明原脚本未扫 Sky 目录）',
         '', '## 按类别汇总', '']
for c in cat_order:
    sub = [m for m in mats if m['cat'] == c]
    if not sub: continue
    lines.append(f'### {c}（{len(sub)} 种）')
    for m in sub:
        lines.append(f'- **{m["cn"]}** `{m["entry"]}` — {m["count"]} 点')
    lines.append('')
lines.append('## 逐点坐标')
for m in mats:
    lines.append(f'### {m["cn"]} `{m["entry"]}`（{m["cat"]}，{m["count"]} 点）')
    for p in m['points']:
        lines.append(f'- ({p[0]}, {p[1]}, {p[2]})')
    lines.append('')
open(OUT_MD, 'w', encoding='utf-8').write('\n'.join(lines))

# ── 控制台摘要 ──
print('sky files:', len(files), '| total actors:', total_actors, '| material actors:', mat_actors)
print('sky material KINDS:', len(mats), '| total spawn points:', sum(m['count'] for m in mats))
print('existing materials.js layer20(sky) points:', SKY_IN_OLD)
print('--- 清单 ---')
for m in mats:
    print(f"  [{m['cat']}] {m['cn']} ({m['entry']}) x{m['count']}")
print('written:', OUT_JSON, OUT_CSV, OUT_MD)
