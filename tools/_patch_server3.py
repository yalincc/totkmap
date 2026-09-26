# -*- coding: utf-8 -*-
'''server.py 层判定补丁：多边形 + 高空 + 低空标记缓冲（修复低空岛被误判为地上）。'''
import io

P = r"E:\WorkSpace\TOTKmap\live-python\server.py"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

def rep(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, "%s count=%d" % (label, n)
    t = t.replace(old, new)
    print("OK:", label)

# 1) layer_of 重写（含天空数据加载 + 多边形/标记缓冲）
rep('''def layer_of(gz):
    """玩家实际高度 -> TOTKmap 数据层（天空>=950 / 地底<0 / 地上）。"""
    return 20 if gz >= 950.0 else (19 if gz < 0.0 else 18)''',
'''# ---------------- 层判定（V1.8.0 M3 修正）：多边形 + 高空 + 低空标记缓冲 ----------------
# 背景：TOTK 天空岛最低约 Z=400（如西哈特尔天空诸岛 Z≈558），而地面最高点
# （海布拉山 647 / 格鲁德高地塔 635）与之重叠——纯高度阈值不可靠；objmap-totk 的
# sky_polys.json 只有 64 个大岛轮廓（缺西哈特尔天空诸岛），故加"低空+附近有天空标记"兜底。
_SKY_POLYS = None      # [{rings, xmin, xmax, ymin, ymax}]
_SKY_MARKERS = None    # [(x, y), ...] layer=20 标记


def _load_sky_data():
    global _SKY_POLYS, _SKY_MARKERS
    try:
        base = os.path.dirname(os.path.abspath(__file__))
        t = io.open(os.path.join(base, "..", "data", "area_sky.js"), encoding="utf-8").read()
        m = re.search(r"window\\.TOTK_AREA_SKY\\s*=\\s*(\\[.*?\\]);", t, re.S)
        if m:
            polys = json.loads(m.group(1))
            _SKY_POLYS = []
            for p in polys:
                xs = [pt[0] for r in p["rings"] for pt in r]
                ys = [pt[1] for r in p["rings"] for pt in r]
                _SKY_POLYS.append({"rings": p["rings"],
                                   "xmin": min(xs), "xmax": max(xs),
                                   "ymin": min(ys), "ymax": max(ys)})
        t2 = io.open(os.path.join(base, "..", "data", "markers.js"), encoding="utf-8").read()
        m2 = re.search(r"window\\.TOTK_MARKERS\\s*=\\s*(\\[.*?\\]);", t2, re.S)
        if m2:
            mk = json.loads(m2.group(1))
            _SKY_MARKERS = [(d["x"], d["y"]) for d in mk if d.get("layer") == 20]
    except Exception:
        pass


def _pip(x, y, pts):
    """射线法：点在多边形内。"""
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _in_sky_poly(x, y):
    if not _SKY_POLYS:
        return False
    for p in _SKY_POLYS:
        if not (p["xmin"] <= x <= p["xmax"] and p["ymin"] <= y <= p["ymax"]):
            continue
        for r in p["rings"]:
            if _pip(x, y, r):
                return True
    return False


def _near_sky_marker(x, y, rad=600.0):
    if not _SKY_MARKERS:
        return False
    r2 = rad * rad
    for mx, my in _SKY_MARKERS:
        dx = mx - x
        dy = my - y
        if dx * dx + dy * dy <= r2:
            return True
    return False


def layer_of(gx, gy, gz):
    """玩家位置 -> TOTKmap 数据层（18 地上 / 19 地底 / 20 天空）。"""
    if gz < 0.0:
        return 19                       # 地底：海平面 0 以下
    if gz >= 900.0:
        return 20                       # 高空必然天空（地面最高约 650）
    if _in_sky_poly(gx, gy):
        return 20                       # 空岛轮廓命中（64 个大岛）
    if gz >= 300.0 and _near_sky_marker(gx, gy):
        return 20                       # 低空岛：高度足够且 600 内有天空内容
    return 18''',
"layer_of 重写")

# 2) poll() 调用点传入 gx/gy
rep('''                         mx=-gy, my=gx,
                         layer=layer_of(gz),''',
'''                         mx=-gy, my=gx,
                         layer=layer_of(gx, gy, gz),''',
"poll 调用 layer_of")

# 3) 启动时加载天空数据（main 入口）
rep('''    threading.Thread(target=poll, daemon=True).start()''',
'''    _load_sky_data()
    threading.Thread(target=poll, daemon=True).start()''',
"启动加载天空数据")

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("层判定补丁完成")
