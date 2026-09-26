# -*- coding: utf-8 -*-
"""检查 slot_00 全部 15 座塔的原始 hash 值 + 附近是否有其他 value==1 的塔类 hash。"""
import io, json, re, struct

path = r"C:\Users\Administrator\AppData\Roaming\Ryujinx\bis\user\save\0000000000000007\0\slot_00\progress.sav"
with open(path, "rb") as f:
    data = f.read()

# 复刻 js 解析
vb = {}
for j in range(0x28, min(0x03c800, len(data)) - 7, 8):
    h = struct.unpack("<I", data[j:j+4])[0]
    vb[h] = j + 4

# 塔映射表
mapf = r"E:\WorkSpace\TOTKmap\data\explore_save_map.js"
with io.open(mapf, "r", encoding="utf-8") as f:
    t = f.read()
emap = json.loads(re.search(r"window\.TOTK_EXPLORE_MAP\s*=\s*(\{.*?\});", t, re.S).group(1))

# markers 里塔名（cat=62）
mf = r"E:\WorkSpace\TOTKmap\data\markers.js"
with io.open(mf, "r", encoding="utf-8") as f:
    mt = f.read()
names = {}
for mm in re.finditer(r'"id":(\d+),"layer":18,"cat":62,"name":"([^"]+)"', mt):
    names[int(mm.group(1))] = mm.group(2)

print("--- 15 座塔 hash 值（slot_00 当前） ---")
for mid, hv in emap["towers"].items():
    h = int(hv, 16)
    off = vb.get(h)
    val = None
    if off is not None:
        val = struct.unpack("<I", data[off:off+4])[0]
    print("id=%s  hash=0x%08x  value=%s  %s" % (mid, h, val, names.get(int(mid), "")))

# 是否有我们不知道的其他塔完成标记（表里 value==1 且 hash 不是已知塔/泪/魔犹伊）
print("--- value==1 的全部 hash（抽样） ---")
ones = []
for h, off in vb.items():
    if struct.unpack("<I", data[off:off+4])[0] == 1:
        ones.append(h)
print("value==1 数量:", len(ones))
print("前 30:", [hex(x) for x in ones[:30]])
