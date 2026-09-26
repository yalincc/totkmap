# -*- coding: utf-8 -*-
"""修复：传送解锁 toast 被 autoSwitchLayer 的切层 toast 覆盖（2s 内抑制后者）。"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
live = os.path.join(ROOT, "js", "live.js")

raw = io.open(live, "rb").read()
eol = b"\r\n" if raw.count(b"\r\n") > raw.count(b"\n") else b"\n"
txt = raw.decode("utf-8")

pairs = [
    # 状态声明：加 teleportTS
    ("  var layerLock = null;                        // 手动层级锁定：null=自动，18/19/20=锁定该层（传送后恢复自动）\n  var lastMX = null, lastMY = null;            // 上一采样位置（传送检测）",
     "  var layerLock = null;                        // 手动层级锁定：null=自动，18/19/20=锁定该层（传送后恢复自动）\n  var lastMX = null, lastMY = null;            // 上一采样位置（传送检测）\n  var teleportTS = 0;                           // 最近一次传送解锁时间戳（抑制紧随的切层 toast）"),
    # 传送检测：记录时间戳
    ("        if (dd > 1000) {\n          layerLock = null;\n          toast('检测到传送，已恢复自动层级切换');\n          updateLockUI();\n        }",
     "        if (dd > 1000) {\n          layerLock = null;\n          teleportTS = Date.now();\n          toast('检测到传送，已恢复自动层级切换');\n          updateLockUI();\n        }"),
    # autoSwitchLayer：传送后 2s 内不弹切层 toast
    ("    if (pos.layer && pos.layer !== T.state.layer) {\n      T.switchLayer(pos.layer, true);\n      toast('已自动切换到' + (LAYER_NAME[pos.layer] || pos.layer) + '层');\n    }",
     "    if (pos.layer && pos.layer !== T.state.layer) {\n      T.switchLayer(pos.layer, true);\n      if (Date.now() - teleportTS > 2000) {\n        toast('已自动切换到' + (LAYER_NAME[pos.layer] || pos.layer) + '层');\n      }\n    }"),
]
for old, new in pairs:
    n = txt.count(old)
    if n != 1:
        print("!! %d occurrence(s): %r" % (n, old[:60]))
        sys.exit(1)
    txt = txt.replace(old, new)
io.open(live, "wb").write(txt.encode("utf-8").replace(b"\n", eol))
print("ok live.js (toast race fix, %d edits)" % len(pairs))

# index.html: live.js 缓存版本 191 -> 192
idx = os.path.join(ROOT, "index.html")
raw = io.open(idx, "rb").read()
eol = b"\r\n" if raw.count(b"\r\n") > raw.count(b"\n") else b"\n"
txt = raw.decode("utf-8")
old = '<script src="js/live.js?v=191"></script>'
if txt.count(old) != 1:
    print("!! index.html live.js v191 not found"); sys.exit(1)
txt = txt.replace(old, '<script src="js/live.js?v=192"></script>')
io.open(idx, "wb").write(txt.encode("utf-8").replace(b"\n", eol))
print("ok index.html (live.js v192)")
