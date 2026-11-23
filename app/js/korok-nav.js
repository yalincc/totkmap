/* ============================================================
 * TOTKmap · 多点克洛格独立导航模块（V2.9.1）
 * ------------------------------------------------------------
 * 与单点导航彻底隔离，专管 3 类需要「跑路线」的多点克洛格：
 *   1. transport（双倍搬运，100 处）：起点 → 朋友营地（三维 <= 18m 切段）
 *   2. ring / stump（飞圈圈 34 + 树桩跑酷 39）：起点 → 终点（三维 <= 15m 切段）
 *   3. flower（追小花，45 处）：逐朵接力 flower_1 → ... → goal（三维 <= 10m + 向前滑窗）
 *
 * 与单点/自动收集隔离的三条规矩：
 *   1. 进入中途即锁死：到达起点进入第 2 段（idx > 0）后，isLocked() 返回 true，
 *      explore-auto.js 禁止中途切去其他克洛格（传送/切层自动解锁防死锁）。
 *   2. 统一坐标出口：resolvePoint(m) 返回当前应去的 3D 坐标（未开始返回起点，
 *      进行中返回当前航点），让画线、选最近点、100m 弹卡三处口径完全一致。
 *   3. 限时可重来：ring/stump/flower 离开起点 >30m 后若跑回起点 <=12m，自动允许重置。
 * ============================================================ */
(function () {
  'use strict';

  var indexMap = null;   // id -> { kind, layer, relayDist, waypoints: [{x,y,z},...] }
  var active = null;     // { id, name, type, layer, kind, relayDist, waypoints, idx, leftStart }

  function isEn() {
    return !!(window.I18N && window.I18N.getLang && window.I18N.getLang() === 'en');
  }

  function dist3D(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    var dz = (a.z != null && b.z != null && !isNaN(a.z) && !isNaN(b.z)) ? (a.z - b.z) : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function toPt(arr, fallbackZ) {
    if (!arr || arr.length < 2) return null;
    var z = (arr.length >= 3 && arr[2] != null && !isNaN(arr[2])) ? Number(arr[2]) : fallbackZ;
    return { x: Number(arr[0]), y: Number(arr[1]), z: (z != null && !isNaN(z)) ? Number(z) : null };
  }

  function ensureIndex() {
    if (indexMap) return indexMap;
    indexMap = Object.create(null);

    // 1. 搬运朋友（100 处）：起点 -> 朋友营地
    var tp = (window.TOTK_KOROK_PATHS && window.TOTK_KOROK_PATHS.items) || [];
    for (var i = 0; i < tp.length; i++) {
      var p = tp[i];
      if (!p || p.id == null || !p.start || !p.goal) continue;
      var sPt = toPt(p.start, null);
      var gPt = toPt(p.goal, null);
      if (!sPt || !gPt) continue;
      indexMap[p.id] = {
        kind: 'transport',
        layer: p.layer,
        relayDist: 18,
        waypoints: [sPt, gPt]
      };
    }

    // 2. 追小花 / 飞圈圈 / 树桩跑酷（118 处）
    var ch = (window.TOTK_KOROK_CHALLENGE_PATHS && window.TOTK_KOROK_CHALLENGE_PATHS.items) || [];
    for (var j = 0; j < ch.length; j++) {
      var c = ch[j];
      if (!c || c.id == null || !c.path || c.path.length < 2) continue;
      if (indexMap[c.id]) continue;
      var kind = c.kind || 'stump';
      // 树桩/飞圈圈若起终点距离太近(<8m)无需多段；追小花即使绕圈也保留完整花朵序列
      if (kind !== 'flower' && !(c.dist >= 8)) continue;

      var wps = [];
      if (kind === 'flower') {
        for (var k = 0; k < c.path.length; k++) {
          var fp = toPt(c.path[k], null);
          if (!fp) continue;
          // 去除相邻完全重合的重复点
          if (wps.length > 0 && dist3D(wps[wps.length - 1], fp) < 0.5) continue;
          wps.push(fp);
        }
      } else {
        var cs = toPt(c.start || c.path[0], null);
        var cg = toPt(c.path[c.path.length - 1], null);
        if (cs && cg) wps = [cs, cg];
      }
      if (wps.length < 2) continue;
      indexMap[c.id] = {
        kind: kind,
        layer: c.layer,
        relayDist: kind === 'flower' ? 10 : 15,
        waypoints: wps
      };
    }
    return indexMap;
  }

  function getEntry(id) {
    if (id == null) return null;
    return ensureIndex()[id] || null;
  }

  function isMultiKorok(id) {
    return !!getEntry(id);
  }

  /* 统一坐标出口：供 explore-auto.js 算最近点 & 100m 弹卡使用 */
  function resolvePoint(m) {
    if (!m) return null;
    var mz = m.z != null ? Number(m.z) : (m.altitude_y != null ? Number(m.altitude_y) : null);
    if (active && active.id === m.id && active.waypoints[active.idx]) {
      return active.waypoints[active.idx];
    }
    var entry = getEntry(m.id);
    if (entry && entry.waypoints.length) {
      return entry.waypoints[0];
    }
    return { x: m.x, y: m.y, z: mz };
  }

  /* 防抢切锁：已过起点、正处于多点任务途中时返回 true */
  function isLocked() {
    return !!(active && active.idx > 0);
  }

  function getState() {
    if (!active) return null;
    return {
      id: active.id,
      kind: active.kind,
      idx: active.idx,
      total: active.waypoints.length,
      locked: active.idx > 0
    };
  }

  function makeBody(base, pt) {
    return {
      id: base.id,
      name: base.name,
      x: pt.x,
      y: pt.y,
      z: pt.z != null ? pt.z : base.fallbackZ,
      type: base.type,
      layer: base.layer
    };
  }

  /* 启动多点克洛格导航（由 live.js navigate() 调用） */
  function start(opts, playerPos, renderLayer) {
    active = null;
    if (!opts || opts.id == null) return null;
    var entry = getEntry(opts.id);
    if (!entry) return null;

    var fallbackZ = (opts.z != null && !isNaN(opts.z)) ? Number(opts.z) : null;
    var wps = entry.waypoints.map(function (pt, idx) {
      // 末点若缺 z 用 marker 自身 z 兜底
      var z = pt.z != null ? pt.z : (idx === entry.waypoints.length - 1 ? fallbackZ : null);
      return { x: pt.x, y: pt.y, z: z };
    });

    var layer = opts.layer != null ? opts.layer : entry.layer;
    var sameLayer = (layer == null || layer === renderLayer);
    var p = (playerPos && playerPos.mx != null)
      ? { x: playerPos.mx, y: playerPos.my, z: playerPos.gz != null ? playerPos.gz : null }
      : null;

    var startIdx = 0;
    if (sameLayer && p) {
      // 若人已经在起点范围内（或追小花已靠近某朵后续花），直接切到下一段
      if (entry.kind === 'flower') {
        for (var i = wps.length - 2; i >= 0; i--) {
          if (dist3D(wps[i], p) <= entry.relayDist) {
            startIdx = i + 1;
            break;
          }
        }
      } else if (dist3D(wps[0], p) <= entry.relayDist) {
        startIdx = 1;
      }
    }

    active = {
      id: opts.id,
      name: opts.name || '目标',
      type: opts.type || '',
      layer: layer,
      fallbackZ: fallbackZ,
      kind: entry.kind,
      relayDist: entry.relayDist,
      waypoints: wps,
      idx: startIdx,
      leftStart: false
    };

    var body = makeBody(active, wps[startIdx]);
    var en = isEn();
    var voiceEv = opts.voiceEvent || null;
    var toastMsg = null;

    if (startIdx === 0) {
      if (!voiceEv && !opts.silent) voiceEv = 'korok_start';
      if (!opts.silent) {
        toastMsg = en
          ? ('Guiding to Korok start first: ' + active.name)
          : ('已设置多点导航（先去起点）：' + active.name);
      }
    } else {
      if (!voiceEv && !opts.silent) {
        voiceEv = (active.kind === 'transport') ? 'korok_to_camp' : 'korok_to_goal';
      }
      if (!opts.silent) {
        toastMsg = (active.kind === 'transport')
          ? (en ? "At start, guiding to friend's camp" : '已在起点，导航至朋友营地')
          : (en ? 'At start, guiding to next Korok point' : '已在起点，导航至下一目标点');
      }
    }

    return {
      isMulti: true,
      body: body,
      voiceEvent: voiceEv,
      toastMsg: toastMsg
    };
  }

  /* 每帧位置推进（由 live.js tickArrival() 调用） */
  function tick(playerPos, curTarget, renderLayer) {
    if (!active || !curTarget || curTarget.id !== active.id) return null;
    if (!playerPos || !playerPos.located || playerPos.mx == null) return null;

    // 切层自动解锁防死锁
    if (active.layer != null && active.layer !== renderLayer) {
      active = null;
      return null;
    }

    var p = { x: playerPos.mx, y: playerPos.my, z: playerPos.gz != null ? playerPos.gz : null };
    var wps = active.waypoints;
    var lastIdx = wps.length - 1;
    var en = isEn();

    // 传送防死锁：若已过起点且同时远离起点和当前目标超过 600m，解除锁死
    if (active.idx > 0) {
      var dCur = dist3D(wps[active.idx], p);
      var dStart = dist3D(wps[0], p);
      if (dCur > 600 && dStart > 600) {
        active = null;
        return null;
      }
    }

    // 1. 限时挑战（飞圈圈/树桩/追花）失败回退：离开起点 >30m 后又跑回起点 <=12m，允许重来
    if (active.kind !== 'transport' && active.idx > 0) {
      var d0 = dist3D(wps[0], p);
      if (d0 > 30) active.leftStart = true;
      else if (active.leftStart && d0 <= 12) {
        active.leftStart = false;
        active.idx = 1;
        return {
          nextTarget: makeBody(active, wps[1]),
          voiceEvent: 'korok_to_goal',
          toastMsg: en ? 'Back at Korok start, restarting route' : '已回到起点，重新开始多点导航'
        };
      }
    }

    // 已在最后一段（终点），等待完成
    if (active.idx >= lastIdx) return null;

    // 2. 追小花：优先匹配当前花，未命中时最多向前滑窗 2 朵（防绕圈花径从第 1 朵误跳终点）
    if (active.kind === 'flower') {
      var hitIdx = -1;
      if (dist3D(wps[active.idx], p) <= active.relayDist) {
        hitIdx = active.idx;
      } else {
        var maxLook = Math.min(lastIdx - 1, active.idx + 2);
        for (var i = active.idx + 1; i <= maxLook; i++) {
          if (dist3D(wps[i], p) <= active.relayDist) {
            hitIdx = i;
            break;
          }
        }
      }
      if (hitIdx < 0) return null;
      var wasStart = (active.idx === 0);
      active.idx = hitIdx + 1;
      var isFinal = (active.idx === lastIdx);
      var stepText = (active.idx + 1) + '/' + wps.length;
      return {
        nextTarget: makeBody(active, wps[active.idx]),
        // 仅首次到达起点播完整语音，中间花朵静默切线+轻 toast 避免语音刷屏
        voiceEvent: wasStart ? 'korok_to_goal' : null,
        toastMsg: isFinal
          ? (en ? 'Last flower! Guiding to final Korok' : '最后一朵花！导航至克洛格终点')
          : (en ? ('Flower reached, next (' + stepText + ')') : ('已触碰小花，前往下一朵（' + stepText + '）'))
      };
    }

    // 3. 搬运朋友 / 飞圈圈 / 树桩：起点 -> 终点（3D 距离判定）
    var ds = dist3D(wps[0], p);
    if (ds <= active.relayDist) {
      active.idx = 1;
      var isTransport = (active.kind === 'transport');
      return {
        nextTarget: makeBody(active, wps[1]),
        voiceEvent: isTransport ? 'korok_to_camp' : 'korok_to_goal',
        toastMsg: isTransport
          ? (en ? "Reached backpack Korok, now guiding to friend's camp" : '已到达背包克洛格起点，自动接力导航至朋友营地')
          : (en ? 'Reached Korok start, now guiding to destination' : '已到达克洛格挑战起点，自动接力导航至终点')
      };
    }

    return null;
  }

  function clear() {
    active = null;
  }

  window.KOROK_NAV = {
    isMultiKorok: isMultiKorok,
    resolvePoint: resolvePoint,
    isLocked: isLocked,
    getState: getState,
    start: start,
    tick: tick,
    clear: clear
  };
})();
