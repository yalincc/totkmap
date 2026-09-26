"""TOTKNavi 校准辅助：把玩家坐标映射到最近 TOTKmap 地区名（验证坐标/层是否正确）。

用法：
  python check_region.py                 # 读存档锚点（当前/最近存档位置）
  python check_region.py <lat> <lng>     # 给定地图坐标 (Z, X) 查地区
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import locate

AREAS_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "areas.js")


def load_areas():
    with open(AREAS_JS, encoding="utf-8") as f:
        s = f.read()
    pat = re.compile(r'\{"id":(\d+),"layer":(\d+),"name":"([^"]*)","x":([-0-9.]+),"y":([-0-9.]+)')
    out = []
    for m in pat.finditer(s):
        out.append({"layer": int(m.group(2)), "name": m.group(3),
                    "x": float(m.group(4)), "y": float(m.group(5))})
    return out


def nearest(lat, lng, layer, areas):
    best, bd = "", 1e18
    for a in areas:
        if a["layer"] != layer:
            continue
        d = (a["x"] - lat) ** 2 + (a["y"] - lng) ** 2
        if d < bd:
            bd, best = d, a["name"]
    return best, bd ** 0.5


def main():
    areas = load_areas()
    print("areas: %d 条" % len(areas))
    if len(sys.argv) >= 3:
        lat, lng = float(sys.argv[1]), float(sys.argv[2])
        for layer in (18, 19, 20):
            n, d = nearest(lat, lng, layer, areas)
            print("  (%7.1f, %7.1f) layer%d -> %s (距离 %.1f)" % (lat, lng, layer, n, d))
        return
    anchors = locate.read_save_triples()
    print("存档锚点 %d 个（(gx,gy,gz)=(X东,Y北,高)，地图坐标 lat=-gy(北负) lng=gx）" % len(anchors))
    for p, off, (gx, gy, gz) in anchors:
        lat, lng = -gy, gx
        layer = 20 if gz >= 950 else (19 if gz < 0 else 18)
        n, d = nearest(lat, lng, layer, areas)
        print("  %s@0x%X  hud=(%7.1f, %7.1f, %6.1f) -> layer%d %s (%.1f)"
              % (os.path.basename(p), off, gx, gy, gz, layer, n, d))


if __name__ == "__main__":
    main()
