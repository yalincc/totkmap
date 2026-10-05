#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
在 catalogs.js 的「位置」大组末尾插入「龙的轨迹」分类项
------------------------------------------------------------
为什么需要改 catalogs.js：
  侧栏分类面板（buildCatalogPanel）直接遍历 CATALOGS 渲染 .cat-item，
  且 catsOfLayer() 有 `count > 0` 过滤。龙的轨迹不是标点（是折线），
  但可以借分类项当"开关"用 —— 点它时 dragon-layer 监听 selected 状态并绘制折线。

分类项本身不产生任何 marker（markers.js 里没有对应 cat 的数据）。

插入位置（各层「位置」大组的 groupIndex —— 由 buildCatalogPanel 按 groupIndex 顺序映射组名）：
  layer18 地上 → groupIndex 1（位置大组，组内最后是「烹饪点」，龙轨迹紧随其后）
  layer19 地下 → groupIndex 1（位置大组，组内最后是「矿场」）
  layer20 天空 → groupIndex 0（位置大组，组内最后是「矿场」）

注意：groupIndex 用错会掉进「怪物」组（layer19 的 5 / layer20 的 4 是怪物组）。

id 分配（避开已用的 1~228）：229/230/231
count = 该层可显示的龙条数（地上/地下各 3、天空 1），仅为通过 count>0 过滤。
"""
import json, os

CAT = r'E:\WorkSpace\TOTKmap\app\data\catalogs.js'
ICON = 'origin_3845393_80603.png'   # 官方 objmap 的「龙」图标

# layer -> (新 catId, count=该层龙条数, groupIndex=位置大组)
NEW = {
    18: (229, 3, 1),
    19: (230, 3, 1),
    20: (231, 1, 0),
}


def main():
    t = open(CAT, encoding='utf-8').read()
    s = t.index('[')
    e = t.rindex(']') + 1
    orig = json.loads(t[s:e])

    # 幂等：先删掉旧的龙轨迹分类项
    base = [c for c in orig if c.get('name') != '龙的轨迹']

    # 在各层「位置」大组的最后一条之后插入。
    # 不能对整个数组排序 —— 那会打乱原有的组内顺序（未命名等），
    # 只按 (layer, groupIndex) 找每层位置组的末项，插在它后面。
    result = list(base)
    for layer in sorted(NEW, reverse=True):      # 从后往前插，避免影响未处理层的下标
        cid, cnt, gi = NEW[layer]
        last = max(
            (i for i, c in enumerate(result)
             if c['layer'] == layer and c.get('groupIndex') == gi),
            default=None,
        )
        item = {
            'id': cid,
            'layer': layer,
            'name': '龙的轨迹',
            'group': '位置',
            'groupIndex': gi,
            'icon': ICON,
            'count': cnt,
            'showName': True,
        }
        result.insert(last + 1 if last is not None else len(result), item)

    body = json.dumps(result, ensure_ascii=False, separators=(',', ':'))
    with open(CAT, 'w', encoding='utf-8') as f:
        f.write(t[:s] + body + t[e:])

    print('写入', CAT, os.path.getsize(CAT), 'bytes，共', len(result), '个分类')
    for layer in sorted(NEW):
        idxs = [i for i, c in enumerate(result)
                if c['layer'] == layer and c.get('name') == '龙的轨迹']
        i = idxs[0]
        prev = result[i - 1]['name'] if i > 0 else '(无)'
        c = result[i]
        print('  layer=%d id=%d groupIndex=%d  前一项=%s  count=%d'
              % (layer, c['id'], c['groupIndex'], prev, c['count']))


if __name__ == '__main__':
    main()
