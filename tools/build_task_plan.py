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
}
# ★ 2026-10-07：IchikaraDaughterPhoto「普莉珂的秘密基地」已按老大决定**删除**
#   （它是卡卡利科村的村庄任务，不是迷你挑战，官方 139 条名单里没有），
#   所以它的 noPlaceReason 也一并撤掉——留着就是给一条不存在的任务写注释。
# ROM 内部事件：不是玩家可接的任务，key 本身就是内部名。
# ★ 注意有一条是**无后缀**的（Npc_BaseCamp_Assistant_ReactingStatue），
#   只循环 1~4 会漏掉它，体检就会一直报 1 条 WARN。
NO_PLACE_INTERNAL = "ROM 内部事件（背景触发器），玩家不可接取，不该上图"
NO_PLACE_REASON["Npc_BaseCamp_Assistant_ReactingStatue"] = NO_PLACE_INTERNAL
for _i in (1, 2, 3, 4):
    NO_PLACE_REASON["Npc_BaseCamp_Assistant_ReactingStatue%d" % _i] = NO_PLACE_INTERNAL


# ------------------------------------------------------------------ NPC 别名修正
# ★ 为什么需要（老大 2026-10-07 校对后拍板）
#   `ActorMsg/Npc.msbt` 只有 101 条，且 key 命名与 `RequestActor` 对不上，
#   所以 253 条任务里 228 条 `npcCn` 是空的（老欠账）。
#   这里**只补 DS 校对确认过的**，不做全量猜译——猜错的 NPC 名比空着更糟。
#
#   判据（不是"看着像"）：ROM 的 EventFlowMsg 里同一个 RequestActor
#   在该任务步骤文本中明确被点名，才算确认。
#     「龙之泪」MemoryOfTheDragon → Npc_Wanderer @ NewHyruleWestHatago
#       ROM 步骤 2 原文：「在忘却神殿的入口见到了博嘉多」
#       事件池同名条目：MemoryOfTheDragon_GoTemple2_Npc_Wanderer_LostTemple
#       → Npc_Wanderer 在本任务语境下就是**博嘉多**（Heba）。
#       ★ 注意 Npc_Wanderer 是通用「旅人」actor 名，别处未必是博嘉多，
#         所以这里按 **任务 key** 精确指定，不用 actor 名全局替换。
NPC_CN_FIX = {
    "MemoryOfTheDragon": "博嘉多",
    # 「今天的菜单」CookAtBaseCamp：ROM 的 RequestActor = Npc_BaseCamp001，
    #   老大 2026-10-07 核查 = **波侬**（Burmano），监视堡垒避难壕内灶台旁的厨师。
    #   佐证：guide.start 原文「找到波侬，他会因为菜单缺少材料而苦恼」，
    #   且 stepsUI 原文「在监视堡垒的避难壕中遇到了负责做饭的波侬」——
    #   ROM 的 actor 名与中文文本里的 NPC 名一致，可确认。
    "CookAtBaseCamp": "波侬",
    # 「看马人的愿望」TakeAnimals：ROM 的 RequestActor = Npc_HyruleDepthHatago007，
    #   老大 2026-10-07 档案 = **陀特茨**（Toffa），平原外围驿站马厩旁的年迈看马人。
    #   佐证：guide.start 原文「到驿站找陀特茨，老头想见见骨头马」——
    #   ROM 的 actor 名与攻略文本里的 NPC 名一致，可确认。
    "TakeAnimals": "陀特茨",
    # 「装点平原外围的驿站的画作」PhotoSpot_Challenge_04：
    #   ROM 的 RequestActor = Npc_HyruleDepthHatago005，
    #   老大 2026-10-07 档案 = **英布利**（Embry），平原外围的驿站主人。
    #   ★ 这是「装点…驿站的画作」系列 15 条里的一条，全系列都是「调查空画框→NPC 出现→给一张照片」。
    "PhotoSpot_Challenge_04": "英布利",
    # 「装点河畔驿站的画作」PhotoSpot_Challenge_05：
    #   ROM 的 RequestActor = Npc_RiverSideHatago003，
    #   老大 2026-10-07 档案 = **玛肯保**（Ember），河畔驿站的主人。
    #   ★ 音译「玛肯保」与英文 Ember 字面（余烬）对不上，
    #   但同一系列另外4 条已确认的驿站点名（帕莉塞/比鞑/英布利/玛肯保）
    #   都是官方中文译名风格，不按英文音译——保持一致。
    "PhotoSpot_Challenge_05": "玛肯保",
    # 「向往的搬运马车」HorseInnChallenge_001（老大 2026-10-07 档案）：
    #   ROM 的 RequestActor = Npc_HyruleWestHatago001，
    #   老大档案 = **可姿米**（Kozumi），新玛丽塔驿站外的女性 NPC。
    #   ★ 不用改流程点：老大档案里**没给野马的具体坐标**（只说「驿站东边的草原」），
    #     按「宁可少一个点也别编」的规矩不补——改成在攻略里用文字描述方位。
    "HorseInnChallenge001": "可姿米",
}


# ------------------------------------------------------------------ 人工补的攻略文本
# ★ MANUAL_REQUIRES / NPC_CN_FIX / FLAG_CN 的姊妹表：**补攻略正文**。
#   什么时候用这张表：
#     · 攻略侧（guide）某栏写「无」或太简略，但人工查到了完整流程
#     · 攻略与 ROM 步骤矛盾，需要人工裁定（同时在 task-card.js 的
#       GUIDE_NOTE_SUSPECT 里标警示）
#   字段与 tasks.js 的 guide 结构一致，**只填非空项**，没写的沿用原值。
#
#   ★ 为什么不直接改 tasks.js：那是上游抽取产物，重跑 extract_quests.py 就没了。
#     人工补充一律放这里，跟 MANUAL_REQUIRES 同一个道理。
# ★ 措辞纪律（老大 2026-10-07 定）：**卡片位置不大，攻略要短**。
#   老大给的资料往往是最全的版本（步骤、坐标、后续全都有），
#   但卡片上只放**玩家做这件事必需的三件事**：
#     如何接取（一句话：在哪找谁）· 注意事项（一个关键点）· 任务奖励（一句话）
#   苹果树的精确坐标、后续波侬出现在城堡食堂这类「补充信息」**不进卡片**，
#   除非它影响玩家能不能做（缺苹果卡住→ 怎么获取必须写进「注意事项」）。
MANUAL_GUIDE = {
    # 「今天的菜单」CookAtBaseCamp（老大 2026-10-07 提供完整档案，卡片版按精简口径）
    #   完整版里还有：果园精确坐标、苹果 12 卢比、波侬后续出现在城堡食堂、
    #   水果拌蘑菇恢复 2 颗心—— 都不进卡片。
    #   ★ 唯一保留的「获取途径」是因为**没有它玩家会卡住**（避难壕里买不到苹果）。
    "CookAtBaseCamp": {
        "start": "监视堡垒避难壕，与厨师波侬对话。",
        "note": "提前准备好苹果（地表商人穆贝处有卖）。",
        "reward": ["一份「水果拌蘑菇」"],
    },
    # ── WANTED 系列（老大 2026-10-07 提供完整档案，按精简口径）────────
    # 6 条共用同一个接取 NPC（谷拉廉斯，避难壕地图桌旁），只是分两批：
    #   第一梯队 5115~5117 → 对话选「大型怪物的情报」
    #   第二梯队 5118~5120 → 第一梯队全做完后再对话，选「未知怪物的情报」
    #   6 条全做完 → 找谷拉廉斯领讨伐勋章
    # ★ 每条的「注意事项」只写**打它的核心手法**（一句话）——
    #   传送点坐标、备用武器、属性药这些都不进卡片，卡片放不下也没必要。
    #   「怎么打到」是玩家真正会卡住的地方；「从哪飞过去」有地图导航就够了。
    "DefeatHugeEnemy_1": {   # 岩石巨人
        "start": "监视堡垒避难壕，与谷拉廉斯对话选「大型怪物的情报」。",
        "note": "打它头顶的矿石，用炸弹花或锤类武器。",
        "reward": ["银卢比"],
    },
    "DefeatHugeEnemy_2": {   # 莫尔德拉吉克
        "start": "监视堡垒避难壕，与谷拉廉斯对话选「大型怪物的情报」。",
        "note": "站在高处往沙地投炸弹花，把它引出来；别站在沙地上。",
        "reward": ["银卢比"],
    },
    "DefeatHugeEnemy_3": {   # 西诺克斯
        "start": "监视堡垒避难壕，与谷拉廉斯对话选「大型怪物的情报」。",
        "note": "射它的眼睛，它会捂眼倒地，趁机上前输出。",
        "reward": ["银卢比"],
    },
    "DefeatHugeEnemy_4": {   # 未知的天空巨人（方块魔像）
        "start": "第一梯队全完成后，与谷拉廉斯对话选「未知怪物的情报」。",
        "note": "用究极手拆掉它的方块，或直接打碎发光的方块核心。",
        "reward": ["100 卢比"],
    },
    "DefeatHugeEnemy_5": {   # 未知的三首之怪物（古栗欧克）
        "start": "第一梯队全完成后，与谷拉廉斯对话选「未知怪物的情报」。",
        "note": "三个头属性不同，备好防火/防寒/防电药；先射眼睛让它倒地。",
        "reward": ["100 卢比"],
    },
    "DefeatHugeEnemy_6": {   # 未知的巨大之影（巨霸迦马）
        "start": "第一梯队全完成后，与谷拉廉斯对话选「未知怪物的情报」。",
        "note": "先射眼睛让它倒地，再打它背上的矿石。",
        "reward": ["100 卢比"],
    },
    # ── 「看马人的愿望」TakeAnimals（老大 2026-10-07 提供完整档案）────
    # **两阶段任务**，卡片上要把两个阶段说清（否则玩家以为做完一阶段就结束了）：
    #   ① 驯骷髅马 → 回驿站交 → 紫卢比 50 + 驿站点数
    #   ② 驯鹿（或熊）→ 回驿站交 → 银卢比 100 + 驿站点数
    # ★ 精简口径：**只留会让玩家卡住 / 失败的点**——
    #   「骷髅马只在夜间、凌晨 5 点消失」「鹿中途下马就跑」这两条是**真会白跑**的坑，
    #   必须写；「潜行套装、从高处滑翔伞落到鹿背」是技巧，可省。
    "TakeAnimals": {
        "start": "平原外围驿站马厩旁，与看马人陀特茨对话接取。",
        "note": "两阶段：先驯骷髅马交差，再驯鹿（或熊）交差。\n"
                "① 骷髅马只在夜间出现，**凌晨 5 点消失**，务必天亮前骑回驿站；\n"
                "② 鹿骑上后**千万别中途下马**，一下马它就跑了。",
        "reward": ["紫卢比 50 + 1 点驿站点数（完成骷髅马阶段）",
                    "银卢比 100 + 1 点驿站点数（完成鹿阶段）"],
    },
    # ── 「装点…驿站的画作」系列（14 条同结构）────────────────────
    # 全系列玩法一样：进驿站 → 调查空画框 → NPC 出现 → 去某地拍一张照 → 回来给他。
    # 所以**「如何接取」和「注意事项」全系列共用一份文案**，
    # 变的只有「去哪儿拍」（各条 ROM 自带note，本表不覆盖）。
    #
    # 「装点平原外围的驿站的画作」：拍萨托利山顶的樱花树（老大 2026-10-07 档案）。
    #   ★ 它是**跑点任务**（驿站 → 萨托利山），坐标已补进 MANUAL_FLOW_PTS。
    "PhotoSpot_Challenge_04": {
        "start": "进平原外围的驿站，调查墙上的空画框，与驿站主人英布利对话。",
        "note": "去**萨托利山山顶**拍那棵巨大的樱花树，再回驿站把照片给英布利。\n"
                "没有照相机的话，画框只有留言，任务触发不了。",
        "reward": ["1 点驿站点数", "蛋挞"],
    },
    # 「装点河畔驿站的画作」PhotoSpot_Challenge_05（老大 2026-10-07 档案）
    #   原guide 的 note 只说「在初始空岛时之神殿中拍摄」，
    #   但没说**怎么算拍对**——玩家会白跑：
    #   画面里没出现红色感叹号提示 =照片不算数，任务不通过。
    #   这条正是「会让玩家白跑」的典型，按精简口径必须写。
    #   拍摄点位见 MANUAL_FLOW_PTS（初始台地·时之神殿遗迹）。
    "PhotoSpot_Challenge_05": {
        "start": "进河畔驿站，调查墙上的空画框，与驿站主人玛肯保对话。",
        "note": "去**地表初始台地的时之神殿遗迹**拍大女神像（位置见地图流程线）。\n"
                "⚠ **别去空岛天空中的那座时之神殿**——同名，但不是这个任务要的。\n"
                "① 照片里必须出现「时之神殿像」的**红色感叹号提示**才算有效，否则不通过；\n"
                "② 忘却神殿的母亲女神像**同样能交**，去过忘却神殿的话那张更好拍；\n"
                "③ 没有照相机的话，画框只有留言，任务触发不了。",
        "reward": ["1 点驿站点数", "精力炒螃蟹"],
    },
    # 「向往的搬运马车」HorseInnChallenge_001（老大 2026-10-07 档案）
    #   原 guide 的note 是一句话，玩家不知道**野马在哪**、也**怎么驯**。
    #   ★ 野马没坐标（档案只说「驿站东边的草原」）→ 不补流程点，
    #     改成在攻略里用方位文字描述（见note 第 ② 条）。
    "HorseInnChallenge001": {
        "start": "新玛丽塔驿站门口，与可姿米对话接取任务。",
        "note": "两件事：\n"
                "① **修马车**：驿站旁地上放着两个车轮，用**究极手**把它们装到马车的轮轴上。\n"
                "② **驯野马**：野马在**驿站东边的草原上**。\n"
                "⚠ **必须蹲下从背后慢慢接近**——正面靠近它会受惊直接跑掉，"
                "这是最容易白跑的一点；出现骑乘提示后按 A 键上马，再连按 L 键安抚。",
        "reward": ["银卢比 100"],
    },
    # 「捕捉咕咕鸡大作战」HorseInnChallenge005（老大 2026-10-07 档案）
    #   原 guide 只有两句话（「与贝黎斯对话」/「将驿站周围的咕咕鸡抓回鸡圈里」），
    #   玩家不知道鸡在**哪**、也**怎么抓**。
    #   ★ 5 个点位写进 MANUAL_FLOW_PTS（地图连线），攻略不重复列坐标——
    #     卡片空间有限，流程线已经承载「去哪」的信息。
    "HorseInnChallenge005": {
        "start": "河畔驿站鸡圈旁，与贝黎斯对话接取任务。",
        "note": "5 只咕咕鸡的位置见**地图流程线**（驿站周围 5 个点）。\n"
                "① 咕咕鸡**不能用究极手抓**，只能靠近后按 A 键抱起；\n"
                "② 抱着鸡**不能游泳**——⑤ 在河中央石头上，必须用究极手"
                "把木板拼成桥走过去；\n"
                "③ ③ 在驿站屋顶马头装饰上，要从驿站内部用**通天术**穿上去。",
        "reward": ["银卢比 100"],
    },
}


# ------------------------------------------------------------------ 人工补的前置条件
# ★ 这是「人工手写任务内容」的正式落脚点（老大 2026-10-07拍板）。
#   以后一条一条校对任务，查到的新前置 / 修正的措辞，都往这张表里加，
#   加完重跑管线即可。**不要手改 app/data/task-plan.js**（生成物，会被冲掉）。
#
# ── 为什么要它 ────────────────────────────────────────────────
#   前置条件有三类来源，能力各不相同：
#     A · ROM 抽取  —— 权威，但① 有自指（`XXX_CanBeStart` 指回自己）
#                    ② flag 名是英文（`Complete_Two_SageChallenges`）
#     B · 网上攻略  —— 有中文，但常写「无」，且可能与 ROM 冲突
#     C · 人工校对  —— **唯一能补「条件型前置」**
#   A+B 都推不出来的，只能靠 C。全库14 种 flag 前置里，
#   真正「条件型」（不是某条任务，而是一个达成状态）的都归这一类。
#
# ── 写法 ──────────────────────────────────────────────────────
#   key = 任务 key（不是任务名！用 name2key 反查，别手写中文名）
#   值 = 前置列表，每条：
#     type='flag' → 条件型：灰字显示、**不给跳转链接**（它不是一条任务）
#                   必须写 reqName（中文说明），否则卡片显示英文 flag 名
#     type='quest' → 任务型：给跳转链接，key 必须能在 tasks.js 里查到
#
# ── 措辞约定（老大 2026-10-07 定）────────────────────────────
#   「主线神殿」=「贤者挑战」，两者同一个东西，统一写「主线贤者挑战」，
#   与 ROM flag 里的 `SageChallenges` 一致，且能套用 1 个 / 2 个 / 3 个。
#
#   不记来源（老大定）：都是随手上网能复核的，不搞 provenance 字段。
#
# 「装点…驿站的画作」系列共用的前置（14 条全一样，抽成常量免得写14 遍）
# ★ 只列PhotoSpot_Challenge_09 / _09_2：它们是「装点封闭驿站的画作」
#   的**两幅画**（同一条任务的两环，sort 5961/5962，共用同一个 NPC 与画框），
#   老大档案只覆盖了另外 14 条，这两条的触发条件按同样口径推断为「有照相机」，
#   但**未经确认**，先不写；要写的话老大确认一声即可。
_CAMERA_PRE = [
    {"type": "flag", "reqName": "完成任意 1 个主线神殿（解锁照相机）"},
]

MANUAL_REQUIRES = {
    # 「未建成的马厩」：ROM 只给了自指的 BuildingMaterialsTutorial_CanBeStart，
    #   攻略「前置任务」栏写「无」→ A/B 都推不出，纯条件型，只能人工写。
    #   老大手工确认：需通关任意 1 个主线贤者挑战。
    "BuildingMaterialsTutorial": [
        {"type": "flag", "reqName": "通关 1 个主线贤者挑战"},
    ],
    # 「马儿去向何方」：ROM 里其实**有**这个 flag（Complete_Two_SageChallenges，
    #   「遭遇海盗袭击的村庄」身上用过同一个），只是没挂到本任务上。
    #   老大确认口径 = 至少通关 2 个主线贤者挑战。
    #   ★ 另一条前置「未建成的马厩」已由guide.requires 自动并入，不在此重复写。
    "FindWhiteHorse": [
        {"type": "flag", "reqName": "通关 2 个主线贤者挑战"},
    ],
    # 「今天的菜单」CookAtBaseCamp：ROM 的 requires 为空，攻略也没写前置。
    #   老大 2026-10-07 核查 = 完成主线「海拉鲁城堡的异变」（sort=6）解锁避难壕入口。
    #   ★ 这是**任务型**前置（不是条件型）→ 给跳转链接，玩家能直接点开那条主线。
    "CookAtBaseCamp": [
        {"type": "quest", "key": "HyruleCastleIncident", "reqName": "海拉鲁城堡的异变"},
    ],
    # 「捕捉咕咕鸡大作战」HorseInnChallenge005（老大 2026-10-07 档案）：
    #   前置 = 情节挑战「未抵达的美食家」（Tribune04，sort=312）。
    #   ROM 的requires 为空、攻略也没写 → 人工补。
    #   用 quest 型（可点击跳转），因为它确实指向库内另一条任务。
    "HorseInnChallenge005": [
        {"type": "quest", "key": "Tribune04", "reqName": "未抵达的美食家"},
    ],
    # ── WANTED 系列（老大 2026-10-07 提供完整档案）────────────────
    # 系列结构（监视堡垒避难壕，讨伐队发布，谷拉廉斯接单）：
    #   「为〇〇带来和平！」×6（sort 451~456）→ WANTED 第一梯队×3（5115~5117）
    #   → 第二梯队「未知」×3（5118~5120）→ 全部完成给讨伐勋章
    #
    # 第一梯队的 3 条：**任一**和平挑战即可（不是要全部完成），
    #所以是条件型前置（flag），给不了跳转链接。
    "DefeatHugeEnemy_1": [
        {"type": "flag", "reqName": "完成任意一条「为〇〇带来和平！」"},
    ],
    "DefeatHugeEnemy_2": [
        {"type": "flag", "reqName": "完成任意一条「为〇〇带来和平！」"},
    ],
    "DefeatHugeEnemy_3": [
        {"type": "flag", "reqName": "完成任意一条「为〇〇带来和平！」"},
    ],
    # 第二梯队的 3 条：需第一梯队**全部 3 条**完成。
    # ★ 原数据是错的：guide.requires 写了 ['岩石巨人','西诺克斯','莫尔德拉吉克WANTED']，
    #   但 name2key 反查时前两个匹配不上（库里叫「岩石巨人WANTED」「西诺克斯WANTED」，
    #   攻略侧少WANTED 后缀），于是只并进来 1 条 → 卡片上显示
    #   「前置条件 · 莫尔德拉吉克WANTED」，看起来只要做一条。
    #   老大 2026-10-07 档案明确：**第一梯队全部 3 条**完成后才能接第二梯队。
    #   修法：用 quest 型显式列全 3 条，每条都能点开（比条件型更好——玩家能直接跳去看）。
    "DefeatHugeEnemy_4": [
        {"type": "quest", "key": "DefeatHugeEnemy_1", "reqName": "岩石巨人WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_3", "reqName": "西诺克斯WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_2", "reqName": "莫尔德拉吉克WANTED"},
    ],
    "DefeatHugeEnemy_5": [
        {"type": "quest", "key": "DefeatHugeEnemy_1", "reqName": "岩石巨人WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_3", "reqName": "西诺克斯WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_2", "reqName": "莫尔德拉吉克WANTED"},
    ],
    "DefeatHugeEnemy_6": [
        {"type": "quest", "key": "DefeatHugeEnemy_1", "reqName": "岩石巨人WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_3", "reqName": "西诺克斯WANTED"},
        {"type": "quest", "key": "DefeatHugeEnemy_2", "reqName": "莫尔德拉吉克WANTED"},
    ],
    # ── 「装点…驿站的画作」系列（PhotoSpot_Challenge_01~14）──────────
    # 老大 2026-10-07 档案（装点平原外围的驿站的画作）确认的全系列共用前置：
    #   **完成任意一个主线神殿（解锁照相机功能）**。
    #   没有它，调查空画框只会看到 NPC 留言，任务根本触发不了。
    # ROM 里没有对应 flag（查过：全库无Camera/Photo 相关 flag，
    #  唯一沾边的是「装点南阿卡莱驿站的画作」的 PhotospotChallenge_Is_Available，
    #   那是"拍照挑战已解锁"不是"有照相机"），所以只能人工写条件型。
    # ★ 给成**系列通用**：这 14 条全都得先有照相机。
    "PhotoSpot_Challenge_01": _CAMERA_PRE,
    "PhotoSpot_Challenge_02": _CAMERA_PRE,
    "PhotoSpot_Challenge_03": _CAMERA_PRE,
    "PhotoSpot_Challenge_04": _CAMERA_PRE,
    "PhotoSpot_Challenge_05": _CAMERA_PRE,
    "PhotoSpot_Challenge_06": _CAMERA_PRE,
    "PhotoSpot_Challenge_07": _CAMERA_PRE,
    "PhotoSpot_Challenge_08": _CAMERA_PRE,
    "PhotoSpot_Challenge_10": _CAMERA_PRE,
    "PhotoSpot_Challenge_11": _CAMERA_PRE,
    "PhotoSpot_Challenge_12": _CAMERA_PRE,
    "PhotoSpot_Challenge_13": _CAMERA_PRE,
    "PhotoSpot_Challenge_14": _CAMERA_PRE,
}


# ------------------------------------------------------------------ 人工钉住任务图层
# ★ 判层 bug 的人工覆盖（老大 2026-10-07 拍板走人工路线）。
#
# ── 问题 ──────────────────────────────────────────────────────
#   「未知的天空巨人」在**西海布拉天空诸岛**（高度 544），却被判成地表，
#   定位时飞到地面找不到。根因是数据源头的 `layer_of()` 用 `gy >= 700` 硬阈值：
#     天空任务高度分布 248~2002，地面最高 1563 —— **700 这条线本身就不成立**。
#
# ── 为什么不能自动修（2026-10-07 实测，两套方案都否决）────────
#   ① 复用 live-python / live-go 的 `layer_of()`（900+多边形+600m天空标记）
#      → **64 条受影响**，把「一击入魂」(h=307马厩旁)、「装点南阿卡莱驿站的画作」
#      (h=309 驿站旁) 这些明显在地面的判成天空。
#      根因：那条「600 米内有天空标点」对**玩家**合理（人不会站驿站里），
#      对**任务**太宽——任何靠近天空标点的地面任务都中招。
#   ② 只用多边形判 → **23 条受影响**，仍双向出错。
#      根因：`area_sky.js` 64 个轮廓里**混进了 3 个地面区域**
#      （`Pln_Fld_Rito_SkyField_Start_01`、`Pln_Fld_Zora_SkyField_Before_DungeonWay`、
#      `StartIslandMerge2`），所以「沉睡于海布拉山西北的洞窟中的水晶」(h=620 地面)
#      也会命中天空多边形。
#   → 多边形要补全得先攻BYML v7（V1.8.1 文档记为独立课题），人工先上。
#
# ── 用法 ──────────────────────────────────────────────────────
#   key = 任务 key；值 = 正确图层（18 地表 / 19 地底 / 20 天空）。
#   **只写需要纠正的**，不在表里的保持自动判层结果。
#   逐条校对确定后往这里加，重跑管线即可。
#
# ── 判据（人工裁决时用）────────────────────────────────────────
#   · 任务名带「天空诸岛/神庙与水晶」且高度 >900 → 天空
#   · 高度 < 500 → 地表（山highest 地面约 1563 在海布拉山/格鲁德高地）
#   · 500~900 之间 → 看任务性质：龙之泪三预言、天空诸岛讨伐 = 天空
#   · 拿不准的先不动，标到台账里等实测
#
MANUAL_LAYERS = {
    # ── 已确认（老大 2026-10-07）────────────────────────────────
    # 「未知的天空巨人」：官方步骤明写「在海布拉地区的**西海布拉天空诸岛**
    #   成功打倒了被称为天空巨人的方块魔像」，高度 544 → 天空。
    #   它是**跨层**任务：另一个流程点 h=113.5 在海拉鲁城堡（回谷拉廉斯交差），
    #   那个点仍属地表，所以 layers 要给 [18, 20]。
    "DefeatHugeEnemy_4": [18, 20],
}
# ★★ 2026-10-07 全库复核结论：**只有上面这一条需要修，其余自动判层都是对的。**
#
#   双向核查方法（可复现）：
#     正向「该判天空却判了地表」：高度>500 且任务名含「天空/空岛/诸岛/云」
#       → 命中 1 条「前往天空的线索」(h=505)。**核实后确认不用修**：
#       它只有一个流程点，是「去水之桥打听线索」的地面任务，
#       名字里的「天空」是**目标**（通往天空的线索）不是发生地，判地表正确。
#     反向「判了天空但名字像地面」：命中 11 条
#       （紧闭之门 / 利特村的丘栗 / 卓拉领地的希多 / 寻找塞尔达 /
#        海利亚湖的神庙与水晶 / 采石之岛的神庙与水晶 / 超高难度的死亡之山赛道 /
#        洛美岛·南洛美·北洛美的预言 / 巡遍所有神庙之人）
#       → 逐个核实**全部是真天空任务**，只是任务名没带「天空」二字
#       （初始空岛、洛美岛、云中神庙…），判天空正确。
#
#   ⇒ 所以 `layer_of()` 的 `gy >= 700` 阈值**在实际数据上基本成立**，
#     不必改成文档建议的 ~500（那会误判 18 条地面任务）。
#     **不要因为「理论上不严谨」就去动它** —— 实测数据比理论可靠。
#     这张表留给以后真正发现错判的任务，按task key 逐条加。


# ------------------------------------------------------------------ 人工补的流程点
# ★ 第 5 张表（2026-10-07 老大提供《看马人的愿望》档案时新增）。
#
# ── 为什么需要 ────────────────────────────────────────────────
#   `_flowPts` 来自 ROM 的 `steps[].pts`，只给「事件触发点」。
#   但有一类任务**要去不止一个地方**，ROM 只记了其中一个：
#   「看马人的愿望」要跑三个地点——
#     ① 平原外围驿站（接任务 / 交两阶段） ② 撒丁公园遗迹（驯骷髅马）
#     ③ 达拉伊特森林（驯鹿，备选）
#   ROM 只给了驿站那一个点 → `_flowN=1` → 判成 **L2 单点**，
#   卡片底部明说「这个任务只有 1 个地点，无需连线」，
#   玩家看不到「还要去北边的遗迹跑一趟」。
#
# ── 价值 ──────────────────────────────────────────────────────
#   补上后 `_flowN >= 2` → 自动升为 **L1 可画流程线**，
#   地图上出现「驿站 → 撒丁公园遗迹」的连线，一眼看出这是个跑点任务。
#   这正是「多点任务显示流程线」这个功能的用途。
#
# ── 坐标口径（**必须用游戏 UI 坐标，三段都写**）──────────────
#   写 `{X, Z, H}` 三个数：X 东西、Z 南北、**H 高度**（游戏 HUD 口径）。
#   内部换算 gx=X、gz=-Z、gy=H+106（106 = 实测基准差，见「坐标与地图速查」）。
#   ★ 老大给的档案坐标是**四段式** `-1688, -0680, 0124`，
#     前两段是 X/Z、**第三段 0124 就是高度**——我第一次漏读了它，
#     导致补出来的点 gy=None（layerOfY 返回 null，三层判层都可能跳过它）。
#     所以脚本现在**缺 H 就跳过并打印警告**，不制造脏数据。
#   ★ 没给坐标的地点**不要写**（如达拉伊特森林），宁可少一个点也别编。
#
MANUAL_FLOW_PTS = {
    # 「看马人的愿望」TakeAnimals（老大 2026-10-07 档案）
    #   驿站坐标与 ROM 已有的一致（X-1449 Z-1251），这里**只补缺的第二点**。
    "TakeAnimals": [
        # 撒丁公园遗迹（骷髅马出没地，仅夜间）
        # 老大档案原文「坐标约为 -1688, -0680, 0124」—— 第四段就是 UI 高度 124。
        {"X": -1688, "Z": -680, "H": 124},
    ],
    # 「装点平原外围的驿站的画作」PhotoSpot_Challenge_04（老大 2026-10-07 档案）
    #   要跑两个点：驿站（调查空画框接任务）→ 萨托利山山顶（拍樱花树）。
    #   ROM 只给了驿站那一个点 → L2 单点，看不出还要上山。
    #   档案原文「樱花树坐标：-2299, -0341, 0350」，第三段 0350 就是 UI 高度 350
    #   （萨托利山山顶约 350 米，量级也对得上）。
    "PhotoSpot_Challenge_04": [
        {"X": -2299, "Z": -341, "H": 350},     # 萨托利山山顶·巨大樱花树
    ],
    # 「装点河畔驿站的画作」PhotoSpot_Challenge_05（老大 2026-10-07 档案）
    #   要跑两个点：河畔驿站（调查空画框接任务）→ 地表·初始台地时之神殿遗迹（拍大女神像）。
    #   ROM 只给了驿站那一个点 → L2 单点，看不出还要飞到大女神像那儿。
    #
    # ★★ 2026-10-07 老大纠正过一次（重要，别再填错）：
    #   我第一版填的是「X 453 / Z -783 / H 1466」——那是**天空层**的时之神殿
    #   （初始空岛上那座，高度 1466 米），**不是这个任务要拍的地方**。
    #   本任务要拍的是**地表初始台地·时之神殿遗迹内**的大女神像：
    #     · 游民星空图文攻略：驿站老板说的「西南方的大女神像」=初始台地时之神殿遗迹里那尊
    #     · Game8：时之神殿遗迹(Temple of Time Ruins) 坐标 -0819, -2014, 0117
    #     · Gamerant：遗迹内女神像坐标 (-0823, -2029, 0119)
    #   两个源相差 31 米（都在女神像那一带，量级对）。
    #   老大 2026-10-07 23:52 明确指定用 **Gamerant** 那组（遗迹内**女神像本体**，更精确）。
    #   教训：档案里给的坐标**要看高度和地名对不对得上**——
    #   1466 米明显是天空，玩家却要"传送+ 滑翔"到地表，不能只看数字照抄。
    "PhotoSpot_Challenge_05": [
        {"X": -823, "Z": -2029, "H": 119},  # 地表·初始台地时之神殿遗迹·大女神像
    ],
    # 「捕捉咕咕鸡大作战」HorseInnChallenge_005（老大 2026-10-07 档案）
    #   要跑 **5 只鸡的所在处** + 驿站交差，ROM 只给了驿站那一个点。
    #   不补点的话卡片只说「1 个地点」，玩家完全不知道要满驿站周边找鸡——
    #   而「鸡在哪」正是这任务 100% 的内容。
    #   补点后 flowN=6 → 升 L1 → 地图画出「驿站 → ① → ② → ③ → ④ → ⑤」连线。
    #
    # ★ 排序按档案里给的 ①~⑤ 顺序（叙事顺序），不要按坐标重排——
    #   ⑤ 在河中央（要搭桥），放最后符合玩家实际推进顺序。
    # ★ 高度用档案给的第三段（如 0037 = 37米，驿站屋顶马头装饰）。
    "HorseInnChallenge005": [
        {"X": 352, "Z": -1073, "H": 9},    # ① 乐团客席附近
        {"X": 344, "Z": -1101, "H": 10},   # ② 驿站内部（商人特里旁）
        {"X": 335, "Z": -1090, "H": 37},   # ③ 驿站屋顶马头装饰（要通天术）
        {"X": 319, "Z": -1126, "H": 17},   # ④ 建材堆旁的树上
        {"X": 382, "Z": -1148, "H": 10},   # ⑤ 河中央的遗迹石（要搭桥）
    ],
}


def is_self_flag(req, own_key):
    """判断一条前置是不是「自指」（ROM 的坑，不是真前置）。

    自指的两种形态（★ 两种都要认）：
      ① type=quest 且 key == 自己        —— drop_self_reference 会转成 flag+selfRef
      ② type=flag且 flag 名以自己的 key 开头 —— 上游 extract_quests 直接给的
         实测：「未建成的马厩」BuildingMaterialsTutorial_CanBeStart
                「马儿去向何方」  FindWhiteHorse_CanStart_Exp
         这种**没有 selfRef 标记**（decorate 阶段已丢），只能靠 flag 前缀反推。

    为什么必须删：卡片会显示成「前置条件 · 未建成的马厩」，
    而任务名也是未建成的马厩 —— 玩家以为要再做一个自己。
    """
    if req.get("type") != "flag":
        return req.get("key") == own_key and own_key is not None
    if req.get("selfRef"):
        return True
    flag = str(req.get("flag") or "")
    return bool(own_key) and flag.startswith(own_key)


# ------------------------------------------------------------------ flag 前置的中文名
# ★ MANUAL_REQUIRES 的「按任务」版本，这里是「按 flag」版本。
#   为什么需要两张：全库 25 条 flag 前置只对应 **15 种 flag**，
#   其中 `EnemyKilled_AccidentOfDekutree` 一条就被 7 条任务共用。
#   按 flag 填一次 = 补 7 条，按任务填要写 7遍。
#
#   语义：flag 名 →玩家该看到的中文条件说明。
#   ★ **不猜**：flag 名虽然能读出大概（如 Complete_Two_SageChallenges
#     ⇒ 通关2个贤者挑战），但「贤者挑战」和「神殿」是不是同一件事、
#     数量对不对，必须人工确认。**猜错前置比留空更糟**——
#     留空玩家知道这没查，错了他会照着一个错条件白跑。
#     所以这张表只放**已确认**的，没确认的留空并进体检 WARN。
#
FLAG_CN = {
    # ✓ 已确认（老大 2026-10-07）
    "Complete_Two_SageChallenges": "通关 2 个主线贤者挑战",
    # ✓ 已确认：打倒德克树长老（主线「丢失的勇者之剑」那个节点）。
    #   **一条覆盖 7 条任务** —— 这就是为什么要按 flag 而不是按任务填。
    #   佐证：flag 名 EnemyKilled_AccidentOfDekutree（Accident = 德克树长老的异变），
    #   且共用它的 7 条任务里包含 GetMasterSword（sort=8，主线丢剑），
    #   sort=5311~5313 的三条迷你挑战也都排在主线之后。
    "EnemyKilled_AccidentOfDekutree": "打倒德克树长老",
    # ✓ 已确认：哈特诺村的初次事件（村长选举剧情）。
    #   **一条覆盖 4 条任务**，且四条正是村长选举的四环（sort 212~215）：
    #   用新名产振兴村子 / 科沙尤西的秘密 / 萨格诺的秘密 / 你是萨格诺派？还是科沙尤西派？
    #   交叉佐证：GameWith 攻略写「『新名物で村おこし』的发生条件：先发生『あなたサゴノ派クサヨシ派』」，
    #   攻略侧这4 条也确实互串了guide.requires。
    "Hateno_FirstEvent_Inside": "哈特诺村的初次事件（村长选举）",
    # ── 以下 8 个由老大 2026-10-07 联网逐条核查确认 ──────────────
    # Rito_Npc_AfterSecretStoneOrAfterSong：
    #   我原推测「找到密石或听完歌之后」，方向接近但不准确 ——
    #   实际是**通关风之神殿**（完成利特村主线）后才能触发这两个迷你挑战。
    "Rito_Npc_AfterSecretStoneOrAfterSong": "通关风之神殿后",
    # ZonauReliefSearch_Ready：老大核实**不是自指**（Ready 只是任务首步骤名，
    #   flag 作用是控制里德乌在监视堡垒出现），所以保留、不删。
    "ZonauReliefSearch_Ready": "与监视堡垒的里德乌对话后",
    # Hateno_ChallengeComplete_04：不是「完成前 3 环」，而是**全部 4 个**
    #   哈特诺村情节挑战（科沙尤西的秘密 / 萨格诺的秘密 / 托可优的重要信件 /
    #   你是萨格诺派还是科沙尤西派）完成后，第 5 个挑战自动触发。
    "Hateno_ChallengeComplete_04": "完成哈特诺村全部情节挑战后",
    "Step_SageOfFire_VillagersSchedule": "推进火之神殿主线后",
    "Clear_GerudoCanyon_ColdEnduranceComparison": "完成格鲁德峡谷的寒冷耐力比赛后",
    "Gerudo_NpcOasis001_CameGerudo": "首次到访格鲁德小镇后",
    "HatenoVillage_FinaleEvent": "完成哈特诺村长选举后",
    # 沃托里村重建链的两个 flag（老大核查后确认挂在这两条**不同**任务上）：
    #   Revive_FinaleEvent_Finish → 沃托里度假胜地计划 (sort 5731)
    #   Revive_Restaurant_Event   → 爸爸的蓝色衬衫(sort 5732)
    # 区分措辞：前者是「整个重建完成」，后者只是「餐厅这一环」。
    # 两条都再挂上攻略侧的「横暴之徒盘踞的村子」，三层一起看才完整。
    "Revive_FinaleEvent_Finish": "完成沃托里村重建后",
    "Revive_Restaurant_Event": "完成沃托里村餐厅重建后",
}
# ⚠ 老大 2026-10-07 核实为「公开攻略查不到、可能是 ROM 内部状态标记」的，**刻意留空**：
#   BaseCamp_ReturnedAway_01  /  BaseCamp_UndergroundPassage_Exp
#   PhotospotChallenge_Is_Available  /  Revive_FinaleEvent_Finish
#   —— 查不到不是错，填一个猜的更糟。查证到了再往上面补。


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
    # ★ 攻略侧的任务名 → key 反查表（2026-10-07新增，P2）
    name2key = {}
    for t in merged:
        k = t.get("key")
        if not k:
            continue
        nm = (t.get("name") or "").strip()
        # 同名只取第一个（实测无重名；有的话也不该硬取，交给人工裁决）
        if nm and nm not in name2key:
            name2key[nm] = k

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
                # ★ flag 中文名：优先用 merge 脚本塞的 reqName，
                #   否则查FLAG_CN（按 flag 批量补，25 条前置只对应 15 种 flag）。
                #   两处都没有 → 留空，进体检 WARN 等待人工补，**不猜**。
                o["reqName"] = r.get("reqName") or FLAG_CN.get(r.get("flag"))
                o["linkable"] = False                   # ★ flag 永不给链接
            out.append(o)

        # ---------- ★★攻略侧前置并入（P2，2026-10-07）----------
        # 起因：「马儿去向何方」的真实前置是「未建成的马厩」，
        # **攻略里明明写着**（guide.requires），但我们只读 ROM 的 requires，
        # 正确答案被扔掉、留了个错的（自指）。
        #
        # 实测全库：攻略侧有前置 56 条，其中能反查到 task key 的 23 条：
        #   · 18 条 ROM 无 quest 前置、攻略有 → **纯增量，白捡**
        #   ·  4 条 两边完全一致        → 跳过
        #   ·  3 条 两边冲突            → **ROM 优先**（见下）
        #   · 33 条 反查不到（写的是「完成主线」这类文字）→ 跳过
        #
        # ★★ 冲突判定：ROM 侧**已有任何 quest 型前置**就整条跳过攻略，
        #   不是只比 key 是否相同。
        #   我第一版只查 `k in gset`（key 是否重复），结果 3 条冲突全被加进去，
        #   「永无止境的说教」变成前置有两个（卓拉领地的希多 + 友好之证）。
        #   ★ 与 group_of() 用 sort 作判据是同一套口径：ROM 原生字段优先于社区攻略。
        #   依据不是猜，两条都能自证：
        #     「永无止境的说教」ROM 前置=卓拉领地的希多（主线 sort=46），
        #       攻略说=友好之证（sort=5618）——攻略那条比它晚 6 号，不可能是前置；
        #       官方步骤也提到"感谢你拯救了领地"（承接主线）。
        #     「第八位英雄」ROM 前置=英雄们的秘密（sort=5911）紧挨 5915，
        #       攻略说=迷路的商队队员（sort=5923）——在它之后，也不可能。
        gset = set()
        rom_q = 0
        for r in out:
            if r.get("type") == "quest" and r.get("key"):
                gset.add(r["key"])
                rom_q += 1
        own = t.get("key")
        for nm in ((t.get("guide") or {}).get("requires") or []) if rom_q == 0 else []:
            nm = str(nm).strip()
            if not nm:
                continue
            k = name2key.get(nm)
            if not k or k == own:      # 反查不到 / 自指 → 跳过
                continue
            if k in gset:              # 重复 → 跳过
                continue
            out.append({"type": "quest", "key": k, "reqName": key2name.get(k),
                        "linkable": True, "src": "guide"})
            gset.add(k)

        # ---------- ★★ 人工补的前置（MANUAL_REQUIRES，最后一道，优先级最高）----------
        # 为什么放最后：它要**替换**掉前面留下的自指项，不是追加。
        #   「未建成的马厩」ROM 给的是 `BuildingMaterialsTutorial_CanBeStart`，
        #   展开后 type=flag、key 指向自己 → 卡片会显示
        #   「前置条件 · 未建成的马厩」，玩家以为要再做一个自己。
        #   真实前置是「通关 1 个主线贤者挑战」，ROM 和攻略都推不出来。
        #
        # 规则：
        #   ① 先删掉**所有自指**项 —— 它们是 ROM 的坑，不是真前置
        #      ★ 必须按 `selfRef` 判，不能按 `key ==自己`：
        #         上面的 decorate 把 flag 分支的 key/selfRef 都丢掉了，
        #         只剩 `flag` 字符串，而 flag 名是 `XXX_CanBeStart` 形式，
        #         要靠前缀反推任务 key 才能判自指（见下）。
        man = MANUAL_REQUIRES.get(t.get("key"))
        if man:
            own = t.get("key") or ""
            out = [r for r in out if not is_self_flag(r, own)]
            have = set(r.get("reqName") for r in out if r.get("reqName"))
            for m in man:
                nm = m.get("reqName")
                if nm and nm in have:
                    continue
                item = {"type": m.get("type"), "reqName": nm, "linkable": False}
                if m.get("type") == "quest":
                    item["key"] = m.get("key")
                    item["reqName"] = key2name.get(m.get("key")) or nm
                    item["linkable"] = item["reqName"] is not None
                out.append(item)
                if nm:
                    have.add(nm)
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
        # ---------- ★★ 人工补的流程点（MANUAL_FLOW_PTS）----------
        # ROM 的 steps[].pts 只给事件触发点，像「看马人的愿望」这种
        # 要跑「驿站 → 撒丁公园遗迹 →（备选）达拉伊特森林」的任务，
        # ROM 只记了驿站那一个 → 判成 L2 单点，卡片上说「无需连线」，
        # 玩家看不到还要去北边遗迹跑一趟。
        # 补上后 `_flowN >= 2` → 自动升 L1，地图画出流程线。
        _mf = MANUAL_FLOW_PTS.get(t.get("key"))
        if _mf:
            _before = len(pts)
            for _p in _mf:
                gx, gz, hh = _p.get("X"), _p.get("Z"), _p.get("H")
                if gx is None or gz is None:
                    print("    !! 流程点缺 X/Z，跳过：%r" % (_p,))
                    continue
                # ★ 高度缺不允许：gy=None 会让 layerOfY 返回 null，
                #   该点在地表/地底/天空三层的判层里都可能被跳过
                #   （实测「看马人的愿望」补点后遗留 1 个 null点）。
                #   游戏 UI 坐标是四段式（X Z H 四段里的第三段），
                #   档案里一般都有；确实拿不到就别写这个点。
                if hh is None:
                    print("    !! 流程点缺 H（高度），跳过：X=%s Z=%s" % (gx, gz))
                    continue
                if any(q.get("gx") == gx and q.get("gz") == -gz for q in pts):
                    continue
                pts.append({
                    "gx": gx, "gz": -gz,
                    # 内部 gy = UI 高度 + 106（106 = 实测的游戏 UI 基准差，
                    # 见「坐标与地图速查」）
                    "gy": hh + 106,
                })
            if len(pts) != _before:
                print("    流程点人工补点 %-24s %d -> %d" % (
                    (t.get("name") or "")[:24], _before, len(pts)))
        t["_flowPts"] = pts
        t["_flowN"] = len(pts)
        t["_tier"] = flow_tier(len(pts))
        t["_group"] = group_of(t)
        # ---------- ★★ 人工图层覆盖（MANUAL_LAYERS）----------
        # 上游 tasks.js 的 layers 由extract_quests.py 的 `gy>=700` 硬阈值生成，
        # 那条线不成立（天空 248~2002 / 地面最高 1563），
        # 导致「未知的天空巨人」这类**中高空天空任务被误判成地表**。
        # 人工钉住的在这里改写，不在表里的保持原样。
        # 详见 MANUAL_LAYERS 上方注释（为什么不能自动修、判据是什么）。
        _ml = MANUAL_LAYERS.get(t.get("key"))
        if _ml:
            _old = t.get("layers")
            t["layers"] = list(_ml)
            t["layer"] = _ml[0]        # 主层：取第一个（= 卡片默认展示那层）
            print("    图层人工覆盖 %-24s %s -> %s" % (
                (t.get("name") or "")[:24], _old, _ml))
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
        # ★ NPC 中文名：仅补 DS 校对确认过的（见 NPC_CN_FIX 注释里的判据）。
        #   只在原值为空时填，绝不覆盖上游已抽到的名字。
        if not t.get("npcCn") and t.get("key") in NPC_CN_FIX:
            t["npcCn"] = NPC_CN_FIX[t["key"]]
        # ★ 攻略正文：人工补充的部分**覆盖**同名栏位，没写的沿用上游原值。
        #   （与 NPC_CN_FIX 的"只在空时填"相反：攻略栏位是文本，
        #    人工查到的完整版就该替换掉「无」或过简的原值。）
        mg = MANUAL_GUIDE.get(t.get("key"))
        if mg:
            t["guide"] = dict(t.get("guide") or {})
            for _k, _v in mg.items():
                t["guide"][_k] = _v
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

    # ---------- ★★ 反向解锁链：先算完全部 reqs，再建索引（P2，2026-10-07）----------
    # 为什么要两轮：攻略并入的前置是在 decorate_requires 里逐条加的，
    #   一条任务的「完成后解锁」依赖**别的**任务的 reqs，必须等所有 reqs 定完。
    # 改动前 unlocks 只来自 extract_quests 的 dependents 反向索引（基于 ROM 前置），
    #   实测「有前置无解锁」68 条 —— 攻略补进来的那些前置会没有对应解锁项，
    #   卡片上就出现「A 的前置是 B，但 B 完成后不解锁 A」的矛盾。
    _dep = defaultdict(list)
    for t in merged:
        own = t.get("key")
        if not own:
            continue
        for r in t["_reqs"]:
            if r.get("type") == "quest" and r.get("key") and r["key"] != own:
                _dep[r["key"]].append(own)
    n_add_unlock = 0
    for t in merged:
        tk = t.get("key")
        if not tk:
            continue
        have = set(u.get("key") for u in t["_unlocks"] if u.get("key"))
        for k in _dep.get(tk, []):
            if k in have:
                continue
            t["_unlocks"].append({"key": k, "reqName": key2name.get(k),
                                  "linkable": key2name.get(k) is not None,
                                  "src": "reverse"})
            have.add(k)
            n_add_unlock += 1
    if n_add_unlock:
        print("      反向解锁链：补 %d 条（攻略并入前置带来的）" % n_add_unlock)

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