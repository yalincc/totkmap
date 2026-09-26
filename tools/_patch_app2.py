# -*- coding: utf-8 -*-
"""js/app.js：服务端存档自动同步（syncProgressFromServer + saveSyncBtn 状态 + TOTK_APP 暴露）。"""
import io

P = r"E:\WorkSpace\TOTKmap\js\app.js"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

def rep(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, "%s count=%d" % (label, n)
    t = t.replace(old, new)
    print("OK:", label)

# 1) applyProgressDone 之后追加 syncProgressFromServer
rep("""  /* 上传存档 → 逐点完成注入（走同一权威合并） */
  function applySavePointDone(parsed) {
    var map = window.TOTK_EXPLORE_MAP || {};
    var pd = TOTKSaveParser.pointDone(parsed, map);
    applyProgressDone(Object.keys(pd || {}).map(Number));
  }
""",
"""  /* 上传存档 → 逐点完成注入（走同一权威合并） */
  function applySavePointDone(parsed) {
    var map = window.TOTK_EXPLORE_MAP || {};
    var pd = TOTKSaveParser.pointDone(parsed, map);
    applyProgressDone(Object.keys(pd || {}).map(Number));
  }

  /* V1.8.0 M3：服务端存档自动同步（BOTWmap 同机制——服务自动定位存档、网页拉取、
   * 游戏内保存后 mtime 变化 → progressGen 变化 → live.js 触发本函数自动刷新） */
  var serverSaveSlot = '';
  function syncProgressFromServer() {
    if (!window.LIVENAV || !window.LIVENAV.online()) return;
    fetch('http://127.0.0.1:8766/progress?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) return;
        if (res.doneIds) applyProgressDone(res.doneIds);
        if (res.counts) {
          state.save = res.counts;
          state.saveVersion = (res.version || '') + ' · 服务端自动同步';
          var m = String(res.save || '').match(/slot_(\\d+)/);
          serverSaveSlot = m ? m[1] : '';
          renderProgress();
          buildCatalogPanel();
          updateCount();
          var btn = $('saveSyncBtn');
          if (btn) btn.textContent = serverSaveSlot ? ('存档自动同步 ✓（slot_' + serverSaveSlot + '）') : '存档自动同步 ✓';
        }
      })
      .catch(function () {});
  }
""",
"syncProgressFromServer")

# 2) 上传路径按钮文案：与自动同步区分
rep("""  function applySaveSync(silent) {
    var btn = $('saveSyncBtn');
    btn.textContent = state.save ? '已同步 ✓ 重新加载' : '📂 从存档加载进度…';""",
"""  function applySaveSync(silent) {
    var btn = $('saveSyncBtn');
    serverSaveSlot = '';
    btn.textContent = state.save ? '已同步 ✓ 重新加载' : '📂 从存档加载进度…';""",
"applySaveSync 重置 serverSaveSlot")

# 3) TOTK_APP 暴露 syncProgressFromServer
rep("""    applyProgressDone: applyProgressDone,
    applyDoneToMarker: applyDoneToMarker,
    buildCatalogPanel: buildCatalogPanel,
    updateCount: updateCount
  };""",
"""    applyProgressDone: applyProgressDone,
    applyDoneToMarker: applyDoneToMarker,
    buildCatalogPanel: buildCatalogPanel,
    updateCount: updateCount,
    syncProgressFromServer: syncProgressFromServer
  };""",
"TOTK_APP 暴露 sync")

with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("app.js 自动同步完成")
