# -*- coding: utf-8 -*-
"""V1.8.1 手动层级锁定补丁：live.js（锁定状态/传送检测/跨层提示）+
app.js（layer-switch 点击钩子）+ css（锁定样式）+ index.html（版本号/v 缓存）。"""
import io, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def patch(path, pairs):
    raw = io.open(path, "rb").read()
    eol = b"\r\n" if raw.count(b"\r\n") > raw.count(b"\n") else b"\n"
    txt = raw.decode("utf-8")
    for old, new in pairs:
        n = txt.count(old)
        if n != 1:
            print("!! %s: %d occurrence(s) for %r" % (path, n, old[:60]))
            sys.exit(1)
        txt = txt.replace(old, new)
    io.open(path, "wb").write(txt.encode("utf-8").replace(b"\n", eol))
    print("ok %s (%d edits)" % (os.path.basename(path), len(pairs)))

# ---------------- js/live.js ----------------
live = os.path.join(ROOT, "js", "live.js")
patch(live, [
    # (a) 状态声明
    ("  var lastProgGen = null, lastProgFetch = 0;   // 存档进度代次（服务端 /pos.progressGen）\n  var arrivedShown = false;",
     "  var lastProgGen = null, lastProgFetch = 0;   // 存档进度代次（服务端 /pos.progressGen）\n  var arrivedShown = false;\n  var layerLock = null;                        // 手动层级锁定：null=自动，18/19/20=锁定该层（传送后恢复自动）\n  var lastMX = null, lastMY = null;            // 上一采样位置（传送检测）"),
    # (b) drawGuide 跨层判断用渲染层
    ("    if (target.layer && target.layer !== pos.layer) return;\n    guideLine = L.polyline([[pos.mx, pos.my], [target.x, target.y]], {",
     "    if (target.layer && target.layer !== renderLayer()) return;\n    guideLine = L.polyline([[pos.mx, pos.my], [target.x, target.y]], {"),
    # (c) tickArrival 用渲染层
    ("    if (target.layer && target.layer !== pos.layer) { arrivedShown = false; return; }",
     "    if (target.layer && target.layer !== renderLayer()) { arrivedShown = false; return; }"),
    # (d) setStatus 头部加 rl
    ("    var el = $('npStatus');",
     "    var rl = renderLayer();\n    var el = $('npStatus');"),
    # (e) npPos 渲染层 + 锁标记
    ("      var s = pos.located\n        ? '位置 (' + Math.round(pos.mx) + ', ' + Math.round(pos.my) + ') · ' +\n          LAYER_NAME[pos.layer] + ' · 高 ' + Math.round(pos.gz)",
     "      var s = pos.located\n        ? '位置 (' + Math.round(pos.mx) + ', ' + Math.round(pos.my) + ') · ' +\n          LAYER_NAME[rl] + (layerLock != null ? ' 🔒' : '') + ' · 高 ' + Math.round(pos.gz)"),
    # (f) npTargetRow 跨层提示（用户自己选择切换）
    ("        var cross = (target.layer && target.layer !== pos.layer);\n        ts = '目标：' + target.name + (target.type ? '（' + target.type + '）' : '');\n        if (cross) ts += ' · 在' + LAYER_NAME[target.layer] + '层，不跨层';",
     "        var cross = (target.layer && target.layer !== rl);\n        ts = '目标：' + target.name + (target.type ? '（' + target.type + '）' : '');\n        if (cross) ts += ' · 在' + LAYER_NAME[target.layer] + '层，点击左侧层按钮切换';"),
    # (g) poll 传送检测
    ("      var key = Math.round(p.mx) + ',' + Math.round(p.my);\n      if (key !== lastPosKey) {",
     "      /* 传送检测：相邻采样位移 > 1000 游戏单位 = 传送（地图传送/深穴/神庙瞬移），解除层级锁定 */\n      if (layerLock != null && lastMX != null) {\n        var dd = Math.sqrt((pos.mx - lastMX) * (pos.mx - lastMX) + (pos.my - lastMY) * (pos.my - lastMY));\n        if (dd > 1000) {\n          layerLock = null;\n          toast('检测到传送，已恢复自动层级切换');\n          updateLockUI();\n        }\n      }\n      lastMX = pos.mx; lastMY = pos.my;\n\n      var key = Math.round(p.mx) + ',' + Math.round(p.my);\n      if (key !== lastPosKey) {"),
    # (h) 锁定函数组（放在 autoSwitchLayer 前）
    ("  /* 跟随玩家 Z 自动切层（天空/地上/地底），不跨层 */\n  function autoSwitchLayer() {\n    if (paused || !autoLayer || !pos.online || !pos.located) return;",
     "  /* ---------------- 手动层级锁定（V1.8.1）：自动切层 + 手动接管，传送后恢复 ---------------- */\n  function renderLayer() {\n    return (layerLock != null) ? layerLock : pos.layer;\n  }\n  function updateLockUI() {\n    var sw = document.getElementById('layerSwitch');\n    if (!sw) return;\n    Array.prototype.forEach.call(sw.querySelectorAll('button'), function (b) {\n      b.classList.toggle('locked', Number(b.getAttribute('data-layer')) === layerLock);\n    });\n  }\n  function setLayerLock(id) {\n    if (layerLock === id) {\n      layerLock = null;\n      toast('已解除层级锁定，恢复自动切换');\n    } else {\n      layerLock = id;\n      toast('已锁定' + (LAYER_NAME[id] || id) + '层（传送后恢复自动）');\n    }\n    lastDrawKey = '';\n    redraw();\n    setStatus();\n    updateLockUI();\n  }\n\n  /* 跟随玩家 Z 自动切层（天空/地上/地底），不跨层 */\n  function autoSwitchLayer() {\n    if (paused || !autoLayer || !pos.online || !pos.located) return;\n    if (layerLock != null) return;   // 手动锁定期间不自动切层"),
    # (i) LIVENAV 导出
    ("      arrived: function () { return arrivedShown; },\n      arriveM: function () { return arriveM; },\n      paused: function () { return paused; }",
     "      arrived: function () { return arrivedShown; },\n      arriveM: function () { return arriveM; },\n      paused: function () { return paused; },\n      /* V1.8.1: 手动层级锁定 */\n      setLayerLock: setLayerLock,\n      lockLayer: function () { return layerLock; }"),
])

# ---------------- js/app.js ----------------
app = os.path.join(ROOT, "js", "app.js")
patch(app, [
    ("  $('layerSwitch').addEventListener('click', function (e) {\n    var btn = e.target.closest('button');\n    if (!btn) return;\n    var id = Number(btn.getAttribute('data-layer'));\n    if (id === state.layer) return;\n    switchLayer(id);\n  });",
     "  $('layerSwitch').addEventListener('click', function (e) {\n    var btn = e.target.closest('button');\n    if (!btn) return;\n    var id = Number(btn.getAttribute('data-layer'));\n    /* V1.8.1: 手动点击 = 切层并锁定；再点同层 = 解除锁定；传送后由 live.js 恢复自动 */\n    if (window.LIVENAV && window.LIVENAV.setLayerLock) {\n      window.LIVENAV.setLayerLock(id);\n    }\n    if (id === state.layer) return;\n    switchLayer(id);\n  });"),
])

# ---------------- css/style.css ----------------
css = os.path.join(ROOT, "css", "style.css")
patch(css, [
    (".layer-switch button.active { background: #eac27e; color: #222; font-weight: 600; }",
     ".layer-switch button.active { background: #eac27e; color: #222; font-weight: 600; }\n.layer-switch button.locked { box-shadow: inset 0 0 0 2px #ffb703; color: #ffd166; }\n.layer-switch button.locked.active { background: #eac27e; color: #222; box-shadow: inset 0 0 0 2px #b45309; }"),
])

# ---------------- index.html ----------------
idx = os.path.join(ROOT, "index.html")
patch(idx, [
    ('<p class="foot-version">TOTKMAP V1.8.0</p>', '<p class="foot-version">TOTKMAP V1.8.1</p>'),
    ('<script src="js/app.js?v=192"></script>', '<script src="js/app.js?v=193"></script>'),
    ('<script src="js/live.js?v=190"></script>', '<script src="js/live.js?v=191"></script>'),
])
print("ALL PATCHED")
