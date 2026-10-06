/* ============================================================
 * 任务板块 · M4 · 流程线（TOTKMAP V2.1）
 * ------------------------------------------------------------
 * 玩法：选中一个任务后，在地图上把它经过的地点按顺序连成虚线，
 *      并在每个节点标出序号。玩家可以点节点看是第几步。
 *
 * ★ 三档只在选中后显示，绝不全图铺满（老大定的口径）
 *   L1 多点（74 条）→ 画流程线 + 序号节点
 *   L2 单点（178 条）→ 只高亮那一个点，不画线
 *   L3 无点（8条）  → 什么都不画，卡片里说明
 *
 * ★ 跨图层不能直接连（实测 74 条 L1 的 240 个流程点里：
 *     地表 199 / 天空 28 / 地底 13）。跨层连线会画出「穿墙直线」，
 *     看起来像bug。处置：只连**当前图层内的相邻节点**，
 *     跨层的那一段不连，并在卡片里说明「有 N 个点在其他图层」。
 *
 * 与其他模块完全隔离：
 *   - 不改 app.js / task-panel.js / task-card.js 任何逻辑
 *   - 只监听 TaskCard 的开/关，通过暴露的 API 通信
 *   - 想下线：删 index.html 里本模块的 script 标签
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.TaskData;
  if (!D) { console.warn('[任务板块] TaskData 未加载，流程线不初始化'); return; }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    var A = global.TOTK_APP;
    if (A && A.toast) { A.toast(msg); return; }
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, 1800);
  }

  var map = null;
  var cur = null;          /* 当前流程线所属任务 */
  var lineLayer = null;    /* 流程线的 LayerGroup */
  var curLayer = 18;
  var lastKey = null;      /* 当前已画的任务 key，防重复画 */

  /* ---------- 图层判定（与 build_task_plan.py 同一口径） ---------- */
  function layerOf(y) {
    if (y == null) return 18;
    if (y < -250) return 19;
    if (y >= 700) return 20;
    return 18;
  }
  function currentLayer() {
    var s = global.TOTK && global.TOTK.state;
    if (s && s.layer != null) return s.layer;
    var a = document.querySelector('#layerSwitch button.active');
    return a ? Number(a.getAttribute('data-layer')) : 18;
  }

  /* ---------- 核心：把任务的流程点按图层切段 ---------- */
  /* 返回 {在本层的点, 跨层点数} —— 顺序严格保持 ROM 叙事顺序，不要排序。 */
  function splitByLayer(t) {
    var here = [], off = 0;
    (t.flowPts || []).forEach(function (p) {
      if (layerOf(p.gy) === curLayer) here.push(p);
      else off++;
    });
    return { here: here, off: off };
  }

  /* ---------- 绘制 ---------- */
  function clear() {
    if (lineLayer && map) { map.removeLayer(lineLayer); lineLayer = null; }
    cur = null; lastKey = null;
  }

  function draw(t) {
    if (!map || !t) { clear(); return; }
    if (lastKey === t.key && lineLayer) return;   /* 已画过，别重复 */
    clear();
    cur = t;

    var sp = splitByLayer(t);
    var g = L.layerGroup();

    /* L3 / L2 / 本层无点：只高亮任务自身的位置点，流程线画不出来 */
    if (!sp.here.length) {
      lineLayer = g;      /* 空组也要挂在 map 上，逻辑统一 */
      g.addTo(map);
      lastKey = t.key;
      updateCardHint(t, sp.off, 0);
      return;
    }

    /* ★ 只连**本层内相邻**的点。
       跨层那一段不连 —— 连出来是穿墙直线，看着像 bug 而不是流程。 */
    var latlngs = sp.here.map(function (p) {
      return [p.gz, p.gx];              /* ★ Leaflet latlng = (gz, gx) */
    });

    if (latlngs.length >= 2) {
      L.polyline(latlngs, {
        color: FLOW_COLOR[t.group] || '#eac27e',
        weight: 2.5,
        opacity: 0.85,
        dashArray: '7,6',
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,              /* 线不抢点击，点节点才响应 */
        zIndex: 500
      }).addTo(g);
    }

    /* 节点：序号 + hover 提示 */
    latlngs.forEach(function (ll, i) {
      var n = i + 1;
      var m = L.marker(ll, {
        icon: L.divIcon({
          className: 'tkf-node-wrap',
          /* title 用「第n 个地点」，别暴露 L1/L2/L3 这种内部术语 */
          html: '<div class="tkf-node" data-n="' + n + '"><span class="tkf-no">' +
                n + '</span></div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        }),
        title: '第 ' + n + ' 个地点',
        zIndexOffset: 600,
        riseOnHover: true
      });
      m.bindTooltip('第 ' + n + ' 个地点', {
        direction: 'top', offset: [0, -10], className: 'mk-label tkf-tip'
      });
      m.on('click', function () {
        toast('第 ' + n + ' 个地点 · ' + ll[0].toFixed(0) + ', ' + ll[1].toFixed(0));
      });
      m.addTo(g);
    });

    /* 起点额外标一下，避免玩家不知道从哪开始 */
    if (latlngs.length >= 2) {
      L.marker(latlngs[0], {
        icon: L.divIcon({
          className: 'tkf-node-wrap',
          html: '<div class="tkf-start" title="起点">起</div>',
          iconSize: [22, 22], iconAnchor: [11, 11]
        }),
        interactive: false,
        zIndexOffset: 700
      }).addTo(g);
    }

    g.addTo(map);
    lineLayer = g;
    lastKey = t.key;
    updateCardHint(t, sp.off, latlngs.length);
  }

  /* 各任务种类的连线颜色，跟任务点配色一致 */
  var FLOW_COLOR = {
    '主线': '#eac27e',
    '重要支线': '#7ec8a9',
    '普通支线': '#6fb3e0',
    '其他': '#a8adb8'
  };

  /* ---------- 卡片里的联动提示 ---------- */
  /* 画完流程线后告诉玩家「本层画了几个点、另外几个在别的图层」，
     不然玩家会以为「就这几个点？」 */
  function updateCardHint(t, offCount, shown) {
    var el = $('tkFlowHint');
    if (!el) return;
    if (t.tier === 'L3') {
      el.textContent = '这个任务没有可定位的地点，无法在地图上连线';
    } else if (offCount > 0) {
      el.textContent = '本图层显示 ' + shown + ' 个地点，另有 ' + offCount +
                       ' 个在其他图层（切图层可见）';
    } else {
      el.textContent = shown >= 2
        ? '已在本图层连出 ' + shown + ' 个地点的流程线'
        : '这个任务在本图层只有 1 个地点';
    }
  }

  /* ---------- 按钮 ---------- */
  /* task-card.js 的「显示流程」按钮 onclick 调这里。
     L2/L3 根本不给按钮（卡片里直接显示说明文案），这里的判断是双保险。 */
  function toggle() {
    var t = global.TaskCard && global.TaskCard.current();
    if (!t) { toast('请先打开一个任务'); return; }
    /* 换任务时不能直接 return「已隐藏」——
       否则点别的任务的「显示流程」会毫无反应（lineLayer 非空就短路了）。
       正确逻辑：同任务 = 开关；不同任务 = 收掉旧的、画新的。 */
    if (lineLayer) {
      if (lastKey === t.key) { clear(); toast('已隐藏流程线'); return; }
      clear();
    }
    if (t.tier === 'L3') { toast('这个任务没有可定位的地点'); return; }
    if (t.tier === 'L2') { toast('这个任务只有 1 个地点，不需要连线'); return; }
    draw(t);
  }

  /* ---------- 与卡片联动 ----------
   * ★ 必须包装 TaskCard.close / open 本身，不能靠监听 document 的 click：
   *   关闭卡片有三条路径，只有第一条会触发 click ——
   *     ① 点卡片外的地图空白  → click ✓
   *     ② 按 Esc              → **只发 keydown，不发 click** ✗（踩过这个坑）
   *     ③ 程序调close()      → 谁都不发✗
   *   早期版本只监听 click，结果按 Esc 关卡片后地图上留一条孤线。
   *   task-flow.js 在 task-card.js 之后加载，此时 TaskCard 已存在，直接包一层最稳。
   *
   * ★★ 只包装 close，**不包装 open**：
   *   打开卡片时自动画线 = 一开卡片地图上就冒出线，
   *   正是老大明确要避免的「地图杂乱」。
   *   流程线只能由玩家点「显示流程」按钮才出现。
   *   （实测踩过：包了 open 之后，一开卡片就有 4 个节点凭空出现，
   *     紧接着点按钮反而把它关掉 —— 行为完全反了。） */
  /* ---------- 追踪（tracking）----------
   * ------------------------------------------------------------
   * ★ 追踪 = 「把这条流程线钉在地图上」，关掉卡片也留着。
   *   之前 close() 一律收线，导致想对照地图看别的任务时线已经没了。
   *
   * 生命周期：
   *   点「追踪」→ 线显示 + tracking=true
   *   → 关卡片 → 线仍在地图上
   *   → 重新打开该任务点「追踪」→ 关闭（toggle）
   *   → 打开别的任务 → 旧线自动收掉（不能两条线叠着）
   */
  var tracking = false;     /* 追踪中：卡片关了线也留着 */
  var trackKey = null;      /* 追踪中的任务 key */

  /* 关卡片：普通收线；追踪中保留 */
  function onCardClose() {
    if (tracking) return;
    clear();
  }

  /* 打开卡片：之前追踪的是别的任务就收掉旧线 */
  function onCardOpen(t) {
    if (tracking && trackKey !== (t && t.key)) {
      tracking = false; trackKey = null;
      clear();
    }
  }

  /* 「追踪」按钮：持久化开关（与「显示流程」的临时显示不同） */
  function toggleTrack() {
    var t = global.TaskCard && global.TaskCard.current();
    if (!t) { toast('请先打开一个任务'); return; }

    if (tracking && trackKey === t.key) {
      tracking = false; trackKey = null; clear();
      toast('已关闭流程线');
      return;
    }
    if (tracking && trackKey !== t.key) {
      tracking = false; trackKey = null; clear();
    }
    if (t.tier === 'L3') { toast('这个任务没有可定位的地点'); return; }
    tracking = true;
    trackKey = t.key;
    draw(t);
    toast('已追踪：' + t.name + '（关掉卡片流程线也会留着）');
  }

  function isTracking(key) {
    return tracking && (!key || trackKey === key);
  }

  function hookCard() {
    var C = global.TaskCard;
    if (!C || C.__flowHooked) return;
    var origClose = C.close;
    var origOpen = C.open;
    C.close = function () {
      onCardClose();
      return origClose.apply(this, arguments);
    };
    C.open = function (t) {
      onCardOpen(t);
      return origOpen.apply(this, arguments);
    };
    C.__flowHooked = true;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    map = (global.TOTK && global.TOTK.map) || null;
    if (!map) { setTimeout(init, 300); return; }
    curLayer = currentLayer();
    injectCSS();
    hookCard();

    /* 切层时：图层变了，之前的线要么重画要么清掉。
       跨层点是画不了的（会穿墙），所以直接清 + 提示，不静默留一条错线。 */
    var sw = $('layerSwitch');
    if (sw) {
      new MutationObserver(function () {
        var l = currentLayer();
        if (l === curLayer) return;
        curLayer = l;
        if (cur) {
          clear();
          toast('已切图层，流程线需重新点「显示流程」');
        }
      }).observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }

    /* 卡片关掉时顺手收线，别在地图上留一堆孤线
       （关卡的三条路径已由 hookCard 兜住，这里只做兜底：
        万一有代码绕过了 TaskCard.close 直接加 hidden class） */
    document.addEventListener('click', function (e) {
      setTimeout(function () {
        var card = $('taskCard');
        if (card && card.classList.contains('hidden') && lineLayer) clear();
      }, 0);
    });

    /* 地图缩放/平移后节点要跟着重画（divIcon 不会自动跟随，得手动刷新） */
    map.on('zoomend moveend', function () {
      if (lineLayer && cur) {
        var k = cur.key; clear(); cur = null; draw(D.byKey(k));
      }
    });

    global.TaskFlow = {
      toggle: toggle,
      toggleTrack: toggleTrack,
      isTracking: isTracking,
      draw: draw,
      clear: clear,
      current: function () { return cur; }
    };
  }

  /* ---------- 样式 ---------- */
  function injectCSS() {
    if ($('task-flow-css')) return;
    var st = document.createElement('style');
    st.id = 'task-flow-css';
    st.textContent = [
      '.tkf-node-wrap { background:none; border:none; }',
      '.tkf-node {',
      '  width:20px; height:20px; border-radius:50%;',
      '  display:flex; align-items:center; justify-content:center;',
      '  background:rgba(20,22,28,.9);',
      '  border:2px solid rgba(234,194,126,.9);',
      '  box-shadow:0 1px 6px rgba(0,0,0,.6);',
      '  transition:transform .12s; user-select:none; }',
      '.tkf-node-wrap:hover .tkf-node { transform:scale(1.25); }',
      '.tkf-no {',
      '  font-size:11px; line-height:1; font-weight:500;',
      '  color:#eac27e; font-variant-numeric:tabular-nums; }',
      '.tkf-start {',
      '  width:22px; height:22px; border-radius:50%;',
      '  display:flex; align-items:center; justify-content:center;',
      '  background:#eac27e; color:#3a2f18;',
      '  font-size:11px; line-height:1; font-weight:500;',
      '  border:2px solid rgba(20,22,28,.9);',
      '  box-shadow:0 1px 6px rgba(0,0,0,.6); }',
      '.tkf-tip { white-space:nowrap; }'
    ].join('\n');
    document.head.appendChild(st);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
