# -*- coding: utf-8 -*-
"""生成 data/explore_save_map.js —— 探索类别存档逐点映射表（幂等）。

覆盖（V1）：
- 鸟望台 15 点：哈希英文名注释 ↔ 标点中文名（翻译表，脚本内校验一一对应）
- 龙之泪 12 点：标点名「记忆N」 ↔ DRAGON_TEARS[N-1]
- 魔犹伊遗失物：GUID 注释坐标 ↔ 标点坐标，互近匹配 + 距离阈值 100
其余类别（神庙/树根/贤者遗志/卡邦达）无逐点名 → 不映射，加载存档后仅计数提示 + 手动标记。
"""
import io, re, json, math

SRC = r"E:\WorkSpace\TOTKmap"
MARKERS_PATH = SRC + r"\data\markers.js"
HASH_PATH = SRC + r"\data\totk_save_hashes.js"
OUT_PATH = SRC + r"\data\explore_save_map.js"

with io.open(MARKERS_PATH, "r", encoding="utf-8") as f:
    markers = json.loads(re.sub(r"^window\.TOTK_MARKERS=", "", f.read()).rstrip().rstrip(";"))
with io.open(HASH_PATH, "r", encoding="utf-8") as f:
    htext = f.read()

M = {m["id"]: m for m in markers}

def get_list(name):
    mm = re.search(r"\b%s:\s*\[(.*?)\]\s*," % name, htext, re.S)
    if not mm:
        return []
    body = mm.group(1)
    out = []
    for em in re.finditer(r"0x([0-9a-fA-F]+)\s*,?\s*//?([^\n]*)\n", body):
        out.append((em.group(1), em.group(2).strip()))
    # 兼容无注释/最后一条无逗号
    return out

def get_guids(name):
    mm = re.search(r"\b%s:\s*\[(.*?)\]\s*," % name, htext, re.S)
    if not mm:
        return []
    return re.findall(r"'([^']+)'", mm.group(1))

# ---------- 1. 鸟望台：英文名 → 中文名 ----------
tower_hashes = get_list("TOWERS_FOUND")
print("TOWERS_FOUND:", len(tower_hashes))
# 中文名表（按英文注释）
TOWER_ZH = {
    "Lookout Landing": "监视堡垒鸟望台",
    "Lindor's Brow": "拉布拉山鸟望台",
    "Pikida Stonegrove": "茨茨齐齐雪原鸟望台",
    "Eldin Canyon": "奥尔汀峡谷鸟望台",
    "Ulri Mountain": "乌尔利山鸟望台",
    "Sahasra Slope": "撒哈斯拉平原鸟望台",
    "Upland Zorana": "卓拉台地鸟望台",
    "Hyrule Field": "海拉鲁平原鸟望台",
    "Gerudo Canyon": "格鲁德峡谷鸟望台",
    "Gerudo Highlands": "格鲁德高地鸟望台",
    "Rabella Wetlands": "拉贝拉湿地带鸟望台",
    "Thyphlo Ruins": "德依布朗遗迹鸟望台",
    "Popla Foothills": "泡泡拉高地鸟望台",
    "Mount Lanayru": "拉聂尔山鸟望台",
    "Rospro Pass": "卡尔加玲鸟望台",
}
tower_map = {}   # markerId -> hash
unmatched_towers = []
for h, en in tower_hashes:
    zh = TOWER_ZH.get(en)
    if not zh:
        unmatched_towers.append(en)
        continue
    hits = [mm for mm in markers if mm.get("cat") == 62 and mm.get("name") == zh]
    if len(hits) == 1:
        tower_map[hits[0]["id"]] = h
    else:
        unmatched_towers.append("%s -> %s(命中%d)" % (en, zh, len(hits)))
print("鸟望台映射:", len(tower_map), " 未匹配:", unmatched_towers)

# ---------- 2. 龙之泪：记忆N ----------
tear_hashes = [
    0x95eaf7f7, 0xd8f6148f, 0xea112a5c, 0x0ba4de99, 0x5a630ce5, 0x2146bc12,
    0x9061714b, 0x7cc0375a, 0xa14c6ed1, 0x587df5b0, 0x5279d33f, 0xc595c991
]
tear_map = {}
unmatched_tears = []
tear_markers = [mm for mm in markers if mm.get("cat") == 83]
for mm in tear_markers:
    m2 = re.match(r"记忆(\d+)", mm.get("name", ""))
    if m2:
        n = int(m2.group(1))
        if 1 <= n <= 12:
            tear_map[mm["id"]] = "0x%08x" % tear_hashes[n - 1]
        else:
            unmatched_tears.append(mm["name"])
    else:
        unmatched_tears.append(mm["name"])
print("龙之泪映射:", len(tear_map), " 未匹配:", unmatched_tears)

# ---------- 3. 魔犹伊：坐标互近匹配 ----------
bub_guids = get_guids("BUBBULS_GUIDS")
bub_coords = []
for em in re.finditer(r"'([^']+)'\s*(?:,)?\s*//[^\n]*?\[([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\]", htext[htext.find("BUBBULS_GUIDS"):htext.find("BUBBULS_GUIDS") + 200000]):
    bub_coords.append((em.group(1), float(em.group(2)), float(em.group(3)), float(em.group(4))))
print("BUBBULS_GUIDS 坐标条数:", len(bub_coords))
bub_markers = [mm for mm in markers if mm.get("cat") == 137]

def dist2(mk, gx, gz):
    return (gx - mk["y"]) ** 2 + (gz - mk["x"]) ** 2

THRESH = 100.0
# 每 GUID 最近 marker；每 marker 最近 GUID；互近 + 阈值
guid_best = []
for g, gx, gh, gz in bub_coords:
    best = min(bub_markers, key=lambda mk: dist2(mk, gx, gz))
    guid_best.append((math.sqrt(dist2(best, gx, gz)), g, best["id"], gx, gz))
guid_best.sort(key=lambda t: t[0])

marker_best = {}
for mk in bub_markers:
    d, g = min((math.sqrt(dist2(mk, gx, gz)), g) for g, gx, gh, gz in bub_coords)
    marker_best[mk["id"]] = (d, g)

bub_map = {}
unmatched_bub = 0
used_ids = set()
for d, g, mid, gx, gz in guid_best:
    if d > THRESH:
        break
    md, mg = marker_best[mid]
    if mg == g and mid not in used_ids:   # 互近唯一
        bub_map[mid] = g
        used_ids.add(mid)
    else:
        unmatched_bub += 1
print("魔犹伊映射:", len(bub_map), " 互近失败/歧义:", unmatched_bub, " 距离阈值外:", sum(1 for t in guid_best if t[0] > THRESH))

# ---------- 输出 ----------
out = """/* TOTKmap 探索类别存档逐点映射表（由 tools/build_explore_map.py 自动生成，勿手改）
 * 用途：加载 progress.sav 后，按此表把存档完成状态逐点写入 state.done
 * 覆盖：鸟望台(%d)/龙之泪(%d)/魔犹伊遗失物(%d) —— 其余类别(神庙/树根/遗志/卡邦达)无逐点名，加载存档后仅计数提示+手动标记
 * 约定：{markerId: hash 或 guid}
 */
window.TOTK_EXPLORE_MAP = {
  "towers": %s,
  "tears": %s,
  "bubbuls": %s
};
""" % (len(tower_map), len(tear_map), len(bub_map),
       json.dumps(tower_map, sort_keys=True),
       json.dumps(tear_map, sort_keys=True),
       json.dumps(bub_map, sort_keys=True))

with io.open(OUT_PATH, "w", encoding="utf-8", newline="\n") as f:
    f.write(out)
print("已写出:", OUT_PATH)
