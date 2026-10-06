# -*- coding: utf-8 -*-
"""补任务官方中文名（M6.2）——联网核实后写进tasks.js。

★ 为什么要单独一个脚本：任务名是 data 层的权威字段，
  但12 条任务的官方中文名在 ROM 里就不存在（nameSrc=key），
  只能靠联网核实后人工补。补完落在数据里，
  verify-data.js 的「无官方中文名」WARN 就会少一条。

★ 为什么用字符串定点替换而不是 json.loads + json.dumps：
  tasks.js 是 400KB 的紧凑 JSON，走parse + dumps 会改空白/转义/行尾
  （踩过：CRLF 被改成 LF，整个文件 diff 没法看，
  还因为 header 处理不当把 window.TOTK_TASKS= 弄丢了 → 文件报废）。
  最小侵入，别和 build_task_plan.py 等生成器打架。

核实结论（2026-10-06联网）：
  6 条佣兵任务 = 官方「为<地区>带来和平!」系列，英文 Bring Peace to X。
    kiranico.com/totk/data/quests/MercenaryChallenge_Akkare 标题为
    "Bring Peace to Akkala!"，Category=ImportantMini，与我们 cat 一致。
    中文名对照官方支线表：阿卡莱/奥尔汀/费罗尼/海布拉/哈特尔/海拉鲁平原。
    注意key 的地区段与实际地区是**错位**的（Akkare 任务的 RequestLocation
    写的是 MapArea_EldinCanyon），所以不能靠 key 猜，必须查表填。
  FindSunaNui2 查不到独立官方名——它不是独立任务，
    是「和缇克尔比试！」(Dalia's Game) 的血月重做版：
    steps 结构完全相同（Playing/Result/TimeOver）、
    dependFlag=FindSunaNui_IsCompleted_Exp、sort 与母任务同为 5914。
    ROM 里就没给这个触发器单独标题，按可读化兜底显示，不硬造名字。
  IchikaraDaughterPhoto = 「普莉珂的秘密基地」
    (Ichikara→科普莉珂，卡卡利科村井里，两步、Report 结尾)。
  Npc_BaseCamp_Assistant_ReactingStatue1~4 是 ROM 内部事件
    (BackgroundEvent)，不是玩家可接任务，没有官方任务名。

用法: patch_quest_names.py [--dry]
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')
DRY = '--dry' in sys.argv

# key -> (官方中文名, 依据)
NAMES = {
    # —— 佣兵讨伐队系列（官方「为X带来和平!」）——
    'Mercenary_Akkare_Bloody':     ('为阿卡莱带来和平!',   'kiranico MercenaryChallenge_Akkare = Bring Peace to Akkala!'),
    'Mercenary_Hateru_Bloody':     ('为哈特尔带来和平!',   '同上，Hateno 驿站队长 Hateru'),
    'Mercenary_Firone_Bloody':     ('为费罗尼带来和平!',   '同上，格鲁德绿洲队长 Firone'),
    'Mercenary_Hebra_Bloody':      ('为海布拉带来和平!',   '同上，Tarrey 驿站队长 Hebra'),
    'Mercenary_HyrulePlain_Bloody':('为海拉鲁平原带来和平!','同上，Tarrey 驿站队长打海拉鲁平原'),
    'Mercenary_Eldin_Bloody':      ('为奥尔汀带来和平!',   '同上，Tabanta 驿站队长 Eldin'),
    # —— 摄影类——
    'IchikaraDaughterPhoto':       ('普莉珂的秘密基地',     'Ichikara=科普莉珂，卡卡利科村井，2步 Report 结尾'),
}

#查不到官方名的：key -> 说明（供报告与后续人工处理）
UNKNOWN = {
    'FindSunaNui2': '是「和缇克尔比试！」(Dalia\'s Game) 的血月重做版，'
                    'steps 与母任务完全相同、sort 同为 5914，ROM 无独立标题。',
    'Npc_BaseCamp_Assistant_ReactingStatue':  'ROM 内部事件（BackgroundEvent），非玩家可接任务。',
    'Npc_BaseCamp_Assistant_ReactingStatue2': '同上。',
    'Npc_BaseCamp_Assistant_ReactingStatue3': '同上。',
    'Npc_BaseCamp_Assistant_ReactingStatue4': '同上。',
}


def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(path, txt):
    """原样写回：newline='' 保证 CRLF 不被改写。"""
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(txt)


def find_task_obj(txt, key):
    """定位任务本体对象在整个 JSON 数组里的区间 [start, end)。

    ★ 判据不能是「第一个 {\"key\":\"X\"」也不能只看前一个字符是不是 '{'：
      task-plan.js 的 unlockList / reqs 里嵌着同名 key，且它们前面也是 '{'。
      实测 Mercenary_Akkare_Bloody 有两个候选：
        位置 198006（84 字符）→ unlockList 里的 {\"key\":..,\"reqName\":..,\"linkable\":true}
        位置 207061（1304 字符）→ 真正的任务本体
      唯一可靠的区分：任务本体的第二个字段就是 "name"。
    """
    pat = '"key":"%s"' % re.escape(key)
    pos = 0
    while True:
        i = txt.find(pat, pos)
        if i < 0:
            return None
        pos = i + 1
        if i == 0 or txt[i - 1] != '{':
            continue
        # 本体判据：key 字段后面紧跟 name 字段
        tail = txt.find('"name":', i, i + 80)
        if tail < 0:
            continue
        start = i - 1
        end = txt.find('},{"key":', i)
        if end < 0:
            end = txt.find(']', i)
        return (start, end)
    return None


def patch(name, applied, skipped):
    """把一个 key 的 name/nameSrc 改成官方名。"""
    path = os.path.join(APP, 'data', name)
    txt = read(path)
    orig = txt
    hit = 0

    for key, (cn, _why) in NAMES.items():
        rng = find_task_obj(txt, key)
        if not rng:
            skipped.append((key, '未在 %s 中定位到任务本体' % name))
            continue
        start, end = rng
        seg = txt[start:end]
        # name 与 nameSrc 必须一起改，否则前端会以为这是「非官方名」
        new = re.sub(r'"name":"%s"' % re.escape(key), '"name":"%s"' % cn, seg, count=1)
        if new == seg:
            skipped.append((key, 'name 字段不是 key 本身，需人工看'))
            continue
        new = new.replace('"nameSrc":"key"', '"nameSrc":"official"', 1)
        txt = txt[:start] + new + txt[end:]
        hit += 1
        applied.append((name, key, cn))

    if txt != orig and not DRY:
        write(path, txt)
    return hit


def main():
    applied, skipped = [], []
    n = 0
    for f in ('tasks.js', 'task-plan.js'):
        n += patch(f, applied, skipped)

    print('=' * 62)
    print('M6.2 补任务官方中文名%s' % ('（dry-run，未写盘）' if DRY else ''))
    print('=' * 62)
    print('已补%d 处：' % n)
    for f, k, cn in applied:
        print('   %-14s %-34s → %s' % (f, k, cn))
    if skipped:
        print('跳过 %d 处：' % len(skipped))
        for k, why in skipped:
            print('   %-34s %s' % (k, why))
    print('')
    print('查不到官方名（保留可读化兜底，需人工确认）：')
    for k, why in UNKNOWN.items():
        print('   %-42s %s' % (k, why))


if __name__ == '__main__':
    main()
