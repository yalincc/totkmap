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

  var VERSION = 'TOTKMAP V1.4.2';
  var LS_DONE = 'totkmap_done_v1';
  var LS_CUSTOM = 'totkmap_custom_v1';
  var LS_LAYER = 'totkmap_layer_v1';
  var LS_NAMES = 'totkmap_names_v1';
  var LS_SAVE = 'totkmap_save_v1';      // 存档同步结果（仅保存收集计数）

  var LAYER_KEY = { 18: 'ground', 19: 'depths', 20: 'sky' };
  var LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' };
  var GROUP_NAME = { 1: '位置', 2: '收集', 3: '装备', 4: '地点', 5: '怪物' };
  var GROUP_ORDER = [1, 2, 3, 4, 5];

  var LABEL_MIN_ZOOM = 4;   // 名称标签显示的最低缩放级别
  var MAX_ZOOM = 7;
  var MIN_ZOOM = 3;

  var state = {
    layer: 18,
    selected: {},          // catalogId -> true（选中的分类）
    done: {},              // markerId -> true（已完成）
    custom: [],            // 自定义标点 [{id,name,desc,x,y,layer}]
    filter: 'all',         // all | done | undone
    showNames: true,
    adding: false,         // 放置自定义标点模式
    groups: {},            // catalogId -> L.LayerGroup
    markers: {},           // markerId -> L.Marker
    customMarks: [],       // 自定义标点 L.Marker
    areaMarks: [],         // 区域名 L.Marker
    current: null,
    lastSearch: [],
    save: null,            // 存档同步结果 {分类名: {done, total}} 或 null
    saveVersion: null      // 存档版本（如 v1.1.x/v1.2.x）
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
    doubleClickZoom: false
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  var tileLayer = null;
  function setTileLayer(layerId) {
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer('tiles_obj/' + LAYER_KEY[layerId] + '/{z}/{x}_{y}.png', {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 7,
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
    var groupName = {};
    relIdx.forEach(function (g, i) {
      groupName[g] = GROUP_NAME[GROUP_ORDER[i]] || '其他';
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
        renderMarkers();
        updateCount();
      });
    });
  }

  function selectDefault() {
    state.selected = {};
    var def = { 18: [62, 63, 65, 66, 67, 68, 73, 75, 76, 77, 78, 79], 19: [97, 190, 99, 100, 101, 104], 20: [109, 111, 118, 120, 205, 173] };
    var list = def[state.layer] || [];
    catsOfLayer(state.layer).forEach(function (c) {
      if (list.indexOf(c.id) >= 0) state.selected[c.id] = true;
    });
    if (!Object.keys(state.selected).length) {
      // 兜底：默认选中每层前 3 个分类
      catsOfLayer(state.layer).slice(0, 3).forEach(function (c) { state.selected[c.id] = true; });
    }
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
      var icon = iconFor(cat);
      var opt = { riseOnHover: true };
      if (icon) opt.icon = icon;
      var mk = L.marker([m.x, m.y], opt);
      if (isDone) mk.setOpacity(0.38);
      mk.bindTooltip(m.name || m.full, {
        direction: 'top',
        offset: [0, -12],
        className: 'mk-label' + (isDone ? ' done-label' : '')
      });
      (function (mm) {
        mk.on('click', function () { openDetail(mm); });
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
          html: esc(a.name),
          iconSize: null
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

  /* ---------------- 详情弹窗 ---------------- */
  function stripHtml(s) {
    if (!s) return '';
    var d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent || d.innerText || '';
  }

  function showDetail(name, catName, iconUrl, desc, isDone, onDone) {
    $('detailName').textContent = name;
    $('detailCat').textContent = catName;
    var img = $('detailIcon');
    if (iconUrl) { img.src = iconUrl; img.style.display = ''; }
    else img.style.display = 'none';
    $('detailDesc').textContent = stripHtml(desc) || '暂无说明。';
    var btn = $('detailDone');
    if (onDone) {
      btn.style.display = '';
      btn.textContent = isDone ? '取消完成标记' : '标记为已完成';
      btn.className = 'btn primary' + (isDone ? ' done' : '');
      btn.onclick = onDone;
    } else {
      btn.style.display = 'none';
    }
    $('detail').classList.remove('hidden');
  }

  function openDetail(m) {
    state.current = m;
    var cat = catById(state.layer, m.cat);
    var isDone = !!state.done[m.id];
    showDetail(
      m.name || m.full,
      (cat ? cat.name : '未知分类') + ' · ' + LAYER_NAME[state.layer],
      cat && cat.icon ? 'assets/icons/' + cat.icon : null,
      m.desc || '',
      isDone,
      function () {
        if (state.done[m.id]) delete state.done[m.id];
        else state.done[m.id] = true;
        saveDone();
        var mk = state.markers[m.id];
        if (mk) {
          mk.setOpacity(state.done[m.id] ? 0.38 : 1);
          mk.unbindTooltip();
          mk.bindTooltip(m.name || m.full, {
            direction: 'top', offset: [0, -12],
            className: 'mk-label' + (state.done[m.id] ? ' done-label' : '')
          });
        }
        buildCatalogPanel();
        updateCount();
        if (state.filter !== 'all') renderMarkers();
        openDetail(m);
      }
    );
  }

  function openCustomDetail(c) {
    state.current = c;
    showDetail(c.name, '自定义标点 · ' + LAYER_NAME[state.layer], null, c.desc || '暂无说明。', false, null);
  }

  $('detailClose').addEventListener('click', function () {
    $('detail').classList.add('hidden');
    state.current = null;
  });
  $('detailCopy').addEventListener('click', function () {
    var m = state.current;
    if (!m) return;
    var text = (m.name || '') + ' 坐标(' + Number(m.x).toFixed(2) + ', ' + Number(m.y).toFixed(2) + ')';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('坐标已复制'); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('坐标已复制');
      }
    } catch (e) { toast('复制失败'); }
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

  /* ---------------- 图层切换 ---------------- */
  $('layerSwitch').addEventListener('click', function (e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var id = Number(btn.getAttribute('data-layer'));
    if (id === state.layer) return;
    switchLayer(id);
  });

  function switchLayer(id) {
    state.layer = id;
    saveJson(LS_LAYER, id);
    Array.prototype.forEach.call($('layerSwitch').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-layer')) === id);
    });
    $('detail').classList.add('hidden');
    $('searchResult').classList.add('hidden');
    $('searchInput').value = '';
    setTileLayer(id);
    selectDefault();
    buildCatalogPanel();
    renderAreas();
    renderMarkers();
    updateCount();
    updateLayerCount();
    map.setView(CENTER, 3);
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
    if (!state.adding) return;
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
  map.on('moveend zoomend', function () { refreshLabels(); updateAreas(); });

  /* ---------------- 初始化 ---------------- */
  loadDone();
  loadCustom();
  loadSaveSync();

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
  renderMarkers();
  updateCount();
  map.setView(CENTER, 3);

  // 存档同步按钮初始状态
  applySaveSync(true);

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
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });
  if (ltClear) ltClear.addEventListener('click', function () {
    catsOfLayer(state.layer).forEach(function (c) { delete state.selected[c.id]; });
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });

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
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });
  if (ltClear) ltClear.addEventListener('click', function () {
    catsOfLayer(state.layer).forEach(function (c) { delete state.selected[c.id]; });
    buildCatalogPanel(); renderMarkers(); updateCount(); updateLayerCount();
  });

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

})();
