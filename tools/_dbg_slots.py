# -*- coding: utf-8 -*-
"""比较各槽 progress.sav：哈希 + 塔数（复刻 js 解析）+ playtime 查找。"""
import hashlib, io, json, os, re, struct, glob

root = r"C:\Users\Administrator\AppData\Roaming\Ryujinx\bis\user\save\0000000000000007\0"

# 1) 各槽文件哈希
files = sorted(glob.glob(os.path.join(root, "slot_*", "progress.sav")))
for p in files:
    with open(p, "rb") as f:
        data = f.read()
    print("%s  md5=%s" % (p.split("slot_")[1].split(os.sep)[0], hashlib.md5(data).hexdigest()[:16]))

# 2) 解析塔数（towers hash 表 value==1 数量 —— 用 explore_save_map 的 15 塔 hash）
mapf = r"E:\WorkSpace\TOTKmap\data\explore_save_map.js"
with io.open(mapf, "r", encoding="utf-8") as f:
    t = f.read()
m = re.search(r"window\.TOTK_EXPLORE_MAP\s*=\s*(\{.*?\});", t, re.S)
emap = json.loads(m.group(1)) if m else None
towers = emap.get("towers", {}) if emap else {}

def parse_towers(path):
    with open(path, "rb") as f:
        data = f.read()
    vb = {}
    for j in range(0x28, min(0x03c800, len(data)) - 7, 8):
        h = struct.unpack("<I", data[j:j+4])[0]
        vb[h] = j + 4
    done = []
    for mid, hv in towers.items():
        off = vb.get(int(hv, 16))
        if off is not None:
            with open(path, "rb") as f:
                f.seek(off)
                if struct.unpack("<I", f.read(4))[0] == 1:
                    done.append(int(mid))
    return done

import json
for p in files:
    done = parse_towers(p)
    print("%s  towers_done=%s (%d)" % (p.split("slot_")[1].split(os.sep)[0], done, len(done)))

# 3) totk_save_hashes.js 里找 PlayTime / 游玩
hf = r"E:\WorkSpace\TOTKmap\data\totk_save_hashes.js"
with io.open(hf, "r", encoding="utf-8") as f:
    ht = f.read()
print("--- PlayTime 相关 ---")
for pat in [r"PlayTime", r"playTime", r"游玩", r"TIME", r"Time"]:
    mm = re.findall(r'("[^"]*%s[^"]*"\s*:\s*[^,\n}]+)' % pat, ht)
    if mm:
        for x in mm[:6]:
            print("  ", x[:120])
print("total len:", len(ht))
