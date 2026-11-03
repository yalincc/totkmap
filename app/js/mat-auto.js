/* ============================================================
 * TOTKmap · 材料收集队列 B（V1.8.0 M4）
 * ------------------------------------------------------------
 * 用法：左侧勾选材料种类 → 地图显示点位 → 点材料点卡片【收集】
 *       → 标记当前点已收集 → 在「当前层 + 已勾选材料 + 未收集 +
 *       未标记完成」点位中按最近优先实时导航自动续导。
 * 完成信号：手动（材料无存档逐点记录）—— 到达后 toast 提示，
 *       点卡片【已收集，继续】确认 → 标记 + 续导；
 *       运行中未到达时点【停止收集】= 停止队列。
 * 约束：不跨层（跟随玩家 Z 切层重建池）、与探索自动导航互斥、
 *       不保存路线、材料卡与探索卡两套独立（各用各的）。
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
  var running = false;      /* 收集队列运行中 */
  var arrived = false;      /* 当前目标已到达（等待确认收集） */
  var current = null;       /* 当前目标 {mid, idx, x, y} */
  var curMid = null;        /* 当前收集的材料 id（V1.8.5：点图标收集单材料，勾选不进池） */
  var lastLayer = null;     /* 上次玩家所在层（切层重建池） */
  var holdStart = 0;        /* 到达后停留计时起点（毫秒，0=未开始） */
  var lastPX = null, lastPY = null;  /* 上次采样位置（玩家大幅移动/传送 → 重选最近点） */
  var DISPLACE_RECHECK = 500;        /* 位移阈值（游戏单位）：传送(>1000)与角色大幅跑动均触发重选 */

  function online() { return !!(window.LIVENAV && window.LIVENAV.online()); }

  function pos() {
    return (window.LIVENAV && window.LIVENAV.pos) ? window.LIVENAV.pos() : null;
  }

  function dist(t, p) {
    var dx = p.mx - t.x, dy = p.my - t.y;
    var pz = p.mz != null ? p.mz : (p.z != null ? p.z : p.gz);
    var dz = (t.z != null && pz != null) ? (pz - t.z) : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 池（V1.8.5）：当前层 + 当前收集材料（点图标指定）+ 未收集 + 未标记完成（点级）。
     勾选只控制地图显示，不进队列池。 */
  function poolForLayer(layer) {
    if (curMid == null) return [];
    var st = A.state();
    var pts = A.matPoints(layer)[curMid] || [];
    var pool = [];
    var col = st.matCollected[curMid] || [];
    var done = st.matDone[curMid] || [];
    for (var i = 0; i < pts.length; i++) {
      if (col.indexOf(i) >= 0 || done.indexOf(i) >= 0) continue;
      pool.push({ mid: curMid, idx: i, x: pts[i][1], y: pts[i][0], z: pts[i][2] });
    }
    return pool;
  }

  function nearest(pool, p) {
    var best = null, bd = Infinity;
    pool.forEach(function (t) {
      var d = dist(t, p);
      if (d < bd) { bd = d; best = t; }
    });
    return best;
  }

  function navTo(t) {
    var m = A.matById(t.mid);
    A.liveNav({
      name: m ? m.cn : T('auto.matPrefix', '材料') + t.mid,
      x: t.x, y: t.y, z: t.z,
      layer: A.state().layer,
      type: m ? m.cat : ''
    });
    /* live.js 的 target 是 fetch 异步返回后才设置：延迟重绘卡片，让按钮标签同步 */
    setTimeout(refreshCard, 200);
  }

  function refreshCard() {
    if (A && A.showMatCard && current) A.showMatCard(current.mid, [current.x, current.y], current.idx, null);
  }

  function advance() {
    arrived = false;
    holdStart = 0;
    var p = pos();
    var layer = (p && p.located) ? p.layer : A.state().layer;
    if (p && p.located) { lastPX = p.mx; lastPY = p.my; }
    var pool = poolForLayer(layer);
    if (!pool.length) { stop(); A.toast(T('auto.mat.allDoneLayer', '本层（{0}）{1}点位已全部收集，收集队列结束', A.layerName(layer), A.matName(curMid))); return; }
    current = nearest(pool, p);
    navTo(current);
    A.toast(T('auto.mat.resume', '续导：{0} · 距下一点 {1} 米', A.matName(current.mid), Math.round(dist(current, p))))
  }

  function onArrive() {
    arrived = true;
    A.toast(T('auto.mat.arrived', '已到达 {0}，收集后点卡片【已收集，继续】', A.matName(current.mid)))
    refreshCard();
  }

  function tick() {
    if (!running) return;
    if (!online()) { stop(); A.toast(T('auto.mat.offline', '实时定位服务断开，收集队列已停止')); return; }
    var p = pos();
    if (!p || !p.located) return;
    /* 切层 → 不跨层：在新层重建池（当前目标不在本层则换最近点） */
    if (lastLayer !== p.layer) {
      lastLayer = p.layer;
      lastPX = p.mx; lastPY = p.my;
      var pool = poolForLayer(p.layer);
      if (!pool.length) { stop(); A.toast(T('auto.mat.allDoneLayer2', '本层（{0}）{1}点位已全部收集，队列结束', A.layerName(p.layer), A.matName(curMid))); return; }
      arrived = false; holdStart = 0;
      current = nearest(pool, p);
      navTo(current);
      A.toast(T('auto.mat.enterLayer', '进入{0}层，续导最近材料点', A.layerName(p.layer)));
      return;
    }
    /* V1.8.4：玩家大幅移动/传送 → 重选最近材料点（不死守旧目标） */
    if (current && lastPX != null) {
      var mv = Math.sqrt((p.mx - lastPX) * (p.mx - lastPX) + (p.my - lastPY) * (p.my - lastPY));
      if (mv > DISPLACE_RECHECK) {
        var pool2 = poolForLayer(p.layer);
        if (!pool2.length) { stop(); A.toast(T('auto.mat.allDoneLayer3', '本层（{0}）勾选材料已全部收集，队列结束', A.layerName(p.layer))); return; }
        arrived = false; holdStart = 0;
        current = nearest(pool2, p);
        navTo(current);
        A.toast(T('auto.mat.switched', '玩家大幅移动，已切换到最近材料点：{0}', A.matName(current.mid)));
      }
    }
    lastPX = p.mx; lastPY = p.my;
    if (!arrived && window.LIVENAV.arrived()) { arrived = true; onArrive(); }
    /* 到达停留自动标记（V1.8.3）：在目标阈值内持续停留 holdSec 秒 → 自动标记收集 + 续导 */
    if (arrived && current) {
      var hs = (window.LIVENAV.holdSec ? window.LIVENAV.holdSec() : 2);
      var d = dist(current, p);
      if (d <= (window.LIVENAV.arriveM ? window.LIVENAV.arriveM() : 30)) {
        if (holdStart === 0) holdStart = Date.now();
        else if (hs <= 0 || Date.now() - holdStart >= hs * 1000) { autoConfirm(); }
      } else {
        holdStart = 0;   /* 离开目标范围 → 重置计时 */
      }
    }
  }

  /* 启动：标记当前点已收集（未收集时）→ 从最近未收集点开始导航。
     已收集的点点【已收集】= 直接启动队列（不重复标记）。 */
  function start(mid, idx, ll) {
    if (running) { A.toast(T('auto.mat.alreadyRunning', '收集队列已在运行（卡片【停止收集】可停）')); return; }
    if (window.EXPLORE_AUTO && window.EXPLORE_AUTO.isRunning()) { A.toast(T('auto.mat.exploreRunning', '探索自动导航运行中，请先停止再开始材料收集')); return; }
    if (!online()) { A.toast(T('auto.common.noService', '实时定位服务未连接（TOTKNavi 未启动？）')); return; }
    var p = pos();
    if (!p || !p.located) { A.toast(T('auto.common.noPos', '尚未获取玩家位置，请先在游戏内进入可操作状态')); return; }
    var st = A.state();
    if (idx >= 0 && (st.matCollected[mid] || []).indexOf(idx) < 0) A.matCollect(mid, idx);
    curMid = String(mid);
    running = true; arrived = false; lastLayer = p.layer; holdStart = 0;
    lastPX = p.mx; lastPY = p.my;
    var pool = poolForLayer(p.layer);
    if (!pool.length) { running = false; curMid = null; A.toast(T('auto.mat.allDone', '本层该材料点位已全部收集')); return; }
    current = nearest(pool, p);
    navTo(current);
    A.toast(T('auto.mat.start', '收集队列开始：{0}（{1}层）', A.matName(current.mid), A.layerName(p.layer)));
  }

  function stop() {
    running = false; arrived = false; current = null; curMid = null; lastLayer = null; holdStart = 0;
    lastPX = null; lastPY = null;
    if (window.LIVENAV) window.LIVENAV.endNav();
  }

  /* 到达停留自动标记（V1.8.3）：计时达标自动确认收集 */
  function autoConfirm() {
    if (!running || !current || !arrived) return;
    holdStart = 0;
    A.matCollect(current.mid, current.idx);
    A.toast(T('auto.mat.autoMarked', '已自动标记收集：{0}，续导下一目标', A.matName(current.mid)))
    advance();
  }

  /* 外部结束导航（面板「结束」/清除目标/停止导航）→ 队列同步停止（防残留） */
  function onNavEnd() {
    if (!running) return;
    running = false; arrived = false; current = null; curMid = null; lastLayer = null; holdStart = 0;
    lastPX = null; lastPY = null;
    A.toast(T('auto.mat.ended', '导航已结束，收集队列已停止'))
  }

  /* 到达后确认收集当前点并续导 */
  function confirmCurrent() {
    if (!running || !current || !arrived) return;
    A.matCollect(current.mid, current.idx);
    A.toast(T('auto.mat.collected', '已收集：{0}', A.matName(current.mid)))
    advance();
  }

  function isCurrent(mid, idx) {
    return running && current && String(current.mid) === String(mid) && current.idx === idx;
  }

  function init() {
    A = window.TOTK_APP;
    if (!A) { setTimeout(init, 300); return; }
    setInterval(tick, 600);
  }

  window.MAT_AUTO = {
    start: start,
    confirm: confirmCurrent,
    stop: stop,
    onNavEnd: onNavEnd,
    isRunning: function () { return running; },
    isArrived: function () { return arrived; },
    isCurrent: isCurrent,
    current: function () { return current; }
  };

  init();
})();
