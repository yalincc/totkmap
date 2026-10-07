#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M1 + M2：任务数据接线 + 分类判定（★ 只出数据，不碰界面）

产出 task-plan.json，供 M3面板/卡片消费；本步骤**不修改 app/ 下任何文件**。

做三件事：
  1. 剔除小游戏/赛事条目（老大定的口径：它们属于「地点」，不进任务板块）
  2. 合并重复 key（同一个 NPC 的多条反应合成1 条，卡片里分条列清）
  3. 按 ROM 权威分类分组+ 判定流程档位

流程档位（自动判定，界面不显示这个术语）：
  L1 去重后>=2 个不同坐标 → 可画流程线（74 条）
  L2 恰好 1 个坐标         → 单点 + 攻略文字（126 条）
  L3 无坐标→ 仅列表（86 条）

用法：
    python tools/build_task_plan.py --dry    # 打印汇总表，不写文件
    python tools/build_task_plan.py --write  # 写出 app/data/task-plan.js
"""
import argparse
import json
import pathlib
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from clean_steps import clean_steps, step_stats

ROOT = pathlib.Path(__file__).resolve().parent.parent
TASKS_JS = ROOT / "app" / "data" / "tasks.js"
OUT_JS = ROOT / "app" / "data" / "task-plan.js"

# ------------------------------------------------------------------ 小游戏识别
# ★ 口径（老大 2026-10-06拍板）：小游戏/赛事归「地点」组，不进任务板块。
# 理由：它们是纯地点型（无任务链、无步骤、无奖励），归「任务」会稀释任务板块，
# 且地点组已有「迷你挑战」分类，同一点会出现两次。
MINIGAME_PAT = re.compile(
    r"(_MiniGame|MiniGame_|Contest|Circuit_|Bowling|Golf|SkyRingChallenge)",re.I)

# 人工确认：name/desc 里带这些词但 key 没匹配到的
MINIGAME_HINT = re.compile(r"(小游戏|赛事|比赛|竞速|多合一|连打|对打)")

# ------------------------------------------------------------------ 人工确认要剔除的条目
# ★ 老大 2026-10-07 拍板（校对台账 P11.5 / P11.6 / P12），共 11 条：
#
# ① 4 条 ROM 内部事件空壳：Npc_BaseCamp_Assistant_ReactingStatue{,2,3,4}
#    实测完全空壳 —— 无中文名(nameSrc=key)、无坐标、stepsUI=0 条、guide 全空、
#    玩家根本接不到、冒险笔记里也查不到 → 不该进任务板块。
#
# ② 6 条补录重复：「为〇〇带来和平！」被收录了两次
#      ROM 版  key = MercenaryChallenge_{Akkare,Eldin,Firone,Hateru,Hebra,HyrulePlain}
#              sort = 451~456，全角叹号，src=rom+guide   ← 保留这条
#      补录版  key = Mercenary_{...}_Bloody
#              sort = null，半角叹号，src=rom，无攻略    ← 删这条
#    两组在上游 tasks.js(286 条) 里都存在，所以必须在这里剔。
#
# ③ FindSunaNui2 —— 补完6 条小游戏后，多出来的那 1 条。
#    实测：nameSrc=key（无中文名，卡片上显示英文 key）、stepsUI 0 条、
#    npc=Npc_oasis016、sort=5914、reqs 指向「和缇克尔比试！」。
#    ★ 它**不是**「第八位英雄」—— 老大拿A9VG+Game8 交叉出的139 条官方名单
#      核对过：第八位英雄是EightHeroStatues_After（sort=5915，本来就在库、有中文名）。
#      FindSunaNui2 是另一条任务，139 条名单里没有它。
#    删掉后：254 → 253 = 游戏官方任务总数（23+60+31+139），四档精确命中。
#
# ★★ 必须改**生成脚本**，不能手改 task-plan.js —— 后者是生成物，重跑管线会被覆盖。
DROP_KEY_PAT = re.compile(
    r"^(Npc_BaseCamp_Assistant_ReactingStatue\d*|Mercenary_\w+_Bloody"
    r"|IchikaraDaughterPhoto|FindSunaNui2)$")

# ------------------------------------------------------------------ 小游戏白名单（补回 6 条）
# ★ 老大 2026-10-07 拍板：这 6 条**补回**任务板块（校对台账 P12）。
#
#   背景：2026-10-06 定的口径是「小游戏/赛事归地点组，不进任务板块」，
#   但老大用 A9VG + Game8 两个独立来源交叉出的**139 条官方迷你挑战名单**里
#   明确包含这 6 条，且它们的 `sort` 全部落在 5000+（迷你挑战区间）。
#   → 两条证据都说明：**它们就是迷你挑战，之前是误剔**。
#
#   注意：这些 key 会被 MINIGAME_PAT 匹配到（MiniGame_ / Circuit_ / SkyRingChallenge），
#   所以必须在 is_minigame() 里**先命中白名单再判正则**，否则补不回来。
KEEP_MINIGAME_KEYS = {
    "Hebra_SkyRingChallenge",          # 利特族的新式飞行训练      sort=5296
    "Goron_MiniGame_Tutorial_01",      # 开园！矿车乐园！          sort=5441
    "Goron_MiniGame_Tutorial_02",      # 速射矿车游戏！            sort=5442
    "Goron_MiniGame_Tutorial_03",      # 超高难度的死亡之山赛道！  sort=5443
    "Circuit_Ichikara",                # 征服一始拉力赛            sort=5511
    "IchikaraCircuit_Tutorial",        # 熟练驾驭左纳乌装置吧      sort=5513
}


# ------------------------------------------------------------------ 无坐标原因标注
# ★ 为什么要有这个表：
#   L1 体检里「无有效坐标」是WARN，但 6 条里有 4 条是 ROM 内部事件
#   （ReactingStatue×4，玩家根本接不到）、1 条是德克塔族树桩的剧情碎片、
#   1 条是井里的照片拍摄点—— 它们**本来就该没有地图坐标**。
#   不标注的话，这个 WARN 会永远挂在体检报告里，让人以为还有 bug 没修完。
#
# 语义：noPlaceReason = 一句话说明「为什么这里没有坐标」，
#verify-data.js 见到它就把该任务从「无坐标」WARN 里排除。
# 只能给**确实无法获得坐标**的任务填；
#   若是「上游漏抽了坐标」这种可修的，填了就是掩盖问题，别填。
NO_PLACE_REASON = {
    "GetMasterSword":
        "德克塔族大树桩处的剧情碎片（注入Cokiri 地名但无实际坐标）",
    "IchikaraDaughterPhoto":
        "拍摄点在卡卡利科村井内（地下空间，地图无对应坐标）",
}
# ROM 内部事件：不是玩家可接的任务，key 本身就是内部名。
# ★ 注意有一条是**无后缀**的（Npc_BaseCamp_Assistant_ReactingStatue），
#   只循环 1~4 会漏掉它，体检就会一直报 1 条 WARN。
NO_PLACE_INTERNAL = "ROM 内部事件（背景触发器），玩家不可接取，不该上图"
NO_PLACE_REASON["Npc_BaseCamp_Assistant_ReactingStatue"] = NO_PLACE_INTERNAL
for _i in (1, 2, 3, 4):
    NO_PLACE_REASON["Npc_BaseCamp_Assistant_ReactingStatue%d" % _i] = NO_PLACE_INTERNAL


def load_tasks():
    text = TASKS_JS.read_text(encoding="utf-8")
    data = json.loads(text[text.index("["): text.rindex("]") + 1])
    return text, data


def is_minigame(t):
    """判断是否小游戏/赛事。返回 (是否, 原因) —— 原因写进输出便于人工复核。"""
    key = str(t.get("key") or "")
    # ★ 白名单优先：这 6 条虽然 key/名字带 MiniGame、Circuit、SkyRingChallenge 字样，
    #   但它们是**正式的迷你挑战**，必须留在任务板块。
    if key in KEEP_MINIGAME_KEYS:
        return False, None
    if MINIGAME_PAT.search(key):
        return True, "key 匹配赛事模式: %s" % key
    blob = (t.get("name") or "") + " " + str(t.get("npc") or "")
    if MINIGAME_HINT.search(blob):
        return True, "名称/NPC 含小游戏特征词"
    return False, None


# 哨兵坐标：ROM 里少数步骤用 (0,0,0) 表示「这一步没有位置信息」
# （实测 4 条任务各 1 个，例如「献给可秋拉的小夜曲」最后一步 Reach）
# ★ 必须过滤，否则会被当成真实坐标画到地图原点(海拉鲁中心)，流程线跑到错地方。
SENTINEL = (0.0, 0.0, 0.0)


def dedup_flow(t):
    """流程坐标去重。★ 两件事必须做：
    1. 过滤哨兵坐标 (0,0,0) —— ROM 用它表示「此步无位置」
    2. 去重 —— ROM一步里常给多个完全同坐标的点，
       不去重会让两点距离=0 → 虚线长度为0 → 线画不出来。
    """
    pts = []
    for s in (t.get("steps") or []):
        for p in (s.get("pts") or []):
            pts.append(p)
    seen = {}
    for p in pts:
        k = (p.get("gx"), p.get("gy"), p.get("gz"))
        if k[0] is None:
            continue
        if all(v is not None and float(v) == 0.0 for v in k):
            continue  # ★ 哨兵
        seen.setdefault(k, p)
    # 顺序按首次出现，保持 ROM 的叙事顺序（不要按坐标排序）
    order = []
    for p in pts:
        k = (p.get("gx"), p.get("gy"), p.get("gz"))
        if k[0] is None:
            continue
        if all(v is not None and float(v) == 0.0 for v in k):
            continue
        if k not in order:
            order.append(k)
    ordered = [seen[k] for k in order]
    return ordered


def flow_tier(n):
    return "L1" if n >= 2 else ("L2" if n == 1 else "L3")


# ===================================================================
# 界面分类 = 游戏官方四档（2026-10-07 老大定调，P11）
# -------------------------------------------------------------------
# 起因：之前用 ROM 的 cat（Main/ImportantMini/Sub/Other 四档），
# 与游戏「冒险笔记」里的分类对不上——用户按分类筛任务时找不到东西。
#
# ★ 判据改成 ROM 的 sort 字段（SortIndex）——它本身就编码了游戏分类。
#   实测三档精确命中官方数（这是决定性证据）：
#     sort < 100      → 主剧情挑战  23 条  官方 23✅
#     100 ~ 999       → 情节挑战    60 条  官方 60 ✅
#     1000 ~ 4999     → 神庙挑战    31 条  官方 31 ✅
#     >= 5000         → 迷你挑战   139 条  官方 139✅
#
#   各档实测范围：主剧情 2–92 / 情节 111–803 / 神庙 2191–3073 / 迷你 5111–7205。
#   区间之间有大量空档（1000~2190、3074~5110），说明这是**分类编号**不是排序权重。
#
# 为什么 sort 比 group/kindCn 都可靠：
#   · sort 是 ROM 挑战表里的原生字段，作者按官方分类顺序填的
#   · cat 只有四档，是ROM 的粗粒度归类，把迷你挑战塞进了 Other
#   · oldCat/kindCn 来自社区攻略标点，会写错
#     （实测「来自地底的呼唤」攻略标"迷你挑战"，但 sort=792 → 情节挑战）
#
# 顺带解决了挂很久的悬案：见上。
GROUP_ORDER = ["主剧情挑战", "情节挑战", "神庙挑战", "迷你挑战"]

# sort 区间→ 官方分类名。上界用开区间，None 代表无上界。
SORT_BANDS = [
    (100, "主剧情挑战"),
    (1000, "情节挑战"),
    (5000, "神庙挑战"),
    (None, "迷你挑战"),
]

# 旧口径（按 ROM cat 兜底）——只在 sort 缺失时用。
# 理论上不该走到：实测 254 条全有 sort。留着是为了将来新增数据源时兜底不崩。
CAT_FALLBACK = {
    "Main": "主剧情挑战",
    "ImportantMini": "情节挑战",
    "Sub": "神庙挑战",
    "Other": "迷你挑战",
}

_sort_warned = set()


def group_of(t):
    """任务 → 游戏官方分类。判据：ROM 的 sort 字段。"""
    s = t.get("sort")
    if s is None:
        # sort 缺失：按 ROM cat 兜底，并 warn 一次（同类只warn 一次，别刷屏）
        key = str(t.get("key") or "?")
        if key not in _sort_warned:
            _sort_warned.add(key)
            sys.stderr.write(
                "[warn] sort 缺失，group_of 退回按 ROM cat 推断: %s (cat=%s)\n"
                % (key, t.get("cat"))
            )
        return CAT_FALLBACK.get(t.get("cat"), "迷你挑战")
    s = int(s)
    for upper, name in SORT_BANDS:
        if upper is None or s < upper:
            return name
    return "迷你挑战"


def drop_self_reference(t, reqs):
    """剔除「前置条件＝自己」（台账 P1，2026-10-07）。

    ROM 的 DependFlagName 里有一类flag 是「**本任务自己的启动条件**」，
    不是前置任务。从 flag 反推 key 时会切出**本任务的 key**，
    于是卡片上出现「前置条件＝未建成的马厩」这种荒唐结果（任务=未建成的马厩）。

    实测 3 条：
      未建成的马厩   flag=BuildingMaterialsTutorial_CanBeStart
      马儿去向何方   flag=FindWhiteHorse_CanStart_Exp
      来自古代的信息 flag=ZonauReliefSearch_Ready

    连带伤害：decorate_unlocks 的反向索引（谁依赖我）会把这个自指当 legit 前置，
    于是「完成后解锁」也变成自己 —— 同一个根因、两个表现。
    所以 **reqs 和 unlocks 都要过一遍**这个函数：前者是「我要先做什么」，
    后者是「我做完解锁什么」，自指时两者都指向自己。

    ★ 为什么两层都改：
      extract_quests.py 里也加了同样过滤（那是真正该修的地方），
      但 tasks.js 是**已生成的产物**，重跑 extract 要全量重解 ROM。
      这里补一道是为了让修法**立刻生效**、且不依赖重跑上游。
      两层逻辑一致、幂等，重复过滤不会出问题（第二次已无自指）。

    降级而非丢弃：这类 flag 携带信息（「满足条件后才可开始」），
    降级成 type=flag 后卡片显示灰字条件提示、不给跳转链接，
    与现有 flag 型的展示口径一致。
    """
    own = t.get("key")
    if not own or not reqs:
        return reqs
    out = []
    for rq in reqs:
        if rq.get("type") == "quest" and rq.get("key") == own:
            rq["type"] = "flag"
            rq["selfRef"] = True      # 留痕，便于日后核对时识别
            rq["linkable"] = False    # 明确不给跳转链接
        out.append(rq)
    return out


def drop_self_unlocks(t, unlocks):
    """剔除「解锁＝自己」（台账 P1 的第二个表现）。

    unlocks 来自 extract_quests.py 的 dependents 反向索引：
    谁在 requires 里引用了我，我就解锁谁。当某条任务的 requires 是自指时，
    反向索引会把「自己」登记成自己的解锁方→ 卡片上「完成后解锁＝自己」。

    unlockList 的项结构是 {key, reqName, linkable}，**没有 type 字段**，
    所以不能复用 drop_self_reference（那个判 type=='quest'）。
    这里是整条丢弃而不是降级：unlockList 只用于「完成后解锁」这一行展示，
    留一条「解锁自己」没有意义（那个 flag 信息已在 reqs 里以灰字呈现）。
    """
    own = t.get("key")
    if not own or not unlocks:
        return unlocks
    return [u for u in unlocks if u.get("key") != own]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    if not (args.dry or args.write):
        ap.error("必须指定 --dry 或 --write")

    text, tasks = load_tasks()
    print("读入 %d 条任务" % len(tasks))

    # ---------- 1. 剔除小游戏 + 人工确认的废条目 ----------
    keep, dropped = [], []
    n_manual = 0
    for t in tasks:
        hit, why = is_minigame(t)
        if hit:
            dropped.append((t, why))
        elif DROP_KEY_PAT.match(str(t.get("key") or "")):
            dropped.append((t, "人工剔除（空壳/重复）"))
            n_manual += 1
        else:
            keep.append(t)
    print("\n【1】剔除小游戏/赛事 %d 条（其中人工剔除空壳+重复 %d 条）"
          % (len(dropped), n_manual))
    for t, why in dropped[:30]:
        print("    %-30s key=%-32s %s" % ((t.get("name") or "")[:30],
                                       str(t.get("key"))[:32], why))
    if len(dropped) > 30:
        print("    … 另有 %d 条" % (len(dropped) - 30))

    # ---------- 2. 重复检查（结论：不合并，只标记）----------
    #★ 2026-10-06 实测结论：不存在真重复，**不能合并**。
    #  之前报告里说的「4 条重复 key（Npc_BaseCamp_Assistant_ReactingStatue）」是**错的**，
    #  实测 tasks.js 里 key 全不重复、name 全不重复。
    #  真正重复的是 **markerId 被多条任务共用**（4 组 × 3 条 = 12 条），但那是
    #  「攻略作者把几个不同任务的攻略写进了同一个玩家标点」，它们：
    #    - key 不同（DefeatHugeEnemy_4/5/6、ExcavateFossil1/2/3 …）
    #    - 坐标不同（分布在不同地区，实测与 marker 坐标全部不同点）
    #    - 是完全不同的任务
    #  → 合并会把不同地区的任务揉成一条，数据反而被破坏。**保持独立。**
    #
    #  真正需要注意的是 GetSensorPlus / GetWalker 这2 条：同坐标（同在实验台），
    #  地图上会重叠成一个点。界面需处理重叠（见下方 byPoint 聚合）。
    bykey = Counter(t.get("key") for t in keep if t.get("key"))
    dupkeys = [k for k, v in bykey.items() if v > 1]
    print("\n【2】重复性检查")
    print("    重复 key：%s" % (dupkeys if dupkeys else "无（0 个）"))
    byname = Counter(t.get("name") for t in keep)
    dupnames = [k for k, v in byname.items() if v > 1]
    print("    重复 name：%s" % (dupnames if dupnames else "无（0 个）"))

    # markerId 共用 = 攻略写在一起，但任务本身独立
    bymid = defaultdict(list)
    for t in keep:
        if t.get("markerId"):
            bymid[t["markerId"]].append(t)
    shared = {k: v for k, v in bymid.items() if len(v) > 1}
    print("    markerId 被多条共用：%d 组（这些是独立任务，**不合并**）" % len(shared))

    # 同坐标重叠 = 界面上会叠成一个点，需要 special 处理
    bypoint = defaultdict(list)
    for t in keep:
        if t.get("gx") is not None and t.get("gz") is not None:
            bypoint[(t["gx"], t["gz"])].append(t)
    overlap = {k: v for k, v in bypoint.items() if len(v) > 1}
    print("    同坐标重叠：%d 处（界面需合并成一个点+ 分条列清）" % len(overlap))
    for pt, items in overlap.items():
        print("      @(%s, %s): %s" % (pt[0], pt[1],
                                        " · ".join(i["name"][:18] for i in items)))
    merged = keep

    # ---------- 3. 分组 + 流程档位 ----------
    # ★ 前置关系解析：requires[] 的字段是 {type, key, flag, resolved}，**没有 name**。
    #   - type='quest' → key 是任务 key，实测 76/76 全部能在 tasks.js 里查到官方中文名，
    #     所以可以补出 reqName 让界面给跳转链接。
    #   - type='flag'  → 只有 flag 字符串（游戏内部条件标记，共 14 种），
    #     不是任务名，**界面不给链接**，灰字显示。
    key2name = {t.get("key"): t.get("name") for t in merged if t.get("key")}

    def decorate_requires(t):
        out = []
        for r in (t.get("requires") or []):
            k = r.get("key")
            o = {"type": r.get("type")}
            if r.get("type") == "quest":
                o["key"] = k
                o["reqName"] = key2name.get(k)          # 76/76 可解析
                o["linkable"] = o["reqName"] is not None  # 解析不到就不给链接
            else:
                o["flag"] = r.get("flag")
                o["linkable"] = False                   # ★ flag 永不给链接
            out.append(o)
        return out

    def decorate_unlocks(t):
        out = []
        for u in (t.get("unlocks") or []):
            if isinstance(u, str):
                out.append({"key": u, "reqName": key2name.get(u),
                            "linkable": key2name.get(u) is not None})
            elif isinstance(u, dict):
                k = u.get("key")
                out.append({"key": k, "reqName": key2name.get(k),
                            "linkable": key2name.get(k) is not None})
        return out

    for t in merged:
        pts = dedup_flow(t)
        t["_flowPts"] = pts
        t["_flowN"] = len(pts)
        t["_tier"] = flow_tier(len(pts))
        t["_group"] = group_of(t)
        # 可上图判定
        # ★ (0,0) 不是空值，是海拉鲁城堡中心。tasks.js 里 posValid 对这类
        #   没兜住（GetMasterSword 的 ROM 点就是 0,0），直接放行会把导航
        #   传到城中心。这里补一道与 armors.py 同样的排除。
        t["_onMap"] = bool(t.get("posValid") and t.get("gx") is not None
                          and t.get("gz") is not None
                          and not (abs(t.get("gx", 0)) < 1 and abs(t.get("gz", 0)) < 1))
        # ★ 无坐标原因：说明白「为什么这里没坐标」，让 L1 体检别把它当缺陷。
        #   没有坐标的任务里，只有本表列出的那些是「本来就该没有」；
        #   其余的一律留空，让 WARN 继续报——那是真待修。
        t["_noPlaceReason"] = NO_PLACE_REASON.get(t.get("key"))
        # ★ 同坐标重叠：地图上会叠成一个点，卡片里要分条列清
        t["_overlap"] = [o["name"] for o in overlap.get((t.get("gx"), t.get("gz")), [])
                         if o is not t]
        t["_reqs"] = drop_self_reference(t, decorate_requires(t))
        t["_unlocks"] = drop_self_unlocks(t, decorate_unlocks(t))
        # ---------- 官方分步清洗（M3.1）----------
        # ★ ROM 的 steps 是「事件触发器数组」不是「玩家步骤列表」：
        #   600/1077 条是空壳（Ready / Collect2nd 这类纯钩子，占号但无字），
        #   12 条文字完全重复（Minus1st~Minus6th 共用一段），
        #   327 条含未替换的游戏变量占位符。
        #   早期卡片直接i+1 编号 → 空壳照样占号，序号与文字整体错位。
        # 清洗后另存 stepsUI，**原始 steps 一字不改**（M4 流程线要用它的 pts）。
        t["_stepsUI"] = clean_steps(t)
        t["_hasStepText"] = bool(t["_stepsUI"])
        # nStepsUI = 玩家真正看到的步数（卡片顶部「N 步」用这个）
        t["_nStepsUI"] = len(t["_stepsUI"])

    print("\n【3】按任务种类分组（ROM 权威 cat，非自编）")
    grp = defaultdict(list)
    for t in merged:
        grp[t["_group"]].append(t)
    for g in GROUP_ORDER:
        if g not in grp:
            continue
        items = grp[g]
        tc = Counter(i["_tier"] for i in items)
        onmap = sum(1 for i in items if i["_onMap"])
        print("  【%s】%d 条  (L1可画线 %d / L2单点 %d / L3仅列表 %d)  可上图 %d"
              % (g, len(items), tc["L1"], tc["L2"], tc["L3"], onmap))

    print("\n    分组内的子类型分布（数据溯源用）：")
    for g in GROUP_ORDER:
        if g not in grp:
            continue
        cc = Counter(i.get("cat") for i in grp[g])
        kc = Counter(i.get("kind") for i in grp[g])
        print("      %-6s cat=%s kind=%s" % (g, dict(cc), dict(kc)))

    # ---------- 4. 抽样明细 ----------
    print("\n【4】L1（可画流程线）任务全列表")
    l1 = [t for t in merged if t["_tier"] == "L1"]
    l1.sort(key=lambda t: -t["_flowN"])
    for t in l1:
        print("   %-30s %-6s %d点 steps=%-3s %s" %
              ((t.get("name") or "")[:30], t["_group"], t["_flowN"],
               t.get("nSteps"), t.get("cat")))
    print("   共 %d 条" % len(l1))

    print("\n【5】L3（仅列表）里仍可上图的（卡片有名字但没坐标）")
    l3map = [t for t in merged if t["_tier"] == "L3" and t["_onMap"]]
    print("   %d 条 —— 全部为单点任务（有一个主坐标，但流程里只有 1 个点）" % len(l3map))

    # ---------- 5. 可上图统计 ----------
    print("\n【6】上图可行性")
    print("   posValid=true且有坐标：%d / %d" % (sum(1 for t in merged if t["_onMap"]), len(merged)))
    nopos = [t for t in merged if not t["_onMap"]]
    if nopos:
        print("   不能上图的 %d 条：" % len(nopos))
        for t in nopos[:10]:
            print("      %-28s posValid=%s gx=%s" % (
                (t.get("name") or "")[:28], t.get("posValid"), t.get("gx")))

    # ---------- 6. 前置关系类型 ----------
    print("\n【7】前置关系 type 分布（flag 型不给链接）")
    tc = Counter()
    for t in merged:
        for r in (t.get("requires") or []):
            tc[r.get("type")] += 1
    print("   ", dict(tc))
    #★ flag 型的标识字段叫flag（不是 name），且 key/resolved 可能为 null
    flagset = defaultdict(int)
    for t in merged:
        for r in (t.get("requires") or []):
            if r.get("type") == "flag":
                flagset[str(r.get("flag"))[:46]] += 1
    print("   flag 共%d 种，最常见的：" % len(flagset))
    for k, v in sorted(flagset.items(), key=lambda x: -x[1])[:6]:
        print("      %-46s 被引用%d 次" % (k, v))
    # quest 型是否有 name/可跳转
    qmiss = 0
    for t in merged:
        for r in (t.get("requires") or []):
            if r.get("type") == "quest" and not r.get("name"):
                qmiss += 1
    print("   quest 型缺 name（不可跳转）: %d 条" % qmiss)

    # 解析率统计（写进输出，便于验收）
    print("\n【8】前置跳转可解析率")
    qr = [x for t in merged for x in t["_reqs"] if x["type"] == "quest"]
    fr = [x for t in merged for x in t["_reqs"] if x["type"] == "flag"]
    print("   quest 型 %d 条，可跳转 %d 条（%.0f%%）"
          % (len(qr), sum(1 for x in qr if x["linkable"]),
             100.0 * sum(1 for x in qr if x["linkable"]) / max(1, len(qr))))
    print("   flag  型 %d 条，全部不给链接（正确）" % len(fr))
    ur = [x for t in merged for x in t["_unlocks"]]
    print("   unlocks %d 条，可跳转 %d 条"
          % (len(ur), sum(1 for x in ur if x["linkable"])))

    # ---------- 8b. 官方分步清洗统计 ----------
    print("\n【9】官方分步清洗（喂给卡片的是 stepsUI，不是原始 steps）")
    agg = [0, 0, 0, 0, 0]
    for t in merged:
        a, b, c, d, e = step_stats(t)
        for i, v in enumerate((a, b, c, d, e)):
            agg[i] += v
    print("   原始步骤 %d → 清洗后 %d（砍掉 %.0f%%）"
          % (agg[0], agg[4], 100.0 * (agg[0] - agg[4]) / max(1, agg[0])))
    print("   空壳 %d / 重复 %d / 脏字符 %d" % (agg[1], agg[2], agg[3]))
    nose = [t for t in merged if not t["_hasStepText"]]
    print("   无可展示分步：%d 个（其中官方中文词条本身不存在 %d 个）"
          % (len(nose), sum(1 for t in nose if t.get("nameSrc") == "key")))
    # 零分步但有坐标的任务：卡片只显示坐标 + 攻略，不能给玩家一个空的「官方分步」
    for t in nose[:6]:
        print("      %-30s key=%-30s steps=%s onMap=%s"
              % ((t.get("name") or "")[:30], str(t.get("key"))[:30],
                 t.get("nSteps"), t["_onMap"]))

    # ---------- 写出 ----------
    if args.write:
        out = []
        for t in merged:
            o = {k: v for k, v in t.items() if not k.startswith("_")}
            o["group"] = t["_group"]
            o["tier"] = t["_tier"]
            o["flowPts"] = [{"gx": p.get("gx"), "gy": p.get("gy"), "gz": p.get("gz")}
                            for p in t["_flowPts"]]
            o["onMap"] = t["_onMap"]
            o["overlap"] = t["_overlap"]
            # 无坐标原因（仅当确实无法获得坐标时才有值）
            if t["_noPlaceReason"]:
                o["noPlaceReason"] = t["_noPlaceReason"]
            o["reqs"] = t["_reqs"]
            o["unlockList"] = t["_unlocks"]
            # 展示用分步（已清洗）；原始 steps 保留在 o["steps"] 供 M4 流程线用
            o["stepsUI"] = t["_stepsUI"]
            o["nStepsUI"] = t["_nStepsUI"]
            o["hasStepText"] = t["_hasStepText"]
            out.append(o)
        body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        OUT_JS.write_text(
            "/* 自动生成，请勿手改。\n"
            "   生成器：tools/build_task_plan.py\n"
            "   上游：app/data/tasks.js（ROM 权威）\n"
            "   group=任务种类（ROM cat）；tier=流程档位（自动判定，界面不显示）\n"
            "*/\nwindow.TOTK_TASK_PLAN=%s;\n" % body,
            encoding="utf-8")
        print("\n已写出 %s（%d 条）" % (OUT_JS, len(out)))
    else:
        print("\n(dry-run，未写文件)")


if __name__ == "__main__":
    sys.exit(main())