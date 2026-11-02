/* ============================================================
 * TOTKmap · 探索自动收集（V2.8.3 纯事件驱动重构）
 * ------------------------------------------------------------
 * 极简规则（对齐 BOTWmap）：
 *   1. 收集模式下：林克距离目标 <= 50m 时自动弹出卡片并智能避让；
 *   2. 林克距离目标 > 60m（远离防抖）或目标标记完成时，立即自动关闭卡片；
 *   3. 目标完成（手动打勾 / totknavi 存档事件驱动同步）后，自动续导下一个最近的未完成标点；
 *   4. 支持点击任意新标点无缝切换收集目标，无需手动取消上一个；
 *   5. 收集池对克洛格等探索要素独立兜底，不依赖侧边栏勾选状态，杜绝引路线闪退；
 *   6. 彻底废除多余的 5 秒主动轮询，零多余网络开销，纯事件驱动。
 * ============================================================ */
(function () {
  'use strict';

  var A = null;

  function T(key, fb) {
    var s = window.I18N ? window.I18N.t(key, fb) : fb;
    for (var i = 2; i < arguments.length; i++) {
      s = String(s).replace('{' + (i - 2) + '}', arguments[i]);
    }
    return s;
  }

  var running = false;      /* 收集模式运行中 */
  var arrived = false;      /* 当前目标已到达（卡片已弹出） */
  var current = null;       /* 当前目标 marker */

  var ARRIVE_DIST = 50;     /* 进入 50m 弹出卡片（用户标准） */
  var LEAVE_DIST = 60;      /* 离开 60m 关闭卡片（防抖） */

  function isKorokCat(cat) {
    return cat === 73 || cat === 130 || cat === 118 || cat === 160;
  }

  function online() { return !!(window.LIVENAV && window.LIVENAV.online()); }

  function pos() {
    return (window.LIVENAV && window.LIVENAV.pos) ? window.LIVENAV.pos() : null;
  }

  function dist(m, p) {
    if (!m || !p) return Infinity;
    var dx = p.mx - m.x, dy = p.my - m.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* 候选池计算：克洛格类天然包含全部克洛格，其他分类若未勾选则以当前目标类别为准 */
  function poolForLayer(layer, targetCat) {
    var st = A.state();
    var isKorok = isKorokCat(targetCat);
    return A.markers().filter(function (m) {
      if (m.layer !== layer) return false;
      var doneId = m.korokStartId || m.id;
      if (st.done[doneId]) return false;

      if (isKorok) {
        return isKorokCat(m.cat);
      }
      return st.selected[m.cat] || (m.cat === targetCat);
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
  }

  function showCard(m) {
    if (A && typeof A.showCard === 'function' && m) A.showCard(m);
  }

  function closeCard() {
    if (A && typeof A.hideCard === 'function') {
      A.hideCard();
    } else {
      var c = document.getElementById('exploreCard');
      if (c) c.classList.add('hidden');
    }
  }

  function advance() {
    arrived = false;
    var p = pos();
    var layer = (p && p.located) ? p.layer : A.state().layer;
    var targetCat = current ? current.cat : 73;
    var pool = poolForLayer(layer, targetCat);
    if (!pool.length) {
      stop();
      closeCard();
      A.toast(T('auto.exp.allDone', '本层收集目标已全部完成！'));
      return;
    }
    current = nearest(pool, p);
    navTo(current);
    A.toast(T('auto.exp.resume', '自动续导下一个：{0}', (current.name || T('auto.common.target', '目标'))));
  }

  function onArrive() {
    showCard(current);
    A.toast(T('auto.exp.arrivedWait', '已到达 {0} 附近（50m），收集完成后自动续导下一个', (current.name || T('auto.common.target', '目标'))));
  }

  function tick() {
    if (!running) return;
    if (!online()) { stop(); closeCard(); A.toast(T('auto.exp.offline', '实时定位服务断开，已停止收集')); return; }
    var p = pos();
    if (!p || !p.located || !current) return;

    // 1. 全局完成态检测（卡片点完成 / 地图点完成 / totknavi 存档推送自动标记）
    var doneId = current.korokStartId || current.id;
    if (A.state().done[doneId]) {
      closeCard();
      advance();
      return;
    }

    // 2. 切层检测：切层重建目标池
    if (current.layer !== p.layer) {
      var pool = poolForLayer(p.layer, current.cat);
      if (!pool.length) {
        stop();
        closeCard();
        A.toast(T('auto.exp.allDoneLayer', '本层（{0}）收集目标已全部完成', A.layerName(p.layer)));
        return;
      }
      arrived = false;
      closeCard();
      current = nearest(pool, p);
      navTo(current);
      A.toast(T('auto.exp.enterLayer', '进入{0}层，续导最近目标', A.layerName(p.layer)));
      return;
    }

    // 3. 距离检测：靠近 (<= 50m) 弹出卡片，远离 (> 60m) 自动关闭卡片
    var d = dist(current, p);

    if (d <= ARRIVE_DIST) {
      if (!arrived) {
        arrived = true;
        onArrive();
      }
    } else if (d > LEAVE_DIST) {
      if (arrived) {
        arrived = false;
        closeCard();
      }
    }
  }

  function start(m) {
    if (window.MAT_AUTO && window.MAT_AUTO.isRunning()) { A.toast(T('auto.exp.matRunning', '材料收集队列运行中，请先停止再开始探索')); return; }
    if (!m || !m.id) { A.toast(T('auto.exp.notSupported', '该标点暂不支持收集模式')); return; }
    if (!online()) { A.toast(T('auto.common.noService', '实时定位服务未连接（TOTKNavi 未启动？）')); return; }
    var p = pos();
    if (!p || !p.located) { A.toast(T('auto.common.noPos', '尚未获取玩家位置，请先在游戏内进入可操作状态')); return; }
    var doneId = m.korokStartId || m.id;
    if (A.state().done[doneId]) { A.toast(T('auto.exp.alreadyDone', '该标点已完成，无需收集')); return; }

    // 无缝切换目标：如果正在运行中，直接切到新目标，不弹窗拒绝
    if (running) {
      if (current && current.id === m.id) {
        A.toast(T('auto.exp.sameTarget', '正在收集中：{0}', (m.name || '目标')));
        return;
      }
      arrived = false;
      current = m;
      navTo(m);
      A.toast(T('auto.exp.switchTarget', '已切换收集目标：{0}', (m.name || T('auto.common.target', '目标'))));
      return;
    }

    running = true; arrived = false;
    current = m;
    navTo(m);
    A.toast(T('auto.exp.start', '开始收集：{0}', (m.name || T('auto.common.target', '目标'))));
  }

  function stop() {
    running = false; arrived = false; current = null;
    if (window.LIVENAV) window.LIVENAV.endNav();
  }

  function completeCurrent() {
    if (!running || !current) return;
    var doneId = current.korokStartId || current.id;
    if (!A.state().done[doneId]) {
      A.state().done[doneId] = true;
      A.saveDone();
      A.applyDoneToMarker(doneId);
      A.renderMarkers();
      A.buildCatalogPanel();
      A.updateCount();
      if (window.KorokLayer && window.KorokLayer.render) window.KorokLayer.render();
    }
    closeCard();
    A.toast(T('auto.exp.marked', '已完成：{0}', (current.name || T('auto.common.target', '目标'))));
    advance();
  }

  function init() {
    A = window.TOTK_APP;
    if (!A) { setTimeout(init, 300); return; }
    setInterval(tick, 600);
  }

  function onNavEnd() {
    if (!running) return;
    running = false; arrived = false; current = null;
    closeCard();
    A.toast(T('auto.exp.ended', '导航已结束，已停止收集'));
  }

  window.EXPLORE_AUTO = {
    start: start,
    stop: stop,
    onNavEnd: onNavEnd,
    isRunning: function () { return running; },
    current: function () { return current; },
    completeCurrent: completeCurrent
  };

  init();
})();
