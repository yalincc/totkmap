# -*- coding: utf-8 -*-
"""给 task-plan.js 补 kindCn 字段：把「情节」和「迷你挑战」拆清楚（M5）。

背景：任务板块的四个分组（主线/重要支线/普通支线/其他）是**ROM 官方分类**，
但玩家实际关心的是另一件事 —— 这是「一段剧情」还是「一个一次性挑战」。
两套分类混在一起，「其他」里塞了 120 条迷你挑战，看着像杂项。

判定依据（按可靠性排序，只用可靠来源，不猜）：
  1. oldCat == '迷你挑战' → 迷你挑战（玩家攻略侧的标记，可信）
  2. oldCat == '情节挑战' → 情节挑战
  3. cat == 'Main'       → 主线剧情（ROM 权威）
  4. cat == 'Sub'/'ImportantMini' 且名称含「神庙与水晶」→ 神庙探索
  5. 其余 → 按名称特征细分（讲故事性强的归「情节」）

★ 不用 kind 字段做判断：那个是 extract_quests.py 里用
  key 字符串猜出来的（'MiniGame' in key 之类），不是 ROM 权威。

用法: add_kindcn.py [--dry]
"""
import io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRY = '--dry' in sys.argv


def classify(t):
    """返回 (kindCn, 依据说明)"""
    old = t.get('oldCat')
    name = t.get('name') or ''
    key = t.get('key') or ''
    cat = t.get('cat')

    if old == '迷你挑战':
        return '迷你挑战', 'oldCat'
    if old == '情节挑战':
        return '情节挑战', 'oldCat'
    if cat == 'Main':
        return '主线剧情', 'cat=Main'

    # 神社探索：ROM 里 CarryToShrine* 一律是「送水晶去神庙」，
    # 官方名两种写法（带「神庙与水晶」/ 只有「的水晶」），都归一类
    if '神庙与水晶' in name or ('水晶' in name and '沉睡于' in name) or key.startswith('CarryToShrine'):
        return '神庙探索', 'ROM CarryToShrine 系列'

    # 佣兵任务：ROM key 统一 Mercenary_*_Bloody（六个地区各一条）
    if key.startswith('Mercenary_'):
        return '地区任务', 'ROM Mercenary 系列'

    # 「只属于我的怪物收藏品 N」：连续任务（1已在 oldCat 里，2~5 靠这个规律补）
    if '只属于我的怪物收藏品' in name:
        return '支线故事', '连续任务系列'

    # Npc_*Reacting* / *Photo：ROM 内部事件，不是真正的任务
    if key.startswith('Npc_') and ('Reacting' in key or 'Photo' in name):
        return '背景事件', 'ROM 内部事件'

    # 名称偏收集要素
    if re.search(r'WANTED|寻宝|财宝|宝|收集|写真|摄影|画作|照片|图', name):
        return '收集要素', '名称偏收集'

    # 叙事句式（带！或？结尾）通常是带前后剧情的小任务
    if re.search(r'！|？$', name):
        return '情节挑战', '名称为叙事句式'

    # 有官方名（ROM 权威）但玩家攻略没标分类 → 归支线故事
    if t.get('nameSrc') == 'rom':
        return '支线故事', 'ROM官方名未标分类'

    return '其他任务', '兜底'


def main():
    path = os.path.join(ROOT, 'app', 'data', 'task-plan.js')
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        txt = f.read()

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
    start, end = j, k + 1
    arr = json.loads(txt[start:end])

    import collections
    dist = collections.Counter()
    reason = collections.Counter()
    for t in arr:
        kc, why = classify(t)
        t['kindCn'] = kc
        dist[kc] += 1
        reason[why] += 1

    print('分类分布:')
    for k, v in dist.most_common():
        print('  %-10s %d' % (k, v))
    print('判定依据:')
    for k, v in reason.most_common():
        print('  %-14s %d' % (k, v))

    if not DRY:
        body = json.dumps(arr, ensure_ascii=False, separators=(',', ':'))
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(txt[:start] + body + txt[end:])
        print('已写入', path)
    else:
        print('DRY：未写入')


if __name__ == '__main__':
    main()