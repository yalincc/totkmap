# -*- coding: utf-8 -*-
"""Stage 扫描器（治本方案①，第一阶段：定位"当前 stage"内存字段）

原理：游戏在 Ryujinx guest RAM 里保存当前 stage 名字符串（MainField / MinusField /
caveNNN / SkyIsland...）。静态注册表里的名字地址固定不变；只有"当前 stage"字段的
内容会随 stage 切换被覆盖（MainField <-> MinusField <-> cave017...）。

流程：
  1) scan     -- 全量扫 stage 名字符串，报告各类别出现次数 + 样例地址
  2) snapshot -- 把候选地址的内容（前 24 字节）快照存 JSON
  3) diff     -- 对比两次快照，报告"内容变化"的地址 = 当前 stage 字段候选

用法：
  py -3.11 stage_scan.py <pid> scan
  py -3.11 stage_scan.py <pid> snapshot <out.json>
  py -3.11 stage_scan.py <pid> diff <a.json> <b.json>
"""
import ctypes
import json
import os
import re
import struct
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from locate import open_process, regions

CHUNK = 64 << 20
PATTERNS = [
    (b"MainField", "MainField"),
    (b"MinusField", "MinusField"),
    (b"SkyIsland", "SkyIsland"),
    (b"SpiritualField", "SpiritualField"),
    (b"StartIsland", "StartIsland"),
    (b"AocField", "AocField"),
    (b"SmallDungeon", "SmallDungeon"),
    (b"LargeDungeon", "LargeDungeon"),
    (b"CDungeon", "CDungeon"),
]
CAVE_RE = re.compile(rb"cave\d\d\d")

def read_mem(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not ctypes.windll.kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size,
                                                    ctypes.byref(got)):
        return None
    return buf.raw[:got.value]

def scan(h, regs):
    """返回 {pattern: [(addr, word)]}（word = 该处前 24 字节首个字符串）。"""
    found = {}
    for base, size in regs:
        off = 0
        while off < size:
            n = min(CHUNK, size - off)
            buf = read_mem(h, base + off, n)
            if buf:
                for pat, name in PATTERNS:
                    start = 0
                    while True:
                        i = buf.find(pat, start)
                        if i < 0:
                            break
                        a = base + off + i
                        found.setdefault(name, []).append(a)
                        start = i + 1
                for m in CAVE_RE.finditer(buf):
                    a = base + off + m.start()
                    found.setdefault("cave", []).append((a, m.group().decode("ascii")))
            off += n
    return found

def word_at(h, addr, n=24):
    d = read_mem(h, addr, n)
    if not d:
        return None
    z = d.find(b"\x00")
    return d[:z if z >= 0 else n].decode("ascii", "replace")

def snapshot(h, found, out):
    items = []
    for name, addrs in found.items():
        for a in addrs:
            if isinstance(a, tuple):
                a, w = a
            else:
                w = word_at(h, a)
            items.append({"name": name, "addr": a, "word": w})
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"time": time.strftime("%H:%M:%S"), "items": items}, f, indent=1)
    print("snapshot saved: %d items -> %s" % (len(items), out))

def diff(a_path, b_path):
    A = json.load(open(a_path, encoding="utf-8"))["items"]
    B = json.load(open(b_path, encoding="utf-8"))["items"]
    am = {x["addr"]: x for x in A}
    bm = {x["addr"]: x for x in B}
    changed = []
    for addr, x in am.items():
        y = bm.get(addr)
        if y and x.get("word") != y.get("word"):
            changed.append((addr, x.get("word"), y.get("word"), x.get("name")))
    print("changed candidates: %d" % len(changed))
    for addr, w0, w1, nm in changed:
        print("  0x%012X  %-12s  %s -> %s" % (addr, nm, w0, w1))
    return changed

def main():
    pid = int(sys.argv[1])
    cmd = sys.argv[2]
    if cmd == "diff":
        changed = diff(sys.argv[3], sys.argv[4])
        return
    h = open_process(pid)
    regs = regions(h)
    total = sum(s for _b, s in regs)
    print("regions: %d  (%.1f GB)" % (len(regs), total / 2**30))
    if cmd == "scan":
        t0 = time.time()
        found = scan(h, regs)
        n = 0
        for name, addrs in sorted(found.items()):
            if name == "cave":
                ws = [w for _a, w in addrs]
                n += len(addrs)
                print("cave     %5d  样例: %s" % (len(addrs), sorted(set(ws))[:8]))
            else:
                n += len(addrs)
                print("%-14s %5d  前3: %s" % (name, len(addrs),
                      [hex(a) for a in addrs[:3]]))
        print("total: %d  (%.1fs)" % (n, time.time() - t0))
    elif cmd == "snapshot":
        out = sys.argv[3]
        found = scan(h, regs)
        snapshot(h, found, out)
    else:
        print("unknown cmd")

if __name__ == "__main__":
    main()
