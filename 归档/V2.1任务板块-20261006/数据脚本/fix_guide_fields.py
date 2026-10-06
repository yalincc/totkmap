# -*- coding: utf-8 -*-
"""
攻略字段修复器（离线）
======================
背景：extract_quests.py 早期用 r"【([^】]{2,8})】" 泛匹配切分 desc，
      把攻略正文里的【地名】（如【依盖队基地】【蜥蜴地洞】）误当成字段名，
      导致 15 条记录的字段值被腰斩。本脚本用白名单重新解析并就地修补 tasks.js。

为什么不用 extract_quests.py 重跑：
      该脚本依赖 zstandard / sarc / byml 三个 ROM 解析库，本机无网络 pip 装不上；
      且 ROM 权威数据（key/cat/steps/requires/romPt…）已经在 tasks.js 里是对的，
      错的只有 guide/raw 这两段「玩家攻略文本」。所以只重解析攻略部分，ROM 数据原样保留。

用法：
  python tools/fix_guide_fields.py            # 修补 tasks.js
  python tools/fix_guide_fields.py --dry      # 只体检不写文件
"""
import sys, os, re, json, pathlib

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(r"E:\WorkSpace\TOTKmap")
TASKS_JS = ROOT / "app" / "data" / "tasks.js"
MARKERS_JS = ROOT / "app" / "data" / "markers.js"

QUEST_CATS = {177, 185, 192, 200, 214}
# ★ 白名单：只有这 5 个是真字段名，正文里的【...】一律当普通文本
GUIDE_FIELDS = ("前置任务", "开启任务", "注意事项", "任务奖励", "解锁任务")
FIELD_RE = re.compile(r"【(" + "|".join(GUIDE_FIELDS) + r")】")


def parse_guide_fields(desc):
    """按白名单字段名切分 desc；段内其余【...】原样保留为正文。"""
    if not desc or "【" not in desc:
        return {}
    marks = [(m.start(), m.end(), m.group(1)) for m in FIELD_RE.finditer(desc)]
    if not marks:
        return {}
    fields = {}
    for i, (_s, e, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(desc)
        val = desc[e:end].strip()
        if name not in fields or (not fields[name] and val):
            fields[name] = val
    return fields


def clean_text(s):
    """清理 HTML 标签与网页残留（与 extract_quests.py 保持一致）"""
    if not s:
        return ""
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</?(div|p|span|b|strong|em)[^>]*>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    s = re.sub(r"点击左下角查看攻略[，。]?", "", s)
    s = re.sub(r"详情可点击左下角的查看攻略[，。]?进行查看", "", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def strip_ps(v):
    """把「无<div>P.s. xxx</div>」这类值里的玩家备注剥离出来。

    攻略里常在「无」之后跟一段 P.s. 补充说明（换武器、别浪费药之类），
    它不是任务名，留在 unlocks/reward 数组里会被当成多条任务。
    ★ 必须先 clean_text 再剥 P.s.：原始值是「无<div>P.s. …</div>」，
      先剥 P.s. 会把尾部 </div> 一起带进备注文本。
    返回 (去掉备注后的正文, 备注文本或 None)。
    """
    if not v:
        return v, None
    v = clean_text(v)
    m = re.search(r"[Pp]\.?\s?s\s*[:：.]\s*", v)
    if not m:
        return v, None
    return v[:m.start()].strip(), clean_text(v[m.end():])


def split_multi(v):
    """一个字段里的多个任务名 -> 数组。

    ★ 与旧版差异：
      1. 先剥 HTML 再判断「无」；
      2. 剥离「P.s. 备注」（旧版会把「无\nP.s. 背一把火属性的武器就行啦」切成三条垃圾）；
      3. 过滤掉切出来的「无」。
    """
    if not v:
        return []
    v, _ps = strip_ps(v)
    if not v or v in ("无", "无。", "-", "—"):
        return []
    parts = re.split(r"[、,，/]\s*", v)
    return [p.strip() for p in parts if p.strip() and p.strip() not in ("无", "无。")]


def load_js_array(path):
    t = path.read_text(encoding="utf-8")
    return json.loads(t[t.index("["): t.rindex("]") + 1])


def save_js_array(path, data, header):
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    path.write_text(header + "window.TOTK_TASKS=" + body + ";\n", encoding="utf-8")


def main():
    dry = "--dry" in sys.argv

    tasks = load_js_array(TASKS_JS)
    markers = {m["id"]: m for m in load_js_array(MARKERS_JS)}

    old_header = TASKS_JS.read_text(encoding="utf-8").split("window.TOTK_TASKS=")[0]

    fixed_fields = 0   # raw 里有假字段 -> 修好
    fixed_unlocks = 0  # unlocks 被切碎的 -> 修好
    touched = []       # (name, 修前 note, 修后 note)

    for t in tasks:
        if t.get("src") not in ("rom+guide", "guide"):
            continue
        mid = t.get("markerId")
        m = markers.get(mid)
        if not m:
            continue
        fields = parse_guide_fields(m.get("desc") or "")
        if not fields:
            continue

        before = dict(t.get("raw") or {})
        if before != fields:
            fixed_fields += 1

        t["raw"] = dict(fields)
        # 各字段里的「P.s. 备注」统一并入 note（它们是攻略作者的补充说明，不是任务名）
        ps_parts = []
        for f in ("前置任务", "开启任务", "注意事项", "任务奖励", "解锁任务"):
            if fields.get(f):
                _body, ps = strip_ps(fields[f])
                if ps:
                    ps_parts.append(ps)
        g = {
            "requires": split_multi(fields.get("前置任务")),
            "start": clean_text(strip_ps(fields.get("开启任务"))[0]),
            "note": clean_text(strip_ps(fields.get("注意事项"))[0]),
            "reward": split_multi(fields.get("任务奖励")),
            "unlocks": split_multi(fields.get("解锁任务")),
        }
        # 正文里的【】是攻略作者用来强调地名的，界面上没必要显示括号
        for k in ("start", "note"):
            g[k] = g[k].replace("【", "").replace("】", "")
        if ps_parts:
            g["note"] = (g["note"] + "\n" + "\n".join(ps_parts)).strip()
        if g != t.get("guide"):
            bn = (t.get("guide") or {}).get("note")
            if bn != g["note"]:
                touched.append((t["name"], bn, g["note"]))
            if len(g["unlocks"]) < len((t.get("guide") or {}).get("unlocks") or []):
                fixed_unlocks += 1
        t["guide"] = g

    # ---- 校验：不允许再出现假字段
    bad = [t["name"] for t in tasks
           if [k for k in (t.get("raw") or {}) if k not in GUIDE_FIELDS]]
    assert not bad, f"仍有假字段：{bad}"

    print(f"攻略字段重解析：{fixed_fields} 条 raw 被修正")
    print(f"unlocks 切碎修正：{fixed_unlocks} 条")
    print(f"note 文本有变化：{len(touched)} 条")
    for n, a, b in touched[:20]:
        print(f"    {n}\n      修前: {a}\n      修后: {b}")

    if dry:
        print("\n[dry] 未写入")
        return
    save_js_array(TASKS_JS, tasks, old_header)
    print(f"\n已写入 {TASKS_JS}（共 {len(tasks)} 条）")


if __name__ == "__main__":
    main()
