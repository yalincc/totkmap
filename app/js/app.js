/* ============================================================
   TOTKMAP · 塞尔达传说：王国之泪 互动地图
   复刻游民星空互动地图交互：图层切换 / 分类筛选 / 完成状态 /
   区域定位 / 搜索 / 详情弹窗 / 自定义标点
   ============================================================ */
(function () {
  'use strict';

  var LAYERS = window.TOTK_LAYERS || [];
  var CATALOGS = window.TOTK_CATALOGS || [];
  var AREAS = window.TOTK_AREAS || [];
  var MARKERS = window.TOTK_MARKERS || [];
  var AREA_CAVE = window.TOTK_AREA_CAVE || [];
  var AREA_SKY = window.TOTK_AREA_SKY || [];
  var AREA_DEPTHS = window.TOTK_AREA_DEPTHS || [];

  var VERSION = 'TOTKMAP V2.1';
  var LS_DONE = 'totkmap_done_v1';
  var LS_CUSTOM = 'totkmap_custom_v1';
  var LS_LAYER = 'totkmap_layer_v1';
  var LS_NAMES = 'totkmap_names_v1';
  var LS_SAVE = 'totkmap_save_v1';
  var LS_AREA = 'totkmap_area_v1';
  var LS_SELECTED = 'totkmap_selected_v2';   // 各层选中的分类（按层存，切层/刷新均保持）

  var LAYER_KEY = { 18: 'ground', 19: 'depths', 20: 'sky' };
  var LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' };
  var GROUP_NAME = { 1: '位置', 2: '收集', 3: '装备', 4: '地点', 5: '怪物' };
  var GROUP_ORDER = [1, 2, 3, 4, 5];

  var LABEL_MIN_ZOOM = 4;   // 名称标签显示的最低缩放级别
  var MAX_ZOOM = 7;   // V1.9.0: z7 尺寸由 z6 瓦片 2× 自动缩放实现（maxNativeZoom=6 保持不变），材料聚合 maxZoom 同步 7
  var MIN_ZOOM = 3;

  var state = {
    layer: 18,
    selected: {},          // 当前层选中的分类 catalogId -> true（是 selectedByLayer[layer] 的引用）
    selectedByLayer: {},   // layerId -> {catalogId:true} 各层独立的分类选择，跨切层/刷新保持
    done: {},              // markerId -> true（已完成）
    custom: [],            // 自定义标点 [{id,name,desc,x,y,layer}]
    filter: 'all',         // all | done | undone
    showNames: true,
    adding: false,         // 放置自定义标点模式
    groups: {},            // catalogId -> L.LayerGroup
    markers: {},           // markerId -> L.Marker
    customMarks: [],       // 自定义标点 L.Marker
    matExpanded: {},       // V1.9.0: z7 已展开的聚合（mid -> {clusterId:true}），展开后渲染为单点
    areaMarks: [],         // 区域名 L.Marker
    current: null,
    lastSearch: [],
    save: null,            // 存档同步结果 {分类名: {done, total}} 或 null
    saveVersion: null,     // 存档版本（如 v1.1.x/v1.2.x）
    areaOn: false,         // 区域轮廓总开关
    areaLayers: {}         // {current: L.LayerGroup}
  };

  /* ---------------- 工具 ---------------- */
  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadJson(key, def) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ---------------- 数据访问 ---------------- */
  function catsOfLayer(layerId) {
    return CATALOGS.filter(function (c) {
      return c.layer === layerId && c.name && c.name !== '未命名' && (c.count || 0) > 0;
    });
  }
  function catById(layerId, id) {
    for (var i = 0; i < CATALOGS.length; i++) {
      var c = CATALOGS[i];
      if (c.layer === layerId && c.id === id) return c;
    }
    return null;
  }
  function countDone(catId) {
    var n = 0;
    for (var i = 0; i < MARKERS.length; i++) {
      var m = MARKERS[i];
      if (m.layer === state.layer && m.cat === catId && state.done[m.id]) n++;
    }
    return n;
  }

  /* ---------------- 地图初始化 ---------------- */
  // objmap-totk（zeldamods.org）坐标系：游戏内坐标 X∈[-6000,6000]（东向）、Z∈[-5000,5000]（北为负）。
  // Leaflet latlng = (Z, X)；CRS = CRS.Simple + 站点原版 transformation（scale = 2^zoom）。
  // 瓦片网格 z3=6x5 z4=12x10 z5=24x20 z6=47x40 z7=94x79，与 24000x20000 原图（z7）逐级 1/2 吻合。
  var TOTK_CRS = L.Util.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(4 / 256, 24000 / 256, 4 / 256, 20000 / 256)
  });
  var TILE_BOX = L.latLngBounds([-5000, -6000], [5000, 6000]);
  var CENTER = [-140.80, -298.54]; // 监视堡垒（游戏坐标）

  var map = L.map('map', {
    crs: TOTK_CRS,
    center: CENTER,
    zoom: 5,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0.5,
    wheelPxPerZoomLevel: 140,
    doubleClickZoom: false,
    maxBounds: TILE_BOX,          // 限制地图不可平移出界（V1.7.2）
    maxBoundsViscosity: 1.0       // 拖动到边缘平滑停在边界
  });

  /* 右下角缩放控件（百分比 / ＋－ / 全图 / 定位，参考 BOTWmap #zoomControls） */
  function updateZoomPct() {
    var el = $('zoomPct');
    if (!el) return;
    var z = map.getZoom();
    el.textContent = Math.round(Math.pow(2, z - MIN_ZOOM) * 100) + '%';
  }
  $('zoomIn').addEventListener('click', function () { map.zoomIn(); });
  $('zoomOut').addEventListener('click', function () { map.zoomOut(); });
  $('zoomFit').addEventListener('click', function () {
    map.fitBounds(TILE_BOX, { animate: true });
    toast('已回到全图');
  });
  $('zoomLocate').addEventListener('click', function () {
    // V1.8.3: 实时服务在线时「定位 + 开关视图跟随」；离线回监视堡垒
    if (window.LIVENAV && LIVENAV.online()) {
      LIVENAV.toggleFollow();
      return;
    }
    map.flyTo(CENTER, 5, { duration: 0.6 });
    toast('已定位到监视堡垒（导航后续接入）');
  });
  map.on('zoomend moveend', updateZoomPct);
  updateZoomPct();

  var tileLayer = null;
  /* V1.8.0 瓦片优化: z3/z4 已转 WebP q80(23.9MB->1.9MB), z5+ 仍是 PNG —— 按缩放级选扩展名 */
  var TotkTileLayer = L.TileLayer.extend({
    getTileUrl: function (coords) {
      var ext = (coords.z <= 4) ? 'webp' : 'png';
      return this._url.replace('{z}', coords.z).replace('{x}', coords.x)
        .replace('{y}', coords.y).replace('{ext}', ext);
    }
  });
  function setTileLayer(layerId) {
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = new TotkTileLayer('tiles_obj/' + LAYER_KEY[layerId] + '/{z}/{x}_{y}.{ext}', {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 6,   // V1.9.0: 保持 6 —— 地图放大到 z7 时自动请求 z6 瓦片并 2× 缩放（z7 尺寸，无需 z7 瓦片）
      tileSize: 256,
      noWrap: true,
      bounds: TILE_BOX,
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    });
    tileLayer.addTo(map);
  }

  /* ---------------- 完成状态 ---------------- */
  function loadDone() { state.done = loadJson(LS_DONE, {}); }
  function saveDone() { saveJson(LS_DONE, state.done); }

  /* ---------------- 分类面板 ---------------- */
  function buildCatalogPanel() {
    var list = $('catalogList');
    var cats = catsOfLayer(state.layer);
    var groups = {};
    // 各层 groupIndex 基准不同（layer20 从 0 起，其余从 1 起），
    // 按相对顺序映射到标准分组名
    function gidx(c) {
      return (c.groupIndex === undefined || c.groupIndex === null) ? 1 : c.groupIndex;
    }
    var relIdx = [];
    cats.forEach(function (c) {
      var g = gidx(c);
      if (relIdx.indexOf(g) < 0) relIdx.push(g);
    });
    relIdx.sort(function (a, b) { return a - b; });
    /* ★ V2.1 M0：分组标题优先读分类自带的 groupCn，不再靠「第几组」猜名字。
     *
     * 旧逻辑（已移除）是把该层出现过的 groupIndex 排序后，按下标去
     * GROUP_ORDER 里取名字 —— 也就是「第 1 组叫位置、第 2 组叫收集」。
     * 只要往中间插入一个新组，或某个 count>0 的分类落进中间，
     * 整层标题就会整体错位（玩家会看到「装备」下面写着「克洛格」）。
     *
     * 现在 groupCn 由 tools/add_group_cn.py 按 (layer, groupIndex) 写入，
     * 且脚本内置「与旧渲染逐条比对」的回归校验，保证显示结果零变化。
     * 下面的按下标推断保留作兜底，老数据（没有 groupCn）仍能正常显示。
     */
    var groupName = {};
    var byIndex = {};
    cats.forEach(function (c) { byIndex[gidx(c)] = c; });
    relIdx.forEach(function (g, i) {
      var explicit = byIndex[g] && byIndex[g].groupCn;
      groupName[g] = explicit || GROUP_NAME[GROUP_ORDER[i]] || '其他';
    });

    cats.forEach(function (c) {
      var g = gidx(c);
      if (!groups[g]) groups[g] = [];
      groups[g].push(c);
    });

    var html = '';
    relIdx.forEach(function (g) {
      var cs = groups[g];
      if (!cs || !cs.length) return;
      html += '<div class="group-title">' + esc(groupName[g]) + '</div>';
      html += '<div class="cat-grid">';
      cs.forEach(function (c) {
        var on = state.selected[c.id] ? ' active' : '';
        // 计数显示：有存档同步数据时显示「已完成/总数」，否则按 gamersky 方式只显示总数
        // gamersky 式：分类列表只显示该分类标点总数，进度统一看「探索度」
        var countText = String(c.count);
        html += '<div class="cat-item' + on + '" data-cat="' + c.id + '">' +
          (c.icon ? '<img src="assets/icons/' + esc(c.icon) + '" alt="">' : '<img src="assets/icons/origin_3845393_70484.png" alt="">') +
          '<span class="cat-name">' + esc(c.name) + '</span>' +
          '<span class="cat-count">' + esc(countText) + '</span>' +
          '</div>';
      });
      html += '</div>';
    });
    if (!html) html = '<div class="sr-empty">当前图层暂无标点分类</div>';
    list.innerHTML = html;

    Array.prototype.forEach.call(list.querySelectorAll('.cat-item'), function (el) {
      el.addEventListener('click', function () {
        var id = Number(el.getAttribute('data-cat'));
        if (state.selected[id]) delete state.selected[id];
        else state.selected[id] = true;
        el.classList.toggle('active');
        saveSelected();          // 按层落盘，切层/刷新后仍保持
        renderMarkers();
        updateCount();
      });
    });
  }

  /* ---------------- 分类选择（按层保持） ----------------
   * 背景：原先 state.selected 是单一对象，switchLayer() 每次切层都调 selectDefault()
   *   把它清空重建 → 用户在「地上」勾的驿站/村庄，切到地下再切回来就没了。
   * 现在：state.selectedByLayer[layer] 各层独立保存，切层时恢复本层选择；
   *   本层从未选过才回退到默认分类。state.selected 始终指向当前层那份，
   *   渲染逻辑（renderMarkers / buildCatalogPanel 等）无需改动。
   * 同时落盘 localStorage，刷新页面也保持。 */
  function saveSelected() { saveJson(LS_SELECTED, state.selectedByLayer); }
  function loadSelected() {
    state.selectedByLayer = loadJson(LS_SELECTED, {}) || {};
  }
  /* 保证 state.selected 指向当前层的对象（首次时建空对象） */
  function bindSelected() {
    var l = state.layer;
    if (!state.selectedByLayer[l]) state.selectedByLayer[l] = {};
    state.selected = state.selectedByLayer[l];
  }
  /* 该层是否已经由用户选过（区别于"默认兜底"） */
  function hasUserSelection(l) {
    return !!(state.selectedByLayer[l] && Object.keys(state.selectedByLayer[l]).length);
  }

  function selectDefault() {
    bindSelected();
    if (hasUserSelection(state.layer)) return;   // 已有本层选择，原样恢复
    var def = { 18: [62, 63, 74], 19: [86, 87, 97], 20: [108, 109, 110] };
    var list = def[state.layer] || [];
    catsOfLayer(state.layer).forEach(function (c) {
      if (list.indexOf(c.id) >= 0) state.selected[c.id] = true;
    });
    if (!Object.keys(state.selected).length) {
      // 兜底：默认选中每层前 3 个分类
      catsOfLayer(state.layer).slice(0, 3).forEach(function (c) { state.selected[c.id] = true; });
    }
    saveSelected();
  }

  function updateCount() {
    var total = 0, done = 0;
    for (var i = 0; i < MARKERS.length; i++) {
      var m = MARKERS[i];
      if (m.layer !== state.layer || !state.selected[m.cat]) continue;
      total++;
      if (state.done[m.id]) done++;
    }
    var cl = $('countLabel');
    if (cl) cl.textContent = '已显示 ' + total + ' 个标点 · 已完成 ' + done;
  }

  /* ---------------- 标记渲染 ---------------- */
  var iconCache = {};
  function iconFor(cat) {
    if (!cat || !cat.icon) return null;
    if (!iconCache[cat.icon]) {
      iconCache[cat.icon] = L.icon({
        iconUrl: 'assets/icons/' + cat.icon,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -10]
      });
    }
    return iconCache[cat.icon];
  }
  /* V1.9.3 完成标记：图标本体 100% 清晰 + 右上角绿色小勾（参考游戏内洞穴「已拿魔犹伊遗失物」打勾，
   * 统一语义：已标记完成 = 右上角打勾）。divIcon 仅用于完成点，未完成仍用 L.icon，无性能负担 */
  var doneIconCache = {};
  function doneIconFor(cat) {
    if (!cat || !cat.icon) return null;
    if (!doneIconCache[cat.icon]) {
      doneIconCache[cat.icon] = L.divIcon({
        className: 'mk-done-icon',
        html: '<img src="assets/icons/' + cat.icon + '" width="22" height="22" alt="">' +
              '<span class="mk-done-check">✓</span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -10]
      });
    }
    return doneIconCache[cat.icon];
  }

  function renderMarkers() {
    Object.keys(state.groups).forEach(function (k) {
      if (map.hasLayer(state.groups[k])) map.removeLayer(state.groups[k]);
    });
    state.groups = {};
    state.markers = {};

    var cats = {};
    catsOfLayer(state.layer).forEach(function (c) { cats[c.id] = c; });

    MARKERS.forEach(function (m) {
      if (m.layer !== state.layer) return;
      if (!state.selected[m.cat]) return;
      var isDone = !!state.done[m.id];
      if (state.filter === 'done' && !isDone) return;
      if (state.filter === 'undone' && isDone) return;

      var cat = cats[m.cat];
      /* V1.9.3 完成标记：完成点用带右上角绿勾的 divIcon，未完成保持原 L.icon */
      var icon = isDone ? doneIconFor(cat) : iconFor(cat);
      var opt = { riseOnHover: true };
      if (icon) opt.icon = icon;
      var mk = L.marker([m.x, m.y], opt);
      mk.bindTooltip((isDone ? '✓ ' : '') + (m.name || m.full), {
        direction: 'top',
        offset: [0, -12],
        className: 'mk-label' + (isDone ? ' done-label' : '')
      });
      (function (mm) {
        mk.on('click', function (e) { openDetail(mm, e); });
      })(m);

      if (!state.groups[m.cat]) state.groups[m.cat] = L.layerGroup();
      state.groups[m.cat].addLayer(mk);
      state.markers[m.id] = mk;
    });

    Object.keys(state.groups).forEach(function (k) { state.groups[k].addTo(map); });
    renderCustomMarks();
    refreshLabels();
  }

  // 视口内名称标签：缩放级别足够且开启名称时显示
  function refreshLabels() {
    var z = map.getZoom();
    var bounds = map.getBounds();
    for (var id in state.markers) {
      var mk = state.markers[id];
      if (!mk) continue;
      var show = state.showNames && z >= LABEL_MIN_ZOOM && bounds.contains(mk.getLatLng());
      if (show) { if (!mk.isTooltipOpen()) mk.openTooltip(); }
      else { if (mk.isTooltipOpen()) mk.closeTooltip(); }
    }
  }

  /* ---------------- 自定义标点 ---------------- */
  var customIcon = L.divIcon({
    className: '',
    html: '<div style="width:22px;height:22px;border-radius:50%;background:#f0a020;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:700;">★</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 22]
  });

  function renderCustomMarks() {
    state.customMarks.forEach(function (c) { map.removeLayer(c.mk); });
    state.customMarks = [];
    state.custom.forEach(function (c) {
      if (c.layer !== state.layer) return;
      var mk = L.marker([c.x, c.y], { icon: customIcon, riseOnHover: true });
      mk.bindTooltip(c.name, { direction: 'top', offset: [0, -20], className: 'mk-label' });
      mk.on('click', function () { openCustomDetail(c); });
      mk.addTo(map);
      state.customMarks.push({ mk: mk, c: c });
    });
  }

  // 旧版(V1.4.0/1.4.1)自定义标点存的是错误换算坐标（x∈[-240,0], y∈[0,288]），
  // 加载时还原 gamersky 坐标再仿射到 objmap 游戏坐标，一次性迁移。
  function loadCustom() {
    state.custom = loadJson(LS_CUSTOM, []);
    state.custom = state.custom.map(function (c) {
      if (c.x >= -240 && c.x <= 0 && c.y >= 0 && c.y <= 288) {
        var gx = c.x * 288 / 240, gy = c.y;
        c.x = Math.round((-42.6811380353599 * gx - 7050.60856084442) * 100) / 100;
        c.y = Math.round((42.6842804369353 * gy - 6258.74590297329) * 100) / 100;
      }
      return c;
    });
  }
  function saveCustom() { saveJson(LS_CUSTOM, state.custom); }

  /* ---------------- 区域名 ---------------- */
  function renderAreas() {
    state.areaMarks.forEach(function (a) { map.removeLayer(a.mk); });
    state.areaMarks = [];
    for (var i = 0; i < AREAS.length; i++) {
      var a = AREAS[i];
      if (a.layer !== state.layer || !a.name) continue;
      var vis = a.visible ? String(a.visible).split(',').map(Number) : null;
      var mk = L.marker([a.x, a.y], {
        interactive: false,
        icon: L.divIcon({
          className: 'area-label',
          html: '<div class="area-label-wrap"><div class="area-label-inner" data-prio="' + (a.prio || 5) + '">' + esc(a.name) + '</div></div>',
          iconSize: [0, 0]
        })
      });
      mk._vis = vis;
      mk._size = a.size || 14;
      state.areaMarks.push({ mk: mk, vis: vis, size: a.size || 14 });
    }
    updateAreas();
  }

  function updateAreas() {
    var z = Math.round(map.getZoom());
    for (var i = 0; i < state.areaMarks.length; i++) {
      var a = state.areaMarks[i];
      var show = !a.vis || a.vis.indexOf(z) >= 0;
      if (show && !map.hasLayer(a.mk)) a.mk.addTo(map);
      else if (!show && map.hasLayer(a.mk)) map.removeLayer(a.mk);
      if (show) {
        var el = a.mk.getElement();
        if (el) el.style.fontSize = Math.max(11, a.size * (0.5 + z * 0.13)) + 'px';
      }
    }
  }

  /* 标签防重叠：同缩放级别内重叠的低优先级标签做偏移，偏移失败则隐藏 */
  function avoidOverlap() {
    var els = [], vw = window.innerWidth, vh = window.innerHeight;
    document.querySelectorAll('.area-label').forEach(function (el) {
      var inner = el.querySelector('.area-label-inner');
      if (!inner) return;
      inner.style.transform = '';
      inner.style.display = '';
      var r = inner.getBoundingClientRect();
      if (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) return;
      var prio = parseInt(inner.getAttribute('data-prio') || '5', 10);
      els.push({ r: r, inner: inner, prio: prio });
    });
    els.sort(function (a, b) { return a.prio - b.prio; });
    var tries = [[0,0],[0,-16],[0,16],[-32,0],[32,0],[0,-32],[0,32],[-16,16],[16,16],[-16,-16],[16,-16],[-48,0],[48,0],[0,-48],[0,48],[-48,-16],[48,-16],[-48,16],[48,16],[-64,0],[64,0],[0,-64],[0,64],[-80,0],[80,0]];
    var placed = [];
    for (var i = 0; i < els.length; i++) {
      var cur = els[i], ok = null;
      for (var t = 0; t < tries.length && !ok; t++) {
        var dx = tries[t][0], dy = tries[t][1];
        var nb = { x: cur.r.left + dx, y: cur.r.top + dy, w: cur.r.width, h: cur.r.height };
        var hit = false;
        for (var p = 0; p < placed.length; p++) {
          var pb = placed[p];
          if (nb.x < pb.x + pb.w && nb.x + nb.w > pb.x && nb.y < pb.y + pb.h && nb.y + nb.h > pb.y) { hit = true; break; }
        }
        if (!hit) ok = { dx: dx, dy: dy };
      }
      if (ok) {
        if (ok.dx || ok.dy) cur.inner.style.transform = 'translate(' + ok.dx + 'px,' + ok.dy + 'px)';
        placed.push({ x: cur.r.left + ok.dx, y: cur.r.top + ok.dy, w: cur.r.width, h: cur.r.height });
      } else {
        cur.inner.style.display = 'none';
      }
    }
  }

  /* ---------------- 详情弹窗 ---------------- */
  function stripHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent || d.innerText || '';
  }

  /* 详情卡片定位：锚定点击位置附近（参考 BOTWmap positionCard：锚点右侧优先，
     放不下转左侧，避让左侧面板；手机用底部抽屉，位置交给 CSS） */
  function positionDetail(ev) {
    var card = $('detail');
    if (!card) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (vw <= 720) {
      card.style.left = ''; card.style.top = '';
      card.style.right = ''; card.style.bottom = '';
      card.style.maxHeight = ''; card.style.overflowY = '';
      return;
    }
    var guard = 366;   // 左侧面板 352 + 间距
    var ax = guard + 200, ay = vh * 0.45;
    if (ev && typeof ev.clientX === 'number') { ax = ev.clientX; ay = ev.clientY; }
    var cw = card.offsetWidth || 300;
    var ch = Math.min(card.offsetHeight || 320, vh * 0.7);
    var left = ax + 20;                                   // 锚点右侧
    var top = ay - ch / 2;                                // 纵向居中于锚点
    if (left + cw > vw - 10) left = ax - cw - 20;         // 放不下 → 锚点左侧
    left = Math.max(guard, Math.min(left, vw - cw - 10));
    top = Math.max(10, Math.min(top, vh - 90));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  /* 详情卡片拖拽（按住头部移动，参考 BOTWmap initCardDrag） */
  function initCardDrag() {
    var card = $('detail');
    var head = $('detailHead');
    if (!head) return;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function down(e) {
      if (e.target.closest && e.target.closest('.detail-close')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = card.offsetLeft; oy = card.offsetTop;
    }
    function move(e) {
      if (!dragging) return;
      var left = Math.max(0, Math.min(ox + e.clientX - sx, window.innerWidth - card.offsetWidth));
      var top = Math.max(0, Math.min(oy + e.clientY - sy, window.innerHeight - 60));
      card.style.left = left + 'px';
      card.style.top = top + 'px';
    }
    function up() { dragging = false; }
    head.addEventListener('mousedown', down);
    head.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches[0]) down(e.touches[0]);
    }, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches[0]) move(e.touches[0]);
    }, { passive: true });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  }

  /* 详情卡片（克洛格卡式纵向结构）
     opts: {name, cat, desc, isDone, onDone, img, region, coord, posText, usage, collected, onNav, onCollect, evt}
     材料卡片带 img/region/coord/posText/usage/导航/收集；探索标点只有 name/cat/desc/标记完成 */
  function showDetail(opts) {
    $('detailName').textContent = opts.name;
    $('detailChip').textContent = opts.cat || '';
    $('detailDesc').textContent = stripHtml(opts.desc || '') || '暂无说明。';
    var isMat = !!(opts.img || opts.onNav);
    var meta = $('detailMeta'), img = $('detailImg'), uRow = $('detailUsageRow');
    var nav = $('detailNav'), col = $('detailCollect'), body = $('detailDesc');
    if (isMat) {
      img.src = opts.img; img.style.display = '';
      $('detailRegion').textContent = opts.region || '';
      $('detailCoord').textContent = opts.coord || '';
      $('detailPos').textContent = opts.posText || '';
      $('detailUsage').textContent = opts.usage || '';
      meta.style.display = ''; uRow.style.display = '';
      nav.style.display = ''; col.style.display = '';
      nav.onclick = opts.onNav || null;
      col.onclick = opts.onCollect || null;
      col.textContent = opts.colBtn || (opts.collected ? '已收集' : '收集');
      body.parentElement.style.display = 'none';
    } else {
      meta.style.display = 'none'; img.style.display = 'none'; uRow.style.display = 'none';
      // V1.8.0: 探索标点/自定义标点也显示「导航」按钮
      nav.style.display = ''; col.style.display = 'none';
      nav.onclick = opts.onNav || null;
      body.parentElement.style.display = '';
    }
    /* V1.8.0: 导航按钮初始文案（该目标导航中 → 停止导航） */
    nav.textContent = '导航';
    if (opts.navTarget && window.LIVENAV && LIVENAV.currentTarget) {
      var _cur = LIVENAV.currentTarget();
      if (_cur && _cur.x === opts.navTarget.x && _cur.y === opts.navTarget.y) nav.textContent = '停止导航';
    }
    var btn = $('detailDone');
    if (opts.onDone) {
      btn.style.display = '';
      btn.textContent = opts.isDone ? '取消完成' : '标记完成';
      btn.className = 'btn primary' + (opts.isDone ? ' done' : '');
      btn.onclick = opts.onDone;
    } else {
      btn.style.display = 'none';
    }
    /* 查看图鉴（联动 totk-site 图鉴站）：opts.compendium 为跳转 URL，无则隐藏 */
    var comp = $('detailComp');
    if (comp) {
      if (opts.compendium) {
        comp.style.display = '';
        comp.onclick = function () { window.open(opts.compendium, '_blank'); };
      } else {
        comp.style.display = 'none';
        comp.onclick = null;
      }
    }
    var card = $('detail');
    var wasHidden = card.classList.contains('hidden');
    card.classList.remove('hidden');
    if (wasHidden || opts.evt) positionDetail(opts.evt && opts.evt.originalEvent || null);
  }

  /* V1.8.0 M3: 探索标点 → 独立探索卡片（与材料卡片完全分离，不共用模板/无图） */
  function openDetail(m, evt) {
    state.current = m;
    var cat = catById(state.layer, m.cat);
    showExploreCard({
      name: m.name || m.full,
      cat: cat ? cat.name : '未知分类',
      desc: m.desc || '',
      m: m,
      isDone: !!state.done[m.id],
      evt: evt
    });
  }

  function openCustomDetail(c) {
    state.current = c;
    showExploreCard({
      name: c.name,
      cat: '自定义标点 · ' + LAYER_NAME[state.layer],
      desc: c.desc || '暂无说明。',
      m: { id: c.id, x: c.x, y: c.y, layer: c.layer, name: c.name },
      isDone: false,
      custom: true,
      evt: null
    });
  }

  $('detailClose').addEventListener('click', function () {
    $('detail').classList.add('hidden');
    state.current = null;
  });
  initCardDrag();
  /* 材料卡片图标点击 -> 查看 256px 原图（克洛格卡「查看原图」同款） */
  $('detailImg').addEventListener('click', function () {
    var src = this.src;
    if (!src) return;
    $('imgPreviewImg').src = src;
    $('imgPreview').classList.remove('hidden');
  });
  $('imgPreview').addEventListener('click', function () {
    this.classList.add('hidden');
  });

  /* ---------------- 搜索 ---------------- */
  var searchTimer = null;
  $('searchInput').addEventListener('input', function () {
    var q = this.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) { $('searchResult').classList.add('hidden'); return; }
    searchTimer = setTimeout(function () { doSearch(q); }, 220);
  });

  function doSearch(q) {
    var ql = q.toLowerCase();
    var hits = [];
    for (var i = 0; i < MARKERS.length; i++) {
      var m = MARKERS[i];
      if (m.layer !== state.layer) continue;
      var hay = ((m.name || '') + ' ' + (m.full || '')).toLowerCase();
      if (hay.indexOf(ql) >= 0) {
        hits.push(m);
        if (hits.length >= 30) break;
      }
    }
    var box = $('searchResult');
    if (!hits.length) {
      box.innerHTML = '<div class="sr-empty">未找到相关标点</div>';
      box.classList.remove('hidden');
      return;
    }
    var html = '';
    hits.forEach(function (m) {
      var cat = catById(state.layer, m.cat);
      html += '<div class="sr-item" data-id="' + m.id + '">' +
        (cat && cat.icon ? '<img src="assets/icons/' + esc(cat.icon) + '" alt="">' : '') +
        '<span class="sr-name">' + esc(m.name || m.full) + '</span>' +
        '<span class="sr-cat">' + esc(cat ? cat.name : '') + '</span>' +
        '</div>';
    });
    box.innerHTML = html;
    box.classList.remove('hidden');

    Array.prototype.forEach.call(box.querySelectorAll('.sr-item'), function (el) {
      el.addEventListener('click', function () {
        var id = Number(el.getAttribute('data-id'));
        var m = null;
        for (var i = 0; i < MARKERS.length; i++) {
          if (MARKERS[i].id === id) { m = MARKERS[i]; break; }
        }
        if (!m) return;
        // 确保该分类被选中
        if (!state.selected[m.cat]) {
          state.selected[m.cat] = true;
          saveSelected();
          buildCatalogPanel();
          renderMarkers();
        }
        box.classList.add('hidden');
        $('searchInput').value = '';
        map.flyTo([m.x, m.y], Math.max(map.getZoom(), 5), { duration: 0.6 });
        setTimeout(function () {
          var mk = state.markers[m.id];
          if (mk) mk.openTooltip();
          openDetail(m);
        }, 750);
      });
    });
  }

  document.addEventListener('click', function (e) {
    var box = $('searchResult');
    if (box && !box.classList.contains('hidden') && !e.target.closest('.search-box')) {
      box.classList.add('hidden');
    }
  });

  /* ---------------- 区域轮廓图层（单总开关，按当前层自动选对应轮廓） ---------------- */
  var AREA_STYLE = {
    cave:   { color: '#f3e79b', weight: 1, fillColor: '#f3e79b', fillOpacity: 0.06, dashArray: '4,3' },
    sky:    { color: '#66ccff', weight: 1, fillColor: '#66ccff', fillOpacity: 0.12 },
    depths: { color: '#ff4444', weight: 1.5, fill: false, dashArray: '4,3' }
  };
  // 当前层 → 对应轮廓 key
  var AREA_KEY_OF_LAYER = { 18: 'cave', 20: 'sky', 19: 'depths' };

  function clearAreaOverlays() {
    if (state.areaLayers.current) {
      map.removeLayer(state.areaLayers.current);
      state.areaLayers.current = null;
    }
  }

  function buildAreaOverlays() {
    clearAreaOverlays();
    if (!state.areaOn) return;
    var key = AREA_KEY_OF_LAYER[state.layer];
    if (!key) return;
    var data = key === 'cave' ? AREA_CAVE : key === 'sky' ? AREA_SKY : AREA_DEPTHS;
    if (!data || !data.length) return;
    var grp = L.layerGroup();
    var style = AREA_STYLE[key];
    data.forEach(function (item) {
      if (key === 'depths') {
        item.polys.forEach(function (poly) { grp.addLayer(L.polygon(poly, style)); });
      } else {
        var p = L.polygon(item.rings, style);
        if (key === 'cave' && item.name) p.bindTooltip(item.name, { sticky: true, direction: 'top' });
        grp.addLayer(p);
      }
    });
    grp.addTo(map);
    state.areaLayers.current = grp;
  }

  function initAreaOverlays() {
    state.areaOn = loadJson(LS_AREA, false);
    var sw = $('areaSwitch');
    var box = $('toggleArea');
    if (sw) sw.checked = !!state.areaOn;
    if (box) box.classList.toggle('cur', !!state.areaOn);
    function apply(on) {
      state.areaOn = !!on;
      saveJson(LS_AREA, state.areaOn);
      if (sw) sw.checked = !!state.areaOn;
      if (box) box.classList.toggle('cur', !!state.areaOn);
      buildAreaOverlays();
    }
    // label 的 for 属性自动切换 input，change 统一处理
    if (sw) sw.addEventListener('change', function () { apply(this.checked); });
    buildAreaOverlays();
  }
  /* ---------------- 图层切换 ---------------- */
  $('layerSwitch').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-layer'));
    /* V1.8.1: 手动点击 = 切层并锁定；再点同层 = 解除锁定；传送后由 live.js 恢复自动 */
    if (window.LIVENAV && window.LIVENAV.setLayerLock) {
      window.LIVENAV.setLayerLock(id);
    }
    if (id === state.layer) return;
    switchLayer(id);
  });

  /* V1.8.0: keepView=true 时保留当前视野（实时层自动切层用，不重置视角） */
  function switchLayer(id, keepView) {
    state.layer = id;
    saveJson(LS_LAYER, id);
    Array.prototype.forEach.call($('layerSwitch').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-layer')) === id);
    });
    $('detail').classList.add('hidden');
    $('searchResult').classList.add('hidden');
    $('searchInput').value = '';
    setTileLayer(id);
    selectDefault();      // 内部会 bindSelected()：恢复本层选择，无记录才用默认值
    buildCatalogPanel();
    renderAreas();
    buildAreaOverlays();
    renderMarkers();
    updateCount();
    updateLayerCount();
    buildMatPanel();
    renderMaterials();
    if (!keepView) map.setView(CENTER, 3);
  }

  /* ---------------- 面板收起 / 名称开关 ---------------- */
  $('panelToggle').addEventListener('click', function () {
    $('panel').classList.toggle('collapsed');
  });
  function syncNameSwitchUI() {
    $('toggleNames').classList.toggle('cur', state.showNames);
    $('nameSwitch').checked = state.showNames;
  }
  $('toggleNames').addEventListener('click', function (e) {
    // label 会触发 input change；此处防止重复处理（点击 span/容器时手动切换）
    if (e.target.tagName === 'INPUT') return;
    e.preventDefault();
    state.showNames = !state.showNames;
    syncNameSwitchUI();
    saveJson(LS_NAMES, state.showNames);
    refreshLabels();
  });
  $('nameSwitch').addEventListener('change', function () {
    state.showNames = this.checked;
    syncNameSwitchUI();
    saveJson(LS_NAMES, state.showNames);
    refreshLabels();
  });

  /* ---------------- 自定义标点流程 ---------------- */
  $('addMarkerBtn').addEventListener('click', function () {
    if (state.adding) { cancelAdding(); return; }
    state.adding = true;
    this.textContent = '× 取消放置';
    map.getContainer().style.cursor = 'crosshair';
    toast('请在地图上点击要放置标点的位置');
  });

  function cancelAdding() {
    state.adding = false;
    $('addMarkerBtn').textContent = '+ 新增标点';
    map.getContainer().style.cursor = '';
  }

  var pendingPos = null;
  map.on('click', function (e) {
    if (!state.adding) {
      // 点击地图空白处自动关闭详情卡片（V1.7.3；V1.9.3 补：探索卡片 exploreCard 一并关闭）
      $('detail').classList.add('hidden');
      $('exploreCard').classList.add('hidden');
      state.current = null;
      return;
    }
    if ($('addMarkerModal').classList.contains('hidden') === false) return;
    var c = e.latlng;
    if (c.lat < -5000 || c.lat > 5000 || c.lng < -6000 || c.lng > 6000) {
      toast('该位置超出地图范围');
      return;
    }
    pendingPos = { x: Math.round(c.lat * 100) / 100, y: Math.round(c.lng * 100) / 100 };
    $('amName').value = '';
    $('amDesc').value = '';
    $('addMarkerModal').classList.remove('hidden');
    $('amName').focus();
  });

  $('amSave').addEventListener('click', function () {
    var name = $('amName').value.trim();
    if (!name) { toast('请输入标点名称'); return; }
    var c = {
      id: 'c' + Date.now(),
      name: name,
      desc: $('amDesc').value.trim(),
      x: pendingPos.x,
      y: pendingPos.y,
      layer: state.layer
    };
    state.custom.push(c);
    saveCustom();
    $('addMarkerModal').classList.add('hidden');
    cancelAdding();
    renderCustomMarks();
    openCustomDetail(c);
  });
  $('amCancel').addEventListener('click', function () {
    $('addMarkerModal').classList.add('hidden');
    cancelAdding();
  });

  /* ---------------- Toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.innerHTML = msg;
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }

  /* ---------------- Service Worker 更新提示（V2.1 M6.5） ----------------
   * 这个项目开SW 纯粹是为了瓦片秒开，代价是「改了代码页面可能没变化」。
   * 检测到新 SW 装好时在这里告诉用户刷一下，别让人以为改动没生效。
   * 只提示一次（sessionStorage 记 flag）——每次都弹会很烦。 */
  window.addEventListener('sw-updated', function () {
    var KEY = 'totkmap_sw_notice';
    try { if (sessionStorage.getItem(KEY)) return; } catch (e) { /* 隐私模式 */ }
    try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* 忽略 */ }
    var t = $('toast');
    if (!t) return;
    /* 做成可点击：点一下直接刷，省得自己按 F5 */
    t.innerHTML = '已下载新版本，<span id="swReload" style="cursor:pointer;' +
      'text-decoration:underline;color:#eac27e">点此刷新</span>';
    t.classList.remove('hidden');
    var r = $('swReload');
    if (r) r.addEventListener('click', function () { location.reload(); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 6000);
  });

  /* ---------- V2.1 M6.6：防具区块的交互 ---------- */
  function bindArmorEnhance(box) {
    if (!box) return;

    /* 同套部件 / 套装统称里的图标 → 找该件的地图标点并打开它的卡片。
     * ★ 不另开卡片：防具信息就在探索卡片里，点哪件就换哪件的内容。
     *   找不到对应标点就退回「切到该件所在图层 + 面板提示」，
     *   因为 armors.js 的 136 件与地图上的 120 个标点不是一一对应
     *   （35 件商店防具地图上是一个「防具店」代表整家店）。 */
    Array.prototype.forEach.call(box.querySelectorAll('[data-go-armor]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var key = b.getAttribute('data-go-armor');
        gotoArmor(key);
      });
    });

    /* 「去哪买」→ 飞到那家防具店（M6.7） */
    Array.prototype.forEach.call(box.querySelectorAll('[data-goto-pt]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var AE2 = window.ArmorEnhance;
        var pt = AE2 && AE2.markerById(b.getAttribute('data-goto-pt'));
        if (!pt) { toast('找不到那个商店标点'); return; }
        gotoMarker(pt);
        openDetail(pt, null);
      });
    });

    /* 关联任务 → 打开任务卡片，并**把地图飞到那个任务的标点**。
       ★ 任务标点在侧栏「任务」大类里，用户未必勾了「任务」分类，
         所以 gotoMarker 里的自动勾选很关键。 */
    Array.prototype.forEach.call(box.querySelectorAll('[data-go-task]'), function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var tk = b.getAttribute('data-go-task');
        var TD = window.TaskData;
        var t = TD && TD.byKey(tk);
        if (!t) { toast('找不到该任务'); return; }
        /* 先跳地图（内部会处理切层+勾分类），再开卡片 */
        var pt = findTaskMarker(t);
        if (pt) gotoMarker(pt);
        window.TaskCard.open(t, e);
      });
    });
  }

  /* 任务 → 地图标点。
     * ★ 不按分类名找：任务点在地图上挂在「迷你挑战」「情节挑战」「支线故事」
     *   这些**攻略分类**下（实测「拉姆达的财宝」标点 cat=185「迷你挑战」），
     *   不叫「任务」——按名字匹配必然落空。
     *   改为按「同图层 + 同坐标 + 同名」定位，这是最稳的判据。 */
  function findTaskMarker(t) {
    if (!t || t.gx == null || t.gz == null) return null;
    var byName = MARKERS.filter(function (m) {
      return m.layer === t.layer && (m.full || m.name) === t.name;
    })[0];
    if (byName) return byName;
    /* 名字对不上就退到坐标邻近（同图层 ±2 游戏单位） */
    var cands = MARKERS.filter(function (m) {
      return m.layer === t.layer
        && Math.abs(m.x - t.gz) < 2 && Math.abs(m.y - t.gx) < 2;
    });
    return cands[0] || null;
  }

  /* 找到某件防具对应的地图标点并跳过去
       （M6.7：光打开卡片不够，地图必须跟着动） */
  function gotoArmor(armorKey) {
    var cats = catalogIdsOfArmor();
    if (!cats.length) { toast('地图上没有防具分类'); return; }
    /* 按名字反查标点 */
    var A = (window.TOTK_ARMORS || []).filter(function (a) { return a.key === armorKey; })[0];
    if (!A) { toast('找不到该防具'); return; }
    var hit = MARKERS.filter(function (m) {
      return cats.indexOf(m.cat) >= 0 && (m.name || '').trim() === A.name;
    })[0];
    if (!hit) {
      /* 地图上没逐件标点（商店防具就是这样，一个「防具店」代表整家店） */
      if (A.layer != null) switchLayer(A.layer);
      toast('「' + A.name + '」在地图上没有单独标点，商店类可在地图搜「防具店」');
      return;
    }
    gotoMarker(hit);
    /* 卡片内容也跟着切过去（它读的是当前点的信息） */
    openDetail(hit, null);
  }

  /* ---------- V2.1 M6.7：跳到地图上的某个标点并高亮 ----------
     * 需求来源：防具卡片里点「同套部件」「关联任务」之后，
     *   卡片是弹出来了，但地图没动——玩家在图上根本找不到那件防具/那个任务在哪。
     *   这跟材料面板的「点图上点→高亮侧栏」是同一条链路，反过来做一遍。
     *
     * 两个必须处理的坑：
     *  ① **marker 只在该分类被勾选时才画**（renderMarkers 里 `if (!state.selected[m.cat]) return`）。
     *     直接 flyTo 过去会飞到一片空白——目标 marker 根本没渲染。
     *     所以要先自动勾上目标分类、等重画完，再飞。
     *  ② 跨图层要先切图层，marker 是按 layer 分组渲染的。
     */
  function gotoMarker(m, opts) {
    opts = opts || {};
    if (!m) return;
    /* 顺序要紧：先切图层，再勾分类。
     * state.selected 是 selectedByLayer[当前层] 的**引用**，
     * 切层会把它指向换成新层的对象——先勾后切等于白勾。 */
    if (m.layer != null && m.layer !== state.layer) {
      switchLayer(m.layer);
    }
    /* 自动勾上目标分类（未勾选则勾上），否则飞过去只看到空白地图 */
    if (m.cat != null && !state.selected[m.cat]) {
      state.selected[m.cat] = true;
      saveSelected();
      buildCatalogPanel();
      updateCount();
    }
    /* 兜底再画一次：切图层/勾分类会触发重画，但防抖可能推迟 */
    renderMarkers();

    var ll = [m.x, m.y];
    var target = Math.max(map.getZoom(), 6);

    /* ---------- 顺序要紧（M6.7 bugfix）----------
       ★ 原来是 flyTo 之后**立刻**加闪光类：
         flyTo 有 0.7s 动画，闪光同时开始 → 等地图停稳，动画早播完了，
         玩家只看到「一个不显眼的小图标」，不知道那是目标。
       正确：先飞，**等 moveend 再闪**。
       ★ 还要在 moveend 里**重新取一次 marker**：
         飞行途中 renderMarkers 可能重画，原来的 element 已经脱离文档，
         往旧节点加class 等于白加（表现为「闪了一下就没了」）。 */
    var flashed = false;
    function flashNow() {
      if (flashed) return;
      flashed = true;
      var mk2 = state.markers[m.id];
      if (!mk2) { toast('已定位到「' + (m.name || m.full || '目标') + '」'); return; }
      var el = mk2.getElement && mk2.getElement();
      if (el) {
        el.classList.remove('mk-locate-flash');
        void el.offsetWidth;            /* 强制重排，动画才能重放 */
        el.classList.add('mk-locate-flash');
        setTimeout(function () {
          if (el.classList) el.classList.remove('mk-locate-flash');
        }, 2600);
      }
      try {
        mk2.openTooltip();
        setTimeout(function () { try { mk2.closeTooltip(); } catch (e) { /* 图层已重画 */ } }, 2500);
      } catch (e) { /* 无关紧要 */ }
    }

    /* 已在目标位置附近时 flyTo 不会触发 moveend（也没必要飞），
       直接闪；否则等地图停稳再闪。 */
    var cur = map.getCenter();
    var near = Math.abs(cur.lat - m.x) < 1 && Math.abs(cur.lng - m.y) < 1
      && map.getZoom() >= target;
    if (near) {
      flashNow();
      return;
    }
    map.once('moveend', flashNow);
    map.flyTo(ll, target, { duration: 0.7 });
    /* 兜底：万一 moveend 没来（缩放相同 Leaflet 会跳过），
       1.2 秒后仍没闪就补一下——宁可闪晚一拍，别不闪。 */
    setTimeout(flashNow, 1200);
  }

  /* catalogs.js 里「防具」分类的 id 列表 */
  var _armorCatCache = null;
  function catalogIdsOfArmor() {
    if (_armorCatCache) return _armorCatCache;
    var out = [];
    (window.TOTK_CATALOGS || []).forEach(function (c) {
      if (c && c.group === '位置' && /^防具/.test(c.name)) out.push(c.id);
    });
    return (_armorCatCache = out);
  }

  /* ---------------- 实时导航入口（V1.8.0，对接 js/live.js 的 LIVENAV） ---------------- */
  function liveNavTo(name, x, y, layer, type) {
    if (window.LIVENAV) {
      LIVENAV.navigate({ name: name, x: x, y: y, layer: layer, type: type || '' });
      return;
    }
    map.flyTo([x, y], 7, { animate: true, duration: 0.8 });
    toast('已定位（实时导航服务未启动，仅移动视角）');
  }

  /* 导航按钮切换：同一目标再次点击 = 停止导航（按钮文案随状态变化） */
  function liveToggleNav(o) {
    if (!window.LIVENAV) {
      map.flyTo([o.x, o.y], 7, { animate: true, duration: 0.8 });
      toast('已定位（实时导航服务未启动，仅移动视角）');
      return;
    }
    var r = LIVENAV.toggleNav(o);
    var nav = $('detailNav');
    if (nav) nav.textContent = (r === 'navigating') ? '停止导航' : '导航';
    var ecNav = $('ecNav');
    if (ecNav) ecNav.textContent = (r === 'navigating') ? '停止导航' : '导航';
  }

  /* ---------------- 问题反馈 ---------------- */
  $('feedbackBtn').addEventListener('click', function () {
    toast('本地离线版：发现数据错误可反馈给制作者修正');
  });

  /* ---------------- 存档同步（《王国之泪》progress.sav） ---------------- */
  function loadSaveSync() {
    var saved = loadJson(LS_SAVE, null);
    if (saved && saved.progress) {
      var p = saved.progress;
      // 旧键迁移：呀哈哈 → 克洛格
      if (p['呀哈哈'] && !p['克洛格']) { p['克洛格'] = p['呀哈哈']; delete p['呀哈哈']; }
      if (p['双倍呀哈哈'] && !p['双倍克洛格']) { p['双倍克洛格'] = p['双倍呀哈哈']; delete p['双倍呀哈哈']; }
      state.save = p;
      state.saveVersion = saved.version || null;
    }
  }
  /* 探索度：按存档同步结果显示各收集项完成百分比 */
  var PROGRESS_ORDER = ['神庙', '鸟望台', '树根', '龙之泪', '克洛格', '双倍克洛格',
    '魔犹伊遗失物', '贤者的遗志', '卡邦达立牌'];
  function renderProgress() {
    var list = $('progressList');
    if (!list) return;
    if (!state.save) {
      list.innerHTML = '<div class="progress-empty">加载存档后显示探索进度（神庙 / 树根 / 克洛格等收集百分比）</div>';
      return;
    }
    var html = '';
    PROGRESS_ORDER.forEach(function (k) {
      var s = state.save[k];
      if (!s) return;
      var pct = Math.round(s.done / s.total * 100);
      html += '<div class="progress-item"><span class="pi-name">' + esc(k) + '</span>' +
        '<span class="pi-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="pi-val">' + s.done + '/' + s.total + '</span></div>';
    });
    list.innerHTML = html || '<div class="progress-empty">存档中无可同步类别</div>';
  }

  function applySaveSync(silent) {
    var btn = $('saveSyncBtn');
    serverSaveSlot = '';
    btn.textContent = state.save ? '已同步 ✓ 重新加载' : '📂 从存档加载进度…';
    btn.classList.toggle('busy', false);
    buildCatalogPanel();
    updateCount();
    renderProgress();
    if (!silent) {
      toast(state.save
        ? '<b>存档已同步：</b>' + (state.saveVersion || '') + '，共 ' + Object.keys(state.save).length + ' 类完成数'
        : '已移除存档同步');
    }
  }

  $('saveSyncBtn').addEventListener('click', function () {
    $('saveFileInput').click();
  });

  /* 帮助：悬停气泡 + 点击打开帮助弹窗（参考 BOTWmap 设计） */
  var suHelp = $('suHelp');
  var suTip = $('suTip');
  var helpBox = $('helpBox');
  if (suHelp && suTip) {
    var showTip = function () { suTip.classList.remove('hidden'); };
    var hideTip = function () { suTip.classList.add('hidden'); };
    suHelp.addEventListener('mouseenter', showTip);
    suHelp.addEventListener('mouseleave', hideTip);
    suHelp.addEventListener('focus', showTip);
    suHelp.addEventListener('blur', hideTip);
    suHelp.addEventListener('click', function (e) {
      e.stopPropagation();
      hideTip();
      if (helpBox) helpBox.classList.remove('hidden');
    });
    document.addEventListener('click', function (e) {
      if (helpBox && !e.target.closest('#helpBox') && !e.target.closest('#suHelp')) {
        helpBox.classList.add('hidden');
      }
      if (!e.target.closest('.su-help-wrap')) hideTip();
    });
    var hbClose = $('hbClose');
    if (hbClose) hbClose.addEventListener('click', function () { helpBox.classList.add('hidden'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && helpBox && !helpBox.classList.contains('hidden')) {
        helpBox.classList.add('hidden');
      }
    });
  }

  /* 拖拽 progress.sav 到面板 */
  var panelEl = $('panel');
  panelEl.addEventListener('dragover', function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  panelEl.addEventListener('drop', function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /\.sav$/i.test(f.name)) {
      handleSaveFile(f);
    } else if (f) {
      toast('请把《王国之泪》的 progress.sav 文件拖进来');
    }
  });

  /* 统一存档文件处理入口（按钮选择 / 拖拽共用） */
  function handleSaveFile(file) {
    var btn = $('saveSyncBtn');
    btn.classList.add('busy');
    btn.textContent = '解析中…';
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var parsed = TOTKSaveParser.parse(e.target.result);
        if (!parsed.ok) { toast('同步失败：' + parsed.error); btn.classList.remove('busy'); btn.textContent = '同步存档'; return; }
        var progress = TOTKSaveParser.collect(parsed);
        state.save = progress;
        state.saveVersion = parsed.version;
        saveJson(LS_SAVE, { version: parsed.version, progress: progress });
        /* V1.8.0 M3: 可逐点映射类别（鸟望台/龙之泪/魔犹伊）以存档为准写入 state.done */
        applySavePointDone(parsed);
        applySaveSync();
      } catch (err) {
        toast('同步失败：' + err.message);
        btn.classList.remove('busy');
        btn.textContent = '同步存档';
      }
    };
    reader.onerror = function () {
      toast('读取存档文件失败');
      btn.classList.remove('busy');
      btn.textContent = '同步存档';
    };
    reader.readAsArrayBuffer(file);
  }

  $('saveFileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    handleSaveFile(file);
  });

  /* ---------------- 事件绑定 ---------------- */
  var aoTimer = null;
  map.on('moveend zoomend', function () {
    refreshLabels(); updateAreas();
    if (aoTimer) clearTimeout(aoTimer);
    aoTimer = setTimeout(function () {
      avoidOverlap();
      setTimeout(avoidOverlap, 450);   // 动画中再跑
      setTimeout(avoidOverlap, 1200);  // 完全稳定后最终兜底
    }, 80);
  });

  /* ---------------- 初始化 ---------------- */
  loadDone();
  loadCustom();
  loadSaveSync();
  loadSelected();          // 先取回各层分类选择，selectDefault() 才能判断"本层选过没"

  var savedLayer = loadJson(LS_LAYER, null);
  var validLayers = LAYERS.map(function (l) { return l.id; });
  if (savedLayer && validLayers.indexOf(savedLayer) >= 0) state.layer = savedLayer;
  var savedNames = loadJson(LS_NAMES, null);
  if (savedNames !== null) {
    state.showNames = !!savedNames;
    syncNameSwitchUI();
  }

  // 初始图层按钮状态
  Array.prototype.forEach.call($('layerSwitch').querySelectorAll('button'), function (b) {
    b.classList.toggle('active', Number(b.getAttribute('data-layer')) === state.layer);
  });

  // 移动端默认收起面板，优先展示地图
  if (window.innerWidth <= 720) {
    $('panel').classList.add('collapsed');
  }

  setTileLayer(state.layer);
  selectDefault();
  buildCatalogPanel();
  renderAreas();
  initAreaOverlays();
  renderMarkers();
  updateCount();
  map.setView(CENTER, 3);

  // 存档同步按钮初始状态
  applySaveSync(true);

  /* ============================================================
     V1.8.0 M3：独立探索卡片 + 探索队列桥接（材料卡片体系保持原样）
     ============================================================ */
  /* 权威合并完成点（可逐点判定类别：鸟望台/龙之泪/魔犹伊）——存档为准 */
  function applyProgressDone(doneIds) {
    var map = window.TOTK_EXPLORE_MAP || {};
    var set = {};
    (doneIds || []).forEach(function (id) { set[id] = true; });
    var changed = false;
    [['towers', map.towers], ['tears', map.tears], ['bubbuls', map.bubbuls]].forEach(function (pair) {
      var tbl = pair[1];
      if (!tbl) return;
      for (var id in tbl) {
        var on = !!set[id];
        if (on && !state.done[id]) { state.done[id] = true; changed = true; }
        else if (!on && state.done[id]) { delete state.done[id]; changed = true; }
      }
    });
    if (changed) {
      saveDone();
      renderMarkers();
      buildCatalogPanel();
      updateCount();
    }
  }

  /* 上传存档 → 逐点完成注入（走同一权威合并） */
  function applySavePointDone(parsed) {
    var map = window.TOTK_EXPLORE_MAP || {};
    var pd = TOTKSaveParser.pointDone(parsed, map);
    applyProgressDone(Object.keys(pd || {}).map(Number));

    /* V2.1 M5: 任务完成态同样以存档为准。
     * 机制：hash('Step_<任务key>') 查到 hash 表 → 值等于 hash('Complete') 即完成。
     * 实测 285/285 全部命中（见 TOTK任务存档同步机制-调研结论.md）。
     * TaskDone 内部与 localStorage 手动态合并，存档优先。 */
    try {
      if (window.TaskDone) {
        window.TaskDone.applySave(TOTKSaveParser.questDone(parsed, window.TOTK_TASK_SAVE));
      }
    } catch (err) {
      /* 任务存档同步失败不该影响探索类的进度应用 */
      if (window.console) console.warn('任务存档同步失败', err);
    }
  }

  /* V1.8.0 M3：服务端存档自动同步（BOTWmap 同机制——服务自动定位存档、网页拉取、
   * 游戏内保存后 mtime 变化 → progressGen 变化 → live.js 触发本函数自动刷新） */
  var serverSaveSlot = '';
  /* V1.9.2 URL 上下文（xnavi 打开地图带 ?game=，见《BOTWmap导航配合接口协议 v1》）：
   * 仅用于异口径进度提示；?follow=1 由 live.js 消费 */
  var urlGame = null, progWarned = false;
  try { urlGame = new URLSearchParams(location.search).get('game'); } catch (e) {}
  function syncProgressFromServer() {
    if (!window.LIVENAV || !window.LIVENAV.online()) return;
    fetch('http://127.0.0.1:8766/progress?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || !res.ok) return;
        /* V1.9.2 口径防御（协议 §2.3，线上 Bug3 教训）：xnavi /progress 按当前游戏分两种口径——
         * TOTK = doneIds；BOTW = points（无 doneIds）。无 doneIds 即异口径/格式不符，
         * 整段跳过、保留现状，绝不把 BOTW 口径的 counts 当 TOTK 进度应用 */
        if (!Array.isArray(res.doneIds)) {
          if (!progWarned) {
            progWarned = true;
            toast(urlGame === 'botw'
              ? '当前导航识别为 BOTW，进度请查看 botw 地图'
              : '进度数据格式不符（非 TOTK 口径），已保留当前进度');
          }
          return;
        }
        applyProgressDone(res.doneIds);
        /* V2.1 M5: 服务端同步路径的任务完成态。
         * questDone = {任务key: {done, stage, idx, total}}，由 server.py 的
         * _quest_done() 用同一套 hash 机制算出（与前端 questDone 同口径）。 */
        if (res.questDone && window.TaskDone) {
          try {
            window.TaskDone.applySave(res.questDone);
          } catch (e) {
            if (window.console) console.warn('任务进度（服务端）应用失败', e);
          }
        }
        if (res.counts) {
          state.save = res.counts;
          state.saveVersion = (res.version || '') + ' · 服务端自动同步';
          var m = String(res.save || '').match(/slot_(\d+)/);
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

  /* 标点完成状态刷新（卡片回调/队列共用） */
  function applyDoneToMarker(mid) {
    var mk = state.markers[mid];
    if (!mk) return;
    var m = null;
    for (var i = 0; i < MARKERS.length; i++) {
      if (String(MARKERS[i].id) === String(mid)) { m = MARKERS[i]; break; }
    }
    /* V1.9.3 完成标记：setIcon 在「原图标」与「右上角绿勾 divIcon」间即时切换，图标本体不降透明度 */
    if (m) {
      var _c = catById(state.layer, m.cat);
      mk.setIcon(state.done[mid] ? doneIconFor(_c) : iconFor(_c));
    }
    mk.unbindTooltip();
    mk.bindTooltip((state.done[mid] ? '✓ ' : '') + (m ? (m.name || m.full) : ''), {
      direction: 'top', offset: [0, -12],
      className: 'mk-label' + (state.done[mid] ? ' done-label' : '')
    });
  }

  /* 塔域：最近鸟望台（15 座塔=地面层 cat=62；TOTK 无现成塔域分区，最近塔为准） */
  var TOWER_MARKERS = null;
  function nearestTower(ll) {
    if (!TOWER_MARKERS) {
      TOWER_MARKERS = MARKERS.filter(function (m) { return m.cat === 62 && m.layer === 18; });
    }
    var best = null, bd = Infinity;
    TOWER_MARKERS.forEach(function (tt) {
      var d = (tt.x - ll[0]) * (tt.x - ll[0]) + (tt.y - ll[1]) * (tt.y - ll[1]);
      if (d < bd) { bd = d; best = tt; }
    });
    return best ? best.name : '';
  }

  /* ---------------- 神庙/图鉴类 desc 解析 ----------------
   * markers.js 里 cat 63（地上神庙）/ cat 109（天空神庙）的 desc 是统一四段格式：
   *   名称：劳鲁的祝福
   *   位置：位于海布拉山西北的洞窟内…
   *   注意事项：与神庙互动后需要从冰水中拿到水晶…
   *   宝箱：位于神庙终点，打开宝箱可获得黄玉。
   * 原先只用正则取出「名称」当试炼名，**位置/注意事项/宝箱三段全部丢弃**，
   * 而「注意事项」正是任务与解谜前置条件的关键信息。这里按行首标签结构化拆开。
   * 非该格式（如洞穴/矿石的自由文本）返回空对象，调用方隐藏对应行即可。 */
  var NOTE_LIMIT = 62;   /* 「注意」折叠时的显示字数 */

  /* markers.js 有 13 条 desc 里带 HTML 标签（如 <div>宝箱位于…</div>，本意是换行）。
   * 卡片用 textContent 注入（不会产生注入风险），但标签会原样显示成字面文本，
   * 所以这里把块级标签换成空格、去掉零散标签，纯文本化。 */
  function plainify(s) {
    return String(s || '')
      .replace(/<\s*br\s*\/?\s*>/gi, ' ')
      .replace(/<\s*\/\s*(p|div|li|ul|ol)\s*>/gi, ' ')
      .replace(/<\s*(p|div|li|ul|ol)\b[^>]*>/gi, ' ')
      .replace(/<[^>]{1,80}>/g, ' ')      /* 兜底：其余零散标签 */
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function parseDescSections(desc) {
    var out = { trial: '', place: '', note: '', chest: '' };
    if (!desc) return out;
    var lines = String(desc).split(/\r?\n/);
    /* 标签写法不统一（半角/全角冒号都出现过），用宽松匹配 */
    var re = {
      trial:  /^\s*名称\s*[:：]\s*(.+)$/,
      place:  /^\s*位置\s*[:：]\s*(.+)$/,
      note:   /^\s*注意事项\s*[:：]\s*([\s\S]*)$/,
      chest:  /^\s*宝箱\s*[:：]\s*([\s\S]*)$/
    };
    var cur = null;
    lines.forEach(function (ln) {
      for (var k in re) {
        var m = ln.match(re[k]);
        if (m) { out[k] = m[1].trim(); cur = (k === 'note' || k === 'chest') ? k : null; return; }
      }
      /* 无标签行：续接到上一段。先剥标签，若剥完这行以「宝箱：」开头
       * 说明是 "<div>宝箱位于…</div>" 这类写法，转为宝箱段的新起点。
       * （姆萨诺奇拉神庙把宝箱写在注意事项里，也靠这里兜住） */
      if (cur && ln.trim()) {
        var t = plainify(ln);
        if (!t) return;
        var cm = t.match(/^宝箱\s*[:：]\s*(.+)$/);
        if (cm) { out.chest = cm[1].trim(); cur = 'chest'; return; }
        var nm = t.match(/^名称\s*[:：]\s*(.+)$/);
        if (nm) { out.trial = nm[1].trim(); return; }
        out[cur] = (out[cur] + ' ' + t).trim();
      }
    });
    out.trial = plainify(out.trial);
    out.place = plainify(out.place);
    out.note = plainify(out.note);
    out.chest = plainify(out.chest);
    return out;
  }
  /* 兼容旧调用点 */
  function parseTrial(desc) { return parseDescSections(desc).trial; }

  /* 探索卡片定位（同 detail 规则：不挡侧栏、锚点侧、可视区钳制） */
  function positionExploreCard(ev) {
    var card = $('exploreCard');
    if (!card) return;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (vw <= 720) {
      card.style.left = ''; card.style.top = '';
      return;
    }
    var guard = 366;
    var ax = guard + 200, ay = vh * 0.45;
    if (ev && typeof ev.clientX === 'number') { ax = ev.clientX; ay = ev.clientY; }
    var cw = card.offsetWidth || 280;
    var ch = card.offsetHeight || 220;
    var left = ax + 20, top = ay - ch / 2;
    if (left + cw > vw - 10) left = ax - cw - 20;
    left = Math.max(guard, Math.min(left, vw - cw - 10));
    top = Math.max(10, Math.min(top, vh - 90));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  /* 探索卡片拖拽（独立实现，不与材料卡共用） */
  function initExploreCardDrag() {
    var card = $('exploreCard');
    var head = $('ecHead');
    if (!head) return;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function down(e) {
      if (e.target.closest && e.target.closest('.detail-close')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = card.offsetLeft; oy = card.offsetTop;
    }
    function move(e) {
      if (!dragging) return;
      card.style.left = Math.max(0, Math.min(ox + e.clientX - sx, window.innerWidth - card.offsetWidth)) + 'px';
      card.style.top = Math.max(0, Math.min(oy + e.clientY - sy, window.innerHeight - 60)) + 'px';
    }
    function up() { dragging = false; }
    head.addEventListener('mousedown', down);
    head.addEventListener('touchstart', function (e) {
      if (e.touches && e.touches[0]) down(e.touches[0]);
    }, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', function (e) {
      if (e.touches && e.touches[0]) move(e.touches[0]);
    }, { passive: true });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  }

  /* 独立探索卡片（紧凑信息卡：名称/分类/描述/标记完成/导航/跳过） */
  function showExploreCard(opts) {
    var m = opts.m || {};
    var ea = window.EXPLORE_AUTO;
    var autoOn = !!(ea && ea.isRunning() && ea.current() && ea.current().id === m.id);
    $('ecChip').textContent = opts.cat || '';
    $('ecName').textContent = opts.name;
    var ll = [m.x, m.y];
    $('ecRegion').textContent = nearestRegion(ll) || '未知';
    $('ecTower').textContent = nearestTower(ll) || '未知';
    $('ecCoord').textContent = 'X ' + Math.round(m.y) + ' · Z ' + Math.round(m.x);

    /* V2.0.2：神庙 desc 的四段信息（试炼/位置/注意/宝箱）结构化上屏。
     * 非神庙（该字段为空）对应行自动隐藏，卡片保持原来的紧凑外观。 */
    var sec = parseDescSections(m.desc || '');
    $('ecTrialRow').style.display = sec.trial ? '' : 'none';
    $('ecTrial').textContent = sec.trial;
    $('ecPlaceRow').style.display = sec.place ? '' : 'none';
    $('ecPlace').textContent = sec.place;
    $('ecChestRow').style.display = sec.chest ? '' : 'none';
    $('ecChest').textContent = sec.chest;

    /* ---------- V2.1 M6.6：防具专属区块 ----------
     * 只在点的是「防具」分类的标点时填充，其余情况置空（CSS :empty 隐藏）。
     * ★ 不改 exploreCard 的任何现有字段 —— 区域/塔域/坐标/按钮/标记完成全保持原样，
     *   只是在中间多一块信息。非防具标点的卡片外观与改动前完全一致。
     * 防具标点名字对不上 armors.js 时（.mode==='set' 的整套统称、
     *   或 '防具店' 这种根本不是某件防具的）会渲染对应形态或直接不渲染。 */
    var aeBox = $('ecArmor');
    if (aeBox) {
      var AE = window.ArmorEnhance;
      var html = '';
      if (AE) {
        /* M6.7：三种来源分别用不同的区块
         * ① 「防具店」标点 → 店内防具清单（无逐件标点的那些按坐标归店）
         * ② 「防具」标点（逐件）→ 单件信息
         * ③ 其它分类 → 什么都不出 */
        if (AE.isShopCat(m.cat)) html = AE.blockForShop(m);
        else if (AE.isArmorCat(m.cat)) html = AE.blockFor(m.name) || '';
      }
      aeBox.innerHTML = html;
      bindArmorEnhance(aeBox);
    }
    /* 「注意」较长，默认折叠 + 展开按钮（不足一屏时按钮不出现） */
    var noteRow = $('ecNoteRow'), noteText = $('ecNoteText'), noteMore = $('ecNoteMore');
    noteRow.style.display = sec.note ? '' : 'none';
    if (sec.note) {
      var long = sec.note.length > NOTE_LIMIT;
      noteText.textContent = long ? sec.note.slice(0, NOTE_LIMIT) + '…' : sec.note;
      noteRow.classList.remove('expanded');
      noteMore.style.display = long ? '' : 'none';
      noteText.classList.toggle('clamped', long);
      noteMore.textContent = '展开';
    }
    var btnNav = $('ecNav'), btnAuto = $('ecAuto'), btnDone = $('ecDone');
    btnNav.textContent = '导航';
    if (window.LIVENAV && window.LIVENAV.currentTarget) {
      var _cur = window.LIVENAV.currentTarget();
      if (_cur && _cur.x === m.x && _cur.y === m.y) btnNav.textContent = '停止导航';
    }
    btnNav.onclick = function () {
      liveToggleNav({ name: m.name || '目标', x: m.x, y: m.y, layer: m.layer, type: opts.cat });
    };
    btnAuto.textContent = autoOn ? '停止自动导航' : '自动导航';
    btnAuto.onclick = function () {
      if (autoOn) { if (ea) ea.stop(); }
      else if (ea) { ea.start(m); }
      showExploreCard({
        name: opts.name, cat: opts.cat, desc: opts.desc, m: m,
        isDone: !!state.done[m.id], custom: opts.custom, evt: null
      });
    };
    if (opts.custom) {
      btnDone.style.display = 'none';
    } else {
      btnDone.style.display = '';
      btnDone.textContent = opts.isDone ? '取消完成' : '标记完成';
      btnDone.className = 'btn primary' + (opts.isDone ? ' done' : '');
      btnDone.onclick = function () {
        if (ea && ea.isRunning() && ea.current() && ea.current().id === m.id) { ea.completeCurrent(); return; }
        if (state.done[m.id]) delete state.done[m.id]; else state.done[m.id] = true;
        saveDone();
        applyDoneToMarker(m.id);
        buildCatalogPanel();
        updateCount();
        if (state.filter !== 'all') renderMarkers();
        showExploreCard({
          name: opts.name, cat: opts.cat, desc: opts.desc, m: m,
          isDone: !!state.done[m.id], custom: opts.custom, evt: null
        });
      };
    }
    var card = $('exploreCard');
    var wasHidden = card.classList.contains('hidden');
    card.classList.remove('hidden');
    if (wasHidden || opts.evt) positionExploreCard(opts.evt && opts.evt.originalEvent || null);
  }
  $('ecClose').addEventListener('click', function () {
    $('exploreCard').classList.add('hidden');
    state.current = null;
  });
  /* V2.0.3 神庙「注意事项」展开/收起 */
  $('ecNoteMore').addEventListener('click', function () {
    var row = $('ecNoteRow');
    var txt = $('ecNoteText');
    var open = !row.classList.contains('expanded');
    row.classList.toggle('expanded', open);
    txt.classList.toggle('clamped', !open);
    this.textContent = open ? '收起' : '展开';
  });
  /* V2.0.3 复制标点名称（查攻略用）。名称取 full（含「神庙-」前缀）优先，
     避免与地图上其他分类重名；自定义标点无 full 时用 name。 */
  $('ecCopy').addEventListener('click', function () {
    var m = state.current;
    if (!m) return;
    var txt = (m.full || m.name || '').trim();
    if (!txt) return;
    copyText(txt, this, '已复制', 'done');
  });
  initExploreCardDrag();

  // V1.8.0 M3 返工：探索自动导航桥接（explore-auto.js 依赖）
  window.TOTK_APP = {
    state: function () { return state; },
    markers: function () { return MARKERS; },
    catsOfLayer: catsOfLayer,
    catById: catById,
    catName: function (id) { var c = catById(state.layer, id); return c ? c.name : ''; },
    layerName: function (l) { return LAYER_NAME[l] || ''; },
    saveDone: saveDone,
    renderMarkers: renderMarkers,
    /* V2.1 M6.6：跳到某件防具的地图标点（任务卡片的防具图标点它） */
    gotoArmor: gotoArmor,
    liveNav: function (o) { if (window.LIVENAV) return window.LIVENAV.navigate(o); return false; },
    toast: toast,
    esc: esc,
    showCard: function (m) {
      showExploreCard({
        name: m.name || m.full,
        cat: (catById(state.layer, m.cat) || {}).name || '未知分类',
        desc: m.desc || '',
        m: m,
        isDone: !!state.done[m.id]
      });
    },
    applyProgressDone: applyProgressDone,
    applyDoneToMarker: applyDoneToMarker,
    buildCatalogPanel: buildCatalogPanel,
    updateCount: updateCount,
    syncProgressFromServer: syncProgressFromServer,
    matById: function (mid) { return matById[mid]; },
    matName: function (mid) { var m = matById[mid]; return m ? m.cn : ('材料' + mid); },
    matPoints: function (layerId) { return matPointsByLayer[layerId] || {}; },
    matCollect: function (mid, idx) {
      var arr = state.matCollected[mid] || [];
      var added = arr.indexOf(idx) < 0;
      if (added) {
        arr.push(idx);
        state.matCollected[mid] = arr;
        saveJson(LS_MAT_COL, state.matCollected);
        renderMatLayer(mid);
      }
      return added;
    },
    showMatCard: function (mid, ll, idx, evt) { var m = matById[mid]; if (m) showMatDetail(m, ll, idx, evt); }
  };

  // 版本号
  var vEl = document.querySelector('.version');
  if (vEl) vEl.textContent = VERSION;

  // 调试/扩展句柄
  window.TOTK = {
    map: map,
    state: state,
    openDetail: openDetail,
    switchLayer: switchLayer,
    refreshLabels: refreshLabels,
    catById: catById
  };

  /* ============================================================
     材料追踪（V1.7.0）—— 参考 BOTWmap 架构：
     - 每材料独立 supercluster 索引（懒加载）
     - 每材料独立 Leaflet LayerGroup，勾选时 addTo(map)，取消时 removeLayer
     - 切层时清空缓存重建
     ============================================================ */
  var MATS = window.TOTK_MATERIALS || { materials: [], points: [] };
  var LS_MAT = 'totkmap_mats_v1';
  var LS_MAT_FAV = 'totkmap_matfav_v1';
  var LS_MAT_COL = 'totkmap_matcol_v1';
  var LS_MAT_DONE = 'totkmap_matdone_v1';
  var MAT_CAT_ORDER = ['植物', '蘑菇', '水果', '昆虫', '鱼', '矿岩'];

  var FX = 180 / 6000, FZ = 85 / 5000;

  var matPointsByLayer = {};
  var matCountByLayer = {};
  (function buildMatPoints() {
    var p = MATS.points || [];
    for (var i = 0; i < p.length; i += 4) {
      var mid = p[i], L = p[i + 1], x = p[i + 2], z = p[i + 3];
      if (!matPointsByLayer[L]) { matPointsByLayer[L] = {}; matCountByLayer[L] = {}; }
      if (!matPointsByLayer[L][mid]) { matPointsByLayer[L][mid] = []; matCountByLayer[L][mid] = 0; }
      matPointsByLayer[L][mid].push([x, z]);
      matCountByLayer[L][mid]++;
    }
  })();

  var matById = {};
  (MATS.materials || []).forEach(function (m) { matById[m.id] = m; });

  state.matTab = 'explore';
  state.matSelected = loadJson(LS_MAT, {});
  state.matFav = loadJson(LS_MAT_FAV, {});
  state.matCollected = loadJson(LS_MAT_COL, {});   // mid -> [点索引]，点级收集记录
  state.matDone = loadJson(LS_MAT_DONE, {});       // mid -> [点索引]，点级完成标记（材料会刷新，重新勾选即重显）
  (function () { for (var k in state.matDone) if (state.matDone[k] === true) delete state.matDone[k]; })();
  state.matFavOnly = false;
  state.matCollapsed = {};
  state.matIdx = {};
  state.matGroups = {};

  function matCountOnLayer(mid, layerId) {
    return (matCountByLayer[layerId] && matCountByLayer[layerId][mid]) || 0;
  }

  function getMatClusterer(mid, layerId, radius) {
    var r = radius || 36;
    var key = layerId + ':' + mid + ':' + r;
    if (state.matIdx[key]) return state.matIdx[key];
    var pts = (matPointsByLayer[layerId] || {})[mid] || [];
    if (!pts.length) return null;
    var feats = pts.map(function (p, i) {
      return {
        id: i,   // 点索引（点级收集用）
        type: 'Feature',
        properties: { matId: mid, gx: p[0], gz: p[1] },
        geometry: { type: 'Point', coordinates: [p[0] * FX, p[1] * FZ] }
      };
    });
    /* V1.9.0: 聚合半径按缩放级别懒构建缓存（低 zoom 大半径减 DOM 数），key=层:材料:半径 */
    var idx = new Supercluster({ radius: r, maxZoom: 7, minZoom: 2 });
    idx.load(feats);
    state.matIdx[key] = idx;
    return idx;
  }

  /* 材料图标分级：随缩放级别 + 聚合数量调整尺寸（参考地名字号随 zoom 调整逻辑） */
  function matIconSize(z) {
    var s = { 3: 20, 4: 22, 5: 26, 6: 30, 7: 34 };
    return s[z] || (z > 7 ? 34 : 20);
  }

  /* ---- 材料卡片（克洛格卡式：区域/坐标/256大图/用途/导航/收集/标记完成） ---- */
  var UPGRADE_NAMES = ['大剑草','潜行鳟鱼','大剑独角仙','铠甲独角仙','毅力胡萝卜','生命松露',
    '精力独角仙','潜行田螺','静静萤火虫','金苹果','苹果','精力鲈鱼','大剑鲤鱼','铠甲鲤鱼',
    '大剑香蕉','宁静公主','远昔骨舌鱼'];
  function usageFor(m) {
    var tags = [];
    if (UPGRADE_NAMES.indexOf(m.cn) >= 0) tags.push('升级素材');
    if (m.cat === '矿岩') tags.push('强化材料');
    else tags.push('料理材料');
    return tags.join(' · ');
  }
  /* 区域：最近地区标注点（无官方边界，近似归属，够用） */
  function nearestRegion(ll) {
    var best = '', bd = Infinity;
    AREAS.forEach(function (a) {
      if (a.layer !== state.layer || !a.name) return;
      var d = (ll[0]-a.x)*(ll[0]-a.x) + (ll[1]-a.y)*(ll[1]-a.y);
      if (d < bd) { bd = d; best = a.name; }
    });
    return best;
  }
  function isCollected(mid, idx) {
    var arr = state.matCollected[mid];
    return arr && arr.indexOf(idx) >= 0;
  }
  function isMatDone(mid, idx) {
    var arr = state.matDone[mid];
    return arr && arr.indexOf(idx) >= 0;
  }
  /* 标记完成 = 单个材料位置（点级），不影响其他位置 */
  function toggleMatDone(mid, idx) {
    var arr = state.matDone[mid] || [];
    var at = arr.indexOf(idx);
    if (at >= 0) arr.splice(at, 1);
    else arr.push(idx);
    if (arr.length) state.matDone[mid] = arr;
    else delete state.matDone[mid];
    saveJson(LS_MAT_DONE, state.matDone);
    renderMatLayer(mid);
  }
  function showMatDetail(m, ll, idx, evt) {
    var pts = (matPointsByLayer[state.layer] || {})[m.id] || [];
    var total = pts.length || 0;
    var gx = Number(ll[1]).toFixed(0), gz = Number(ll[0]).toFixed(0);
    var colBtn = '';
    var MA = window.MAT_AUTO;
    if (MA && MA.isRunning() && MA.isCurrent(m.id, idx)) colBtn = MA.isArrived() ? '已收集，继续' : '停止收集';
    showDetail({
      name: m.cn,
      cat: m.cat + ' · ' + LAYER_NAME[state.layer],
      desc: '',
      img: 'assets/materials/' + m.entry + '.png',
      region: nearestRegion(ll),
      coord: 'X ' + gx + ' · Z ' + gz,
      posText: '第 ' + (idx + 1) + ' / ' + total + ' 个位置',
      usage: usageFor(m),
      isDone: isMatDone(m.id, idx),
      collected: isCollected(m.id, idx),
      onDone: function () { toggleMatDone(m.id, idx); showMatDetail(m, ll, idx, evt); },
      onNav: function () {
        liveToggleNav({ name: m.cn, x: ll[0], y: ll[1], layer: state.layer, type: m.cat });
        toast('第 ' + (idx + 1) + '/' + total + ' 个位置');
      },
      navTarget: { x: ll[0], y: ll[1] },
      colBtn: colBtn,
      onCollect: function () { matCollectClick(m, ll, idx); },
      compendium: (window.TOTK_COMPENDIUM_URL ? window.TOTK_COMPENDIUM_URL + '/items/' + m.entry : ''),
      evt: evt
    });
  }
  /* M4：材料卡「收集」按钮 —— 接入材料收集队列 B（js/mat-auto.js）
     队列未运行：标记当前点已收集 + 启动队列（已收集的点点【已收集】= 直接启动）
     队列运行中：当前目标=该点 → 未到达=停止 / 已到达=确认收集续导；其他点 → 提示不打断 */
  function matCollectClick(m, ll, idx) {
    var MA = window.MAT_AUTO;
    if (!MA) { toast('材料队列未加载'); return; }
    if (MA.isRunning()) {
      if (MA.isCurrent(m.id, idx)) {
        if (MA.isArrived()) MA.confirm();
        else MA.stop();
      } else {
        var c = MA.current();
        var cm = c ? matById[c.mid] : null;
        toast('收集队列正在导航 ' + (cm ? cm.cn : '其他材料') + '，请先停止或完成当前目标');
      }
      return;
    }
    MA.start(m.id, idx, ll);
  }

  function renderMatLayer(mid) {
    if (state.matGroups[mid]) {
      map.removeLayer(state.matGroups[mid]);
      delete state.matGroups[mid];
    }
    if (!state.matSelected[mid] || state.matTab !== 'material') return;
    var bounds = map.getBounds();
    var z = Math.round(map.getZoom());
    var grp = L.layerGroup();
    var m = matById[mid];
    var pts = (matPointsByLayer[state.layer] || {})[mid] || [];
    if (!pts.length) return;

    /* V1.9.0 方向1: z≥7 强制单点显示（绕过 supercluster 聚合，按视口 bbox 直接过滤点位） */
    if (z >= 7) {
      var padV = 60;   // 游戏单位缓冲（图标半宽）
      var west = bounds.getWest() - padV, east = bounds.getEast() + padV;
      var south = bounds.getSouth() - padV, north = bounds.getNorth() + padV;
      var inView = [];
      for (var pi2 = 0; pi2 < pts.length; pi2++) {
        var px = pts[pi2][0], pz = pts[pi2][1];
        if (px >= west && px <= east && pz >= south && pz <= north) inView.push(pi2);
      }
      /* 视口内点数超上限 → 回退聚合（防海量单点卡死） */
      if (inView.length <= 400) {
        var lsize = matIconSize(z);
        for (var vi = 0; vi < inView.length; vi++) {
          var pi3 = inView[vi];
          var ll2 = [pts[pi3][1], pts[pi3][0]];
          var icon2 = L.divIcon({
            className: '',
            html: '<div class="mat-leaf" style="width:' + lsize + 'px;height:' + lsize + 'px;" title="' + esc(m.cn) + '" data-char="' + esc(m.cn[0]) + '"><img src="assets/materials/' + m.entry + '.png" onerror="this.remove()"></div>',
            iconSize: [lsize, lsize], iconAnchor: [lsize / 2, lsize / 2]
          });
          (function (ll3, mid2, id2) {
            var mk = L.marker(ll3, { icon: icon2, riseOnHover: true, bubblingMouseEvents: false });
            if (isCollected(mid2, id2) || isMatDone(mid2, id2)) mk.setOpacity(0.38);
            mk.bindTooltip(m.cn, { direction: 'top', offset: [0, -lsize / 2 - 4], className: 'mk-label' });
            mk.on('click', function (e) { showMatDetail(m, ll3, id2, e); });
            grp.addLayer(mk);
          })(ll2, mid, pi3);
        }
        grp.addTo(map);
        state.matGroups[mid] = grp;
        return;
      }
    }

    /* V1.9.0: 聚合半径按缩放级别动态调整。100%（z3）=96、200-283%（z4~z4.9）=192（同级聚合不拆碎，滚轮连续缩放平滑）；400%（z5）=256；800%（z6）=128 过渡平滑；z7 超限回退用 8px */
    var r = z >= 7 ? 8 : (z <= 3 ? 96 : z < 5 ? 192 : z === 5 ? 256 : 128);
    var idx = getMatClusterer(mid, state.layer, r);
    if (!idx) return;
    var idxr = idx;
    // supercluster coords are [X*FX, Z*FZ], map bounds are game coords
    var padX = 800 * FX, padZ = 800 * FZ;
    var fakeBbox = [
      bounds.getWest() * FX - padX, bounds.getSouth() * FZ - padZ,
      bounds.getEast() * FX + padX, bounds.getNorth() * FZ + padZ
    ];
    var clusters = idxr.getClusters(fakeBbox, z);
    clusters.forEach(function (c) {
      var coords = c.geometry.coordinates;
      var gx = coords[0] / FX, gz = coords[1] / FZ;
      var latlng = [gz, gx];
      var props = c.properties;
      if (props.cluster) {
        /* V1.9.0: 已展开的聚合（z7 点击徽标后）→ 渲染其内部所有点位为单点 */
        var expSet = state.matExpanded[mid];
        if (expSet && expSet[c.id] && z >= 7) {
          var leaves = idxr.getLeaves(c.id, Infinity) || [];
          for (var li = 0; li < leaves.length; li++) {
            var lf = leaves[li];
            var lc = lf.geometry.coordinates;
            var llf = [lc[1] / FZ, lc[0] / FX];
            var lsize = matIconSize(z);
            var licon = L.divIcon({
              className: '',
              html: '<div class="mat-leaf" style="width:' + lsize + 'px;height:' + lsize + 'px;" title="' + esc(m.cn) + '" data-char="' + esc(m.cn[0]) + '"><img src="assets/materials/' + m.entry + '.png" onerror="this.remove()"></div>',
              iconSize: [lsize, lsize], iconAnchor: [lsize / 2, lsize / 2]
            });
            (function (ll3, mid2, id2) {
              var mk2 = L.marker(ll3, { icon: licon, riseOnHover: true, bubblingMouseEvents: false });
              if (isCollected(mid2, id2) || isMatDone(mid2, id2)) mk2.setOpacity(0.38);
              mk2.bindTooltip(m.cn, { direction: 'top', offset: [0, -lsize / 2 - 4], className: 'mk-label' });
              mk2.on('click', function (e) { showMatDetail(m, ll3, id2, e); });
              grp.addLayer(mk2);
            })(llf, mid, lf.id);
          }
          return;
        }
        var size = matIconSize(z) + (props.point_count >= 100 ? 12 : props.point_count >= 20 ? 6 : 0);
        var icon = L.divIcon({
          className: '',
          html: '<div class="mat-cluster" style="width:' + size + 'px;height:' + size + 'px;" data-char="' + esc(m.cn[0]) + '"><img src="assets/materials/' + m.entry + '.png" onerror="this.remove()"><span>' + props.point_count + '</span></div>',
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        });
        (function (ll, sz) {
          var mk = L.marker(ll, { icon: icon, riseOnHover: true, bubblingMouseEvents: false });
          mk.bindTooltip(m.cn + ' · ' + props.point_count + '点', { direction: 'top', offset: [0, -sz / 2 - 4] });
          mk.on('click', function () {
            /* V1.9.0: z7 已无法再放大 → 展开聚合为单点；z<7 仍逐级放大 */
            if (map.getZoom() >= 7) expandMatCluster(mid, c.id);
            else map.flyTo(ll, Math.min(map.getZoom() + 1, 7), { duration: 0.3 });
          });
          grp.addLayer(mk);
        })(latlng, size);
      } else {
        var lsize = matIconSize(z);
        var icon2 = L.divIcon({
          className: '',
          html: '<div class="mat-leaf" style="width:' + lsize + 'px;height:' + lsize + 'px;" title="' + esc(m.cn) + '" data-char="' + esc(m.cn[0]) + '"><img src="assets/materials/' + m.entry + '.png" onerror="this.remove()"></div>',
          iconSize: [lsize, lsize], iconAnchor: [lsize / 2, lsize / 2]
        });
        (function (ll, mid, idx) {
          var mk = L.marker(ll, { icon: icon2, riseOnHover: true, bubblingMouseEvents: false });
          if (isCollected(mid, idx) || isMatDone(mid, idx)) mk.setOpacity(0.38);
          mk.bindTooltip(m.cn, { direction: 'top', offset: [0, -lsize / 2 - 4], className: 'mk-label' });
          mk.on('click', function (e) {
            showMatDetail(m, ll, idx, e);
            // Sidebar linkage: expand cat, scroll to item, flash
            var listEl = $('matList');
            if (listEl) {
              var catBody = listEl.querySelector('.mat-cat[data-cat="' + m.cat + '"] .mat-cat-body');
              if (catBody) {
                catBody.parentElement.classList.remove('collapsed');
                var item = listEl.querySelector('.mat-item[data-mat="' + mid + '"]');
                if (item) {
                  item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                  item.classList.remove('flash');
                  void item.offsetWidth;
                  item.classList.add('flash');
                }
              }
            }
          });
          grp.addLayer(mk);
        })(latlng, mid, c.id);
      }
    });
    grp.addTo(map);
    state.matGroups[mid] = grp;
  }

  /* V1.9.0: 聚合徽标点击 —— z7 超限回退场景下展开为单点（getLeaves 取聚合内全部位置）；z<7 由点击处 flyTo 逐级放大 */
  function expandMatCluster(mid, cid) {
    if (!state.matExpanded[mid]) state.matExpanded[mid] = {};
    state.matExpanded[mid][cid] = true;
    renderMatLayer(mid);
    toast('已展开聚合点位（' + LAYER_NAME[state.layer] + '），点击单个材料查看');
  }

  function renderMaterials() {
    if (state.matTab !== 'material') return;
    for (var mid in state.matSelected) renderMatLayer(Number(mid));
  }

  function buildMatPanel() {
    var list = $('matList');
    if (!list) return;
    var layerId = state.layer;
    var byCat = {};
    MAT_CAT_ORDER.forEach(function (c) { byCat[c] = []; });
    (MATS.materials || []).forEach(function (m) {
      var n = matCountOnLayer(m.id, layerId);
      if (n <= 0) return;
      if (state.matFavOnly && !state.matFav[m.id]) return;
      if (!byCat[m.cat]) byCat[m.cat] = [];
      byCat[m.cat].push({ m: m, n: n });
    });

    var html = '';
    var favCount = 0;
    (MATS.materials || []).forEach(function (m) {
      if (state.matFav[m.id] && matCountOnLayer(m.id, layerId) > 0) favCount++;
    });
    html += '<div class="mat-fav-filter' + (state.matFavOnly ? ' on' : '') + '" id="matFavFilter">';
    html += '<span class="mat-fav-star">' + (state.matFavOnly ? '\u2605' : '\u2606') + '</span>';
    html += '<span>只看收藏 (' + favCount + ')</span>';
    html += '</div>';

    MAT_CAT_ORDER.forEach(function (cat) {
      var items = byCat[cat];
      if (!items || !items.length) return;
      var collapsed = state.matCollapsed[cat] ? ' collapsed' : '';
      var layerTotal = items.reduce(function (s, it) { return s + it.n; }, 0);
      html += '<div class="mat-cat' + collapsed + '" data-cat="' + esc(cat) + '">';
      html += '<div class="mat-cat-head">';
      html += '<span class="mat-cat-arrow">▼</span>';
      html += '<span class="mat-cat-name">' + esc(cat) + '</span>';
      html += '<span class="mat-cat-count">' + items.length + '种 · ' + layerTotal + '点</span>';
      html += '</div><div class="mat-cat-body mat-grid">';
      items.forEach(function (it) {
        var m = it.m;
        var on = state.matSelected[m.id] ? ' checked' : '';
        var fav = state.matFav[m.id] ? ' fav' : '';
        html += '<div class="mat-item' + on + fav + '" data-mat="' + m.id + '">';
        html += '<span class="mat-star" data-fav="' + m.id + '">' + (state.matFav[m.id] ? '\u2605' : '\u2606') + '</span>';
        html += '<span class="mat-item-name">' + esc(m.cn) + '</span>';
        html += '<span class="mat-item-count">' + it.n + '</span>';
        html += '</div>';
      });
      html += '</div></div>';
    });
    list.innerHTML = html || '<div class="sr-empty">当前图层暂无材料</div>';

    var ff = $('matFavFilter');
    if (ff) ff.addEventListener('click', function () {
      state.matFavOnly = !state.matFavOnly;
      buildMatPanel();
    });

    Array.prototype.forEach.call(list.querySelectorAll('.mat-cat-head'), function (hd) {
      hd.addEventListener('click', function (e) {
        if (e.target.tagName === 'INPUT' || e.target.classList.contains('mat-star')) return;
        var cat = hd.parentElement;
        var name = cat.getAttribute('data-cat');
        state.matCollapsed[name] = !state.matCollapsed[name];
        cat.classList.toggle('collapsed');
      });
    });
    Array.prototype.forEach.call(list.querySelectorAll('.mat-item'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.classList.contains('mat-star')) {
          var mid = Number(e.target.getAttribute('data-fav'));
          if (state.matFav[mid]) delete state.matFav[mid];
          else state.matFav[mid] = true;
          saveJson(LS_MAT_FAV, state.matFav);
          buildMatPanel();
          return;
        }
        var mid = Number(el.getAttribute('data-mat'));
        var nowOn = !state.matSelected[mid];
        if (nowOn) state.matSelected[mid] = true;
        else delete state.matSelected[mid];
        saveJson(LS_MAT, state.matSelected);
        el.classList.toggle('checked', nowOn);
        if (nowOn && state.matDone[mid]) {
          // 材料会刷新：重新勾选时清除该材料点级“标记完成”，全部位置重新显示（可重新采集）
          delete state.matDone[mid];
          saveJson(LS_MAT_DONE, state.matDone);
        }
        renderMatLayer(mid);
        updateMatCount();
      });
    });
    updateMatCount();
  }

  function updateMatCount() {
    var el = $('matCount');
    if (!el) return;
    var n = 0, total = 0;
    (MATS.materials || []).forEach(function (m) {
      if (matCountOnLayer(m.id, state.layer) <= 0) return;
      total++;
      if (state.matSelected[m.id]) n++;
    });
    el.textContent = n + '/' + total + ' 材料';
  }

  function setTab(tab) {
    state.matTab = tab;
    Array.prototype.forEach.call($('sideTabs').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    /* 探索搜索框只在探索 Tab 显示，材料 Tab 隐藏（V1.7.2） */
    var globalSearch = document.querySelector('.search-box');
    if (globalSearch) globalSearch.classList.toggle('hidden', tab === 'material');
    var srBox = $('searchResult');
    if (srBox) srBox.classList.add('hidden');
    var explorePane = $('explorePane'), matPane = $('materialPane');
    if (tab === 'material') {
      explorePane.classList.add('hidden');
      matPane.classList.remove('hidden');
      // V1.7.5: 切到材料 Tab 时保留已勾选的探索标点（神庙/鸟望塔等），与材料位置叠加显示，便于同时定位
      buildMatPanel();
      renderMaterials();
    } else {
      matPane.classList.add('hidden');
      explorePane.classList.remove('hidden');
      for (var mid in state.matGroups) map.removeLayer(state.matGroups[mid]);
      state.matGroups = {};
      renderMarkers();
    }
  }
  $('sideTabs').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    setTab(btn.getAttribute('data-tab'));
  });

  $('matAll').addEventListener('click', function () {
    (MATS.materials || []).forEach(function (m) {
      if (matCountOnLayer(m.id, state.layer) > 0) state.matSelected[m.id] = true;
    });
    saveJson(LS_MAT, state.matSelected);
    buildMatPanel();
    renderMaterials();
  });
  $('matClear').addEventListener('click', function () {
    state.matSelected = {};
    saveJson(LS_MAT, state.matSelected);
    buildMatPanel();
    for (var mid in state.matGroups) map.removeLayer(state.matGroups[mid]);
    state.matGroups = {};
    updateMatCount();
  });

  var matSearchTimer = null;
  $('matSearchInput').addEventListener('input', function () {
    var q = this.value.trim();
    var box = $('matSearchResult');
    if (matSearchTimer) clearTimeout(matSearchTimer);
    if (!q) { box.classList.add('hidden'); return; }
    matSearchTimer = setTimeout(function () {
      var ql = q.toLowerCase();
      var hits = [];
      (MATS.materials || []).forEach(function (m) {
        if (hits.length >= 30) return;
        if (matCountOnLayer(m.id, state.layer) <= 0) return;
        if (m.cn.toLowerCase().indexOf(ql) >= 0) hits.push(m);
      });
      if (!hits.length) {
        box.innerHTML = '<div class="sr-empty">未找到相关材料</div>';
      } else {
        var html = '';
        hits.forEach(function (m) {
          html += '<div class="sr-item" data-mat="' + m.id + '">' +
            '<span class="sr-name">' + esc(m.cn) + '</span>' +
            '<span class="sr-cat">' + esc(m.cat) + ' · ' + matCountOnLayer(m.id, state.layer) + '点</span></div>';
        });
        box.innerHTML = html;
      }
      box.classList.remove('hidden');
      Array.prototype.forEach.call(box.querySelectorAll('.sr-item'), function (el) {
        el.addEventListener('click', function () {
          var mid = Number(el.getAttribute('data-mat'));
          state.matSelected[mid] = true;
          saveJson(LS_MAT, state.matSelected);
          box.classList.add('hidden');
          $('matSearchInput').value = '';
          buildMatPanel();
          renderMatLayer(mid);
          toast('已勾选「' + matById[mid].cn + '」，放大地图查看具体位置');
        });
      });
    }, 200);
  });
  document.addEventListener('click', function (e) {
    var box = $('matSearchResult');
    if (box && !box.classList.contains('hidden') && !e.target.closest('.search-box')) {
      box.classList.add('hidden');
    }
  });

  var matRenderTimer = null;
  map.on('moveend zoomend', function () {
    if (state.matTab !== 'material') return;
    if (matRenderTimer) clearTimeout(matRenderTimer);
    matRenderTimer = setTimeout(renderMaterials, 120);
  });


  /* ---------------- 图层工具栏（全选/清空 + 计数） ---------------- */
  function updateLayerCount() {
    var el = $('layerCount');
    if (!el) return;
    var cats = catsOfLayer(state.layer);
    var n = 0;
    cats.forEach(function (c) { if (state.selected[c.id]) n++; });
    el.textContent = n + '/' + cats.length + ' 图层';
  }
  var ltAll = $('ltAll');
  var ltClear = $('ltClear');
  if (ltAll) ltAll.addEventListener('click', function () {
    catsOfLayer(state.layer).forEach(function (c) { state.selected[c.id] = true; });
    saveSelected();
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });
  if (ltClear) ltClear.addEventListener('click', function () {
    catsOfLayer(state.layer).forEach(function (c) { delete state.selected[c.id]; });
    saveSelected();
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });

  /* ---------------- 复制到剪贴板（通用） ----------------
   * navigator.clipboard 在 file:// 与非安全上下文中不可用/会 reject，
   * 故保留 execCommand('copy') 兜底（项目既有做法）。 */
  function copyText(txt, btn, doneText, cls) {
    function flash() {
      if (!btn) { if (doneText) flashHint(doneText); return; }
      var old = btn.textContent;
      btn.textContent = doneText || '已复制';
      if (cls) btn.classList.add(cls);
      setTimeout(function () { btn.textContent = old; if (cls) btn.classList.remove(cls); }, 1500);
    }
    function fallbackCopy() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      flash();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(flash).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  /* ---------------- 帮助弹窗路径复制按钮 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll('.copy-btn'), function (b) {
    b.addEventListener('click', function () {
      var txt = b.getAttribute('data-copy') || '';
      function flashCopy(btn) {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1500);
      }
      function fallbackCopy(btn) {
        var ta = document.createElement('textarea');
        ta.value = txt;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        flashCopy(btn);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { flashCopy(b); }).catch(function () { fallbackCopy(b); });
      } else {
        fallbackCopy(b);
      }
    });
  });

  /* 初始图层计数 */
  updateLayerCount();



  /* ---------------- 探索度展开/收起 ---------------- */
  var progressHead = $('progressHead');
  if (progressHead) progressHead.addEventListener('click', function () {
    $('progressSection').classList.toggle('collapsed');
  });

  /* ---------------- URL 深链（联动超级全能互动地图图鉴站） ----------------
     ?actor=Item_PlantGet_O  材料深链：自动切材料 Tab、勾选该材料、切到有点的层、定位第一个刷点并开详情卡
     ?q=海拉鲁城堡           探索深链：自动填充探索搜索框并搜索定位
     来源：totk-site 图鉴「在地图上查看」按钮 / 站外分享链接 */
  (function () {
    var sp;
    try { sp = new URLSearchParams(location.search); } catch (e) { return; }
    var actor = sp.get('actor');
    var q = sp.get('q');
    if (!actor && !q) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}  // 清参数，防刷新重复定位

    if (q) {
      var inp = $('searchInput');
      if (inp) { inp.value = q; doSearch(q); }
    }

    if (actor) {
      var hit = null;
      (MATS.materials || []).forEach(function (m) {
        if (hit) return;
        if (m.entry === actor || (m.actors || []).indexOf(actor) >= 0) hit = m;
      });
      if (!hit) { toast('未找到材料：' + actor); return; }
      // 切到该材料有点的层：地上 18 > 天空 20 > 地下 19
      var order = [18, 20, 19], pick = null;
      for (var i = 0; i < order.length; i++) {
        if (matCountOnLayer(hit.id, order[i]) > 0) { pick = order[i]; break; }
      }
      state.matSelected[hit.id] = true;
      saveJson(LS_MAT, state.matSelected);
      setTab('material');
      if (pick && pick !== state.layer) switchLayer(pick, true);
      buildMatPanel();
      renderMatLayer(hit.id);
      renderMaterials();
      var pts = (matPointsByLayer[state.layer] || {})[hit.id] || [];
      if (pts.length) {
        var ll = [pts[0][1], pts[0][0]];
        map.flyTo(ll, 7, { animate: true, duration: 1.2 });
        setTimeout(function () { showMatDetail(hit, ll, 0, null); }, 1300);
      }
      toast('已定位材料「' + hit.cn + '」' + (pick ? '（' + LAYER_NAME[pick] + '）' : ''));
    }
  })();

})();
