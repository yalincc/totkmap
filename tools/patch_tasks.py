# -*- coding: utf-8 -*-
"""任务数据层修补（M5）：把已核实的事实补进 tasks.js / task-plan.js。

★★ 为什么用字符串定点替换而不是 json.loads + json.dumps：
   1. 这两个文件是**超大紧凑 JSON**（tasks.js 400KB / task-plan.js 530KB），
      走一遍 parse + dumps 会改变空白/转义/行尾（实测踩过：
      原文件是 CRLF，重写成 LF 后整个文件 diff 变得没法看，
      还因为 header 截断把window.TOTK_TASKS= 这个变量名丢了 → 文件彻底报废）。
   2. 数据层是别人（build_task_plan.py 等）反复重跑的地带，
      最小侵入才不会互相打架。

当前修补项：
  1. 「一发入魂！？」→ 去掉社区攻略的感叹号（官方无汉化名，保留 guide 来源标记）
  2. 补 NPC「帕莉塞」与地点「米那卡雷马宿」
  3. 补前置任务「海拉鲁城堡的异变」

用法: patch_tasks.py [--dry]
"""
import io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'app')
DRY = '--dry' in sys.argv


def read(path):
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write(path, txt):
    """原样写回：newline='' 保证 CRLF 不被改写。"""
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(txt)


def patch_tasks_js():
    """tasks.js：给「一发入魂！？」改名 + 补 npc/loc。"""
    path = os.path.join(APP, 'data', 'tasks.js')
    txt = read(path)
    changes = 0

    # 1) 改名（只替换 name 字段值，不动其他地方的同名字符串）
    if '"name":"一发入魂！？"' in txt:
        txt = txt.replace('"name":"一发入魂！？"', '"name":"一发入魂"')
        changes += 1

    # 2) 补 npc/loc —— 必须精确定位到这一条任务对象内
    #    该条是 key:null，靠 name 定位后向后取到下一个 "},{" 作为对象边界。
    key = '"name":"一发入魂"'
    i = txt.find(key)
    if i >= 0:
        obj_end = txt.find('},{"', i)
        if obj_end < 0:
            obj_end = len(txt)
        obj = txt[i:obj_end]
        new_obj = obj
        if '"npcCn":null' in new_obj:
            new_obj = new_obj.replace('"npcCn":null', '"npcCn":"帕莉塞"', 1)
            new_obj = new_obj.replace('"npc":null', '"npc":"Parise"', 1)
            changes += 1
        txt = txt[:i] + new_obj + txt[obj_end:]

    if changes and not DRY:
        write(path, txt)
    print('tasks.js：%d 处改动' % changes)
    return changes


def patch_plan_js():
    """task-plan.js：改名 + guide.前置任务 + reqs 前置链。"""
    path = os.path.join(APP, 'data', 'task-plan.js')
    txt = read(path)
    changes = 0

    if '"name":"一发入魂！？"' in txt:
        txt = txt.replace('"name":"一发入魂！？"', '"name":"一发入魂"')
        changes += 1

    key = '"name":"一发入魂"'
    i = txt.find(key)
    if i >= 0:
        obj_end = txt.find('},{"', i)
        if obj_end < 0:
            obj_end = len(txt)
        obj = txt[i:obj_end]

        # guide.前置任务：原值可能是缺失、null 或空串
        if '"前置任务":""' in obj:
            obj = obj.replace('"前置任务":""', '"前置任务":"完成「海拉鲁城堡的异变」"', 1)
            changes += 1

        # reqs：加一条指向前置任务的链（卡片可点击跳转）
        if '"reqs":[]' in obj and '海拉鲁城堡的异变' not in obj:
            obj = obj.replace(
                '"reqs":[]',
                '"reqs":[{"type":"前置","key":null,'
                '"reqName":"海拉鲁城堡的异变","linkable":true}]',
                1)
            changes += 1

        txt = txt[:i] + obj + txt[obj_end:]

    if changes and not DRY:
        write(path, txt)
    print('task-plan.js：%d 处改动' % changes)
    return changes


if __name__ == '__main__':
    if DRY:
        print('=== DRY RUN，不写文件 ===')
    a = patch_tasks_js()
    b = patch_plan_js()
    print('合计 %d 处' % (a + b))
    if a + b == 0:
        print('（没找到目标，可能已改过）')