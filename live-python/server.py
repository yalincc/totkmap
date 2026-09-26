"""TOTKNavi-python · TOTK 实时玩家定位服务（TOTKmap V1.8.0 M1 快速验证版）

定位策略（与 ZeldaTOTKmap 实测一致）：
  1. known_addrs 快路径：内存偏移跨游戏/Ryujinx 重启稳定，直接重基址读取（<1s）
  2. 存档锚点扫描：读 progress.sav 最后位置 -> 窗口扫描 guest RAM -> 副本数 + 旋转矩阵特征
     -> 短名单走动确认（locate.py）
  3. watchdog：位置流断 -> 重试快路径 -> 3 分钟无果全量重扫；进程重启自动重挂

HTTP 契约（与后续 Go 化版本一致，网页端只认这套）：
  GET  /pos      -> {ok, mx, my, gz, layer, verified, source, age, target}
                     mx/my = Leaflet latlng = (Z, X)；Z 北负南正（与游戏地图一致），X 东正
                     layer = 20 天空 / 19 地底 / 18 地上（按玩家实际高度）
  GET  /target   -> 当前目标或 {ok:false}
  POST /target   -> {"x":..,"y":..,"name":..,"type":..,"layer":18|19|20} 或 {"clear":true}
                     layer 可省（缺省 null）；网页端按 layer 判断是否跨层
  GET  /rescan   -> 触发重新定位
端口 8766（与 BotwNavi 一致）。用法：python live-python/server.py
"""
import ctypes
import glob
import io
import json
import os
import re
import struct
import sys
import threading
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import locate
from locate import MEMORY_BASIC_INFORMATION

PORT = int(os.environ.get("TOTKNAVI_PORT", "8766"))
PROCESS_NAME = "Ryujinx"
ELEV_BIAS = 105.0

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPPROCESS = 0x2
MEM_COMMIT = 0x1000
MEM_MAPPED = 0x40000
PAGE_GUARD = 0x100

k32 = ctypes.windll.kernel32
k32.OpenProcess.restype = wintypes.HANDLE

HANDLE = None
PID = None
LOCK = {"addr": None, "verified": False, "copies": 0, "source": "-"}
STATE = {"ok": False, "gx": 0.0, "gy": 0.0, "gz": 0.0,
         "mx": 0.0, "my": 0.0, "layer": 18, "age": 0.0,
         "verified": False, "copies": 0, "source": "-"}
TARGET = [None]                       # 网页设置的导航目标 {name,x,y,type} 或 None

KNOWN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "known_addrs.json")
DEFAULT_OFFSETS = [0x3869ED10, 0x386C2A48, 0x3875DA10]
LEGACY_BLOCK = 0x0447CED50000
GUEST_BASE = 0


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * 260)]


def find_pid(name):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        return None
    e = PROCESSENTRY32()
    e.dwSize = ctypes.sizeof(e)
    ok = k32.Process32First(snap, ctypes.byref(e))
    found = None
    while ok:
        if e.szExeFile.decode("ascii", "replace").lower().startswith(name.lower()):
            found = e.th32ProcessID
            break
        ok = k32.Process32Next(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    return found


def reopen_process():
    global HANDLE, PID
    pid = find_pid(PROCESS_NAME)
    if not pid:
        return False
    if pid == PID and HANDLE:
        return True
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return False
    HANDLE, PID = h, pid
    print("  [proc] attached to %s pid=%d" % (PROCESS_NAME, pid), flush=True)
    return True


def read_mem(addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(HANDLE, ctypes.c_void_p(addr), buf, size,
                                 ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def guest_ram(min_mb=1024.0):
    """Host 地址 + 大小 of the guest DRAM block（TOTK 实测约 6GB 单块）。"""
    best = (0, 0)
    mbi = MEMORY_BASIC_INFORMATION()
    addr = 0
    while addr < 0x7FFFFFFFFFFF:
        n = k32.VirtualQueryEx(HANDLE, ctypes.c_void_p(addr), ctypes.byref(mbi),
                               ctypes.sizeof(mbi))
        if n == 0:
            break
        base, size = mbi.BaseAddress or 0, mbi.RegionSize
        if (mbi.State == MEM_COMMIT and mbi.Type == MEM_MAPPED
                and (mbi.Protect & 0xFF) in (0x04, 0x02)
                and not (mbi.Protect & PAGE_GUARD)
                and size > best[1]):
            best = (base, size)
        nxt = base + size
        addr = nxt if nxt > addr else addr + 0x1000
    return best if best[1] >= min_mb * 1048576.0 else (0, 0)


def decode_pos(d):
    """12 字节内存 -> (gx, gy, gz) = (X东, Y北, 实际高度) 或 None。"""
    if not d or len(d) != 12:
        return None
    v0, v1, v2 = struct.unpack("<3f", d)
    if v0 == 0.0 and v1 == 0.0 and v2 == 0.0:
        return None
    gx, gz, gy = v0, v1 - ELEV_BIAS, -v2
    if not (-6000.0 < gx < 6000.0 and -6000.0 < gy < 6000.0
            and -1300.0 < gz < 3200.0):
        return None
    return (gx, gy, gz)


def load_offsets():
    try:
        with open(KNOWN_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    out = []

    def add(v):
        try:
            o = int(v, 16) if isinstance(v, str) else int(v)
        except Exception:
            return
        if 0 < o < 0x100000000 and o not in out:
            out.append(o)

    for v in data.get("offsets") or []:
        add(v)
    try:
        blk = data.get("block") or LEGACY_BLOCK
        blk = int(blk, 16) if isinstance(blk, str) else int(blk)
    except Exception:
        blk = LEGACY_BLOCK
    for v in data.get("addrs") or []:
        try:
            a = int(v, 16) if isinstance(v, str) else int(v)
        except Exception:
            continue
        if a > blk:
            add(a - blk)
    for o in DEFAULT_OFFSETS:
        add(o)
    return out


def save_known(addrs):
    global GUEST_BASE
    if not GUEST_BASE:
        GUEST_BASE = guest_ram()[0]
    offs = []
    for a in addrs:
        try:
            o = a - GUEST_BASE if a > GUEST_BASE else a
        except Exception:
            continue
        if 0 < o < 0x100000000 and o not in offs:
            offs.append(o)
    for o in load_offsets():
        if o not in offs:
            offs.append(o)
    try:
        with open(KNOWN_FILE, "w", encoding="utf-8") as f:
            json.dump({"block": "0x%012X" % GUEST_BASE,
                       "offsets": ["0x%08X" % o for o in offs],
                       "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, f, indent=2)
        print("  [known] saved %d offset(s)" % len(offs), flush=True)
    except Exception as e:
        print("  [known] save failed: %s" % e, flush=True)


def try_offsets(verbose=True):
    """快路径：把记忆的偏移重基址到当前进程并读取（多副本一致才算数）。"""
    global GUEST_BASE
    if not reopen_process():
        if verbose:
            print("  [known] Ryujinx not running", flush=True)
        return None
    base, size = guest_ram()
    if not base:
        if verbose:
            print("  [known] guest DRAM block not ready yet", flush=True)
        return None
    GUEST_BASE = base
    offs = load_offsets()
    vals = []
    for o in offs:
        v = decode_pos(read_mem(base + o, 12))
        if v is not None:
            vals.append((base + o, o, v))
    if not vals:
        if verbose:
            print("  [known] none of the %d remembered offsets is usable" % len(offs), flush=True)
        return None
    best, bestn = None, -1
    for a, _o, v in vals:
        n = sum(1 for _b, _p, w in vals
                if abs(v[0] - w[0]) < 2 and abs(v[1] - w[1]) < 2
                and abs(v[2] - w[2]) < 2)
        if n > bestn:
            best, bestn = (a, v), n
    if bestn < 2 and len(offs) > 1:
        if verbose:
            print("  [known] no agreement between copies - unreliable", flush=True)
        return None
    if verbose:
        print("  [known] block 0x%012X | %d/%d offsets readable, best 0x%X "
              "agreed by %d copy(ies)  hud=(%.1f, %.1f, %.1f)"
              % (base, len(vals), len(offs), best[0], bestn - 1,
                 best[1][0], best[1][1], best[1][2]), flush=True)
    return best


def layer_of(gz):
    """玩家实际高度 -> TOTKmap 数据层（天空>=950 / 地底<0 / 地上）。"""
    return 20 if gz >= 950.0 else (19 if gz < 0.0 else 18)


def poll():
    """10Hz 把锁定地址镜像进 STATE（mx/my = Leaflet latlng = (Z北, X东)）。"""
    while True:
        a = LOCK["addr"]
        d = read_mem(a, 12) if a else None
        v = decode_pos(d) if d else None
        if v:
            gx, gy, gz = v
            STATE.update(ok=True, gx=gx, gy=gy, gz=gz,
                         mx=-gy, my=gx,
                         layer=layer_of(gz),
                         age=time.time(),
                         verified=LOCK["verified"], copies=LOCK["copies"],
                         source=LOCK["source"])
        else:
            STATE["ok"] = False
            STATE["source"] = "locating..." if not a else "address lost"
        time.sleep(0.1)


def watch_shortlist(shortlist):
    """短名单走动确认：锁到真正会动的分组。"""
    base = {}
    for g in shortlist:
        for a in g["addrs"]:
            d = read_mem(a, 12)
            if d and len(d) == 12:
                base[a] = struct.unpack("<3f", d)
    moved = [0] * len(shortlist)
    confirmed = -1
    while True:
        time.sleep(0.6)
        for gi, g in enumerate(shortlist):
            for a in g["addrs"]:
                d = read_mem(a, 12)
                if not d or len(d) != 12:
                    continue
                v = struct.unpack("<3f", d)
                b = base.get(a)
                base[a] = v
                if b is None:
                    continue
                if (abs(v[0] - b[0]) > 0.5 or abs(v[1] - b[1]) > 0.5
                        or abs(v[2] - b[2]) > 0.5):
                    moved[gi] += 1
        top = max(range(len(moved)), key=lambda i: moved[i])
        if moved[top] >= 3:
            if top != confirmed:
                confirmed = top
                a = shortlist[top]["addrs"][0]
                LOCK.update(addr=a, verified=True,
                            copies=shortlist[top]["copies"], source="scan")
                save_known([a] + load_known())
                print("  [watch] locked onto group %d: copies=%d struct=%d"
                      % (top, shortlist[top]["copies"], shortlist[top]["struct"]), flush=True)


def verify_known(addr):
    """后台验证记忆地址：值动 -> verified；失效 -> 重基址 / 重扫。"""
    prev = decode_pos(read_mem(addr, 12))
    bad = 0
    while True:
        time.sleep(0.3)
        if LOCK["addr"] != addr:
            return
        cur = decode_pos(read_mem(addr, 12))
        if cur is None:
            bad += 1
            if bad == 2:
                reopen_process()
            if bad >= 4:
                hit = try_offsets(verbose=False)
                if hit:
                    a, v = hit
                    print("  [verify] re-based onto new block 0x%X" % a, flush=True)
                    LOCK.update(addr=a, verified=False, copies=0, source="known")
                    prev, bad = v, 0
                    continue
            if bad >= 10:
                print("  [verify] address went bad - re-locating", flush=True)
                LOCK["addr"] = None
                LOCK["verified"] = False
                relocalize("remembered address became unreadable")
                return
            continue
        bad = 0
        if prev is not None and (abs(cur[0] - prev[0]) > 0.2
                                 or abs(cur[1] - prev[1]) > 0.2
                                 or abs(cur[2] - prev[2]) > 0.2):
            if not LOCK["verified"]:
                print("  [verify] address is live (moved) -> verified", flush=True)
                LOCK["verified"] = True
        prev = cur


def relocalize(reason):
    if not reopen_process() or PID is None:
        print("  [relocate] %s -> Ryujinx not running" % reason, flush=True)
        return False
    print("  [relocate] %s -> running save-anchor scan" % reason, flush=True)
    try:
        res, log = locate.locate(PID)
    except Exception:
        import traceback
        print(traceback.format_exc(), flush=True)
        return False
    for line in log:
        print("    " + line, flush=True)
    if not res:
        print("  [relocate] scan found nothing", flush=True)
        return False
    addr = res["addr"]
    LOCK.update(addr=addr, verified=False, copies=res.get("copies", 0), source="scan")
    sl = res.get("shortlist", [])
    if sl:
        threading.Thread(target=watch_shortlist, args=(sl,), daemon=True).start()
    else:
        LOCK["verified"] = True
    save_known([addr] + load_known())
    print("  [relocate] candidate 0x%X hud=(%.1f, %.1f, %.1f) - being watched"
          % ((addr,) + tuple(res["hud"])), flush=True)
    return True


LAST_SCAN = [0.0]


def watchdog():
    while True:
        time.sleep(3)
        if LOCK["addr"] and STATE["ok"]:
            continue
        hit = try_offsets(verbose=False)
        if hit:
            a, v = hit
            first = LOCK["addr"] is None
            LOCK.update(addr=a, verified=False, copies=0, source="known")
            print("  [watchdog] recovered 0x%X hud=(%.1f, %.1f, %.1f)"
                  % ((a,) + tuple(v)), flush=True)
            if first:
                threading.Thread(target=verify_known, args=(a,), daemon=True,
                                 name="verify").start()
            continue
        if time.time() - LAST_SCAN[0] > 180:
            LAST_SCAN[0] = time.time()
            relocalize("watchdog: no remembered offset works")


# ================= /progress：服务端存档逐点完成判定（V1.8.0 M3 自动导航） =================
# 复刻 js/save-parser.js 解析口径：版本表 / HASH_TABLE_END / 0xa3db7114 哨兵 / GUID 格式
SAVE_GAME_VERSIONS = [
    (0x0046c3c8, 0x0003c050, 2307552, "v1.0"),
    (0x0047e0f4, 0x0003c088, 2307656, "v1.1.x/v1.2.x"),
    (0x0049e946, 0x0003c138, 2307856, "v1.4.x"),
]
HASH_TABLE_END = 0x03c800
PROGRESS_CACHE_SEC = 2.0        # /progress 缓存，避免高频 IO（游戏保存后 2s 内可检测到）
_progress_cache = {"t": 0.0, "payload": None, "mtime": 0.0}


def _find_save():
    """返回 (mtime, path)：优先 slot_00（用户实际使用的槽）；
    Ryujinx 保存时会把所有槽 mtime 写成同一时刻，mtime 判槽不可靠。"""
    base = os.path.join(os.environ.get("APPDATA", ""), "Ryujinx", "bis", "user", "save")
    cands = []
    for p in glob.glob(os.path.join(base, "*", "0", "slot_*", "progress.sav")):
        try:
            cands.append((os.path.getmtime(p), p))
        except OSError:
            continue
    if not cands:
        return None
    cands.sort(key=lambda x: x[0], reverse=True)  # 同名 mtime 时保持槽号顺序
    for mt, p in cands:
        if p.replace("\\", "/").endswith("/slot_00/progress.sav"):
            return (mt, p)
    return cands[0]


def _parse_save(path):
    """解析 progress.sav → {ok, version, valueByHash, guids}（与 js parse() 同口径）。"""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        return {"ok": False, "error": "read: %s" % e}
    if len(data) < 8 or struct.unpack("<I", data[0:4])[0] != 0x01020304:
        return {"ok": False, "error": "bad header"}
    header = struct.unpack("<I", data[4:8])[0]
    meta = struct.unpack("<I", data[8:12])[0]
    version = None
    for h, m, sz, v in SAVE_GAME_VERSIONS:
        if len(data) == sz and header == h and meta == m:
            version = v
            break
    if not version:
        return {"ok": False, "error": "unsupported version"}
    value_by_hash = {}
    guids_offset = None
    end = min(HASH_TABLE_END, len(data))
    for j in range(0x28, end - 7, 8):
        h = struct.unpack("<I", data[j:j + 4])[0]
        if h == 0xA3DB7114:
            guids_offset = struct.unpack("<I", data[j + 4:j + 8])[0]
        value_by_hash[h] = j + 4
    if guids_offset is None or guids_offset <= 0 or guids_offset >= len(data):
        return {"ok": False, "error": "no guid table"}
    guids = []
    k = guids_offset
    while k < len(data) - 8:
        lo = struct.unpack("<I", data[k:k + 4])[0]
        up = struct.unpack("<I", data[k + 4:k + 8])[0]
        if lo == 0 and up == 0:
            break
        guids.append("0x%08x%08x" % (up, lo))
        k += 8
    return {"ok": True, "version": version, "valueByHash": value_by_hash, "guids": guids, "data": data}


def _load_explore_map():
    """读 data/explore_save_map.js 中的 JSON 映射表。"""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "explore_save_map.js")
    try:
        with io.open(p, "r", encoding="utf-8") as f:
            text = f.read()
        m = re.search(r"window\.TOTK_EXPLORE_MAP\s*=\s*(\{.*?\});", text, re.S)
        if not m:
            return None
        return json.loads(m.group(1))
    except Exception:
        return None


def _murmur3_32(key, seed=0):
    """MurmurHash3 x86 32-bit —— 与 js murmurHash3.x86.hash32 完全一致（'Clear'/'Open' 等字符串 hash）。"""
    data = key.encode("utf-8")
    n = len(data)
    h = seed & 0xFFFFFFFF
    i = 0
    while i + 4 <= n:
        k = int.from_bytes(data[i:i + 4], "little")
        k = (k * 0xCC9E2D51) & 0xFFFFFFFF
        k = (((k << 15) | (k >> 17)) & 0xFFFFFFFF) * 0x1B873593 & 0xFFFFFFFF
        h ^= k
        h = (((h << 13) | (h >> 19)) & 0xFFFFFFFF) * 5 + 0xE6546B64 & 0xFFFFFFFF
        i += 4
    tail = data[i:]
    k = 0
    if len(tail) >= 3:
        k |= tail[2] << 16
    if len(tail) >= 2:
        k |= tail[1] << 8
    if len(tail) >= 1:
        k |= tail[0]
        k = (k * 0xCC9E2D51) & 0xFFFFFFFF
        k = (((k << 15) | (k >> 17)) & 0xFFFFFFFF) * 0x1B873593 & 0xFFFFFFFF
        h ^= k
    h ^= n
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h


def _parse_completism():
    """读 data/totk_save_hashes.js 的 CompletismHashes → {KEY: [hash|guid, ...]}。"""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "totk_save_hashes.js")
    try:
        with io.open(p, "r", encoding="utf-8") as f:
            t = f.read()
        m = re.search(r"var\s+CompletismHashes\s*=\s*(\{.*?\})", t, re.S)
        if not m:
            return None
        keys = {}
        for km in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*?)\n\s*\],?", m.group(1), re.S):
            arr = []
            for a, b, c in re.findall(r"0x([0-9a-fA-F]+)|'([^']+)'|\"([^\"]+)\"", km.group(2)):
                if a:
                    arr.append(int(a, 16))
                else:
                    arr.append(b or c)
            keys[km.group(1)] = arr
        return keys
    except Exception:
        return None


DRAGON_TEARS = [
    0x95eaf7f7, 0xd8f6148f, 0xea112a5c, 0x0ba4de99, 0x5a630ce5, 0x2146bc12,
    0x9061714b, 0x7cc0375a, 0xa14c6ed1, 0x587df5b0, 0x5279d33f, 0xc595c991
]


def _progress_counts(parsed):
    """与 js/save-parser.js collect() 同口径：{分类名: {done, total}}。"""
    vb = parsed["valueByHash"]
    data = parsed["data"]
    guids = parsed["guids"]
    C = _parse_completism() or {}
    out = {}

    def cnt(lst, val):
        n = 0
        if isinstance(val, str):
            val = _murmur3_32(val)
        for h in lst:
            off = vb.get(h)
            if off is not None and struct.unpack("<I", data[off:off + 4])[0] == val:
                n += 1
        return n

    def cg(lst):
        n = 0
        for g in lst:
            if g in guids:
                n += 1
        return n

    out["鸟望台"] = {"done": cnt(C.get("TOWERS_FOUND", []), 1), "total": len(C.get("TOWERS_FOUND", []))}
    out["龙之泪"] = {"done": cnt(DRAGON_TEARS, 1), "total": len(DRAGON_TEARS)}
    out["神庙"] = {"done": cnt(C.get("SHRINES_STATUS", []), "Clear"), "total": len(C.get("SHRINES_STATUS", []))}
    out["树根"] = {"done": cnt(C.get("LIGHTROOTS_STATUS", []), "Open"), "total": len(C.get("LIGHTROOTS_STATUS", []))}
    out["克洛格"] = {"done": cnt(C.get("KOROKS_HIDDEN", []), 1), "total": len(C.get("KOROKS_HIDDEN", []))}
    out["双倍克洛格"] = {"done": cnt(C.get("KOROKS_CARRY", []), "Clear"), "total": len(C.get("KOROKS_CARRY", []))}
    out["魔犹伊遗失物"] = {"done": cg(C.get("BUBBULS_GUIDS", [])), "total": len(C.get("BUBBULS_GUIDS", []))}
    out["残旧的地图"] = {"done": cnt(C.get("TREASURE_MAPS_FOUND", []), 1), "total": len(C.get("TREASURE_MAPS_FOUND", []))}
    out["贤者的遗志"] = {"done": cg(C.get("SAGE_WILLS_FOUND", [])), "total": len(C.get("SAGE_WILLS_FOUND", []))}
    sc = (C.get("SCHEMATICS_STONE_FOUND", []) or []) + (C.get("SCHEMATICS_YIGA_FOUND", []) or [])
    out["设计图石板"] = {"done": cnt(sc, 1), "total": len(sc)}
    out["卡邦达立牌"] = {"done": cg(C.get("ADDISON_COMPLETED", [])), "total": len(C.get("ADDISON_COMPLETED", []))}
    for zh, key in (("独眼巨人", "BOSSES_HINOXES_DEFEATED"), ("岩石巨人", "BOSSES_TALUSES_DEFEATED"),
                    ("莫尔德拉吉克", "BOSSES_MOLDUGAS_DEFEATED"), ("方块魔像", "BOSSES_FLUX_CONSTRUCT_DEFEATED"),
                    ("巨霸伽马", "BOSSES_FROXS_DEFEATED"), ("古栗欧克", "BOSSES_GLEEOKS_DEFEATED"),
                    ("地洞入口", "LOCATION_CHASMS_VISITED"), ("洞穴入口", "LOCATION_CAVES_VISITED"),
                    ("井", "LOCATION_WELLS_VISITED")):
        lst = C.get(key, []) or []
        out[zh] = {"done": cnt(lst, 1), "total": len(lst)}
    return out


def progress_payload(force=False):
    """重新解析当前槽存档 → doneIds（可逐点映射的已完成标点 id 列表）。"""
    now = time.time()
    if not force and _progress_cache["payload"] and now - _progress_cache["t"] < PROGRESS_CACHE_SEC:
        return _progress_cache["payload"]
    found = _find_save()
    if not found:
        out = {"ok": False, "error": "未找到 progress.sav（Ryujinx 存档目录）"}
        _progress_cache.update({"t": now, "payload": out})
        return out
    mt, path = found
    if not force and _progress_cache["payload"] and _progress_cache["mtime"] == mt:
        return _progress_cache["payload"]
    parsed = _parse_save(path)
    if not parsed.get("ok"):
        out = {"ok": False, "error": parsed.get("error")}
        _progress_cache.update({"t": now, "payload": out, "mtime": mt})
        return out
    emap = _load_explore_map() or {}
    vb = parsed["valueByHash"]
    done_ids = []
    # towers/tears：hash 表 value == 1
    with open(path, "rb") as f:
        for tbl in ("towers", "tears"):
            for mid, hv in (emap.get(tbl) or {}).items():
                off = vb.get(int(hv, 16))
                if off is None:
                    continue
                f.seek(off)
                if struct.unpack("<I", f.read(4))[0] == 1:
                    done_ids.append(int(mid))
        # bubbuls：GUID 存在于存档 GUID 表
        for mid, guid in (emap.get("bubbuls") or {}).items():
            if guid in parsed["guids"]:
                done_ids.append(int(mid))
    out = {"ok": True, "version": parsed["version"], "save": path, "doneIds": done_ids,
           "mapped": sum(len(emap.get(k) or {}) for k in ("towers", "tears", "bubbuls")),
           "counts": _progress_counts(parsed), "mtime": mt}
    _progress_cache.update({"t": now, "payload": out, "mtime": mt})
    return out


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/pos":
            payload = dict(STATE)
            payload["target"] = TARGET[0]
            pp = progress_payload()
            payload["progressGen"] = (pp.get("save") or "") + ":" + str(int(pp.get("mtime") or 0))
            self._json(payload)
            return
        if path == "/target":
            self._json(TARGET[0] or {"ok": False})
            return
        if path == "/rescan":
            threading.Thread(target=relocalize, args=("/rescan requested",),
                             daemon=True).start()
            self._json({"started": True})
            return
        if path == "/progress":
            self._json(progress_payload())
            return
        self._json({"ok": False, "error": "unknown endpoint"}, code=404)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/target":
            try:
                n = int(self.headers.get("Content-Length", "0"))
                data = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                data = {}
            if data.get("clear"):
                TARGET[0] = None
                print("  [target] cleared", flush=True)
            else:
                TARGET[0] = {"x": float(data.get("x", 0)), "y": float(data.get("y", 0)),
                             "name": data.get("name", ""), "type": data.get("type", ""),
                             "layer": data.get("layer")}
                print("  [target] set %s at (%.1f, %.1f) layer=%s" % (TARGET[0]["name"],
                      TARGET[0]["x"], TARGET[0]["y"], TARGET[0]["layer"]), flush=True)
            self._json({"ok": True, "target": TARGET[0]})
            return
        self._json({"ok": False, "error": "unknown endpoint"}, code=404)

    def log_message(self, *a):
        pass


def main():
    print("TOTKNavi-python  ·  TOTKmap V1.8.0 M1", flush=True)
    print("等待 Ryujinx（%s）..." % PROCESS_NAME, flush=True)
    while not reopen_process():
        time.sleep(3)
    print("guest RAM 探测中...", flush=True)
    base, size = guest_ram()
    if base:
        print("guest DRAM: 0x%X  %.0f MB" % (base, size / 1048576.0), flush=True)
    else:
        print("guest DRAM 未就绪（游戏进入可操作后再重试）", flush=True)

    hit = try_offsets()
    if hit:
        a, v = hit
        LOCK.update(addr=a, verified=False, copies=0, source="known")
        threading.Thread(target=verify_known, args=(a,), daemon=True,
                         name="verify").start()
    else:
        relocalize("initial locate")

    threading.Thread(target=poll, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()

    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("HTTP 服务: http://127.0.0.1:%d  （/pos /target /progress /rescan，Ctrl+C 退出）" % PORT, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)


if __name__ == "__main__":
    main()
