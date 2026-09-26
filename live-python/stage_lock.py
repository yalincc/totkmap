# -*- coding: utf-8 -*-
"""瞬时 stage 快照：批量页读候选地址内容（<2s），隔 5s 再读一次，过滤活跃加载队列。

用法：
  py -3.11 stage_lock.py <pid> snap <out.json> [--addr addr.json]
    --addr 缺省时用 tools/_stage_snap_a.json ∪ _stage_snap_b.json 的地址并集
  py -3.11 stage_lock.py <pid> diff <a.json> <b.json>
"""
import ctypes
import json
import os
import sys
import time
from ctypes import wintypes

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from locate import open_process

def read_mem(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not ctypes.windll.kernel32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size,
                                                    ctypes.byref(got)):
        return None
    return buf.raw[:got.value]

def collect_addrs():
    """A∪B 快照地址并集（同一会话内存布局稳定，无需重扫）。"""
    base = os.path.dirname(os.path.abspath(__file__))
    roots = [os.path.join(base, "..", "tools", "_stage_snap_a.json"),
             os.path.join(base, "..", "tools", "_stage_snap_b.json")]
    s = set()
    for p in roots:
        d = json.load(open(p, encoding="utf-8"))
        for x in d["items"]:
            s.add(x["addr"])
    return sorted(s)

def bulk_read(h, addrs):
    """按 4KB 页聚合批量读，返回 {addr: word(24B 到 NUL)}。"""
    out = {}
    page_map = {}
    for a in addrs:
        page_map.setdefault(a & ~0xFFF, []).append(a)
    for page, lst in page_map.items():
        d = read_mem(h, page, 0x1000)
        if not d:
            continue
        for a in lst:
            off = a - page
            chunk = d[off:off + 24]
            if not chunk:
                continue
            z = chunk.find(b"\x00")
            w = chunk[:z if z >= 0 else 24]
            try:
                out[a] = w.decode("ascii", "replace")
            except Exception:
                out[a] = ""
    return out

def snap(h, addrs, out):
    t0 = time.time()
    s1 = bulk_read(h, addrs)
    time.sleep(5.0)
    s2 = bulk_read(h, addrs)
    stable, active = {}, {}
    for a in addrs:
        if s1.get(a) == s2.get(a):
            stable[a] = s1.get(a, "")
        else:
            active[a] = (s1.get(a, ""), s2.get(a, ""))
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"time": time.strftime("%H:%M:%S"), "stable": stable,
                   "active": active}, f)
    print("snap %s: %d addrs, stable=%d active=%d (%.1fs)"
          % (out, len(addrs), len(stable), len(active), time.time() - t0), flush=True)

def diff(a_path, b_path):
    A = json.load(open(a_path, encoding="utf-8"))
    B = json.load(open(b_path, encoding="utf-8"))
    sa, sb = A["stable"], B["stable"]
    diffs = []
    for a, w in sa.items():
        wb = sb.get(a)
        if wb is not None and w != wb:
            diffs.append((a, w, wb))
    for a, w in sb.items():
        if a not in sa:
            diffs.append((a, "<absent>", w))
    diffs.sort()
    print("stable diffs: %d" % len(diffs), flush=True)
    for a, w0, w1 in diffs[:300]:
        print("  0x%012X  %-30s -> %s" % (a, (w0 or "")[:30], (w1 or "")[:30]), flush=True)
    return diffs

def main():
    pid = int(sys.argv[1])
    cmd = sys.argv[2]
    if cmd == "diff":
        diff(sys.argv[3], sys.argv[4])
        return
    h = open_process(pid)
    if cmd == "snap":
        out = sys.argv[3]
        addrs = collect_addrs()
        snap(h, addrs, out)
    elif cmd == "diff":
        diff(sys.argv[3], sys.argv[4])
    else:
        print("unknown cmd")

if __name__ == "__main__":
    main()
