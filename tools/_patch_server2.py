# -*- coding: utf-8 -*-
'''server.py 补丁（M3 自动同步）：/progress 返回 counts（与 js collect() 同口径）、默认读 slot_00、
/pos 增加 progressGen、缓存 2s。'''
import io, re

P = r"E:\WorkSpace\TOTKmap\live-python\server.py"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    text = f.read()

def rep(old, new, label):
    global text
    n = text.count(old)
    assert n == 1, "%s count=%d" % (label, n)
    text = text.replace(old, new)
    print("OK:", label)

# 1) _find_save：优先 slot_00（用户实际槽），否则 mtime 最新
rep('''def _find_save():
    """Ryujinx 各槽 progress.sav 中 mtime 最新者（游戏当前正在写的槽）。"""
    base = os.path.join(os.environ.get("APPDATA", ""), "Ryujinx", "bis", "user", "save")
    best = None
    for p in glob.glob(os.path.join(base, "*", "0", "slot_*", "progress.sav")):
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if best is None or mt > best[0]:
            best = (mt, p)
    return best''',
'''def _find_save():
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
        if p.replace("\\\\", "/").endswith("/slot_00/progress.sav"):
            return (mt, p)
    return cands[0]''',
"_find_save slot_00 优先")

# 2) _parse_save 返回 data 字节（计数需要）
rep('''    return {"ok": True, "version": version, "valueByHash": value_by_hash, "guids": guids}''',
'''    return {"ok": True, "version": version, "valueByHash": value_by_hash, "guids": guids, "data": data}''',
"_parse_save 返回 data")

# 3) progress_payload 增加 counts + 缓存 2s
rep('''PROGRESS_CACHE_SEC = 5.0        # /progress 缓存，避免高频 IO''',
'''PROGRESS_CACHE_SEC = 2.0        # /progress 缓存，避免高频 IO（游戏保存后 2s 内可检测到）''',
"缓存 2s")

# 4) 新增 murmur3 + counts 逻辑，插到 progress_payload 之前
rep('''def progress_payload(force=False):''',
'''def _murmur3_32(key, seed=0):
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
        m = re.search(r"var\\s+CompletismHashes\\s*=\\s*(\\{.*?\\});", t, re.S)
        if not m:
            return None
        keys = {}
        for km in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*\\[(.*?)\\]", m.group(1), re.S):
            arr = []
            for a, b, c in re.findall(r"0x([0-9a-fA-F]+)|'([^']+)'|\\"([^\\"]+)\\"", km.group(2)):
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


def progress_payload(force=False):''',
"counts + murmur3")

# 5) progress_payload 内：counts 并入返回
rep('''    out = {"ok": True, "version": parsed["version"], "save": path, "doneIds": done_ids,
           "mapped": sum(len(emap.get(k) or {}) for k in ("towers", "tears", "bubbuls"))}''',
'''    out = {"ok": True, "version": parsed["version"], "save": path, "doneIds": done_ids,
           "mapped": sum(len(emap.get(k) or {}) for k in ("towers", "tears", "bubbuls")),
           "counts": _progress_counts(parsed), "mtime": mt}''',
"counts 并入返回")

# 6) /pos 增加 progressGen
rep('''        if path == "/pos":
            payload = dict(STATE)
            payload["target"] = TARGET[0]
            self._json(payload)
            return''',
'''        if path == "/pos":
            payload = dict(STATE)
            payload["target"] = TARGET[0]
            pp = progress_payload()
            payload["progressGen"] = (pp.get("save") or "") + ":" + str(int(pp.get("mtime") or 0))
            self._json(payload)
            return''',
"/pos progressGen")

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(text)
print("server.py 自动同步补丁完成")
