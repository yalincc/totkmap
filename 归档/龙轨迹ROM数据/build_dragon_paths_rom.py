#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成网站用的龙轨迹数据 dragon_paths_rom.js
------------------------------------------------------------
输入：dragon_rails_raw.json / dragon_rails_path.json（由 extract_dragon_rails.py 产出）
输出：app/data/dragon_paths_rom.js  →  window.TOTK_DRAGON_PATHS_ROM

数据结构（与 dragon_paths.js 兼容，额外带高度信息）：
  items[] = {
    id, name, en, color, layer, desc,
    segments:  [[x, y], ...]        平面坐标，x=X(东) y=Z(北)，Leaflet latlng=(y,x)
    altitude:  [h, ...]             与 segments 等长，飞行高度 Y（米，负=地下）
    groundSegs / depthSegs          按高度自动切出的地表段 / 地下段
    altRange, totalLengthM, railName, closed,
    start:   {x, y, height}          ROM Actor 给的官方起点
    marks:   [{x,y,label,kind,dist}] 自动匹配的地标
    regions: [{x,y,label,dist}]     区域标签
    extraRails: [...]                白龙的其余轨道（高空线/联络轨/初岛支线）
  }

白龙有 5 条轨道：低空主环（做主 segments）+ 高空线/2 条联络轨/初岛支线（做 extraRails）。
三元素龙各 1 条闭合环，按 Y 切分成地表段与地下段。
"""
import os, json, math

BASE = os.path.dirname(os.path.abspath(__file__))
SRC_RAW = os.path.join(BASE, 'dragon_rails_raw.json')
SRC_PATH = os.path.join(BASE, 'dragon_rails_path.json')
OUT = r'E:\WorkSpace\TOTKmap\app\data\dragon_paths_rom.js'
MARKERS = r'E:\WorkSpace\TOTKmap\app\data\markers.js'
AREAS = r'E:\WorkSpace\TOTKmap\app\data\areas.js'

# 地下判定阈值：Y 低于此值算地下段（元素龙最低 -552m，地面设施在 0 附近）
DEPTH_Y = -80.0

# 沿线地标标注：**默认关闭**。
# 这些点与左侧栏「神庙/鸟望台/驿站/地洞入口」等分类图标坐标完全重复，
# 同时显示会出现"同一地点两个图标、且位置对不上"的错觉（用户实测反馈），故不再输出。
# 若只想在轨迹上额外提示，可把下面开关打开并调窄半径。
ENABLE_MARKS = False
LANDMARK_CATS = {
    62: '鸟望台', 63: '神庙', 66: '村庄', 67: '驿站', 69: '地洞入口',
    70: '洞穴入口', 72: '女神雕像', 183: '古代研究所', 184: '神殿',
}
NAME_BLOCK = ('呀哈哈', '运输呀哈哈', '隐藏呀哈哈', '魔犹伊', '克洛格', '未命名')

MARK_RADIUS = 900.0
MARK_MAX_PER_RAIL = 12
MARK_MAX_PER_KIND = 3
REGION_RADIUS = 900.0
REGION_MAX = 6

# 轨道 → 龙
RAIL2DRAGON = {
    'Low_Rail_For_Dragon_Light': dict(
        id='light', layer=20, en='Light Dragon', color='#e8e6f0',
        actor='Enemy_Dragon_Light_001',
        name='白龙',
        desc='白龙沿两条同走向的轨道绕全图大圈：低空轨约 33.3km（Y700~1000）、'
             '高空轨约 33.8km（Y1600~2370）。另有两条联络轨与一条初岛支线。'
             '降落处即龙之泪所在，全程高空不落地。'),
    'Rail_For_Dragon_Fire': dict(
        id='dinraal', layer=18, en='Dinraal', color='#ff7a45',
        actor='Enemy_Dragon_Fire',
        name='奥尔龙',
        desc='火属性龙，全长约 14.3km。主要盘绕格鲁德沙漠与拉聂尔山一带，'
             '地下段从深穴潜入，路线最低至地下 -552m。'),
    'Rail_For_Dragon_Ice': dict(
        id='faroons', layer=18, en='Frozone', color='#7ad7f0',
        actor='Enemy_Dragon_Ice',
        name='费罗龙',
        desc='冰属性龙，全长约 8.6km，三条元素龙里最短。'
             '环线在泡泡拉高地与天空岛一带，最低至地下 -440m。'),
    'Rail_For_Dragon_Electric': dict(
        id='nailong', layer=18, en='Nurede', color='#f5c542',
        actor='Enemy_Dragon_Electric',
        name='聂尔龙',
        desc='雷属性龙，全长约 10.4km。环线在乌尔利山与奥尔汀峡谷一带，'
             '最低至地下 -441m。'),
}

# 白龙其余轨道
LIGHT_EXTRA = [
    'High_Rail_For_Dragon_Light',
    'Low_Rail_For_Dragon_Light_Inter',
    'High_Rail_For_Dragon_Light_Inter',
    'First_Island_Rail_For_Dragon_Light',
]
EXTRA_DESC = {
    'High_Rail_For_Dragon_Light': '白龙同一大圈的高空版本，走向与低空轨基本重合',
    'Low_Rail_For_Dragon_Light_Inter': '从主环线东南段分出的下潜联络轨（低空）',
    'High_Rail_For_Dragon_Light_Inter': '主环线高空段分出的联络轨',
    'First_Island_Rail_For_Dragon_Light': '初始空岛附近的小环线，白龙降临点与大师剑夺回演出在此',
}


def load_js_array(path):
    """从 app/data/*.js 里抠出 window.X=[...] 的数组"""
    t = open(path, encoding='utf-8').read()
    s = t.index('[')
    e = t.rindex(']') + 1
    return json.loads(t[s:e])


def load_markers():
    out = []
    for m in load_js_array(MARKERS):
        if 'x' not in m or 'y' not in m:
            continue
        cat = m.get('cat')
        if cat not in LANDMARK_CATS:
            continue
        if any(b in m['name'] for b in NAME_BLOCK):
            continue
        out.append({'name': m['name'], 'x': m['x'], 'y': m['y'],
                    'layer': m.get('layer'), 'kind': LANDMARK_CATS[cat]})
    return out


def load_regions():
    try:
        out = []
        for a in load_js_array(AREAS):
            if 'x' not in a or 'y' not in a:
                continue
            nm = a.get('name') or a.get('full') or ''
            if not nm or any(b in nm for b in NAME_BLOCK):
                continue
            out.append({'name': nm, 'x': a['x'], 'y': a['y'], 'layer': a.get('layer')})
        return out
    except Exception:
        return []


def nearest(rail_pts, pool, radius, limit, per_kind=None):
    hits = []
    for m in pool:
        best = min(math.hypot(p[0] - m['x'], p[2] - m['y']) for p in rail_pts)
        if best <= radius:
            hits.append((best, m))
    hits.sort(key=lambda t: t[0])
    out, used, kn = [], set(), {}
    for dist, m in hits:
        if m['name'] in used:
            continue
        k = m.get('kind', '')
        if per_kind and kn.get(k, 0) >= per_kind:
            continue
        used.add(m['name'])
        kn[k] = kn.get(k, 0) + 1
        out.append({'x': round(m['x'], 1), 'y': round(m['y'], 1),
                    'label': m['name'], 'kind': k, 'dist': int(dist)})
        if len(out) >= limit:
            break
    return out


def split_by_altitude(path):
    """按高度把环切成连续的地表段/地下段。

    返回两个列表，每个元素是索引列表（可能是环形区间，末尾接回首部）。
    不能用 [start,end) 区间表示：闭合环上地表/地下往往交替，
    跨首尾的那一段用区间写会丢点（实测费罗龙地下段会变成空）。
    """
    n = len(path)
    ground = set(i for i in range(n) if path[i][1] >= DEPTH_Y)
    depth = set(i for i in range(n) if path[i][1] < DEPTH_Y)

    def runs(s):
        if not s or len(s) == n:
            return [list(range(n))] if s else []
        out, cur = [], []
        # 从不属于 s 的点起扫，保证区间不跨首尾
        start = next(i for i in range(n) if i not in s)
        i = start
        for _ in range(n):
            if i in s:
                cur.append(i)
            elif cur:
                out.append(cur)
                cur = []
            i = (i + 1) % n
        if cur:
            out.append(cur)
        return out

    def to_segs(idxs):
        return [[round(path[i][0], 1), round(path[i][2], 1)] for i in idxs]

    return [to_segs(r) for r in runs(ground) if len(r) >= 2], \
           [to_segs(r) for r in runs(depth) if len(r) >= 2]


def main():
    raw = json.load(open(SRC_RAW, encoding='utf-8'))
    sampled = json.load(open(SRC_PATH, encoding='utf-8'))
    path_by = {r['uniqueName']: r for r in sampled['rails']}
    actors = raw['actors']

    markers = load_markers()
    regions = load_regions()

    items = []
    for uname, cfg in RAIL2DRAGON.items():
        pr = path_by[uname]
        pts = pr['path']                      # [[X,Y,Z], ...]
        segs = [[round(p[0], 1), round(p[2], 1)] for p in pts]
        alts = [round(p[1], 1) for p in pts]

        gspans, dspans = split_by_altitude(pts)
        ground_segs = gspans
        depth_segs = dspans

        item = {
            'id': cfg['id'],
            'name': cfg['name'],
            'en': cfg['en'],
            'color': cfg['color'],
            'layer': cfg['layer'],
            'desc': cfg['desc'],
            'railName': uname,
            'closed': pr['isClosed'],
            'totalLengthM': pr['totalLengthM'],
            'pointCount': pr['pointCount'],
            'altRange': pr['yRange'],
            'segments': segs,
            'altitude': alts,
            'groundSegs': ground_segs,
            'depthSegs': depth_segs,
            'hasDepthPart': bool(depth_segs),
            'marks': nearest(pts, markers, MARK_RADIUS, MARK_MAX_PER_RAIL,
                             per_kind=MARK_MAX_PER_KIND) if ENABLE_MARKS else [],
            'regions': nearest(pts, regions, REGION_RADIUS, REGION_MAX),
        }
        # 地下段两端（出入口）：地下层画轨迹时用来标起点
        # 从原始三维点取高度，tooltip 里显示
        dstarts, seen = [], set()
        for sg in depth_segs:
            for idx in (0, len(sg) - 1):
                p = sg[idx]
                key = (p[0], p[1])
                if key in seen:
                    continue
                seen.add(key)
                # 找同坐标的三维点取 Y
                h = next((q[1] for q in pts
                          if round(q[0], 1) == p[0] and round(q[2], 1) == p[1]), 0)
                dstarts.append({'x': p[0], 'y': p[1], 'height': round(h, 1)})
        item['depthStarts'] = dstarts
        a = actors.get(cfg['actor'])
        if a:
            item['start'] = {'x': round(a['x'], 1), 'y': round(a['y'], 1),
                             'height': a['height']}
        if cfg['id'] == 'light':
            extra = []
            for en in LIGHT_EXTRA:
                er = path_by[en]
                extra.append({
                    'railName': en,
                    'name': er['name'],
                    'desc': EXTRA_DESC[en],
                    'totalLengthM': er['totalLengthM'],
                    'closed': er['isClosed'],
                    'altRange': er['yRange'],
                    'segments': [[round(p[0], 1), round(p[2], 1)] for p in er['path']],
                })
            item['extraRails'] = extra
        items.append(item)

    out = {
        'version': 'ROM-V1',
        'source': 'G:\\YUZU\\Switch Games\\TOTKroms / Banc/MainField/DeepHole/'
                  'Set_DragonRail_Static.bcett.byml.zs',
        'note': 'ROM 官方轨道（三次贝塞尔，按 ~58m 采样）。'
                'segments=[x=X东, y=Z北]，Leaflet latlng=(y,x)；'
                'altitude 为对应点飞行高度 Y（米，负=地下）。'
                'groundSegs/depthSegs 按 Y<-80m 自动切分，同一条环线的地表段与地下段。',
        'depthThreshold': DEPTH_Y,
        'items': items,
    }

    js = (
        '/* ============================================================\n'
        ' * 龙轨迹数据 · ROM 官方轨道版\n'
        ' * ------------------------------------------------------------\n'
        ' * 由 归档/龙轨迹ROM数据/build_dragon_paths_rom.py 从 ROMFS 自动生成，勿手改\n'
        ' * 源：Banc/MainField/DeepHole/Set_DragonRail_Static.bcett.byml.zs\n'
        ' * 相比 dragon_paths.js（社区手工近似）：精确贝塞尔曲线 + 真实飞行高度 +\n'
        ' * 地表/地下段按实际高度自动切分（不再是猜测的虚线）\n'
        ' * ============================================================ */\n'
        'window.TOTK_DRAGON_PATHS_ROM = '
        + json.dumps(out, ensure_ascii=False, separators=(',', ':'))
        + ';\n'
    )
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(js)

    print('写出', OUT, os.path.getsize(OUT), 'bytes\n')
    for it in items:
        print('%-8s %-4s 点%4d 长%6.0fm 高%5.0f~%5.0f  地表段%d 地下段%d 地标%d 区域%d' % (
            it['id'], it['name'], len(it['segments']), it['totalLengthM'],
            it['altRange'][0], it['altRange'][1],
            len(it['groundSegs']), len(it['depthSegs']),
            len(it['marks']), len(it['regions'])))
    light = next(i for i in items if i['id'] == 'light')
    print('\n白龙支线 %d 条：' % len(light['extraRails']))
    for e in light['extraRails']:
        print('  %-34s 点%4d 长%6.0fm' % (e['railName'], len(e['segments']), e['totalLengthM']))


if __name__ == '__main__':
    main()
