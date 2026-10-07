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
  /* 「正在由 framePoints 主动调视野」的防重入锁。
   * 必须模块级：init() 里的监听回调和 draw() 都要读它。
   * 见 init() 里 zoomend/moveend 监听处的说明（不锁会无限递归爆栈）。 */
  var REFRAMING = false;
  /* 「干活的那个点」= 本层最后一个流程点，由 draw() 写入、clear() 清空。
   * 见 draw() 尾部与 toggleTrack 里的说明。 */
  var target = null;
  /* 本层的全部点（latlng 数组），飞行后的补拉远用。 */
  var hereL = [];

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
  /* ---------- 流程点按图层切段 ----------
   *★ 2026-10-07 改判据：优先用 **task-plan.js 的 `t.layers`**（数据层已含人工覆盖）。
   *
   * 原来这里用 `layerOf(p.gy)` 纯高度判，实测漏了一种情况——
   * 「装点河畔驿站的画作」的数据 `layers=[18]`（人工确认过），
   * 但它的时之神殿遗迹点高 1466 米，`layerOf` 判成天空层 20
   * → 地表层只连出驿站1 个点，卡片提示「另有 1 个在其他图层」，
   *   而那个点在地表根本点不到（玩家不知道要去哪）。
   * 这跟 task-panel.js 的 `pointInLayer` 是同一个坑（那里已改成优先用 t.layers），
   * 当时只改了一处、漏了这里。
   *
   * 与 task-panel.js 保持同一口径：先看 t.layers，只在拿不到时才退回高度判断。 */
  function splitByLayer(t) {
    var here = [], off = 0;
    var declared = (t.layers && t.layers.length) ? t.layers : [t.layer];
    (t.flowPts || []).forEach(function (p) {
      /* ① 单层任务：整条都在这一层，全部算本层。
       *    这样「装点河畔驿站的画作」的1466 米时之神殿点
       *    不会再被 layerOf 判成天空层（实测原来只连出驿站 1 个点）。 */
      if (declared.length === 1) {
        if (declared[0] === curLayer) here.push(p);
        else off++;
        return;
      }
      /* ② 多层任务（如[18,20]）：先用高度判。
       *   高度能**明确对上非当前层**就按高度算（大多数情况）。
       *
       *   ★「未知的天空巨人」是个特例：它两个点的高度**都**判成 18
       *   （650 米的西海布拉天空诸岛正好卡在 700 阈值下方，
       *    城堡那个点更是地面），可数据层人工指定了它涉及 20 天空层。
       *   于是天空层会算出「0 个点」——高度里根本没有那个层的信息。
       *
       *   判「高度信息缺失」的口径：**该点判出的层 == layers 的第一层**
       *   （第一层是这条任务的主层/接任务那层），而当前层是**后面的层**。
       *   → 说明当前层只能靠人工覆盖得到，按叙事顺序把第一个点补进来。 */
      var byH = layerOf(p.gy);
      if (byH === curLayer) { here.push(p); return; }
      if (curLayer !== declared[0] && byH === declared[0]) {
        /* 当前层不是主层、而这个点判成了主层 → 当前层缺信息，补位 */
        if (here.length === 0) here.push(p);
        else off++;
        return;
      }
      off++;
    });
    return { here: here, off: off };
  }

  /* ---------- 绘制 ---------- */
  function clear() {
    if (lineLayer && map) { map.removeLayer(lineLayer); lineLayer = null; }
    /* 收线时同步摘掉任务图标上的追踪光环，否则会留下一个「以为还在追踪」的图标。
     * ★ 用 markedKey 而不是 trackKey：取消追踪的分支里 trackKey 会**先**被置 null
     *   再调 clear()，那时已经不知道该摘谁的光环了。 */
    markTracked(markedKey, false);
    cur = null; lastKey = null; target = null; hereL = [];
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

    /*小跨度（点位几乎重合）时：点只剩红点、也不连线。
       连出来的虚线在3 米间距下是一团糊影，比不画更糟。 */
    var tiny = spanTooTiny(latlngs);

    if (latlngs.length >= 2 && !tiny) {
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

    /* 节点：序号 + hover 提示
     * ★★ 第 1 个点**不画序号圆**，改用下面的「起」徽标代替。
     *   原因：第 1 个点就是任务自己的位置，任务图标（18px）画在完全相同的
     *   坐标上，两个圆心重合怎么调zIndex 都是「一个盖住另一个」——
     *   节点盖住图标就打不开卡片（老大 2026-10-07 报的问题），
     *   图标盖住序号 1 则「第 1 步」这个信息就丢了。
     *   合并成一个「起」徽标后：图标 + 起 + 序号 2/3/4 各占各的位置，全可读。
     *
     * ★★ tiny（小跨度退化）：点位几乎重合时（实测 7 条 L1 跨度<30 米，
     *   最短 0 米）不画序号数字，只画小红点。详见 spanTooTiny 的注释。 */
    latlngs.forEach(function (ll, i) {
      if (i === 0) return;                 /* 第 1 个点交给「起」徽标 */
      var n = i + 1;
      var m = L.marker(ll, {
        icon: L.divIcon({
          className: 'tkf-node-wrap',
          /* title 用「第n 个地点」，别暴露 L1/L2/L3 这种内部术语 */
          html: tiny
            ? '<div class="tkf-dot" data-n="' + n + '"></div>'
            : '<div class="tkf-node" data-n="' + n + '"><span class="tkf-no">' +
              n + '</span></div>',
          iconSize: tiny ? [12, 12] : [20, 20],
          iconAnchor: tiny ? [6, 6] : [10, 10]
        }),
        title: '第 ' + n + ' 个地点',
        zIndexOffset: 600,
        riseOnHover: true
      });
      m.bindTooltip('第 ' + n + ' 个地点 · 点击打开任务卡片', {
        direction: 'top', offset: [0, -10], className: 'mk-label tkf-tip'
      });
      /* ★ 点节点 = 打开该任务卡片（2026-10-07老大提）
       *
       * 为什么要这个：追踪后卡片被关掉（点地图空白），地图上只剩线和节点。
       * 玩家要取消追踪必须先重新打开卡片，而当时唯一的入口是任务图标——
       * 但节点画在**同一坐标**上把图标盖住了（已用 zIndexOffset 900 修），
       * 双保险：不管图标在不在，点线上的任一个点都能回卡片。
       * 只弹 toast 说「第 n 个地点」对玩家没用——他要看的是这张卡片。 */
      m.on('click', function (e) {
        var C = global.TaskCard;
        if (C && cur) { C.open(cur, e); return; }
        toast('第 ' + n + ' 个地点 · ' + ll[0].toFixed(0) + ', ' + ll[1].toFixed(0));
      });
      m.addTo(g);
    });

    /* 起点徽标：既是「第 1 个地点」也是「起点」，合并成一个。
     * ★ iconAnchor [1,17] 把它甩到右上角，不压住任务图标。
     * ★ zIndexOffset 700：压在图标(900)之下、节点(600)之上——
     *   保证它自己可见，又不会抢走图标的点击。 */
    if (latlngs.length >= 2) {
      var s0 = L.marker(latlngs[0], {
        icon: L.divIcon({
          className: 'tkf-node-wrap',
          /* 小跨度时「起」也会和别的点撞上，同样退化成红点 */
          html: tiny
            ? '<div class="tkf-dot" data-n="1"></div>'
            : '<div class="tkf-start" title="第 1 个地点 · 起点">起</div>',
          iconSize: tiny ? [12, 12] : [16, 16],
          iconAnchor: tiny ? [6, 6] : [1, 17]
        }),
        title: '第 1 个地点 · 起点',
        zIndexOffset: 700,
        riseOnHover: true
      });
      s0.bindTooltip('第 1 个地点 · 起点 · 点击打开任务卡片', {
        direction: 'top', offset: [0, -10], className: 'mk-label tkf-tip'
      });
      /* 起点同样可点开卡片（与其它节点一致的手感） */
      s0.on('click', function (e) {
        var C = global.TaskCard;
        if (C && cur) { C.open(cur, e); }
      });
      s0.addTo(g);
    }

    g.addTo(map);
    lineLayer = g;
    lastKey = t.key;
    updateCardHint(t, sp.off, latlngs.length, tiny);
    /* 视野自适应：拉远装下全部点 + 放大分开太挤的点（见 framePoints 注释） */
    framePoints(latlngs);
    /* ★ 记下「干活的那个点」= 本层最后一个流程点。
     * 叙事顺序里最后一个点是玩家真正要动手的位置
     * （接/交任务在第 1 点，采集/拍摄/战斗在后面），
     * toggleTrack 飞到这里——见 toggleTrack 里的说明。
     * 同理存下本层全部点，供飞行后的补拉远用。 */
    hereL = latlngs.slice();
    target = latlngs.length ? latlngs[latlngs.length - 1] : null;
  }

  /* ---------- 视野自适应（A 方案，2026-10-07老大拍板）----------
   * ------------------------------------------------------------
   * 问题：流程线的点位跨度差异极大。
   *   实测全库 77 条 L1 的最大点间距——中位数 599 米，但**25 条不到 300 米**，
   *   最短的只有 3 米（两条相邻任务点）。跨度小的时候，
   *   默认缩放下**序号节点会挤成一团**，玩家根本分不清哪个是哪个。
   *   典型：「捕捉咕咕鸡大作战」6 个点全在 67 米内。
   *
   * 做法：画完线后按「所有点的包围盒」调一次视野，保证每个点之间
   *   至少有可分辨的屏幕间距。
   *
   * ★ 为什么不用 map.fitBounds：
   *   fitBounds 会把地图**拉到最大**，跨度大的任务（如7976 米）
   *   正好合适，但跨度小的会**拉到很近的倍率**，
   *   而倍率过高会让底图细节爆掉、也丢掉了周边参照物。
   *   折中方案：自己算一个「够用就好」的缩放值，并设上下限。
   *
   * ★ 只在**跨度小**时才动地图：
   *   跨度大的任务（>= 约 500 米）本来就能看全，没必要改玩家的视野——
   *   玩家可能正在看自己要去的地方。 */
  var MIN_SEP_PX = 34;      /* 两个序号节点之间至少要的屏幕像素 */
  /* ★ ZOOM_MAX 必须 = app.js 的 MAX_ZOOM（7），不能自己拍。
   *   瓦片图 z7 就是极限（V1.9.0：z7 由 z6 瓦片 2× 放大实现），
   *   设成 12 是无效配置：`setView` 会被Leaflet 夹到 7，
   *   看起来「缩放了但没效果」，很难查。 */
  var ZOOM_MAX = 7;
  /* ZOOM_MIN_OUT = 流程线拉远的下限，必须 = app.js 的 MIN_ZOOM（3）。
   * 跨度大的任务（如海拉鲁城堡的异变跨 15 公里）在 z6 装不下，
   * 必须能退到 z3/z4 才装得下——老大 2026-10-07 明确要求
   * 「跨度大的任务，不应该被限定在一个画面中」。 */
  var ZOOM_MIN_OUT = 3;
  var PX_PER_M = 2;         /* 瓦片 2 像素 = 1 米（坐标与地图速查.md） */
  /* ★ 20 米的来历（实测，不是拍的）：
   *   zoom 7 下 **1 米 = 1 像素**（z5=0.25 / z6=0.5 / z7=1，每档 ×2），
   *   而序号圆的直径是 20px → 相邻两点要分开**至少要 20 米**。
   *   地图 maxZoom=7（V1.9.0：z7 由 z6 瓦片 2× 放大），再放大只有马赛克。
   *   ⇒ 20 米是「能不能显示序号」的物理门槛，不是我随手定的整数。
   *   第一版写 30米，把「咕咕鸡」那种最小段 14 米的任务也误判成退化，
   *   结果 6 个序号全没了——偏保守也会出错，阈值要有依据。 */
  var SPAN_TINY2_M = 20;    /* 相邻段 < 20 米 → 缩到头也分不开，退化成无序号红点 */

  /* 相邻两点的直线距离（米）。
   * 抽成函数是因为 framePoints 侧和spanTooTiny 侧要用同一套换算，
   * 两处各写一遍迟早会跑偏（第一版就因为只在一处 ×2 而判定全错）。 */
  function segMeters(a, b) {
    var lat1 = a[0], lng1 = a[1], lat2 = b[0], lng2 = b[1];  /* latlng = (gz, gx) */
    var dy = (lat1 - lat2) * PX_PER_M;
    var dx = (lng1 - lng2) * PX_PER_M *
      Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function framePoints(latlngs) {
    if (!map || !latlngs || latlngs.length < 2) return;
    /* ==================================================================
     * 视野自适应：**双向**（拉远 + 放大）
     * ------------------------------------------------------------------
     * 第一版只会放大（step 恒为正），于是两个问题（老大 2026-10-07 报）：
     *   ① 「装点河畔驿站的画作」两点相距 2128 米，z6 一屏装不下 →
     *      点「任务目标」后目标点**在屏幕外**（实测屏幕坐标 -460, 1451），
     *      玩家只看到一条虚线伸出屏幕，完全不知道目标在哪。
     *   ② 老大：「跨度大的任务不应该被限定在一个画面里」——
     *      z6 只能装约 2 公里，跨度 4~15 公里的任务（海拉鲁城堡的异变跨 15公里）
     *      **无论怎么调都装不下**。
     *
     * 判据改成**包围盒**（不是最小相邻间距）：
     *   · 装不下（bbox 超出视口）→ **拉远**，直到装得下（下限 MIN_ZOOM）
     *   · 太挤（最小相邻间距 < 34px）→ 放大，until 分得开（上限 ZOOM_MAX）
     *   两个条件都要满足，**先拉远再放大**的顺序天然正确：
     *   拉远只会让间距变大，所以放大判断在拉远之后基本不会触发。
     *
     * ★ 为什么拉远要跟「居中」一起做：
     *   只 setView(center, zoom) 不动中心的话，bbox 可能仍然横跨屏幕两侧。
     *   正确做法 = setView(bbox 中心, 能装下 bbox 的最小 zoom)。
     * ================================================================== */
    var pts = latlngs.map(function (ll) {
      return map.latLngToContainerPoint(ll);
    });

    /* ---- ① 拉远：让**所有点都进视口** ----
     * ★ 判据不能用「两点间距 > 视口」（第一版这么写，错）：
     *   实测「装点河畔驿站的画作」两点间距 1161px、视口 1320px → 判"装得下"不拉远，
     *   但两点分别在 (700,550) 和 (1861,-385) —— **第二个点在屏幕外 460 像素**。
     *   间距小 ≠ 在屏内：点可能分居屏幕中心两侧而间距仍然不大。
     *   正确判据 = **把地图中心移到 bbox 中心后，bbox 的一半能否放进视口半宽/半高**。
     */
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    var halfW = ((global.innerWidth  || 1200) - 80) / 2;
    var halfH = ((global.innerHeight || 800)  - 80) / 2;
    /* bbox 中心相对当前视口中心的偏移 + bbox 自身半宽 = 需要放进视口的总半径 */
    var cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
    var vcX = (global.innerWidth  || 1200) / 2;
    var vcY = (global.innerHeight || 800)  / 2;
    var needX = Math.abs(cX - vcX) + (maxX - minX) / 2;
    var needY = Math.abs(cY - vcY) + (maxY - minY) / 2;
    var need = Math.max(needX / halfW, needY / halfH);
    if (need > 1.05) {                    /* 超出 5% 才动，避免抖动 */
      /* zoom 每 -1，屏幕距离 ×0.5 → 需要 log2(need) 级 */
      var zOut = Math.floor(map.getZoom() - Math.log(need) / Math.LN2);
      zOut = Math.max(zOut, ZOOM_MIN_OUT);
      if (zOut < map.getZoom()) {
        var cLatLng = map.containerPointToLatLng([cX, cY]);
        REFRAMING = true;
        try { map.setView(cLatLng, zOut, { animate: false }); }
        finally { REFRAMING = false; }
        /* 位置变了，重新取一次屏幕坐标（下面的放大判断要用新值） */
        pts = latlngs.map(function (ll) {
          return map.latLngToContainerPoint(ll);
        });
      }
    }

    /* ---- ② 放大：最挤的相邻两段仍分不开就进 ---- */
    var minPx = Infinity;
    for (var i = 1; i < pts.length; i++) {
      var d = Math.sqrt(Math.pow(pts[i].x - pts[i - 1].x, 2) +
                        Math.pow(pts[i].y - pts[i - 1].y, 2));
      if (d < minPx) minPx = d;
    }
    if (minPx >= MIN_SEP_PX) return;              /* 最挤的一段也够宽，不动 */
    if (minPx <= 0) return;                       /* 所有点重合，tiny 判定会接手 */

    /* Leaflet 的 zoom 每 +1，屏幕距离 **×2**（不是 +1），
     * 所以要的是 log2 的倍率差，不是线性除法。
     * 例：minPx=14、want=34 → 差 2.43 倍 → log2≈1.28 → zoom+2。 */
    var step = Math.ceil(Math.log(MIN_SEP_PX / minPx) / Math.LN2);
    var z = Math.min(map.getZoom() + step, ZOOM_MAX);
    if (z <= map.getZoom()) return;               /* 已到上限 */
    /* ★ 上锁再 setView：否则 zoomend → 重画 → 再 framePoints → 无限递归（实测爆栈） */
    REFRAMING = true;
    try { map.setView(map.getCenter(), z, { animate: false }); }
    finally { REFRAMING = false; }
  }

  /* ---------- 小跨度任务的节点退化为「无序号红点」 ----------
   * ------------------------------------------------------------
   * 有一类任务点位几乎重合：实测全库 77 条 L1 里有 **7 条最大间距不到 30 米**
   * （「英帕与地上图画」是 **0 米**——两个流程点同一个位置）。
   * 这种任务再怎么缩放，序号 1/2 也会叠在一起，
   * 而地图 maxZoom=7 已经是瓦片图的极限，再拉就只剩马赛克。
   *
   * 老大的判断：「这种任务标点顺序无所谓的话，可以直接画一个小红点。」
   * → 采纳：点位太近时**去掉序号数字**，只留一个小红点表示「这里也是一个点」。
   * 玩家看到的是「驿站周围散着几个红点」，具体顺序看卡片里的攻略文字。
   *
   * ★★★ 判据必须是「**所有相邻段里最小的那段**」，不是总跨度：
   *   实测「海拉鲁城堡的异变」总跨度 15488 米（很大），
   *   但它 11 个点里有一段只有 **2 米**、另一段 5 米——
   *   总跨度判据会判它"跨度大、不用退化"，可那两段的序号照样叠成一团。
   *   ⇒只要**有一段**挤到分不开，整条线的序号就该退化成红点。
   *   （framePoints 那边同理，只看最小段间距。）
   */
  function spanTooTiny(latlngs) {
    if (!latlngs || latlngs.length < 2) return false;
    var minSeg = Infinity;
    for (var i = 1; i < latlngs.length; i++) {
      var m = segMeters(latlngs[i], latlngs[i - 1]);
      if (m < minSeg) minSeg = m;
    }
    return minSeg < SPAN_TINY2_M;
  }

  /* 各任务种类的连线颜色，跟任务点配色一致。
   * ★ 键必须与 task-data.js 的 group（四档官方分类）完全一致——
   *   这里原来用的是旧五档名（主线/重要支线/普通支线/其他），
   *   2026-10-07 分类改造后一个都匹配不上，连线全部退回默认色。
   *   漏改的后果很隐蔽：功能正常、只是颜色不对，容易漏掉。 */
  var FLOW_COLOR = {
    '主剧情挑战': '#eac27e',
    '情节挑战': '#7ec8a9',
    '神庙挑战': '#6fb3e0',
    '迷你挑战': '#b8a0e8'
  };

  /* ---------- 卡片里的联动提示 ---------- */
  /* 画完流程线后告诉玩家「本层画了几个点、另外几个在别的图层」，
     不然玩家会以为「就这几个点？」 */
  function updateCardHint(t, offCount, shown, tiny) {
    var el = $('tkFlowHint');
    if (!el) return;
    if (t.tier === 'L3') {
      el.textContent = '这个任务没有可定位的地点，无法在地图上连线';
    } else if (offCount > 0) {
      el.textContent = '本图层显示 ' + shown + ' 个地点，另有 ' + offCount +
                       ' 个在其他图层（切图层可见）';
    } else if (tiny) {
      /* ★ 小跨度：地图上只有几个红点、**没有线**。
       *   文案必须跟着改，否则玩家按提示去找流程线却找不到。 */
      el.textContent = '本图层这 ' + shown + ' 个地点挨得很近，地图上用红点标出、不连线';
    } else {
      el.textContent = shown >= 2
        ? '已在本图层连出 ' + shown + ' 个地点的流程线'
        : '这个任务在本图层只有 1 个地点';
    }
  }

  /* ---------- 按钮 ---------- */
  /* ★ 2026-10-07老大把卡片的「显示流程」按钮删了，入口合并到「任务点」按钮
     （那个按钮走 toggleTrack）。所以 toggle() 现在**没有 UI 入口**，
     仅保留给验收脚本与将来的临时显示需求。
     两个方法的区别：
       toggle()      —— 临时显示，关掉卡片线就没了
       toggleTrack() —— 追踪钉住，关卡片也留着（**现役入口**）
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
   *   流程线只能由玩家点「任务目标」按钮才出现（原「显示流程」按钮已删）。
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

  /* ---------- 追踪中的任务图标加光环 ----------
   * 不加的话，追踪关掉卡片后地图上只剩「线 + 节点」，
   * 玩家不知道这条线是哪个任务的——而要取消追踪必须先点开那张卡片。
   * 加一个脉动光环 = 一眼看出「这条线属于这个图标」，也是回卡片的指引。
   *
   * 靠 DOM class 实现而不是新画一个 marker：新 marker 会在同一坐标
   * 再叠一个元素，又回到「谁盖住谁」的老问题（见 task-panel.js 的 zIndexOffset 注释）。 */
  var TRACK_CLS = 'is-tracked';
  var markedKey = null;      /* 当前挂着光环的任务 key（与 trackKey 分开，见下） */
  function markTracked(key, on) {
    var P = global.TaskPanel;
    if (!P || !P.markByKey) return;
    if (on) { P.markByKey(key, true); markedKey = key; }
    else {
      P.markByKey(key, false);
      if (markedKey === key) markedKey = null;
    }
  }

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
    /* 任务图标挂光环：告诉玩家「这条线属于这个图标」，也是回卡片的指引。
     * 放在 draw 之后 —— draw() 内部会调 clear() 摘旧光环，先挂会被自己摘掉。 */
    markTracked(t.key, true);
    /* ★★ 飞到「干活的那个点」（本层最后一个流程点）。
     *
     * 为什么：任务流程的叙事顺序是「接任务 → 干活 → 交任务」，
     * 第一个点通常是接任务的地方（驿站/村庄），
     * **真正要动手的位置是后面那个**（女神像、野马、遗迹…）。
     * 只画线不飞过去的话，玩家看到的只是一条伸出屏幕的虚线
     * （实测「装点河畔驿站的画作」目标点在屏幕外 -460,1451），
     * 等于没告诉他目标在哪。
     *
     * 走gotoMarker 而不是直接 setView：它带光圈高亮，
     * 玩家能明确看到「就是这里」（和「任务点」按钮的观感一致）。
     * 复用它还顺带拿到卡片避让（moveCardAside）。
     */
    if (target && global.TOTK && global.TOTK.gotoMarker) {
      global.TOTK.gotoMarker({
        x: target[0], y: target[1],       /* ★ latlng = (gz, gx) */
        cat: null, name: t.name, marker: null,
        /* keepZoom：framePoints 刚按点分布算好倍率（跨度大的会拉到 z3/z4），
         * 不让 gotoMarker 用 `max(zoom,6)` 又拉回来——那样起点会被推出屏外。 */
        keepZoom: true
      });
      /* ★★ 飞行**之后**再补一次视野自适应。
       * 为什么必须补：draw() 里那次拉远是围绕「飞行前的地图中心」算的
       * （那时中心在驿站）。飞行后中心移到目标点，两点就分居屏幕两侧，
       * 实测「装点河畔驿站的画作」两点相距 2128 米，飞完只有 1 个点可见。
       * moveend 里再跑一次 framePoints，这次是围绕「装下全部点」重算。
       * （REFRAMING 锁在这里不会死循环：flyTo 已结束，锁已释放。） */
      if (global.TOTK.map) {
        var _mf = function () { framePoints(hereL); };
        global.TOTK.map.once('moveend', _mf);
        setTimeout(_mf, 1300);   /* 兜底：缩放级别没变时 Leaflet 会跳过 moveend */
      }
    }
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
          /* ★ 2026-10-07：清线的同时**必须把 tracking 一起重置**——
             原来只 clear() 不动tracking，于是切层后按钮还显示「取消追踪」、
             但线上没东西，状态和表现对不上（与下面兜底那处同一个毛病）。 */
          tracking = false; trackKey = null;
          /* ★ 2026-10-07：原来这里提示「需重新点『显示流程』」，
             但那个按钮已经被老大删掉了（入口合并到「任务目标」按钮），
             玩家照着提示去点会找不到按钮。改成实际存在的按钮名。 */
          toast('已切图层，流程线需重新点「任务目标」');
        }
      }).observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }

    /* 卡片关掉时顺手收线，别在地图上留一堆孤线
       （关卡的三条路径已由 hookCard 兜住，这里只做兜底：
        万一有代码绕过了 TaskCard.close 直接加 hidden class）

       ★ 2026-10-07 修正（老大报的状态不一致）：
         这里原来**无条件 clear()**，没看 tracking。
         于是玩家点了「任务目标」（= 追踪开启）、按钮已变成「取消追踪」，
         但点地图空白关卡片时兜底逻辑把线收了 —— tracking 仍是 true，
         表现就是「按钮说在追踪、线却没了」，状态和表现对不上。
         现在改成和 onCardClose 同一口径：**追踪中不收**，
         这条兜底只负责「没点任务目标」的临时线。 */
    document.addEventListener('click', function (e) {
      setTimeout(function () {
        if (tracking) return;                 /* 追踪中：线钉住，不收 */
        var card = $('taskCard');
        if (card && card.classList.contains('hidden') && lineLayer) clear();
      }, 0);
    });

    /* 地图缩放/平移后节点要跟着重画（divIcon 不会自动跟随，得手动刷新）
     * ★★ 必须加 reframe 锁（2026-10-07 踩过爆栈）：
     *   framePoints() 会调 map.setView() → 触发 zoomend → 这里clear()+draw()
     *   → draw() 末尾又调 framePoints() → 又 setView → **无限递归爆栈**
     *   （实测报 Uncaught RangeError: Maximum call stack size exceeded）。
     *   锁的语义：「正在由framePoints 主动调整视野」时，本次 zoomend 不重画——
     *   因为 setView 之后 Leaflet 自己会重画 marker 位置，不需要我们再画一遍。 */
    map.on('zoomend moveend', function () {
      if (REFRAMING) return;
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
      /* 小跨度退化：点位几乎重合时用小红点，不带序号（见 spanTooTiny 注释） */
      '.tkf-dot {',
      '  width:11px; height:11px; border-radius:50%;',
      '  background:#e8695a;',
      '  border:2px solid rgba(20,22,28,.9);',
      '  box-shadow:0 1px 4px rgba(0,0,0,.6);',
      '  transition:transform .12s; user-select:none; }',
      '.tkf-node-wrap:hover .tkf-dot { transform:scale(1.35); }',
      '.tkf-no {',
      '  font-size:11px; line-height:1; font-weight:500;',
      '  color:#eac27e; font-variant-numeric:tabular-nums; }',
      '.tkf-start {',
      '  width:16px; height:16px; border-radius:50%;',
      '  display:flex; align-items:center; justify-content:center;',
      '  background:#eac27e; color:#3a2f18;',
      '  font-size:10px; line-height:1; font-weight:700;',
      '  border:2px solid rgba(20,22,28,.9);',
      '  box-shadow:0 1px 6px rgba(0,0,0,.6);',
      '  cursor:pointer; }',
      '.tkf-node-wrap:hover .tkf-start { transform:scale(1.25); }',
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
