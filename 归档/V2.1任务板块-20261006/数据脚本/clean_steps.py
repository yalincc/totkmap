#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""官方分步清洗（V2.1 M3.1）
================================================================
为什么需要这个模块
------------------
ROM 的 `Steps` 数组**不是「玩家步骤列表」，是「事件触发器数组」**。
每个 Step 代表一个触发点，未必带文案。三类脏数据混在里面：

  1. 空壳步骤（600/1077 条，285 个任务全中）
     典型：`Ready`（任务开始钩子）、`Collect2rd`/`Minus2nd`（中途计数点）
     —— 它们只是给引擎一个「到这里改一下进度」的位置，
        MSBT 词条里对应的 Label 是空的，**游戏内也不会显示任何文字**。
     ★ 早期卡片直接 `i+1` 编号，空壳照样占号，
       于是「来自地底的呼唤」显示成 1=空 2=正文 3=正文 4=空 5=正文 —— 看起来像错位。

  2. 文字完全重复（12 条/ 8 个任务）
     ROM 里`Minus1st`~`Minus6th` 六个触发点共用同一段文案
     （游戏内是「随进度刷新的一段话」，不是六个步骤）。
     实测「来自地底的呼唤」Minus1st/3rd/4th/5th/6th 五条一字不差。

  3. 未替换的游戏变量占位符 + 控制字符（327 条 / 203 个任务）
     形如 `已把　:Connect_FirstIsland_TotalPart￿촀只眼睛投入了深穴`
     —— `:Xxx￿촀` 是游戏运行时的动态数值（计数），
     静态 MSBT 里拿不到真值，`￿촀` 是U+FFFF 类残留，必须处理掉。

本模块的处置原则：**宁缺勿错**
  - 空壳 → 直接丢（游戏内也不显示，留着只会错位）
  - 重复 → 同任务内按文字去重，保留首次出现（保持 ROM 叙事顺序）
  - 占位符 → 整段删除，不猜数值。删完若该句变成空壳，也一并丢
  - 原始 `steps` **一个字节都不改**：M4 流程线要用它的 `pts`（坐标）

用法：
    from clean_steps import clean_steps
    ui = clean_steps(task)          # -> [{name, text}, ...]
    ui = clean_steps(task, keep_pts=True)   # -> [{name, text, pts}, ...]
"""
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 脏字符

# 控制字符（保留 \n=0x0A 与 \t=0x09，它们是 extract_quests 有意保留的换行/缩进）
CTRL = re.compile(r"[\x00-\x08\x0b-\x1f]")
# U+FFFE / U+FFFF —— MSBT 的字符串终止符漏进正文
TERM = re.compile(r"[\ufffe\uffff]")
# 私用区残留：\ucd00 落在韩文谚文区（CJK 扩展 A 之后的音节区），
# 显然是解码器把 MSBT 的插值标记错映射过去了）。实测全库 13 处，
# 固定跟在 U+FFFF 后面当占位符尾巴用。
PUA = re.compile(r"[\ucd00-\ucfff\ue000-\uf8ff]")

# 游戏变量占位符。
# MSBT 里的动态插值写法：`<空白><变量名><U+FFFF><私用区尾巴>`，例如
#   已把　:Connect_FirstIsland_TotalPart\uffff\uc7c0只眼睛投入了深穴
#   并把　DConnect_FirstIsland_TotalPartMinus\uffff\uc7c0只眼睛运到了…
# 变量值是运行时动态计数，静态 MSBT 里拿不到真值 → 整段删除，不猜。
# 三种前缀都见过：`:Var`（带冒号）/ `DVar`（Minus 类）/ `Var`（裸名）。
PLACEHOLDER = re.compile(
    r"[ \u3000]*[:\uff1a]?[A-Za-z_][A-Za-z0-9_]*[\uffff][\ucd00-\ucfff\ue000-\uf8ff]?"
)
# 兜底：任何 U+FFFF / 私用区残留一律删掉（防止正则没覆盖到的形态漏网）
ORPHAN_MARK = re.compile(r"[\ufffe\uffff\ucd00-\ucfff\ue000-\uf8ff]+")
# U+FFFD REPLACEMENT CHARACTER —— 解码失败痕迹
REPL = "\ufffd"

# 变量占位符被删后，句子会缺数字：「已把[4]只眼睛」→「已把只眼睛」。
# 静态数据拿不到那个动态计数（游戏内是随进度刷新的），
# 宁缺勿错→ 补一个「（数量）」占位说明，让玩家知道这里本来有数字。
# 只在**确实删掉了占位符**的位置补，不做全文量词猜测（实测 214 处命中里
# 绝大多数是「一座神庙」「一个朋友」这类正常量词，不能乱加）。
COUNT_GAP = re.compile(r"([把座只个条张片棵根枚份位])\s*([一-龥])")

# 清洗后若只剩标点/空白，视为空壳
PUNCT_ONLY = re.compile(r"^[\s，。、；：！？…—·「」『』（）()\-–—\.]*$")


# 量词：占位符紧贴在量词左边 = 这个量词的数字是运行时变量，删掉后要标注。
# 例「已把:Var￿촀只眼睛」——「把」后是数字位，「只」前也是。
# 严格限定：PLACEHOLDER 匹配处的前一个字符必须是量词，才补标注。
QUANT = re.compile(r"[把座只个条张片棵根枚份位]")


def _scrub(text, mark_gap=False):
    """去掉控制字符、终止符、私用区残留、游戏变量占位符，压掉残留空格。

    mark_gap=True 时，在「删掉占位符留下数字空洞」的位置补「（数量）」标注。
    """
    if not text:
        return ""
    s = text
    # 占位符紧跟在量词/数字位上时，删掉会留下病句，先打标记再删
    if mark_gap:
        def _repl(m):
            # 紧贴量词的占位符 = 缺失的数字位，补标注
            if m.start() > 0 and QUANT.match(s[m.start() - 1]):
                return "（数量）"
            return ""
        s = PLACEHOLDER.sub(_repl, s)
    s = ORPHAN_MARK.sub("", s)   # 兜底删残留标记（含未被PLACEHOLDER覆盖的形态）
    s = CTRL.sub("", s)          # 再删控制字符
    s = s.replace(REPL, "")   # 解码失败痕迹
    # 占位符被删后常留下一串孤立空格：「已把  4只眼睛」→「已把 4只眼睛」
    s = re.sub(r"[ \t]{2,}", " ", s)
    # 行尾空格 + 全行空白行
    s = "\n".join(line.rstrip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = s.strip()
    return s


def _is_shell(text):
    """空文本 or清洗后只剩标点 → 视为空壳，丢弃。"""
    if not text or not text.strip():
        return True
    return bool(PUNCT_ONLY.match(text.strip()))


def clean_steps(task, keep_pts=False):
    """把某个任务的 steps 清洗成「可直接给玩家看的官方分步」。

    参数
    ----
    task     : tasks.js / task-plan.js 里的一条任务记录
    keep_pts : True 时每步带上 pts（M4 流程线用；列表展示不需要，可省体积）

    返回
    ----
    [{name, text(, pts)}, ...]  顺序 = ROM 原始顺序（不要重排，叙事顺序有信息量）
    """
    out = []
    seen = set()
    for st in (task.get("steps") or []):
        raw = st.get("text") or ""
        if not raw.strip():
            continue                      # ← 空壳，直接丢（占号元凶）
        text = _scrub(raw, mark_gap=True)
        if _is_shell(text):
            continue                      # ← 清洗完变空壳（整句只有占位符）
        # 同任务内按「清洗后的文字」去重 —— 顺序敏感的重复才是真冗余
        key = text
        if key in seen:
            continue
        seen.add(key)
        item = {"name": st.get("name") or "", "text": text}
        if keep_pts:
            item["pts"] = st.get("pts") or []
        out.append(item)
    return out


def step_stats(task):
    """体检：返回 (原始条数, 空壳数, 重复数, 脏字符数, 清洗后条数)。

    用途：验收脚本和 --dry 输出，确保清洗逻辑没有把正常步骤误伤。
    """
    steps = task.get("steps") or []
    total = len(steps)
    empty = sum(1 for s in steps if not (s.get("text") or "").strip())
    dirty = sum(1 for s in steps
                if CTRL.search(s.get("text") or "")
                or ORPHAN_MARK.search(s.get("text") or ""))
    texts = [_scrub(s.get("text") or "") for s in steps
             if not _is_shell(_scrub(s.get("text") or ""))]
    dup = len(texts) - len(set(texts))
    return total, empty, dup, dirty, len(clean_steps(task))


# ---------------------------------------------------------------- 自检
if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    import json

    root = Path(__file__).resolve().parent.parent
    src = (root / "app" / "data" / "tasks.js").read_text(encoding="utf-8")
    tasks = json.loads(src[src.index("["):src.rindex("]") + 1])

    t0 = e0 = d0 = c0 = n0 = 0
    zero = []
    for t in tasks:
        a, b, c, d, e = step_stats(t)
        t0 += a; e0 += b; d0 += d; c0 += c; n0 += e
        if e == 0:
            zero.append(t)

    print("=== 官方分步清洗体检 ===")
    print("任务总数            %d" % len(tasks))
    print("原始步骤            %d" % t0)
    print("  空壳              %d  (%.0f%%)"
          % (e0, 100.0 * e0 / max(1, t0)))
    print("  文字完全重复      %d" % c0)
    print("  含脏字符/占位符   %d" % d0)
    print("清洗后步骤          %d  (砍掉 %.0f%%)"
          % (n0, 100.0 * (t0 - n0) / max(1, t0)))
    print()
    print("清洗后为 0 步的任务 %d 个：" % len(zero))
    src_none = sum(1 for t in zero if t.get("nameSrc") == "key")
    print("  其中官方中文词条文件本身不存在（nameSrc=key）: %d" % src_none)
    print("  → 这些是迷你挑战/赛事/佣兵支线，游戏内也没有任务文本")
    for t in zero[:40]:
        print("   %-34s key=%-32s steps=%d"
              % ((t.get("name") or "")[:34], str(t.get("key"))[:32], t.get("nSteps")))
