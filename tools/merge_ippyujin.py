# -*- coding: utf-8 -*-
"""合并「一发入魂」的重复条目（M5）。

问题：任务板块里同一个任务有两条记录 ——
  ① key="HourseInnChallenge004" name="一击入魂"（官方名，ROM 提取，有存档变量）
  ② key=null              name="一发入魂"（社区起名，玩家攻略，有攻略文本）
两条坐标只差约 10 米（3085,-1670 vs 3093,-1658），确实是同一个迷你挑战。

为什么必须合而不是只改名：
  「标记完成」和存档同步都靠 key。key=null 的那条**没有存档变量**，
  玩家在游戏里做完「一击入魂」，地图上这条永远不会变绿 —— 白做。

处置：以有 key 的官方条目为主，吸收攻略条目的攻略文本与坐标精度，
     删除 key=null 的重复条目。

用法: merge_ippyujin.py [--dry]
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = '--dry' in sys.argv

# 同一任务的判定：两条都在「其他」类，且名字互为「一发入魂/一击入魂」
MASTER_KEY = 'HourseInnChallenge004'


def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def parse_plan(txt):
    j = txt.index('[')
    depth, k = 0, j
    while True:
        if txt[k] == '[':
            depth += 1
        elif txt[k] == ']':
            depth -= 1
            if depth == 0:
                break
        k += 1
    return j, k + 1, json.loads(txt[j:k+1])


def main():
    path = os.path.join(ROOT, 'app', 'data', 'task-plan.js')
    txt = read(path)
    start, end, arr = parse_plan(txt)

    master = None
    dup = None
    for t in arr:
        if t.get('key') == MASTER_KEY:
            master = t
        elif t.get('key') is None and (t.get('name') or '').rstrip('！？') == '一发入魂':
            dup = t

    if not master:
        print('找不到主条目 key=%s' % MASTER_KEY)
        return 1
    if not dup:
        print('找不到要合并的重复条目（可能已合并过）')
        return 0

    print('主条目:', json.dumps({x: master.get(x) for x in
                                ['key', 'name', 'nameSrc', 'gx', 'gz']}, ensure_ascii=False))
    print('重复条:', json.dumps({x: dup.get(x) for x in
                                ['key', 'name', 'nameSrc', 'gx', 'gz']}, ensure_ascii=False))

    # 1) 名字统一用官方译名（一击入魂）
    master['name'] = '一击入魂'
    # 2) NPC / 地点中文名（官方条目里npcCn/locCn 是 null，从攻略条目补）
    if not master.get('npcCn'):
        master['npcCn'] = '帕莉塞'
    if not master.get('locCn'):
        master['locCn'] = '米那卡雷马宿'
    # 3) 攻略文本：官方条目是空的，把攻略条目那份搬过来
    if not master.get('guide') and dup.get('guide'):
        master['guide'] = dup['guide']
    # 4) 官方分步：攻略条目有 steps 的话也搬（一般没有）
    if not master.get('stepsUI') and dup.get('stepsUI'):
        master['stepsUI'] = dup['stepsUI']
        master['nStepsUI'] = len(dup['stepsUI'])
        master['hasStepText'] = dup.get('hasStepText', True)
    # 5) 分类标记统一成「迷你挑战」（这是玩家攻略侧的分类名，可信）
    if not master.get('oldCat'):
        master['oldCat'] = '迷你挑战'
    # 6) 前置任务：补 reqs + guide.前置任务
    # ★ type 必须是 'flag' 不是 '前置'（2026-10-07 修正）
    #   全库 reqs 的 type 只有两种语义：quest=另一条任务（可跳转）、
    #   flag=游戏内部条件标记（不给链接）。凭空造第三种 '前置' 会：
    #     · 在统计里变成孤立的第3 类（实测「前置」1 条）
    #     · 走进 else 分支拿不到 flag，卡片上不给链接也不显示条件说明
    #   「海拉鲁城堡的异变」是**主线任务名**但没有 ROM key（合并时没匹配上），
    #   所以按 flag 处理：显示为条件、不给跳转链接。���确名称等信息在 reqName 里。
    reqs = master.get('reqs') or []
    if not any((r or {}).get('reqName') == '海拉鲁城堡的异变' for r in reqs):
        reqs.append({'type': 'flag', 'key': None,
                     'reqName': '海拉鲁城堡的异变', 'linkable': False,
                     'noKey': True})
    master['reqs'] = reqs
    g = master.setdefault('guide', {})
    if isinstance(g, dict) and '海拉鲁城堡的异变' not in (g.get('前置任务') or ''):
        g['前置任务'] = '完成「海拉鲁城堡的异变」'

    # 7) 删除重复条目
    arr = [t for t in arr if t is not dup]
    print('合并后条目数: %d → %d' % (start and len(arr) + 1, len(arr)))

    if not DRY:
        body = json.dumps(arr, ensure_ascii=False, separators=(',', ':'))
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(txt[:start] + body + txt[end:])
        print('已写入', path)
    else:
        print('DRY：未写入')
    return 0


if __name__ == '__main__':
    sys.exit(main())