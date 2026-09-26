"""Auto-locate the player's coordinate address in Ryujinx guest RAM.

Fully automatic, two stages:

  1. ANCHOR - read the newest TOTK save (`slot_XX/progress.sav`) for the last
     known player position.  Memory and save share the same raw layout
     `(X_east, Z_height + 105, -Y_north)`, verified 2026-09-14.
  2. RELOCATE - scan guest RAM for float32 triples inside a window around that
     anchor and pick the *value with the most copies*: the player object is
     referenced by camera / UI / save caches, so it has far more copies than a
     random NPC.  Ranking inside the anchor window also avoids the old failure
     mode where a frozen "inactive object default position" won on copy count.

usage:
    python locate.py <pid> [--window N] [--json] [--out FILE]
"""
import ctypes
import json
import os
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes

import numpy as np

np.seterr(all="ignore")     # NaN/inf in guest RAM is normal; silence the noise

SAVE_ROOT = os.path.expandvars(r"%APPDATA%\Ryujinx\bis\user\save")
# progress.sav holds the player triple at these offsets (two copies); caption.sav
# mirrors it at 0x1E0.  Verified on game version 1.2.1 / BID 9B4E43650501A4D4.
SAVE_OFFSETS = {"progress.sav": (0x532AC, 0x53324), "caption.sav": (0x1E0,)}
ELEV_BIAS = 105.0    # stored height is real height + 105
MIRROR_STEP = 0x800000000   # Ryujinx's second view of guest RAM, 32 GB higher
CHUNK = 64 << 20     # 64 MB per read
THREADS = 16
HIT_CAP = 3_000_000  # safety valve: stop collecting if the window is too wide

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
MEM_MAPPED = 0x40000


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


k32 = ctypes.windll.kernel32
k32.OpenProcess.restype = wintypes.HANDLE
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MEMORY_BASIC_INFORMATION),
                               ctypes.c_size_t]
k32.VirtualQueryEx.restype = ctypes.c_size_t


def open_process(pid):
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        raise RuntimeError("OpenProcess failed (err=%d)" % ctypes.get_last_error())
    return h


def regions(h, min_mb=256.0):
    """Committed readable regions worth scanning (guest RAM blocks).

    Ryujinx keeps guest DRAM in ONE huge RW MEM_MAPPED block (~6 GB for TOTK).
    Right after launch that block is still growing and other mappings are
    bigger, so a plain "everything >= 256 MB" filter picked 1.6 GB of unrelated
    regions and found nothing -- always prefer the largest RW mapping when it
    is big enough to be DRAM.

    The same guest memory is also mapped a second time 32 GB higher, so when we
    fall back to the size filter we drop the mirror window: scanning it again
    only doubles the work and the hit list.
    """
    mbi = MEMORY_BASIC_INFORMATION()
    addr, raw, dram = 0, [], None
    LIMIT = 0x7FFFFFFFFFFF
    while addr < LIMIT:
        n = k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi),
                               ctypes.sizeof(mbi))
        if n == 0:
            break
        base = mbi.BaseAddress or 0
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT:
            if size >= min_mb * 1048576.0:
                raw.append((base, size))
            if (mbi.Type == MEM_MAPPED and (mbi.Protect & 0xFF) in (0x02, 0x04)
                    and (dram is None or size > dram[1])):
                dram = (base, size)
        addr = base + size
    if dram and dram[1] >= 512 * 1048576:
        return [dram]
    base_set = {b for b, _s in raw}
    out = [(b, s) for b, s in raw if (b + MIRROR_STEP) not in base_set]
    return out


def sane(gx, gy, gz):
    return (-20000.0 < gx < 20000.0 and -20000.0 < gy < 20000.0
            and -2000.0 < gz < 5000.0) and (abs(gx) > 1.0 or abs(gy) > 1.0)


def read_save_triples():
    """Return [(path, offset, (gx, gy, gz))] from the newest save files."""
    cands = []
    for dirpath, _dn, fns in os.walk(SAVE_ROOT):
        for fn in fns:
            if fn in SAVE_OFFSETS:
                p = os.path.join(dirpath, fn)
                try:
                    cands.append((os.path.getmtime(p), p, fn))
                except OSError:
                    pass
    cands.sort(reverse=True)
    out, seen = [], []
    for _mt, p, fn in cands:            # ALL files, not just the newest few
        try:
            with open(p, "rb") as f:
                data = f.read()
        except OSError:
            continue
        for off in SAVE_OFFSETS.get(fn, ()):
            if off + 12 > len(data):
                continue
            mx, mz, my = struct.unpack_from("<fff", data, off)
            gx, gz, gy = mx, mz - ELEV_BIAS, -my
            if not sane(gx, gy, gz):
                continue
            key = (round(gx, 1), round(gy, 1), round(gz, 1))
            if key in seen:             # six slots share one mtime, so dedupe by
                continue                # position instead of trusting mtime order
            seen.append(key)
            out.append((p, off, (gx, gy, gz)))
    return out


def anchor_refs(anchors, limit=8, merge=4.0):
    """Distinct memory-space refs for every save slot.

    All six slots share one mtime (the game rewrites them together), so picking
    "the newest save" is arbitrary -- we must treat every slot as a candidate
    anchor and let the structure signature decide which one is loaded.

    Nearby anchors are merged: two slots a few metres apart are the same place
    as far as a +/-60 scan is concerned, and every extra anchor costs work.
    """
    out = []
    for _p, _off, hud in anchors:
        r = (hud[0], hud[2] + ELEV_BIAS, -hud[1])
        if all((abs(r[0] - o[0]) > merge or abs(r[1] - o[1]) > merge
                or abs(r[2] - o[2]) > merge) for o in out):
            out.append(r)
        if len(out) >= limit:
            break
    return out


def scan_region(h, base, size, refs, window, hits):
    """Collect float32 triples that sit within `window` of ANY anchor ref.

    Performance note: building one full mask per anchor costs ~11 array passes
    each (measured: 8 anchors -> 208 s vs 35 s for one).  A hit must pass all
    three axes against the *union* of the anchor boxes, so we pre-filter with a
    cheap range test per axis and only run the exact per-anchor comparison on
    the survivors -- random guest bytes almost never survive even one axis.
    """
    np.seterr(all="ignore")     # worker threads need their own errstate
    if not isinstance(refs, list):
        refs = [refs]
    gx0 = min(r[0] for r in refs) - window
    gx1 = max(r[0] for r in refs) + window
    gh0 = min(r[1] for r in refs) - window
    gh1 = max(r[1] for r in refs) + window
    gz0 = min(r[2] for r in refs) - window
    gz1 = max(r[2] for r in refs) + window
    off = 0
    while off < size:
        if len(hits) > HIT_CAP:
            return
        n = min(CHUNK, size - off)
        buf = ctypes.create_string_buffer(n)
        got = ctypes.c_size_t()
        ok = k32.ReadProcessMemory(h, ctypes.c_void_p(base + off), buf, n,
                                   ctypes.byref(got))
        if ok and got.value >= 12:
            raw = buf.raw[:got.value]
            a = np.frombuffer(raw[:len(raw) // 4 * 4], dtype="<f4")
            if len(a) >= 3:
                ax, ah, az = a[:-2], a[1:-1], a[2:]
                idx = np.nonzero((ax > gx0) & (ax < gx1))[0]
                if idx.size:
                    keep = (ah[idx] > gh0) & (ah[idx] < gh1)
                    idx = idx[keep]
                if idx.size:
                    keep = (az[idx] > gz0) & (az[idx] < gz1)
                    idx = idx[keep]
                if idx.size:
                    axs, ahs, azs = ax[idx], ah[idx], az[idx]
                    for j in range(idx.size):
                        x, z, ny = float(axs[j]), float(ahs[j]), float(azs[j])
                        ri, rd = 0, 1e18
                        for k, r in enumerate(refs):
                            d = ((x - r[0]) ** 2 + (z - r[1]) ** 2
                                 + (ny - r[2]) ** 2) ** 0.5
                            if d < rd:
                                ri, rd = k, d
                        if rd <= window:
                            hits.append((base + off + int(idx[j]) * 4,
                                         x, z, ny, ri, rd))
        off += n


def rot_ok(h, addr):
    """Is there an orthonormal 3x3 float matrix within 64 bytes after addr?

    ActorBase stores mPosition immediately followed by mRotation, so a real game
    object passes this test while plain UI/derived copies usually do not.
    """
    buf = ctypes.create_string_buffer(128)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, 128,
                                 ctypes.byref(got)) or got.value < 64:
        return False
    a = np.frombuffer(buf.raw[:got.value // 4 * 4], dtype="<f4").astype(np.float64)
    for st in range(4, 17):
        if st + 9 > len(a):
            break
        m = a[st:st + 9].reshape(3, 3)
        cols = m.T
        norms = np.linalg.norm(cols, axis=0)
        if not np.all(np.abs(norms - 1.0) < 0.05):
            continue
        dots = [abs(float(np.dot(cols[i], cols[j])))
                for i in range(3) for j in range(i + 1, 3)]
        if max(dots) < 0.08:
            return True
    return False


def say(log, text):
    log.append(text)
    print(text, flush=True)


def locate(pid, window=60.0, log=None):
    log = log if log is not None else []
    t0 = time.time()
    anchors = read_save_triples()
    if not anchors:
        say(log, "no usable save anchor found")
        return None, log
    refs = anchor_refs(anchors)
    say(log, "save anchors: %d file offsets -> %d distinct positions"
        % (len(anchors), len(refs)))
    for i, r in enumerate(refs):
        say(log, "  slot#%d mem=(%.1f, %.1f, %.1f)  hud=(%.1f, %.1f, %.1f)"
            % (i, r[0], r[1], r[2], r[0], -r[2], r[1] - ELEV_BIAS))

    h = open_process(pid)
    regs = regions(h)
    say(log, "regions>=256MB: %d  (%.1f GB)"
        % (len(regs), sum(s for _b, s in regs) / 2**30))
    for b, s in regs:
        say(log, "  region 0x%012X  %8.0f MB" % (b, s / 1048576.0))

    best = None
    shortlist = []
    # The save may be several minutes old, so the first pass uses a generous
    # window (120 m).  Escalating to 400 m only if nothing came back at all.
    for attempt, win in enumerate((max(window, 120.0), 400.0), 1):
        hits = []
        with ThreadPoolExecutor(max_workers=THREADS) as ex:
            futs = [ex.submit(scan_region, h, b, s, refs, win, hits) for b, s in regs]
            for f in futs:
                f.result()
        say(log, "pass %d (window +/-%.0f): %d triple hits in %.1fs"
            % (attempt, win, len(hits), time.time() - t0))
        if not hits:
            continue
        groups = {}
        for addr, x, z, ny, ri, rd in hits:
            key = (round(x, 1), round(z, 1), round(ny, 1))
            g = groups.setdefault(key, {"addrs": [], "ri": ri, "dist": rd})
            g["addrs"].append(addr)
            if rd < g["dist"]:
                g["dist"], g["ri"] = rd, ri
        ranked = sorted(groups.items(), key=lambda kv: -len(kv[1]["addrs"]))
        say(log, "  top groups (copies, struct-hit, dist to its own slot anchor):")
        scored = []
        # NOTE: neither copy count nor the structure signature identifies the
        # player on its own (see README).  Keep a generous shortlist and let the
        # runtime liveness watcher decide.
        for key, g in ranked[:30]:
            st = sum(1 for a in g["addrs"][:64] if rot_ok(h, a))
            scored.append({"key": key, "addrs": g["addrs"], "struct": st,
                           "dist": g["dist"], "ri": g["ri"],
                           "copies": len(g["addrs"])})
            if len(scored) <= 12:
                say(log, "    x%-5d struct %2d  d=%6.1f  slot#%d  mem=(%.1f, %.1f, %.1f)  hud=(%.1f, %.1f, %.1f)"
                    % (len(g["addrs"]), st, g["dist"], g["ri"],
                       key[0], key[1], key[2], key[0], -key[2], key[1] - ELEV_BIAS))
        scored.sort(key=lambda s: (-(s["struct"] > 0), -s["struct"],
                                   s["dist"], -s["copies"]))
        best = scored[0]
        shortlist = [{"hud": [s["key"][0], -s["key"][2], s["key"][1] - ELEV_BIAS],
                      "copies": s["copies"], "struct": s["struct"],
                      "dist": s["dist"], "slot": s["ri"],
                      "addrs": s["addrs"][:24]} for s in scored]
        if best["struct"] > 0:
            break
    if best is None:
        say(log, "FAILED: no confident candidate")
        return None, log
    key, addr = best["key"], best["addrs"][0]
    say(log, "candidate 0x%012X  copies=%d struct=%d  hud=(%.1f, %.1f, %.1f)  [pending liveness check]"
        % (addr, best["copies"], best["struct"], key[0], -key[2], key[1] - ELEV_BIAS))
    say(log, "shortlist: %d groups, %d addresses"
        % (len(shortlist), sum(len(g["addrs"]) for g in shortlist)))
    say(log, "total %.1fs" % (time.time() - t0))
    return {"addr": addr, "copies": best["copies"], "struct": best["struct"],
            "hud": (key[0], -key[2], key[1] - ELEV_BIAS),
            "shortlist": shortlist, "log": log}, log


def main():
    pid = int(sys.argv[1])
    window = 60.0
    out = None
    logfile = r"E:\WorkSpace\ZeldaTOTKmap\.workbuddy\locate_log.txt"
    as_json = "--json" in sys.argv
    for i, a in enumerate(sys.argv):
        if a == "--window":
            window = float(sys.argv[i + 1])
        if a == "--out":
            out = sys.argv[i + 1]
        if a == "--logfile":
            logfile = sys.argv[i + 1]
    try:
        res, log = locate(pid, window)
    except Exception:
        import traceback
        tb = "EXCEPTION\n" + traceback.format_exc()
        print(tb, flush=True)
        if logfile:
            with open(logfile, "w", encoding="utf-8") as f:
                f.write(tb)
        sys.exit(3)
    if logfile:
        with open(logfile, "w", encoding="utf-8") as f:
            f.write("\n".join(log))
    if res is None:
        sys.exit(2)
    if out:
        with open(out, "w", encoding="utf-8") as f:
            json.dump(res, f)
    if as_json:
        print(json.dumps({"addr": "0x%012X" % res["addr"], "copies": res["copies"],
                          "struct": res["struct"], "hud": res["hud"]}))


if __name__ == "__main__":
    main()
