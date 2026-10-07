# -*- coding: utf-8 -*-
"""
TOTK 任务数据提取器
==================
从 RomFS 提取权威任务数据，与现有玩家攻略文本融合，输出 app/data/tasks.js

数据源：
  1. RSDB/Challenge.Product.121.rstbl.byml.zs   -> 285 条挑战定义（分类/前置/坐标/NPC/地点）
  2. Mals/CNzh.Product.121.sarc.zs              -> ChallengeMsg/Info_*.msbt 官方中文名+分步描述
                                                   LocationMsg / ActorMsg/Npc.msbt 地名与 NPC 名
  3. app/data/markers.js                        -> 现有 170 条玩家攻略文本（前置/开启/注意事项/奖励/解锁）

坐标约定（实测修正）：地图 x = 游戏 Z，地图 y = 游戏 X
图层判定（沿用项目调研结论）：y < -250 地底(19) / y >= 700 天空(20) / 其余地表(18)

用法：
  python tools/extract_quests.py
"""
import sys, os, re, json, math, pathlib, collections
sys.stdout.reconfigure(encoding='utf-8')

import zstandard as zstd
import sarc
import byml

ROOT = pathlib.Path(r"E:\WorkSpace\TOTKmap")
ROM = pathlib.Path(r"G:\YUZU\Switch Games\TOTKroms")
TMP = ROOT / "tools" / "_quest"
OUT_JS = ROOT / "app" / "data" / "tasks.js"
OUT_JSON = TMP / "tasks_full.json"
OUT_REPORT = ROOT / "归档" / "任务数据交接" / "提取报告.md"


# ---------------------------------------------------------------- 基础解压
def load_dicts():
    d = {}
    for p in (TMP / "dicts").glob("*.zsdic"):
        d[p.name] = p.read_bytes()
    if d:
        return d
    raw = (ROM / "Pack" / "ZsDic.pack.zs").read_bytes()
    s = sarc.SARC(zstd.ZstdDecompressor().decompress(raw))
    (TMP / "dicts").mkdir(parents=True, exist_ok=True)
    for n in s.list_files():
        d[os.path.basename(n)] = s.get_file_data(n).tobytes()
        (TMP / "dicts" / os.path.basename(n)).write_bytes(d[os.path.basename(n)])
    return d


def zsdec(blob, dicts):
    for name in dicts:
        try:
            return zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(dicts[name])).decompress(blob)
        except Exception:
            continue
    return zstd.ZstdDecompressor().decompress(blob)


# ---------------------------------------------------------------- MSBT
def parse_msbt(data):
    assert data[:8] == b"MsgStdBn", "not msbt"
    le = data[8:10] == b"\xff\xfe"
    enc = "utf-16-le" if le else "utf-16-be"
    u16 = (lambda b, o: int.from_bytes(b[o:o+2], "little")) if le else (lambda b, o: int.from_bytes(b[o:o+2], "big"))
    u32 = (lambda b, o: int.from_bytes(b[o:o+4], "little")) if le else (lambda b, o: int.from_bytes(b[o:o+4], "big"))

    labels, texts = [], []
    for m in re.finditer(rb"(LBL1|TXT2)", data):
        magic, body = m.group(), data[m.start() + 0x10:]
        if magic == b"LBL1":
            n = u32(body, 0)
            off = 4 + 8 * n
            try:
                for _ in range(n):
                    cnt = body[off]; off += 1
                    name = body[off:off+cnt].decode("ascii"); off += cnt
                    idx = u32(body, off); off += 4
                    labels.append((idx, name))
            except Exception:
                labels = []
        else:
            n = u32(body, 0)
            offs = [u32(body, 4 + 4*i) for i in range(n)]
            for i, o in enumerate(offs):
                end = offs[i+1] if i+1 < n else len(body)
                chunk, out, j = body[o:end], [], 0
                while j + 2 <= len(chunk):
                    u = u16(chunk, j)
                    if u == 0x000E:
                        j += 2
                        if j + 2 > len(chunk): break
                        j += 2 + 2 * u16(chunk, j)
                        out.append("　")
                        continue
                    if u == 0: break
                    out.append(chunk[j:j+2].decode(enc, errors="ignore"))
                    j += 2
                texts.append("".join(out))
    return {name: (texts[i] if i < len(texts) else "") for i, name in labels}, texts


# ---------------------------------------------------------------- 工具
STRIP = re.compile(r"[\s　!！?？・·.,、，。；:：（）()\[\]【】“”\"'’‘\-—~～…‥]")

def norm(s):
    return STRIP.sub("", s or "")

def bigrams(s):
    return set(s[i:i+2] for i in range(len(s) - 1)) if len(s) > 1 else {s}

def sim(a, b):
    A, B = bigrams(a), bigrams(b)
    return len(A & B) / max(1, len(A | B))

def clean_text(s):
    """清理 HTML 标签与网页残留"""
    if not s: return ""
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</?(div|p|span|b|strong|em)[^>]*>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    s = re.sub(r"点击左下角查看攻略[，。]?", "", s)
    s = re.sub(r"详情可点击左下角的查看攻略[，。]?进行查看", "", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()

def strip_ps(v):
    """剥离「无<div>P.s. xxx</div>」里的玩家备注（换武器、别浪费药之类）。

    它不是任务名，留在 unlocks/reward 数组里会被 split_multi 切成多条垃圾。
    ★ 必须先 clean_text 再剥 P.s.：原值是「无<div>P.s. …</div>」，
      直接剥会把尾部 </div> 带进备注文本。
    """
    if not v:
        return v, None
    v = clean_text(v)
    m = re.search(r"[Pp]\.?\s?s\s*[:：.]\s*", v)
    if not m:
        return v, None
    return v[:m.start()].strip(), clean_text(v[m.end():])

def split_multi(v):
    """一个字段里的多个任务名 -> 数组"""
    if not v: return []
    v, _ps = strip_ps(v)
    if not v or v in ("无", "无。", "-", "—"): return []
    parts = re.split(r"[、,，/]\s*", v)
    return [p.strip() for p in parts if p.strip() and p.strip() not in ("无", "无。")]


# ---------------------------------------------------------------- 1) 挑战表
def load_challenges(dicts):
    p = ROM / "RSDB" / "Challenge.Product.121.rstbl.byml.zs"
    cache = TMP / "Challenge.byml"
    if not cache.exists():
        cache.write_bytes(zsdec(p.read_bytes(), dicts))
    root = byml.Byml(cache.read_bytes()).parse()

    def cname(r):
        return r["__RowId"].split("/")[-1].replace(".game__challenge__Challenge.gyml", "")

    out = {}
    for r in root:
        out[cname(r)] = r
    return out


# ---------------------------------------------------------------- 2) 中文文本
def load_zh(dicts):
    cache = TMP / "CNzh.sarc"
    if not cache.exists():
        cache.write_bytes(zsdec((ROM / "Mals" / "CNzh.Product.121.sarc.zs").read_bytes(), dicts))
    s = sarc.SARC(cache.read_bytes())
    zh, loc, npc = {}, {}, {}
    for fn in s.list_files():
        d = s.get_file_data(fn).tobytes()
        if fn.startswith("ChallengeMsg/Info_") and fn.endswith(".msbt"):
            m, _ = parse_msbt(d)
            zh[fn[len("ChallengeMsg/Info_"):-len(".msbt")]] = m
        elif fn == "LocationMsg/Location.msbt":
            loc, _ = parse_msbt(d)
        elif fn == "ActorMsg/Npc.msbt":
            npc, _ = parse_msbt(d)
    return zh, loc, npc


# ---------------------------------------------------------------- 3) 现有攻略
QUEST_CATS = {177, 185, 192, 200, 214}
# ★ 只有这 5 个是真正的字段名。攻略正文里还有【依盖队基地】【托可优的重要信件】这类
#   用【】标注的地名/任务名，它们不是字段——早期版本用 r"【([^】]{2,8})】" 泛匹配，
#   把这些正文地名误当成字段名，导致值被腰斩（15 条记录受损）。必须白名单。
GUIDE_FIELDS = ("前置任务", "开启任务", "注意事项", "任务奖励", "解锁任务")
FIELD_RE = re.compile(r"【(" + "|".join(GUIDE_FIELDS) + r")】")
# 匹配字段名之间的正文（含被误当字段的【】地名，原样保留）
FIELD_SPLIT_RE = re.compile(r"【(?:" + "|".join(GUIDE_FIELDS) + r")】")


def parse_guide_fields(desc):
    """按白名单字段名切分 desc。

    策略：只在 5 个真字段名处切段，段内其余【...】全部视为正文原样保留。
    返回 {字段名: 值}；无真字段则返回 {}。
    """
    if not desc or "【" not in desc:
        return {}
    # 先定位所有真字段名的位置
    marks = [(m.start(), m.end(), m.group(1)) for m in FIELD_RE.finditer(desc)]
    if not marks:
        return {}
    fields = {}
    for i, (_s, e, name) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(desc)
        val = desc[e:end].strip()
        # 同名字段重复出现时保留首次（攻略里【前置任务】只应出现一次）
        if name not in fields or (not fields[name] and val):
            fields[name] = val
    return fields


def load_guide():
    t = (ROOT / "app" / "data" / "markers.js").read_text(encoding="utf-8")
    ms = json.loads(t[t.index("["): t.rindex("]") + 1])
    out = []
    for m in ms:
        desc = m.get("desc") or ""
        if m.get("cat") not in QUEST_CATS and "【前置任务】" not in desc and "【开启任务】" not in desc:
            continue
        fields = parse_guide_fields(desc)
        if not fields:
            continue
        out.append({
            "id": m["id"], "layer": m.get("layer"), "cat": m.get("cat"),
            "name": m["name"], "full": m.get("full"),
            "x": m["x"], "y": m["y"], "fields": fields,
        })
    return out


# ---------------------------------------------------------------- 4) 依赖解析
def resolve_flag(flag, chalkeys):
    """从 DependFlagName 反推挑战 key；反推不出则当条件 flag"""
    if not flag:
        return None
    parts = flag.split("_")
    for i in range(len(parts) - 1, 0, -1):
        cand = "_".join(parts[:i])
        if cand in chalkeys:
            return {"type": "quest", "key": cand, "resolved": True, "flag": flag}
    return {"type": "flag", "key": None, "resolved": False, "flag": flag}


# ---------------------------------------------------------------- 主流程
def main():
    dicts = load_dicts()
    print("[1/5] 挑战表...")
    chal = load_challenges(dicts)
    print("      挑战:", len(chal))
    print("[2/5] 中文文本...")
    zh, loc, npc = load_zh(dicts)
    print("      任务中文:", len(zh), " 地名:", len(loc), " NPC:", len(npc))
    print("[3/5] 现有攻略...")
    guide = load_guide()
    print("      含任务字段的标点:", len(guide))

    chalkeys = set(chal)

    # --- 建立 官方中文名 -> key 索引
    name2key = {}
    for k, v in zh.items():
        n = (v.get("Name") or "").strip()
        if n:
            name2key.setdefault(n, k)
    norm2key = {norm(n): k for n, k in name2key.items()}

    # --- 匹配现有攻略（四阶段：精确 -> 规范化 -> 系列拆分 -> 错别字模糊）
    matched, unmatched, fuzzy = {}, [], []
    for g in guide:
        nm = g["name"].strip()
        nk = norm(nm)

        if nm in name2key:                                   # 1 精确
            matched[name2key[nm]] = (g, "exact")
            continue
        if nk in norm2key:                                   # 2 规范化（去标点）
            matched[norm2key[nk]] = (g, "norm")
            continue

        # 3 系列拆分：「重大发明！传送标记器！足迹模式！图鉴感应」这类一个标点代表多个任务
        frags = [f.strip() for f in re.split(r"[！!？?、，,/。·]", nm) if len(norm(f.strip())) >= 3]
        series = []
        for f in frags:
            nf = norm(f)
            for k, v in zh.items():
                on = norm((v.get("Name") or "").strip())
                if not on or len(on) < 3:
                    continue
                # 双向包含，但长度差 <= 5，避免「海布拉」误吃掉「海布拉山北方的神庙与水晶」
                if (nf in on and len(on) - len(nf) <= 5) or (on in nf and len(nf) - len(on) <= 5):
                    if k not in series:
                        series.append(k)
        if series:
            for k in series:
                if k not in matched:
                    matched[k] = (g, "series")
                    fuzzy.append((nm, zh[k].get("Name"), "series", 1.0))
            continue

        # 4 错别字/单字差异：bigram 相似度
        best = (0, None)
        for k, v in zh.items():
            on = norm((v.get("Name") or "").strip())
            if not on:
                continue
            s = sim(nk, on)
            if s > best[0]:
                best = (s, k)
        # 阈值 0.45：实测该区间（提示/指示、洞穴/洞窟、旅店/旅馆、沃托利/沃托里）
        # 全部为同一任务的不同写法，捞回的收益远大于误配风险，且报告会逐条列出供确认
        if best[0] >= 0.45 and best[1] not in matched:
            matched[best[1]] = (g, "fuzzy")
            fuzzy.append((nm, zh[best[1]].get("Name"), "fuzzy", round(best[0], 2)))
        else:
            cand = (zh[best[1]].get("Name"), round(best[0], 2)) if best[1] else ("", 0)
            unmatched.append(g)
            fuzzy.append((nm, cand[0], "unmatched", cand[1]))
    print(f"      匹配: 精确/规范/模糊 共 {len(matched)}  未匹配 {len(unmatched)}  (模糊 {len(fuzzy)})")

    # --- 图层判定
    def layer_of(y):
        if y is None: return 18
        if y < -250: return 19
        if y >= 700: return 20
        return 18

    # --- 组装
    print("[4/5] 组装任务记录...")
    tasks = []
    for key, r in sorted(chal.items()):
        z = zh.get(key, {})
        name = (z.get("Name") or "").strip()
        # 收集步骤与目标点
        steps, pts = [], []
        for st in (r.get("Steps") or []):
            sn = st.get("Name", "")
            txt = clean_text(z.get(sn, ""))
            sp = []
            for dp in (st.get("DestinationPoint") or []):
                p = dp.get("Pos") or dp.get("AlternativePos")
                if p:
                    # 一律存游戏原始坐标 X(东西) / Y(高度) / Z(南北)
                    sp.append({"gx": round(p["X"], 3), "gy": round(p["Y"], 2),
                               "gz": round(p["Z"], 3)})
            if sp: pts.extend(sp)
            steps.append({"name": sn, "text": txt, "pts": sp})

        # 主坐标一律用游戏坐标 (gx=X东西, gy=Y高度, gz=Z南北)
        # 一对一匹配取玩家标点（markers 是地图系：markers.x=游戏Z，markers.y=游戏X，需换回）
        # 系列拆分（一标点代表多任务）取 ROM 各自坐标，否则多个任务会挤在同一个点
        g, mtype = matched.get(key, (None, None))
        if g and mtype in ("exact", "norm", "fuzzy"):
            gx, gz = g["y"], g["x"]
            # 高度只在水平位置吻合时回填：多阶段任务的第一个目标点可能不是玩家标的那处，
            # 硬填会造成「位置是 A、高度是 B」的矛盾（如「讨伐加侬多夫」pts[0] 在地表）
            gy = None
            if pts and math.hypot(gx - pts[0]["gx"], gz - pts[0]["gz"]) < 500:
                gy = pts[0]["gy"]
            layer, src_xy = g["layer"], "marker"
        elif pts:
            gx, gy, gz = pts[0]["gx"], pts[0]["gy"], pts[0]["gz"]
            layer, src_xy = layer_of(gy), "rom"
        else:
            gx = gy = gz = None; layer = 18; src_xy = "none"

        # 分类兜底：ROM 未标 Category 的按 key 名推断类型
        cat = r.get("Category")
        catCn = {"Main": "主线", "ImportantMini": "重要支线", "Sub": "普通支线"}.get(cat, "其他")
        kind = {"Main": "story", "ImportantMini": "side", "Sub": "side"}.get(cat)
        if kind is None:
            if "MiniGame" in key: kind = "minigame"
            elif "Tutorial" in key: kind = "tutorial"
            elif "CarryToShrine" in key: kind = "shrine"
            else: kind = "quest"

        # 坐标有效性：ROM 有占位 0,0（如 GetMasterSword），不能当真坐标用
        pos_valid = gx is not None and gz is not None and not (abs(gx) < 1 and abs(gz) < 1)

        # 依赖
        # ★★ 自指排除（2026-10-07，台账 P1）
        # ROM 的 DependFlagName 里有一类flag 是「**本任务自己的启动条件**」，
        # 不是前置任务。resolve_flag 从 flag 反推key 时会切出**本任务的 key**，
        # 于是产生「前置条件＝自己」的荒唐结果。
        #
        # 实测 3 条：
        #   未建成的马厩   flag=BuildingMaterialsTutorial_CanBeStart
        #   马儿去向何方   flag=FindWhiteHorse_CanStart_Exp
        #   来自古代的信息 flag=ZonauReliefSearch_Ready
        #
        # 连带伤害：下游的 dependents 反向索引会把这个自指当 legit 前置，
        # 于是「完成后解锁」也变成自己 —— 同一个根因、两个表现。
        #
        # 修法：**在赋给 requires 之后过滤掉 key==本任务key 的那条**。
        # 为什么不在 resolve_flag 内部排除：它被调用时还没有本任务 key
        # （key 在后面的分支才赋值），拿不到自己。
        # 为什么降级为 type=flag 而不是直接丢弃：这类flag 确实携带信息
        #   （「完成前置条件后才可开始」），降级后卡片显示为灰字条件提示、
        #   不给跳转链接，与现有 type=flag 的展示口径一致。
        dep = resolve_flag(r.get("DependFlagName"), chalkeys)
        requires = []
        if dep:
            requires.append(dep)

        # NPC / 地点
        actor = (r.get("RequestActor") or "").split("/")[-1].replace(".engine__actor__ActorParam.gyml", "")
        locid = (r.get("RequestLocation") or "").split("/")[-1].replace(".game__location__Location.gyml", "")
        npcCn = npc.get(actor + "_Name") or npc.get(actor) or ""
        locCn = loc.get(locid, "")

        # ROM 侧图层（按游戏高度 Y 判定），用于和玩家标点的 layer 对照
        rom_layer = layer_of(pts[0]["gy"]) if pts else None
        rom_pt = dict(pts[0]) if pts else None

        rec = {
            "key": key,
            "name": name or key,
            "nameSrc": "rom" if name else "key",
            "cat": cat or "Other",
            "catCn": catCn,
            "kind": kind,
            "oldCat": {"177": "情节挑战", "185": "迷你挑战", "192": "迷你挑战",
                       "200": "情节挑战", "214": "情节挑战"}.get(str(g["cat"])) if g else None,
            "layer": layer,
            # ★ 游戏坐标（唯一对外口径，用户看到的就是这三个）
            "gx": round(gx, 3) if gx is not None else None,
            "gy": round(gy, 2) if gy is not None else None,
            "gz": round(gz, 3) if gz is not None else None,
            "hasHeight": gy is not None,
            # 地图绘制基准（内部用，不展示给用户）：mapX = gz，mapY = gx
            "mapX": round(gz, 3) if gz is not None else None,
            "mapY": round(gx, 3) if gx is not None else None,
            "posSrc": src_xy,
            "posValid": pos_valid,
            "romLayer": rom_layer,
            "romPt": rom_pt,
            "npc": actor or None,
            "npcCn": npcCn or None,
            "loc": locid or None,
            "locCn": locCn or None,
            "sort": r.get("SortIndex"),
            "nSteps": len(steps),
            "steps": steps,
            "requires": requires,
            "dependFlag": r.get("DependFlagName") or None,
            "markerId": g["id"] if g else None,
            "match": mtype,
            "src": "rom+guide" if g else "rom",
        }
        if g:
            f = g["fields"]
            rec["rawName"] = g["name"]
            rec["guide"] = {
                "requires": split_multi(f.get("前置任务")),
                "start": clean_text(f.get("开启任务")),
                "note": clean_text(f.get("注意事项")),
                "reward": split_multi(f.get("任务奖励")),
                "unlocks": split_multi(f.get("解锁任务")),
            }
            rec["raw"] = dict(f)
        tasks.append(rec)

    # 未匹配的攻略 -> 独立记录（不能丢）
    for g in unmatched:
        f = g["fields"]
        tasks.append({
            "key": None,
            "name": g["name"].strip(),
            "nameSrc": "guide",
            "cat": "Other", "catCn": "其他", "kind": "quest",
            "oldCat": {"177": "情节挑战", "185": "迷你挑战", "192": "迷你挑战",
                       "200": "情节挑战", "214": "情节挑战"}.get(str(g["cat"])),
            "layer": g["layer"],
            "gx": round(g["y"], 3), "gy": None, "gz": round(g["x"], 3), "hasHeight": False,
            "mapX": g["x"], "mapY": g["y"],
            "posSrc": "marker",
            "posValid": not (abs(g["x"]) < 1 and abs(g["y"]) < 1),
            "npc": None, "npcCn": None, "loc": None, "locCn": None,
            "sort": None, "nSteps": 0, "steps": [], "requires": [], "dependFlag": None,
            "markerId": g["id"], "match": None, "src": "guide",
            "guide": {
                "requires": split_multi(f.get("前置任务")),
                "start": clean_text(f.get("开启任务")),
                "note": clean_text(f.get("注意事项")),
                "reward": split_multi(f.get("任务奖励")),
                "unlocks": split_multi(f.get("解锁任务")),
            },
            "raw": dict(f),
        })

    # --- 自指过滤（台账 P1）：剔除「前置条件＝自己」
    # 必须在所有 key 都赋值之后做，所以放在这里而不是提取时。
    # 被剔除的降级成 type=flag（条件型提示，不给跳转链接）。
    n_self = 0
    for t in tasks:
        own = t.get("key")
        if not own:
            continue
        keep = []
        for rq in t.get("requires", []):
            if rq.get("type") == "quest" and rq.get("key") == own:
                rq["type"] = "flag"
                rq["selfRef"] = True      # 留痕：便于日后核对时识别
                n_self += 1
            keep.append(rq)
        t["requires"] = keep
    if n_self:
        print("[4/5] 自指过滤：%d 条「前置＝自己」已降级为条件 flag" % n_self)

    # --- 反向：给有 key 的记录补 unlocks（谁依赖我）
    dependents = collections.defaultdict(list)
    for t in tasks:
        for rq in t.get("requires", []):
            if rq["type"] == "quest":
                dependents[rq["key"]].append(t["key"])

    # ---------------------------------------------------------------- 输出
    print("[5/5] 输出...")
    OUT_JSON.write_text(json.dumps(tasks, ensure_ascii=False, indent=1), encoding="utf-8")

    # tasks.js（加载用，steps 只保留首个点，控制体积）
    slim = []
    for t in tasks:
        d = dict(t)
        d["steps"] = [{"name": s["name"], "text": s["text"],
                       "pts": s["pts"][:2]} for s in t["steps"]]
        d["unlocks"] = dependents.get(t["key"], []) if t["key"] else []
        slim.append(d)
    body = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
    OUT_JS.write_text(
        "// TOTK 任务数据 —— 由 tools/extract_quests.py 从 RomFS 提取并融合玩家攻略生成\n"
        "// 坐标：gx=游戏X(东西) gy=游戏Y(高度) gz=游戏Z(南北) —— 对外唯一口径\n"
        "// mapX/mapY 是地图图标绘制基准（mapX=gz, mapY=gx），仅内部用，不展示给用户\n"
        "// 图层 18地表 / 19地底 / 20天空（按游戏高度 gy 判定：<-250 地底，>=700 天空）\n"
        "// 数据源：RSDB/Challenge(285) + Mals/CNzh 官方中文名 + markers.js 玩家攻略\n"
        f"window.TOTK_TASKS={body};\n", encoding="utf-8")

    # --- 统计
    cc = collections.Counter(t["cat"] for t in tasks)
    src = collections.Counter(t["src"] for t in tasks)
    ly = collections.Counter(t["layer"] for t in tasks)
    withxy = sum(1 for t in tasks if t["gx"] is not None)
    withname = sum(1 for t in tasks if t["nameSrc"] == "rom")
    withstep = sum(1 for t in tasks if t["nSteps"] > 0)
    depok = sum(1 for t in tasks if any(r["resolved"] for r in t["requires"]))
    ndep = sum(1 for t in tasks if t["requires"])

    # 坐标质检：玩家标点 vs ROM 目标点
    diffs = []
    for t in tasks:
        if t.get("posSrc") == "marker" and t.get("romPt") and t.get("gx") is not None:
            d = math.hypot(t["gx"] - t["romPt"]["gx"], t["gz"] - t["romPt"]["gz"])
            diffs.append((d, t["name"], t["layer"], t["romLayer"]))
    diffs.sort(reverse=True)
    layer_conflict = [(n, a, b) for d, n, a, b in diffs if a and b and a != b]

    report = f"""# TOTK 任务数据提取报告

> 生成：{__import__('datetime').datetime.now():%Y-%m-%d %H:%M} · 脚本 `tools/extract_quests.py`
> 输出：`app/data/tasks.js`（`window.TOTK_TASKS`）

## 一、总量

| 项 | 数 |
|---|---|
| 任务总数 | **{len(tasks)}** |
| 其中 ROM 权威 | {src['rom'] + src['rom+guide']} |
| 其中仅玩家攻略（未匹配上官方） | {src['guide']} |
| 有官方中文名 | {withname} |
| 有坐标 | {withxy} |
| 有分步官方描述 | {withstep} |

## 二、分类（官方 Category）

| 分类 | 数 |
|---|---|
| 主线 Main | {cc.get('Main', 0)} |
| 重要支线 ImportantMini | {cc.get('ImportantMini', 0)} |
| 普通支线 Sub | {cc.get('Sub', 0)} |
| 其他（ROM 未标分类 / 未匹配） | {cc.get('Other', 0)} |

## 三、图层分布

| 图层 | 数 |
|---|---|
| 18 地表 | {ly.get(18, 0)} |
| 19 地底 | {ly.get(19, 0)} |
| 20 天空 | {ly.get(20, 0)} |

## 四、任务链

- 有前置依赖记录：**{ndep}** 条
- 其中能解析成真实任务 key：**{depok}** 条（其余为条件型 flag，如 `SageOfGerudo_IsCompleted_Exp`）
- 反向索引 `unlocks`（谁依赖我）已写入每条记录

## 五、与现有 170 条的匹配

- 精确/规范化匹配：{sum(1 for t in tasks if t['match'] in ('exact', 'norm'))}
- 模糊匹配：{sum(1 for t in tasks if t['match'] == 'fuzzy')}
- 未匹配（保留为独立记录）：{sum(1 for t in tasks if t['src'] == 'guide')}

### 模糊匹配明细（需人工确认）
{chr(10).join(f'- 现有「{a}」→ 官方「{b}」  [{c} {d}]' for a, b, c, d in fuzzy if c != 'unmatched') or '（无）'}

### 未匹配清单（附最接近的官方名与相似度，供人工裁决）
{chr(10).join(f'- 现有「{a}」  最接近: {b} ({d})' for a, b, c, d in fuzzy if c == 'unmatched') or '（无）'}

## 六、坐标体系（重要）

**两套坐标并存，口径如下：**

| 体系 | 字段 | 含义 | 用途 |
|---|---|---|---|
| 游戏坐标 | `gx` / `gy` / `gz` | X=东西向、Y=**高度**、Z=南北向 | **对外唯一口径**，用户看到的只能是这个 |
| 地图坐标 | `mapX` / `mapY` | Leaflet 图标绘制基准 | 内部绘制用，**不展示给用户** |

**映射（双向，实测确认）：**
```
地图坐标 -> 游戏坐标:   gx = mapY      gz = mapX
游戏坐标 -> 地图坐标:   mapX = gz      mapY = gx
```
即 **地图 x 装的是游戏 Z，地图 y 装的是游戏 X（轴是交换的）**。

> 交接 README 原写 `(x,y)=(东西向 Z, 南北向 Y)`，**实测写反了**。
> 验证：ROM 目标点与 144 个玩家标点比对，按 `[X,Z]` 中位数误差 **3681**（等同随机），
> 按 `[Z,X]` 中位数误差 **12**，130/144 落在 500 内。
> 范围也对得上：markers.x ∈ [-3553,3583] ≈ ROM Z ∈ [-3535,3579]；markers.y ∈ [-3891,4657] ≈ ROM X ∈ [-3888,4805]。

**高度 `gy`**：玩家标点（markers.js）是 2D 的、没有高度；有 ROM 目标点的会回填，`hasHeight` 标明有没有。

**图层判定**（沿用项目既有结论，按游戏高度 `gy`）：
`gy < -250` 地底(19) / `gy >= 700` 天空(20) / 其余地表(18)。
**别用 `gy < 0`** —— 井底实测 -99，会误判成地底。

## 七、坐标质检（玩家标点 vs ROM 目标点）

可比样本 {len(diffs)} 条。图层不一致（玩家标点层 ≠ ROM 高度判定层）：**{len(layer_conflict)}** 条。

### 偏差最大的 15 条（可能是标错位置，或任务是多阶段、首个目标点不代表任务地点）
{chr(10).join(f'- {n}：偏差 {d:.0f}（玩家标 layer {a} / ROM 判定 layer {b}）' for d, n, a, b in diffs[:15]) or '（无）'}

### 图层冲突清单
{chr(10).join(f'- {n}：玩家层 {a} vs ROM 层 {b}' for n, a, b in layer_conflict[:20]) or '（无）'}

## 八、已知限制

- 32 条挑战（多为小游戏/教程）无官方中文文本，`name` 用内部 key 兜底
- NPC 中文名覆盖率低（{sum(1 for t in tasks if t.get('npcCn'))} 条）：`ActorMsg/Npc.msbt` 只有 101 个条目且 key 命名与 `RequestActor` 不一致，NPC 名多在 `EventFlowMsg` 里，未深挖
- 地名中文名覆盖 {sum(1 for t in tasks if t.get('locCn'))} 条：`LocationMsg` 只有 101 个地标名，不含区域名
"""
    OUT_REPORT.write_text(report, encoding="utf-8")

    print(f"\n完成：{len(tasks)} 条 -> {OUT_JS}  ({OUT_JS.stat().st_size/1024:.0f} KB)")
    print("分类:", dict(cc))
    print("来源:", dict(src))
    print("图层:", dict(ly))
    print(f"有坐标 {withxy} / 有官方名 {withname} / 依赖可解析 {depok}/{ndep}")


if __name__ == "__main__":
    main()
