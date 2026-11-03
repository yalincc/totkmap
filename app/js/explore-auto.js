/* ============================================================
 * TOTKmap · 探索自动收集（V2.8.5 动态就近切换 + 100m 统一弹卡 + 目标跟随操作）
 * ------------------------------------------------------------
 * 极简规则：
 *   1. 由 live.js 坐标更新事件直接驱动（无独立定时器）；
 *   2. 跑图过程中实时计算周围未完成同类标点：若出现比当前目标更近（差值 > 15m 防抖）
 *      的同类标点，自动切换导航到更近的标点；
 *   3. 林克三维距离目标 <= 100m 时自动弹出卡片，离开 > 120m 自动关闭卡片；
 *   4. 当前目标完成（存档同步完成 / 手动点完成）后，自动续导同层同分类最近的未完成标点；
 *   5. 用户点新标点「收集」或对某标点点「取消完成」时，目标无条件立即跟随到该标点。
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
  var arrived = false;      /* 当前目标已进入 100m 范围 */
  var current = null;       /* 当前目标 marker */
  var pinPos = null;        /* 手动指定非最近目标时的玩家起点（移动 >= 30m 后解除锁定恢复动态就近） */

  var ARRIVE_DIST = 100;    /* 进入 100m 三维空间距离弹出卡片 */
  var LEAVE_DIST = 120;     /* 离开 120m 三维空间距离自动收起卡片 */
  var SWITCH_HYST = 15;     /* 动态切换更近标点的防抖差值（15m，防中线往复闪跳） */
  var PIN_RELEASE = 30;     /* 手动指定远处标点后，角色移动超过 30m 恢复动态就近吸附 */

  function isKorokCat(cat) {
    return cat === 73 || cat === 130 || cat === 118 || cat === 160 || cat === 96 || cat === 145;
  }

  function online() { return !!(window.LIVENAV && window.LIVENAV.online()); }

  function pos() {
    return (window.LIVENAV && window.LIVENAV.pos) ? window.LIVENAV.pos() : null;
  }

  function dist(m, p) {
    if (!m || !p) return Infinity;
    var dx = p.mx - m.x, dy = p.my - m.y;
    var pz = p.gz != null ? p.gz : (p.z != null ? p.z : 0);
    var mz = m.z != null ? m.z : (m.altitude_y != null ? m.altitude_y : 0);
    var dz = pz - mz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 候选池：同层 + 未完成 + 同类别（克洛格类天然包含全部克洛格起点，排除目的地营地 96/145 单独导航） */
  function poolForLayer(layer, targetCat) {
    var st = A.state();
    var isKorok = isKorokCat(targetCat);
    return A.markers().filter(function (m) {
      if (m.layer !== layer) return false;
      if (m.cat === 96 || m.cat === 145) return false; // 朋友营地不单独作为起点目标
      var doneId = m.korokStartId || m.id;
      if (st.done[doneId]) return false;

      if (isKorok) {
        return isKorokCat(m.cat);
      }
      return m.cat === targetCat;
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

  function navTo(m, silent) {
    if (!m || !A) return;
    var mz = m.z != null ? m.z : (m.altitude_y != null ? m.altitude_y : null);
    A.liveNav({
      id: m.id,
      name: m.name || m.full,
      x: m.x,
      y: m.y,
      z: mz,
      layer: m.layer,
      type: A.catName(m.cat),
      silent: !!silent
    });
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
    pinPos = null;
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
    navTo(current, true);
    if (p && p.located && dist(current, p) <= ARRIVE_DIST) {
      arrived = true;
      showCard(current);
    }
    A.toast(T('auto.exp.resume', '自动续导：{0} · {1}', (current.name || T('auto.common.target', '目标')), Math.round(dist(current, p)) + 'm'));
  }

  function onArrive() {
    showCard(current);
    A.toast(T('auto.exp.arrivedWait', '已进入 {0} 范围（100m），收集完成后自动续导下一个', (current.name || T('auto.common.target', '目标'))));
  }

  function tick() {
    if (!running || !A) return;
    if (!online()) { stop(); closeCard(); A.toast(T('auto.exp.offline', '实时定位服务断开，已停止收集')); return; }
    var p = pos();
    if (!p || !p.located || !current) return;

    // 1. 完成态检测（手动点完成 / 存档自动同步完成）
    var doneId = current.korokStartId || current.id;
    if (A.state().done[doneId]) {
      closeCard();
      advance();
      return;
    }

    // 2. 切层检测：切层重建同分类目标池
    if (current.layer !== p.layer) {
      var pool = poolForLayer(p.layer, current.cat);
      if (!pool.length) {
        stop();
        closeCard();
        A.toast(T('auto.exp.allDoneLayer', '本层（{0}）收集目标已全部完成', A.layerName(p.layer)));
        return;
      }
      arrived = false;
      pinPos = null;
      closeCard();
      current = nearest(pool, p);
      navTo(current, true);
      A.toast(T('auto.exp.enterLayer', '进入{0}层，续导最近目标', A.layerName(p.layer)));
      return;
    }

    // 3. 动态就近检测：角色移动后，若周围有明显更近（差值 > 15m）的未完成同类标点，自动切换过去
    if (pinPos) {
      var moved = Math.sqrt((p.mx - pinPos.mx) * (p.mx - pinPos.mx) + (p.my - pinPos.my) * (p.my - pinPos.my));
      if (moved >= PIN_RELEASE) pinPos = null;
    }
    var d = dist(current, p);
    if (!pinPos) {
      var poolNow = poolForLayer(p.layer, current.cat);
      var best = nearest(poolNow, p);
      if (best && best.id !== current.id) {
        var dBest = dist(best, p);
        if (dBest + SWITCH_HYST < d) {
          current = best;
          d = dBest;
          navTo(current, true);
          if (d <= ARRIVE_DIST) {
            arrived = true;
            showCard(current);
          } else if (arrived) {
            arrived = false;
            closeCard();
          }
          A.toast(T('auto.exp.switchNearest', '发现更近目标：{0} · {1}', (current.name || T('auto.common.target', '目标')), Math.round(d) + 'm'));
          return;
        }
      }
    }

    // 4. 距离检测：<= 100m 自动弹出卡片，> 120m 自动收起卡片
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

  function updatePinForManualPick(m, p) {
    if (!p || !p.located) { pinPos = null; return; }
    var pool = poolForLayer(m.layer, m.cat);
    var best = nearest(pool, p);
    // 若用户手动点的本来就是最近点，直接开启完全动态就近；若特意点了远处点，则在原地 30m 内保护该选择
    if (best && best.id !== m.id && dist(best, p) + SWITCH_HYST < dist(m, p)) {
      pinPos = { mx: p.mx, my: p.my };
    } else {
      pinPos = null;
    }
  }

  function start(m) {
    if (!A) A = window.TOTK_APP;
    if (window.MAT_AUTO && window.MAT_AUTO.isRunning()) { A.toast(T('auto.exp.matRunning', '材料收集队列运行中，请先停止再开始探索')); return; }
    if (!m || !m.id) { A.toast(T('auto.exp.notSupported', '该标点暂不支持收集模式')); return; }
    if (!online()) { A.toast(T('auto.common.noService', '实时定位服务未连接（TOTKNavi 未启动？）')); return; }
    var p = pos();
    if (!p || !p.located) { A.toast(T('auto.common.noPos', '尚未获取玩家位置，请先在游戏内进入可操作状态')); return; }
    var doneId = m.korokStartId || m.id;
    if (A.state().done[doneId]) { A.toast(T('auto.exp.alreadyDone', '该标点已完成，无需收集')); return; }

    var wasRunning = running;
    running = true;
    current = m;
    updatePinForManualPick(m, p);
    arrived = (dist(m, p) <= ARRIVE_DIST);
    navTo(m, true);
    showCard(m);
    A.toast(T(wasRunning ? 'auto.exp.switchTarget' : 'auto.exp.start',
      wasRunning ? '已切换收集目标：{0}' : '开始收集：{0}',
      (m.name || T('auto.common.target', '目标'))));
  }

  /* 当用户在收集模式下对某个标点点击「取消完成」时，立即将收集目标切回该标点 */
  function switchTo(m) {
    if (!running || !m || !m.id) return;
    if (!A) A = window.TOTK_APP;
    var p = pos();
    current = m;
    updatePinForManualPick(m, p);
    arrived = !!(p && p.located && dist(m, p) <= ARRIVE_DIST);
    navTo(m, true);
    A.toast(T('auto.exp.switchTarget', '已切回收集目标：{0}', (m.name || T('auto.common.target', '目标'))));
  }

  function stop() {
    running = false; arrived = false; current = null; pinPos = null;
    if (window.LIVENAV) window.LIVENAV.endNav();
  }

  /* 仅退出连续收集状态，不清空 LIVENAV（用于用户点击单点「导航」接管时） */
  function stopSilent() {
    running = false; arrived = false; current = null; pinPos = null;
  }

  function completeCurrent() {
    if (!running || !current) return;
    if (!A) A = window.TOTK_APP;
    var doneId = current.korokStartId || current.id;
    if (!A.state().done[doneId]) {
      if (typeof A.setMarkerDoneState === 'function') {
        A.setMarkerDoneState(doneId, true);
      } else {
        A.state().done[doneId] = true;
        A.applyDoneToMarker(doneId);
      }
      A.saveDone();
      A.renderMarkers();
      A.buildCatalogPanel();
      A.updateCount();
      if (window.KorokLayer && window.KorokLayer.render) window.KorokLayer.render();
    }
    var doneName = current.name || T('auto.common.target', '目标');
    closeCard();
    A.toast(T('auto.exp.marked', '已完成：{0}', doneName));
    advance();
  }

  function init() {
    A = window.TOTK_APP;
    if (!A) { setTimeout(init, 200); return; }
  }

  function onNavEnd() {
    if (!running) return;
    running = false; arrived = false; current = null; pinPos = null;
  }

  window.EXPLORE_AUTO = {
    start: start,
    switchTo: switchTo,
    stop: stop,
    stopSilent: stopSilent,
    onTick: tick,
    onNavEnd: onNavEnd,
    isRunning: function () { return running; },
    current: function () { return current; },
    completeCurrent: completeCurrent
  };

  init();
})();
