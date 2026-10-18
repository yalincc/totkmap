/* ============================================================
 * 克洛格运输轨迹图层（TOTKMAP V2.5 · 独立模块）
 * ------------------------------------------------------------
 * - 参考 BOTWmap korok_paths.js 轨迹设计
 * - 完全独立于 app.js：仅依赖 window.TOTK.map / window.TOTK.state
 * - 数据来源：app/data/korok_paths.js（ROM 官方 Link 提取的 100 对起始点与朋友营地）
 * - 联动机制：
 *     地上层(18)：勾选「双呀哈哈」(cat 130) 时自动绘制 98 条虚线轨迹 + 朋友营地标记
 *     天空层(20)：勾选「双呀哈哈」(cat 160) 时自动绘制 2 条虚线轨迹 + 朋友营地标记
 *     完成状态：跟随已完成过滤/隐藏设置，点击线段或营地标记可直接唤起详情卡
 * ============================================================ */
(function () {
  'use strict';

  var PATHS = (window.TOTK_KOROK_PATHS && window.TOTK_KOROK_PATHS.items) || [];
  var CAT_ID = { 18: 130, 20: 160 };

  var map = null;
  var group = null;
  var curLayer = 18;
  var ready = false;
  var lastSig = '';

  /* ---------- 工具函数 ---------- */
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

  function findMarkerById(id) {
    var markers = window.TOTK_MARKERS || [];
    for (var i = 0; i < markers.length; i++) {
      if (markers[i].id === id) return markers[i];
    }
    return null;
  }

  /* ---------- 样式注入 ---------- */
  var CSS = '' +
    '.korok-camp-pin{cursor:pointer;transition:transform .15s ease;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));}' +
    '.korok-camp-pin:hover{transform:scale(1.25);z-index:999!important;}' +
    '.korok-camp-pin.done{opacity:0.45;filter:grayscale(60%);}' +
    '.korok-path-line{cursor:pointer;}';

  function injectCSS() {
    if (document.getElementById('korok-layer-css')) return;
    var st = document.createElement('style');
    st.id = 'korok-layer-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ---------- 营地图标 ---------- */
  function campIcon(isDone) {
    var sz = (window.TOTK_GET_TIER_SIZE && window.TOTK_GET_TIER_SIZE('T3')) || 24;
    var half = Math.round(sz / 2);
    return L.icon({
      iconUrl: 'assets/icons/korok_camp_target.png',
      iconSize: [sz, sz],
      iconAnchor: [half, half],
      className: 'korok-camp-pin' + (isDone ? ' done' : '')
    });
  }

  /* ---------- 渲染轨迹与营地 ---------- */
  function render() {
    if (!map) return;
    if (group) { map.removeLayer(group); group = null; }
    if (!isOn() || !PATHS.length) return;

    var g = L.layerGroup();
    var s = window.TOTK && window.TOTK.state;
    var settings = window.TOTK_SETTINGS || {};
    var filter = s ? s.filter : 'all';

    PATHS.forEach(function (p) {
      if (p.layer !== curLayer) return;

      var isDone = !!(s && s.done && s.done[p.id]);
      var hideKorok = (settings.doneMode === 'hide' && (!settings.hideDoneTypes || settings.hideDoneTypes.korok !== false));
      if (isDone && hideKorok) return;
      if (filter === 'done' && !isDone) return;
      if (filter === 'undone' && isDone) return;

      var pts = p.path; // [[start_z, start_x], [goal_z, goal_x]]
      if (!pts || pts.length < 2) return;

      var lineColor = isDone ? '#27ae60' : '#F4D03F';
      var opacity = isDone ? 0.6 : 0.95;

      // 1. 深色半透明描边底层，保证不同底图上可读
      L.polyline(pts, {
        color: 'rgba(15,20,15,0.85)',
        weight: 5,
        opacity: 0.65,
        dashArray: '6, 8',
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(g);

      // 2. 亮色虚线主体
      var line = L.polyline(pts, {
        color: lineColor,
        weight: 2.8,
        opacity: opacity,
        dashArray: '6, 8',
        lineCap: 'round',
        lineJoin: 'round',
        className: 'korok-path-line',
        interactive: true
      }).addTo(g);

      line.bindTooltip((isDone ? '✓ ' : '') + '运送呀哈哈 · 直线距离约 ' + p.dist + 'm', {
        direction: 'top',
        className: 'mk-label' + (isDone ? ' done-label' : '')
      });

      (function (pid) {
        line.on('click', function (e) {
          var m = findMarkerById(pid);
          if (m && window.TOTK && window.TOTK.openDetail) {
            window.TOTK.openDetail(m, e);
          }
        });
      })(p.id);

      // 3. 终点：朋友营地标记
      var goalPt = [p.goal[0], p.goal[1]];
      var camp = L.marker(goalPt, {
        icon: campIcon(isDone),
        interactive: true,
        riseOnHover: true
      }).addTo(g);

      camp.bindTooltip((isDone ? '✓ ' : '') + '朋友的营地（运送终点）', {
        direction: 'top',
        offset: [0, -12],
        className: 'mk-label' + (isDone ? ' done-label' : '')
      });

      (function (pid) {
        camp.on('click', function (e) {
          var m = findMarkerById(pid);
          if (m && window.TOTK && window.TOTK.openDetail) {
            window.TOTK.openDetail(m, e);
          }
        });
      })(p.id);
    });

    g.addTo(map);
    group = g;
  }

  /* ---------- 监听与生命周期 ---------- */
  function signature() {
    var s = window.TOTK && window.TOTK.state;
    var filter = s ? s.filter : 'all';
    var doneCount = (s && s.done) ? Object.keys(s.done).length : 0;
    var settings = window.TOTK_SETTINGS || {};
    var doneMode = settings.doneMode || 'default';
    var hideKorok = (settings.hideDoneTypes && settings.hideDoneTypes.korok !== false) ? '1' : '0';
    var z = map ? map.getZoom() : 5;
    return curLayer + '|' + (isOn() ? '1' : '0') + '|' + filter + '|' + doneCount + '|' + doneMode + '|' + hideKorok + '|' + z;
  }

  function tick() {
    if (!ready) return;
    var sig = signature();
    if (sig !== lastSig) {
      lastSig = sig;
      render();
    }
  }

  function observeLayer() {
    var sw = document.getElementById('layerSwitch');
    if (!sw) return;
    var obs = new MutationObserver(function () {
      var l = currentLayer();
      if (l !== curLayer) {
        curLayer = l;
        tick();
      }
    });
    obs.observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  function init() {
    map = (window.TOTK && window.TOTK.map) || null;
    if (!map) {
      setTimeout(init, 300);
      return;
    }
    curLayer = currentLayer();
    injectCSS();
    observeLayer();
    setInterval(tick, 150);
    render();
    ready = true;

    window.KorokPathLayer = {
      render: render,
      isVisible: isOn,
      paths: PATHS
    };
    window.KorokLayer = window.KorokPathLayer;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

