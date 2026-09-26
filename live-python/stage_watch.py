# -*- coding: utf-8 -*-
"""Stage 实时监视器：对已知候选地址持续轮询，记录每次内容变化（时间戳 + 旧值 -> 新值）。

用法：py -3.11 stage_watch.py <pid> <a.json> <b.json> <dur_sec> [--out out.json]
候选 = A/B 快照中内容不同的地址；每 0.5s 轮询一次。
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

def word_at(h, addr, n=32):
    d = read_mem(h, addr, n)
    if not d:
        return None
    z = d.find(b"\x00")
    return d[:z if z >= 0 else n].decode("ascii", "replace")

def main():
    pid = int(sys.argv[1])
    A = json.load(open(sys.argv[2], encoding="utf-8"))["items"]
    B = json.load(open(sys.argv[3], encoding="utf-8"))["items"]
    dur = float(sys.argv[4])
    out = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5].startswith("--out") else None
    if out:
        out = sys.argv[6]

    am = {x["addr"]: x for x in A}
    bm = {x["addr"]: x for x in B}
    cands = []
    for addr, x in am.items():
        y = bm.get(addr)
        if y and x.get("word") != y.get("word"):
            cands.append(addr)
    for addr in bm:
        if addr not in am:
            cands.append(addr)
    cands = sorted(set(cands))
    print("candidates: %d" % len(cands), flush=True)

    h = open_process(pid)
    base = {a: word_at(h, a) for a in cands}
    events = []
    t0 = time.time()
    while time.time() - t0 < dur:
        time.sleep(0.5)
        for a in cands:
            w = word_at(h, a)
            if w is None or base.get(a) == w:
                continue
            ev = {"t": round(time.time() - t0, 1), "addr": a,
                  "old": base.get(a), "new": w}
            events.append(ev)
            base[a] = w
            print("t=%5.1f  0x%012X  %-28s -> %s" % (ev["t"], a, ev["old"], ev["new"]), flush=True)
    print("done: %d events" % len(events), flush=True)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump({"events": events}, f, indent=1)
        print("saved -> %s" % out, flush=True)

if __name__ == "__main__":
    main()
