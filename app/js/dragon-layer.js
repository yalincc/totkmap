/* ============================================================
 * 龙轨迹图层（TOTKMAP V2.0 · 独立模块）
 * ------------------------------------------------------------
 * - 完全独立于 app.js：仅依赖 window.TOTK.map / window.TOTK.state（app.js 已暴露）
 * - 不修改 app.js 任何逻辑：分类项只是"开关"，绘制全在本模块内
 * - 入口：侧栏「位置」大组末尾的「龙的轨迹」小分类（catalogs.js id 229/230/231）
 *   点它 → app.js 写入 state.selected[catId] → 本模块监听到变化后绘制
 * - 数据：window.TOTK_DRAGON_PATHS_ROM（ROM 官方轨道，Banc/MainField/DeepHole/
 *   Set_DragonRail_Static.bcett）—— 精确贝塞尔曲线 + 真实飞行高度 Y
 * - 图层联动：
 *     天空层(20) 只画白龙
 *     地上层(18) 三元素龙：地表段实线 + 地下段虚线（淡显）
 *     地下层(19) 三元素龙：地下段实线 + 地表段虚线（淡显）
 * - 方向：沿线按弧长间隔放箭头，指示龙的飞行方向（代替圆点起点）
 * ============================================================ */
(function () {
  'use strict';

  var ROM = window.TOTK_DRAGON_PATHS_ROM || { items: [], depthThreshold: -80 };
  var ITEMS = ROM.items || [];
  /* 兼容旧接口名 */
  window.TOTK_DRAGON_PATHS = ROM;

  /* 分类 catId：与 catalogs.js 里插入的「龙的轨迹」一致 */
  var CAT_ID = { 18: 229, 19: 230, 20: 231 };
  /* 方向箭头间距（游戏单位，米）。
     420m 太密（白龙一圈 79 个箭头，全图糊成一片）；
     900m 时白龙 33 个、元素龙 9~17 个 —— 全图一眼看清走向，
     放大到 z6 单看某一段也有 2~3 个箭头指示方向。 */
  var ARROW_GAP = 900;

  var map = null;
  var group = null;
  var curLayer = 18;
  var ready = false;

  /* ---------- 小工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function currentLayer() {
    if (window.TOTK && window.TOTK.state && window.TOTK.state.layer != null) return window.TOTK.state.layer;
    var active = document.querySelector('#layerSwitch button.active');
    return active ? Number(active.getAttribute('data-layer')) : 18;
  }
  function isOn() {
    var s = window.TOTK && window.TOTK.state;
    if (!s || !s.selected) return false;
    var id = CAT_ID[curLayer];
    return !!(id && s.selected[id]);
  }
  /* 白龙线浅色，配深色描边才看得清 */
  function strokeFor(base) {
    return base === '#e8e6f0' ? 'rgba(40,44,58,0.85)' : 'rgba(20,22,28,0.7)';
  }

  /* ---------- 样式 ---------- */
  /* tooltip 直接复用 app.css 的 .mk-label（与神庙/鸟望台等图标完全一致的横向标签），
     这里只补一点龙专属信息需要的样式。 */
  var CSS = '' +
    '.dlg-arrow{pointer-events:none;}' +
    '.dlg-tip{font-variant-numeric:tabular-nums;}';
  function injectCSS() {
    if (document.getElementById('dragon-layer-css')) return;
    var st = document.createElement('style');
    st.id = 'dragon-layer-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 方向箭头 ---------- */
  /* ang = 顺时针旋转角（屏幕坐标：x 向东为正，y 向南为正；箭头默认朝北） */
  function arrowIcon(color, ang) {
    return L.divIcon({
      className: 'dlg-arrow',
      html: '<svg width="20" height="20" viewBox="0 0 14 14" style="transform:rotate(' + ang + 'deg)">' +
        '<path d="M7 0.5 L12 13 L7 10 L2 13 Z" fill="' + color + '" ' +
        'stroke="rgba(0,0,0,.8)" stroke-width="1.4" stroke-linejoin="round"/></svg>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
  }

  /* 沿线按弧长每 ARROW_GAP 放一个箭头。pts 为 [x,y] 平面坐标 */
  function addArrows(g, d, pts, color) {
    if (!pts || pts.length < 2) return;
    var acc = ARROW_GAP * 0.4;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var dist = Math.sqrt(dx * dx + dy * dy);
      acc += dist;
      if (acc < ARROW_GAP) continue;
      acc = 0;
      /* latlng = (Z, X)；dx 是东西向、dy 是南北向 */
      var ang = Math.atan2(dx, -dy) * 180 / Math.PI;
      L.marker([b[1], b[0]], {
        icon: arrowIcon(color, ang),
        interactive: false,
        keyboard: false
      }).addTo(g);
    }
  }

  /* ---------- 折线 ---------- */
  /* segs: [[x,y],...]；opt.dash 非空则虚线（另一层域，用淡色示意） */
  function drawLine(g, d, segs, opt) {
    if (!segs || segs.length < 2) return;
    var ll = segs.map(function (s) { return [s[1], s[0]]; });
    /* 深色底衬：保证浅色线在浅色瓦片上可读 */
    L.polyline(ll, {
      color: strokeFor(d.color),
      weight: opt.weight + 2.4,
      opacity: 0.4,
      dashArray: opt.dash || null,
      lineCap: 'round', lineJoin: 'round', interactive: false
    }).addTo(g);
    var line = L.polyline(ll, {
      color: opt.color || d.color,
      weight: opt.weight,
      opacity: opt.opacity != null ? opt.opacity : 1,
      dashArray: opt.dash || null,
      lineCap: 'round', lineJoin: 'round'
    }).addTo(g);
    /* 与其他地图图标一致：横向短标签，hover 轨迹即显示 */
    line.bindTooltip(opt.tip || d.name, {
      sticky: true, direction: 'top', className: 'mk-label dlg-tip'
    });
    return line;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!map) return;
    if (group) { map.removeLayer(group); group = null; }
    if (!isOn()) return;

    var g = L.layerGroup();
    var isDepth = curLayer === 19;
    var isSky = curLayer === 20;

    ITEMS.forEach(function (d) {
      /* 白龙只在天空层；三元素龙只在地面层与地下层 */
      if (d.layer === 20) { if (!isSky) return; }
      else { if (isSky) return; }

      var main, ghost;   /* main = 实线（本层域内），ghost = 虚线（另一层） */
      if (isSky) {
        main = [{ segs: d.segments, dash: null, w: 4.2 }];
        ghost = (d.extraRails || []).map(function (e) {
          return { segs: e.segments, dash: e.railName.indexOf('Inter') >= 0 ? '7,6' : '2,8', w: 2.4 };
        });
      } else if (isDepth) {
        main = (d.depthSegs || []).map(function (s) { return { segs: s, dash: null, w: 3.6 }; });
        ghost = (d.groundSegs || []).map(function (s) { return { segs: s, dash: '8,7', w: 2.6 }; });
      } else {
        main = (d.groundSegs || []).map(function (s) { return { segs: s, dash: null, w: 3.8 }; });
        ghost = (d.depthSegs || []).map(function (s) { return { segs: s, dash: '8,7', w: 2.6 }; });
      }

      /* 虚线（另一层域）先画，压在实线下面；用龙的本色但半透明以示"非本层" */
      ghost.forEach(function (s) {
        if (!s.segs || s.segs.length < 2) return;
        drawLine(g, d, s.segs, {
          dash: s.dash, weight: s.w, opacity: 0.42,
          tip: d.name + ' · ' + (isDepth ? '地上段' : '地下段')
        });
      });

      /* 实线（本层域内）+ 方向箭头 */
      main.forEach(function (s) {
        if (!s.segs || s.segs.length < 2) return;
        drawLine(g, d, s.segs, { dash: null, weight: s.w, opacity: 1 });
        addArrows(g, d, s.segs, d.color);
      });
    });

    g.addTo(map);
    group = g;
  }

  /* ---------- 监听：分类选中状态 ---------- */
  /* app.js 的 switchLayer() 会调 selectDefault() 重置 state.selected，
     所以这里记住"用户是否开启了龙的轨迹"，切层后自动把该层分类项补勾上，
     实现"一个开关"跨层生效（否则每切一层都要重新点）。

     判定"用户意图"不能只看 selected 的边沿 —— 切层重置和用户点击
     产生的都是 true→false，边沿区分不了。
     改为直接监听分类项的 DOM 点击事件（事件捕获阶段，能抢在 app.js 之前）：
       点到「龙的轨迹」→ 明确是用户操作，记录意图，不再自动补勾
       切层导致的重置 → 没有任何点击，按 userOn 补勾。 */
  var userOn = false;
  var lastSig = '';

  function signature() {
    return curLayer + '|' + (isOn() ? '1' : '0');
  }

  function ensureChecked() {
    if (!userOn) return;
    var s = window.TOTK && window.TOTK.state;
    var id = CAT_ID[curLayer];
    if (!s || !id || s.selected[id]) return;
    s.selected[id] = true;
    var el = document.querySelector('#catalogList .cat-item[data-cat="' + id + '"]');
    if (el) el.classList.add('active');
  }

  function tick() {
    if (!ready) return;
    ensureChecked();
    var sig = signature();
    if (sig !== lastSig) { lastSig = sig; render(); }
  }

  /* 用户点了「龙的轨迹」分类项 —— 明确意图，之后不自动补勾 */
  function onUserToggle(e) {
    var el = e.target && e.target.closest && e.target.closest('#catalogList .cat-item');
    if (!el) return;
    var id = Number(el.getAttribute('data-cat'));
    if (!id || CAT_ID[curLayer] !== id) return;
    /* 事件在 app.js 的 handler 之前跑（捕获阶段），此时还没翻转状态，
       所以延后一拍再读，读到的就是点击后的真实状态 */
    setTimeout(function () { userOn = isOn(); tick(); }, 0);
  }

  function observeState() {
    document.addEventListener('click', onUserToggle, true);
    /* app.js 每次切层会重建整个 .cat-item 列表（innerHTML 替换），
       事件委托到 document 上才不会失效。
       状态本身用轮询兜底读取（app.js 改的是普通对象，没有 change 事件）。 */
    setInterval(tick, 120);
  }

  function observeLayer() {
    var sw = document.getElementById('layerSwitch');
    if (!sw) return;
    var obs = new MutationObserver(function () {
      var l = currentLayer();
      if (l !== curLayer) {
        curLayer = l;
        tick();   /* ensureChecked 会按 userOn 自动补勾该层的龙轨迹分类 */
      }
    });
    obs.observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    map = (window.TOTK && window.TOTK.map) || null;
    if (!map) { setTimeout(init, 300); return; }
    curLayer = currentLayer();
    /* 若上次会话在当前层勾过龙轨迹（app.js 会把 selected 存 localStorage），先记住意图 */
    userOn = isOn();
    lastSig = signature();
    injectCSS();
    observeLayer();
    observeState();
    render();
    ready = true;

    window.DragonLayer = {
      render: render,
      isVisible: isOn,
      items: ITEMS
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
