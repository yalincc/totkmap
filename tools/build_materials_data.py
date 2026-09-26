#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TOTK 材料刷点数据管道 v2（参考 BOTWmap build_materials_data.py）
- 按 encyclopedia entry 分组，Get 后缀 actor 自动合并到主条目
- 输出 materials[] 带 actors[] 数组，points 为 flat [matId, layer, x, z, ...]
"""
import sys, os, json, csv, re
from collections import defaultdict, Counter
sys.path.insert(0, r'D:\dev\pylibs')
import zstandard as zstd
import byml

ROM = r'G:\YUZU\Switch Games\TOTKroms'
OUT_JS = r'E:\WorkSpace\TOTKmap\data\materials.js'
OUT_CSV = r'E:\WorkSpace\TOTKmap\data\materials_stat.csv'
ZH_JSON = r'C:\Users\Administrator\Doubao\chats\2026-09-25\new-chat-1\zh_actor_msgs.json'

_d = open(os.path.join(ROM, 'Pack', 'ZsDic.pack.zs'),'rb').read()
_raw = zstd.ZstdDecompressor().decompress(_d, max_output_size=64*1024*1024)
BCETT_DIC = _raw[0x20088:0x20088+0x20000]
_dec = zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(BCETT_DIC))

zh = json.load(open(ZH_JSON, encoding='utf-8'))

def categorize(g):
    if g.startswith('Item_Plant') or g.startswith('Item_PlantGet'): return '植物'
    if g.startswith('Item_Mushroom') or g.startswith('Item_MushroomGet'): return '蘑菇'
    if g.startswith('Item_Fruit'): return '水果'
    if g in ('BombFruit','FireFruit','IceFruit','ElectricalFruit','WaterFruit',
             'LightFruit','ConfusionFruit_Static','ConfusionFruit'): return '水果'
    if g.startswith('Animal_Insect'): return '昆虫'
    if g.startswith('Animal_Fish') or g.startswith('Item_FishGet'): return '鱼'
    if g.startswith('Obj_Mineral') or g.startswith('Obj_MineRock'): return '矿岩'
    if g.startswith('Item_Ore'): return '矿岩'
    return None

def is_material(g):
    if not isinstance(g, str): return False
    if 'OwnedByNpc' in g or 'Temporary' in g or 'GoronDisplay' in g or 'Kakariko' in g:
        return False
    return categorize(g) is not None

def layer_of(y):
    if y >= 700: return 20
    if y < 0: return 19
    return 18

# ── 核心：actor → encyclopedia entry（MSBT label base）──
# 同 entry 的多个 actor 合并为一个材料条目
def normalize_entry(g):
    """把任意摆放 actor 名映射到 encyclopedia entry（中文名查询键）。"""
    # Plant: Item_Plant_X / Item_PlantGet_X → Item_PlantGet_X
    if g.startswith('Item_PlantGet_'):
        return g  # already entry form
    if g.startswith('Item_Plant_'):
        return 'Item_PlantGet_' + g[len('Item_Plant_'):]
    # Mushroom
    if g.startswith('Item_MushroomGet_'):
        return g
    if g.startswith('Item_Mushroom_'):
        return 'Item_MushroomGet_' + g[len('Item_Mushroom_'):]
    # Fish: Animal_Fish_X / Item_FishGet_X → Item_FishGet_X
    if g.startswith('Item_FishGet_'):
        return g
    if g.startswith('Animal_Fish_'):
        return 'Item_FishGet_' + g[len('Animal_Fish_'):]
    # Insect: Animal_Insect_X → Animal_Insect_X (MSBT 直接用此名)
    # EP 后缀 = 静静萤火虫的放置变体，合并到 E
    if g == 'Animal_Insect_EP':
        return 'Animal_Insect_E'
    # Minerals: 直接用 actor 名作为 entry
    # ConfusionFruit_Static → ConfusionFruit (MSBT label)
    if g == 'ConfusionFruit_Static':
        return 'ConfusionFruit'
    return g

def scan():
    points = defaultdict(list)
    # Surface + depths: MainField root + MinusField
    for field in ['MainField', 'MinusField']:
        d = os.path.join(ROM, 'Banc', field)
        files = sorted(f for f in os.listdir(d) if f.endswith('.bcett.byml.zs'))
        for fn in files:
            try:
                raw = _dec.decompress(open(os.path.join(d, fn),'rb').read(),
                                      max_output_size=256*1024*1024)
                root = byml.Byml(raw).parse()
            except Exception as e:
                print('FAIL', fn, e); continue
            actors = root.get('Actors') if isinstance(root, dict) else None
            if not actors: continue
            for a in actors:
                g = a.get('Gyaml') if isinstance(a, dict) else None
                if not is_material(g): continue
                tr = a.get('Translate')
                if not tr or len(tr) < 3: continue
                x, y, z = float(tr[0]), float(tr[1]), float(tr[2])
                points[g].append((layer_of(y), round(x,1), round(z,1)))
    # Sky islands: MainField/Sky subdirectory — all forced to layer 20
    sky_dir = os.path.join(ROM, 'Banc', 'MainField', 'Sky')
    if os.path.isdir(sky_dir):
        files = sorted(f for f in os.listdir(sky_dir) if f.endswith('.bcett.byml.zs'))
        for fn in files:
            try:
                raw = _dec.decompress(open(os.path.join(sky_dir, fn),'rb').read(),
                                      max_output_size=256*1024*1024)
                root = byml.Byml(raw).parse()
            except Exception as e:
                print('FAIL sky', fn, e); continue
            actors = root.get('Actors') if isinstance(root, dict) else None
            if not actors: continue
            for a in actors:
                g = a.get('Gyaml') if isinstance(a, dict) else None
                if not is_material(g): continue
                tr = a.get('Translate')
                if not tr or len(tr) < 3: continue
                x, y, z = float(tr[0]), float(tr[1]), float(tr[2])
                points[g].append((20, round(x,1), round(z,1)))
    return points

# 手动中文名覆盖（MSBT 无对应或需要修正）
MANUAL_ZH = {
    'Animal_Insect_K': '昆虫群（随机）',
    'Animal_Insect_O': '昆虫群（随机）',
    'Animal_Insect_Z': '昆虫群（随机）',
    'Obj_MineralGrain_A_01': '散落的岩盐',
    'Obj_MineralGrain_A_02': '散落的打火石',
    'Obj_MineralGrain_A_03': '散落的左纳尼乌姆',
    'Obj_MineralGrain_A_04': '散落的蛋白石',
    'Obj_MineralGrain_A_05': '散落的黄玉',
    'Obj_MineralBury_A_01': '埋藏的矿床',
    'Obj_Mineral_B_02': '稀有矿床',
}

def cn_for_entry(entry):
    if entry in MANUAL_ZH: return MANUAL_ZH[entry]
    # 尝试多种 MSBT label 模式
    candidates = [entry + '_Name']
    # Item_MushroomGet_X → Item_Mushroom_X（TOTK 蘑菇 MSBT 标签不统一）
    if 'Get_' in entry:
        alt = entry.replace('Get_', '_')
        candidates.append(alt + '_Name')
    for lbl in candidates:
        if lbl in zh: return zh[lbl]
    return entry

def main():
    print('扫描 bcett ...')
    raw_pts = scan()
    print('原始 actor 数:', len(raw_pts))

    # 按 entry 分组
    entries = defaultdict(lambda: {'actors': set(), 'points': []})
    for actor, pts in raw_pts.items():
        entry = normalize_entry(actor)
        entries[entry]['actors'].add(actor)
        entries[entry]['points'].extend(pts)

    # 构建材料表
    mats = []
    for entry, info in sorted(entries.items()):
        actors = sorted(info['actors'])
        cat = categorize(actors[0])
        cn = cn_for_entry(entry)
        # 去重
        seen = set()
        uniq = []
        for L, x, z in info['points']:
            key = (L, x, z)
            if key in seen: continue
            seen.add(key)
            uniq.append((L, x, z))
        mats.append({
            'cat': cat, 'cn': cn, 'entry': entry,
            'actors': actors, 'count': len(uniq),
        })

    # 排序：按大类，同类按点数降序
    cat_order = ['植物','蘑菇','水果','昆虫','鱼','矿岩']
    mats.sort(key=lambda m: (cat_order.index(m['cat']) if m['cat'] in cat_order else 99, -m['count']))
    for i, m in enumerate(mats): m['id'] = i

    # flat points: [matId, layer, x, z, ...]
    flat = []
    for m in mats:
        entry = m['entry']
        info = entries[entry]
        seen = set()
        for L, x, z in info['points']:
            key = (L, x, z)
            if key in seen: continue
            seen.add(key)
            flat.extend([m['id'], L, x, z])

    data = {
        'meta': {
            'version': '2.0', 'feature': '材料追踪',
            'count': len(mats), 'points': len(flat)//4,
            'source': 'TOTK romfs v1.0.0 Banc MainField+MinusField bcett; 官方简中 MSBT',
        },
        'materials': mats,
        'points': flat,
    }
    js = 'var TOTK_MATERIALS = ' + json.dumps(data, ensure_ascii=False, separators=(',',':')) + ';'
    open(OUT_JS, 'w', encoding='utf-8').write(js)
    print('written:', OUT_JS, '%.1f KB' % (os.path.getsize(OUT_JS)/1024))

    # CSV
    with open(OUT_CSV, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['类别','中文名','entry','actors','点数'])
        w.writeheader()
        for m in mats:
            w.writerow({'类别':m['cat'],'中文名':m['cn'],'entry':m['entry'],
                        'actors':'+'.join(m['actors']),'点数':m['count']})

    print('=== 大类汇总 ===')
    for cat in cat_order:
        n = sum(1 for m in mats if m['cat']==cat)
        p = sum(m['count'] for m in mats if m['cat']==cat)
        print(f'  {cat}: {n} 种 / {p} 点')
    print(f'合计: {len(mats)} 种 / {len(flat)//4} 点')
    layer_cnt = Counter()
    for i in range(0, len(flat), 4):
        layer_cnt[flat[i+1]] += 1
    print(f'分层: 地表(18)={layer_cnt[18]} 地底(19)={layer_cnt[19]} 天空(20)={layer_cnt[20]}')

if __name__ == '__main__':
    main()
