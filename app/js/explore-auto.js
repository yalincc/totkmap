/* ============================================================
 * TOTKmap · 探索自动导航（V1.8.0 M3 返工）
 * ------------------------------------------------------------
 * 用法：左侧勾选类别 → 地图显示标点 → 点标点卡片【自动导航】
 *       → 在当前层已勾选类别「未完成」标点中按最近优先自动续导。
 * 完成判定：到达后以存档为准 —— 服务端 /progress 轮询（等游戏存档
 *       保存后自动检测），可逐点判定类别（鸟望台/龙之泪/魔犹伊）
 *       自动续导；其余类别 / 服务离线 → 等手动【标记完成】。
 * 约束：不跨层（跟随玩家 Z 自动切层重建池）、不保存路线、
 *       无队列 UI、到达阈值内部固定（LIVENAV.arriveM，面板不可调）。
 * ============================================================ */
(function () {
  'use strict';

  var A = null;

  /* 2026-10-28：提示文案统一走词条。I18N.t 不自带插值，这里补 {0}{1} 顺序替换；
     I18N 未加载（理论不会）时退回中文原文。 */
  function T(key, fb) {
    var s = window.I18N ? window.I18N.t(key, fb) : fb;
    for (var i = 2; i < arguments.length; i++) {
      s = String(s).replace('{' + (i - 2) + '}', arguments[i]);
    }
    return s;
  }
  var running = false;      /* 自动导航运行中 */
  var waiting = false;      /* 到达后等待确认（存档轮询 or 手动） */
  var arrived = false;      /* 当前目标已到达 */
  var current = null;       /* 当前目标 marker */
  var pollT = null;         /* /progress 轮询定时器 */

  function online() { return !!(window.LIVENAV && window.LIVENAV.online()); }

  function pos() {
    return (window.LIVENAV && window.LIVENAV.pos) ? window.LIVENAV.pos() : null;
  }

  function dist(m, p) {
    var dx = p.mx - m.x, dy = p.my - m.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function poolForLayer(layer) {
    var st = A.state();
    return A.markers().filter(function (m) {
      return m.layer === layer && st.selected[m.cat] && !st.done[m.id];
    });
  }

  function nearest(pool, p) {
    var best = null, bd = Infinity;
    pool.forEach(function (m) {
      var d = dist(m, p);
      if (d < bd) { bd = d; best = m; }
    });
    return best;
  }

  function navTo(m) {
    A.liveNav({ name: m.name || m.full, x: m.x, y: m.y, layer: m.layer, type: A.catName(m.cat) });
    /* live.js 的 target 是 fetch 异步返回后才设置：延迟重绘卡片，让「停止导航」标签同步 */
    setTimeout(refreshCard, 200);
  }

  function mappable(m) {
    var mp = window.TOTK_EXPLORE_MAP || {};
    return !!((mp.towers && (m.id in mp.towers)) ||
              (mp.tears && (m.id in mp.tears)) ||
              (mp.bubbuls && (m.id in mp.bubbuls)));
  }

  function refreshCard() {
    if (A && A.showCard && current) A.showCard(current);
  }

  function advance() {
    waiting = false;
    arrived = false;
    var p = pos();
    var layer = (p && p.located) ? p.layer : A.state().layer;
    var pool = poolForLayer(layer);
    if (!pool.length) { stop(); A.toast(T('auto.exp.allDone', '本层已勾选类别全部完成，自动导航结束')); return; }
    current = nearest(pool, p);
    navTo(current);
    A.toast(T('auto.exp.resume', '自动续导：{0} · {1}', (current.name || T('auto.common.target', '目标')), (A.catName(current.cat) || '')));
    refreshCard();
  }

  function onArrive() {
    waiting = true;
    if (mappable(current) && online()) {
      A.toast(T('auto.exp.arrivedWait', '已到达 {0}，等待存档确认完成后自动续导…', (current.name || T('auto.common.target', '目标'))))
      pollProgress();
    } else {
      A.toast(T('auto.exp.arrivedManual', '已到达 {0}，请点「标记完成」继续下一个', (current.name || T('auto.common.target', '目标'))))
    }
    refreshCard();
  }

  function pollProgress() {
    if (pollT) clearInterval(pollT);
    pollT = setInterval(function () {
      if (!running || !current) { clearInterval(pollT); pollT = null; return; }
      fetch('http://127.0.0.1:8766/progress?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (running && res && res.ok && res.doneIds && res.doneIds.indexOf(current.id) >= 0) {
            clearInterval(pollT); pollT = null;
            A.applyProgressDone(res.doneIds);
            A.toast(T('auto.exp.saveConfirmed', '存档确认完成：{0}', (current.name || T('auto.common.target', '目标'))))
            advance();
          }
        })
        .catch(function () { /* 服务暂不可达，下轮重试 */ });
    }, 5000);
  }

  function tick() {
    if (!running) return;
    if (!online()) { stop(); A.toast(T('auto.exp.offline', '实时定位服务断开，自动导航已停止')); return; }
    var p = pos();
    if (!p || !p.located) return;
    /* 切层 → 不跨层：在新层重建目标池（当前目标不在本层则不续旧目标） */
    if (current && current.layer !== p.layer) {
      var pool = poolForLayer(p.layer);
      if (!pool.length) { stop(); A.toast(T('auto.exp.allDoneLayer', '本层（{0}）已勾选类别全部完成，自动导航结束', A.layerName(p.layer))); return; }
      waiting = false; arrived = false;
      current = nearest(pool, p);
      navTo(current);
      A.toast(T('auto.exp.enterLayer', '进入{0}层，续导最近目标', A.layerName(p.layer)));
      refreshCard();
      return;
    }
    if (!arrived && window.LIVENAV.arrived()) {
      arrived = true;
      onArrive();
    }
  }

  function start(m) {
    if (running) { A.toast(T('auto.exp.alreadyRunning', '自动导航已在运行（卡片【停止自动导航】可停）')); return; }
    if (window.MAT_AUTO && window.MAT_AUTO.isRunning()) { A.toast(T('auto.exp.matRunning', '材料收集队列运行中，请先停止再开始探索')); return; }
    if (!m || !m.id) { A.toast(T('auto.exp.notSupported', '该标点暂不支持自动导航')); return; }
    if (!online()) { A.toast(T('auto.common.noService', '实时定位服务未连接（TOTKNavi 未启动？）')); return; }
    var p = pos();
    if (!p || !p.located) { A.toast(T('auto.common.noPos', '尚未获取玩家位置，请先在游戏内进入可操作状态')); return; }
    if (A.state().done[m.id]) { A.toast(T('auto.exp.alreadyDone', '该标点已完成，自动导航不可用')); return; }
    running = true; waiting = false; arrived = false;
    current = m;
    navTo(m);
    A.toast(T('auto.exp.start', '自动导航开始：{0}', (m.name || T('auto.common.target', '目标'))));
    refreshCard();
  }

  function stop() {
    running = false; waiting = false; arrived = false; current = null;
    if (pollT) { clearInterval(pollT); pollT = null; }
    if (window.LIVENAV) window.LIVENAV.endNav();
  }

  function completeCurrent() {
    if (!running || !current) return;
    if (!A.state().done[current.id]) {
      A.state().done[current.id] = true;
      A.saveDone();
      A.applyDoneToMarker(current.id);
      A.renderMarkers();
      A.buildCatalogPanel();
      A.updateCount();
    }
    if (pollT) { clearInterval(pollT); pollT = null; }
    A.toast(T('auto.exp.marked', '已标记完成：{0}', (current.name || T('auto.common.target', '目标'))))
    advance();
  }

  function init() {
    A = window.TOTK_APP;
    if (!A) { setTimeout(init, 300); return; }
    setInterval(tick, 600);
  }

  /* 外部结束导航（面板「结束」/清除目标）→ 自动导航同步停止（防残留） */
  function onNavEnd() {
    if (!running) return;
    running = false; waiting = false; arrived = false; current = null;
    if (pollT) { clearInterval(pollT); pollT = null; }
    A.toast(T('auto.exp.ended', '导航已结束，自动导航已停止'))
  }

  window.EXPLORE_AUTO = {
    start: start,
    stop: stop,
    onNavEnd: onNavEnd,
    isRunning: function () { return running; },
    isWaiting: function () { return waiting; },
    current: function () { return current; },
    completeCurrent: completeCurrent
  };

  init();
})();
