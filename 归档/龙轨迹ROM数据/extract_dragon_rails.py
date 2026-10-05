#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 TOTK ROMFS 提取龙轨迹官方数据
------------------------------------------------------------
数据源：
  Banc/MainField/DeepHole/Set_DragonRail_Static.bcett.byml.zs        主轨道（8 条）
  Banc/MainField/LargeDungeon/Set_DragonBattleAndZeldaCatch_*.bcett.byml.zs  龙战涡旋点
  Scene/Component/DragonMgrParam/Default.game__scene__DragonMgrParam.bgyml  龙行为参数

要点：
  - .zs 为 zstd 压缩 + ROM 自带 BCETT 字典（Pack/ZsDic.pack.zs 偏移 0x20088，长 0x20000）
  - 轨道点是三次贝塞尔：Translate=P0，Control0/1=手柄，NextDistance=到下一点弧长
  - 坐标系 Translate=[X, Y高度, Z]，与 TOTKmap markers 的 [x,y]=[X,Z] 一致

输出：
  dragon_rails_raw.json    原始轨道点（含控制柄/弧长/连接）
  dragon_rails_path.json   贝塞尔采样后的地图折线
  dragon_config.json       龙的配置与起点
"""
import sys, os, json, math

sys.path.append(r'D:\dev\pylibs')
import zstandard as zstd
import byml

ROM = r'G:\YUZU\Switch Games\TOTKroms'
OUT = os.path.dirname(os.path.abspath(__file__))

DIC_OFF, DIC_LEN = 0x20088, 0x20000


def make_dec():
    d = open(os.path.join(ROM, 'Pack', 'ZsDic.pack.zs'), 'rb').read()
    raw = zstd.ZstdDecompressor().decompress(d, max_output_size=64 * 1024 * 1024)
    dic = raw[DIC_OFF:DIC_OFF + DIC_LEN]
    return zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(dic))


def read_bcett(dec, *parts):
    p = os.path.join(ROM, *parts)
    out = dec.decompress(open(p, 'rb').read(), max_output_size=32 * 1024 * 1024)
    return byml.Byml(out).parse()


# ---------- 贝塞尔采样 ----------
def bez(p0, c0, c1, p1, t):
    u = 1 - t
    return (
        u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
        u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1],
        u * u * u * p0[2] + 3 * u * u * t * c0[2] + 3 * u * t * t * c1[2] + t * t * t * p1[2],
    )


def sample_rail(pts, closed, step_m=60.0):
    """按 NextDistance 自适应细分贝塞尔，返回采样点列表"""
    n = len(pts)
    out = []
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        a = pts[i]
        b = pts[(i + 1) % n]
        p0, p1 = a['Translate'], b['Translate']
        # 控制柄可能缺失（退化段），缺失时按直线处理
        c0 = a.get('Control1') or p0           # 出点手柄
        c1 = b.get('Control0') or p1           # 入点手柄
        seg_len = a.get('NextDistance') or math.dist(p0, p1)
        steps = max(2, min(60, int(seg_len / step_m) + 1))
        for s in range(steps):
            t = s / steps
            out.append(bez(p0, c0, c1, p1, t))
        if not closed and i == n - 2:
            out.append(tuple(p1))
    return out


# ---------- 轨道命名 / 归属 ----------
RAIL_META = {
    'Low_Rail_For_Dragon_Light': dict(
        dragon='light', role='main', name='白龙主环线（低空）',
        desc='白龙绕全图的大圈主航线，高度偏低（Y 700~1000）。'),
    'High_Rail_For_Dragon_Light': dict(
        dragon='light', role='main', name='白龙主环线（高空）',
        desc='白龙同一大圈的高空版本（Y 1600~2370），与低空线走向基本重合。'),
    'Low_Rail_For_Dragon_Light_Inter': dict(
        dragon='light', role='link', name='白龙联络轨（低空）',
        desc='从主环线东南段（格鲁德峡谷附近）分出的下潜联络轨，接回主环线。'),
    'High_Rail_For_Dragon_Light_Inter': dict(
        dragon='light', role='link', name='白龙联络轨（高空）',
        desc='主环线高空段分出的联络轨，末端接回高空主线。'),
    'First_Island_Rail_For_Dragon_Light': dict(
        dragon='light', role='branch', name='白龙初岛支线',
        desc='初始空岛附近的小环线，白龙降临点（Y 1800）与大师剑夺回演出在此。'),
    'Rail_For_Dragon_Fire': dict(
        dragon='dinraal', role='main', name='奥尔龙（Dinraal）环线',
        desc='火属性龙奥尔龙的闭合飞行环线，主要在格鲁德沙漠 / 拉聂尔山一带。'),
    'Rail_For_Dragon_Ice': dict(
        dragon='faroons', role='main', name='费罗龙（Frozone）环线',
        desc='冰属性龙费罗龙的闭合环线，在泡泡拉高地 / 天空岛一带。'),
    'Rail_For_Dragon_Electric': dict(
        dragon='nailong', role='main', name='聂尔龙（Nurede）环线',
        desc='雷属性龙聂尔龙的闭合环线，在乌尔利山 / 奥尔汀峡谷一带。'),
}

DRAGON_CN = {
    'light': ('白龙', 'Light Dragon', '#e8e6f0', '天空层'),
    'dinraal': ('奥尔龙', 'Dinraal', '#ff7a45', '地上 / 地下'),
    'faroons': ('费罗龙', 'Frozone', '#7ad7f0', '地上 / 地下'),
    'nailong': ('聂尔龙', 'Nurede', '#c9a0ff', '地上 / 地下'),
}


def main():
    dec = make_dec()

    # 1) 主轨道
    rail_root = read_bcett(dec, 'Banc', 'MainField', 'DeepHole',
                           'Set_DragonRail_Static.bcett.byml.zs')

    raw_rails = []
    for r in rail_root.get('Rails', []):
        name = r.get('Dynamic', {}).get('UniqueName', '?')
        meta = RAIL_META.get(name, {})
        pts = []
        for p in r.get('Points', []):
            pts.append({
                'Translate': p.get('Translate'),
                'Control0': p.get('Control0'),
                'Control1': p.get('Control1'),
                'NextDistance': p.get('NextDistance'),
                'PrevDistance': p.get('PrevDistance'),
                'Hash': p.get('Hash'),
                'Connections': p.get('Connections') or [],
            })
        raw_rails.append({
            'uniqueName': name,
            'railHash': r.get('Hash'),
            'gyml': r.get('Gyaml'),
            'isClosed': r.get('IsClosed'),
            'enabledFlag': r.get('Dynamic', {}).get('IsEnabledGameDataFlagName'),
            'meta': meta,
            'pointCount': len(pts),
            'totalLengthM': round(sum(p['NextDistance'] or 0 for p in pts), 1),
            'points': pts,
        })

    # Actors：龙的出场起点
    actors = {}
    for a in rail_root.get('Actors', []):
        g = a.get('Gyaml')
        t = a.get('Translate')
        if g and t:
            actors[g] = {'translate': t, 'x': t[0], 'y': t[2], 'height': t[1]}

    # 2) 采样成折线
    path_rails = []
    for r in raw_rails:
        pts = r['points']
        if not pts:
            continue
        samples = sample_rail(pts, r['isClosed'])
        m = r['meta']
        path_rails.append({
            'uniqueName': r['uniqueName'],
            'dragon': m.get('dragon'),
            'role': m.get('role'),
            'name': m.get('name'),
            'desc': m.get('desc'),
            'isClosed': r['isClosed'],
            'enabledFlag': r['enabledFlag'],
            'pointCount': r['pointCount'],
            'totalLengthM': r['totalLengthM'],
            # 采样点：保留 1 位小数足够（游戏单位 1m）
            'path': [[round(s[0], 1), round(s[1], 1), round(s[2], 1)] for s in samples],
            'yRange': [round(min(s[1] for s in samples), 1),
                       round(max(s[1] for s in samples), 1)],
        })

    # 3) 龙战（涡旋挑战）点
    battle = read_bcett(dec, 'Banc', 'MainField', 'LargeDungeon',
                        'Set_DragonBattleAndZeldaCatch_Static.bcett.byml.zs')
    spirals = []
    for r in battle.get('Rails', []):
        n = r.get('Dynamic', {}).get('UniqueName', '?')
        pts = [p['Translate'] for p in r.get('Points', []) if p.get('Translate')]
        if not pts:
            continue
        spirals.append({
            'uniqueName': n,
            'isClosed': r.get('IsClosed'),
            'pointCount': len(pts),
            'center': [round(sum(p[i] for p in pts) / len(pts), 1) for i in range(3)],
            'yRange': [round(min(p[1] for p in pts), 1), round(max(p[1] for p in pts), 1)],
            'path': [[round(v, 1) for v in p] for p in pts],
        })
    battle_actors = [{'gyml': a.get('Gyaml'),
                      'translate': a.get('Translate')}
                     for a in battle.get('Actors', []) if a.get('Gyaml')]

    # 4) DragonMgrParam：行为参数
    p = os.path.join(ROM, 'Scene', 'Component', 'DragonMgrParam',
                     'Default.game__scene__DragonMgrParam.bgyml')
    mgr = byml.Byml(open(p, 'rb').read()).parse()

    cfg = []
    for it in mgr.get('DragonInfoList', []):
        rail = it.get('RailMoveSetting', {}) or {}
        mp = rail.get('MoveParam', {}) or {}
        cfg.append({
            'fileName': it.get('FileName'),
            'bindPointRespawn': it.get('BindPointRespawnGameDataName'),
            'calcSkipInterval': it.get('CalcSkipInterval'),
            'desiredAngularSpeed': mp.get('DesiredAngularSpeed'),
            'desiredRollSpeed': mp.get('DesiredRollSpeed'),
            'isEnabled': rail.get('IsEnabled'),
            'warpOnRailChanged': rail.get('WarpOnRailChanged'),
            'isWritePosToGameData': it.get('IsWritePosToGameData'),
        })

    out_raw = {
        'source': 'Banc/MainField/DeepHole/Set_DragonRail_Static.bcett.byml.zs',
        'note': '坐标系 Translate=[X,Y高度,Z]；NextDistance=到下一点弧长(m)；IsClosed=是否闭合',
        'rails': raw_rails,
        'actors': actors,
    }
    out_path = {
        'source': out_raw['source'],
        'note': '每点 [X,Y高度,Z]，已按弧长 60m 贝塞尔采样；Leaflet 用 latlng=(Z,X)',
        'dragons': DRAGON_CN,
        'rails': path_rails,
    }
    out_battle = {
        'source': 'Banc/MainField/LargeDungeon/Set_DragonBattleAndZeldaCatch_Static.bcett.byml.zs',
        'note': '龙战涡旋挑战的螺旋轨与相关 Actor（Enemy_Dragon_Light_002 / Dragon_Darkness 等）',
        'spirals': spirals,
        'actors': battle_actors,
    }
    out_cfg = {
        'source': 'Scene/Component/DragonMgrParam/Default.game__scene__DragonMgrParam.bgyml',
        'note': '龙沿轨移动的行为参数：角速度/滚转角/重算间隔/位置写回',
        'dragons': cfg,
    }

    for name, obj in [('dragon_rails_raw.json', out_raw),
                      ('dragon_rails_path.json', out_path),
                      ('dragon_battle.json', out_battle),
                      ('dragon_config.json', out_cfg)]:
        fp = os.path.join(OUT, name)
        json.dump(obj, open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print('写出', name, os.path.getsize(fp), 'bytes')

    print()
    print('轨道汇总：')
    for r in path_rails:
        print('  %-34s %-10s 点%3d  长%6d m  Y %5.0f~%5.0f  采样%4d' % (
            r['uniqueName'], r['dragon'], r['pointCount'],
            r['totalLengthM'], r['yRange'][0], r['yRange'][1], len(r['path'])))


if __name__ == '__main__':
    main()
