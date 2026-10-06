/* ============================================================
 * 防具面板（V2.1 M6.5）
 * ------------------------------------------------------------
 * 侧栏第三个 Tab「防具」，照材料面板的结构与样式语言：
 *   搜索 + 获取方式分档 + 图标网格 + 套装链接
 *
 * ★ 命名：叫「防具」不叫「装备」—— 防具是唯一不会损坏的装备，
 *   武器和盾牌用久了会坏。这是分类的根本区别，不是我随手起的。
 *
 * ★ 套装展示：老大明确要求**每件独立展示，不合并成一格**
 *   （"套装显示三个图标，分开展示。有不少套装的位置相差很远，
 *     没必要强行合并"）。
 *   同套部件之间用「套装链接」跳转 —— 一个套装内三件往往散在地图各处，
 *   这是唯一能让人快速凑齐的手段。
 *
 * 与 app.js 完全隔离（照 task-panel.js 的做法）：
 *   - 不改 app.js 任何逻辑，本模块自己渲染进#armorList
 *   - 选中状态存自己的 localStorage key
 *   - 想下线：删index.html 里本模块的 script 标签
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.ArmorData;
  if (!D) { console.warn('[防具] ArmorData 未加载，面板不初始化'); return; }

  var LS = 'totkmap_armor_v1';
  var state = { q: '', how: '', layer: null, sel: {}, collapsed: {} };
  var onPick = null;/* 外部（app.js）注册的「勾选后画地图点」回调 */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  function currentLayer() {
    var s = global.TOTK && global.TOTK.state;
    if (s && s.layer != null) return s.layer;
    var a = document.querySelector('#layerSwitch button.active');
    return a ? Number(a.getAttribute('data-layer')) : 18;
  }

  function load() {
    try { state.sel = JSON.parse(localStorage.getItem(LS) || '{}') || {}; }
    catch (e) { state.sel = {}; }
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify(state.sel)); } catch (e) { /* 隐私模式 */ }
  }

  /* ---------- 数据筛选 ---------- */
  function list() {
    var L = state.layer;
    var arr = D.all.filter(function (r) {
      /* 图层联动：跟地图当前图层走。防具可能跨层（同套装三件不在同层），
         所以每件各自按自己的 layer 过滤，而不是按套装整体。 */
      if (L != null && r.layer !== L) return false;
      if (state.how && r.how !== state.how) return false;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name || '').toLowerCase().indexOf(q) < 0
          && (r.set || '').toLowerCase().indexOf(q) < 0
          && (r.how || '').indexOf(q) < 0) return false;
      }
      return true;
    });
    /* 排序：套装名 → 部位（头/身/腿），同套挨着放才看得出是一套 */
    var order = { 头部: 0, 上身: 1, 下身: 2 };
    arr.sort(function (x, y) {
      if (x.set !== y.set) return (x.set || '').localeCompare(y.set || '', 'zh');
      return (order[x.slot] || 9) - (order[y.slot] || 9);
    });
    return arr;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var box = $('armorList');
    if (!box) return;
    var arr = list();

    /* 计数：当前筛选下多少件 / 已勾选多少 */
    var cnt = $('armorCount');
    if (cnt) {
      var on = arr.filter(function (r) { return state.sel[r.key]; }).length;
      cnt.textContent = on + '/' + arr.length + ' 防具';
    }

    if (!arr.length) {
      box.innerHTML = '<div class="sr-empty">当前图层 / 筛选下暂无防具</div>';
      bindGrid();
      return;
    }

    /* 按套装分段。老大要「每件独立展示」，所以不把三件折叠成一格，
       只是用一个小标题把同套的挨在一起，点标题能跳该套第一件。 */
    var html = '';
    var lastSet = null;
    arr.forEach(function (r) {
      if (r.set !== lastSet) {
        lastSet = r.set;
        var set = D.setOf(r.setId);
        var n = set ? set.total : 1;
        html += '<div class="arm-set-h"' + (n > 1 ? ' data-set="' + esc(r.setId) + '"' : '') + '>'
          + '<span class="arm-set-n">' + esc(r.set || '未分组') + '</span>'
          + (n > 1 ? '<span class="arm-set-c">套装 ' + n + ' 件</span>' : '')
          + '</div>';
      }
      var on = state.sel[r.key] ? ' checked' : '';
      html += '<div class="arm-item' + on + '" data-armor="' + esc(r.key) + '"'
        + ' title="' + esc(r.name + '（' + r.slot + '）· ' + (r.how || '未知')) + '">'
        /* ★ 不用 loading="lazy"：面板在侧栏的滚动容器里，
           视口外的懒加载图浏览器压根不会去拉 —— 验收里读naturalWidth
           全是 0，看着像破图，其实是懒加载没触发。
           136 张图共 4MB，一次性加载对本地应用完全可接受。 */
        + '<img class="arm-ic" src="' + esc(r.icon || '') + '" alt="">'
        + '<span class="arm-n">' + esc(r.name) + '</span>'
        + '<span class="arm-m">' + esc(r.slot) + (r.upgradeable ? ' · 可升' + r.upgrade.maxLevel : '') + '</span>'
        + '</div>';
    });
    box.innerHTML = html;
    bindGrid();
  }

  function bindGrid() {
    var box = $('armorList');
    if (!box) return;

    Array.prototype.forEach.call(box.querySelectorAll('[data-armor]'), function (el) {
      el.addEventListener('click', function (e) {
        var key = el.getAttribute('data-armor');
        /* 单击= 选中/取消（勾上后地图画点）；双击 = 直接开卡片。
           分开是因为「勾选」是批量操作，「看详情」是单件行为，
           合成一个手势会让批量勾选变得危险。 */
        if (e.detail >= 2) {
          openCard(key);
          return;
        }
        state.sel[key] = !state.sel[key];
        save();
        render();
        if (onPick) onPick();
      });
    });

    /* 套装小标题：跳到该套第一件 */
    Array.prototype.forEach.call(box.querySelectorAll('.arm-set-h[data-set]'), function (el) {
      el.addEventListener('click', function () {
        var sid = el.getAttribute('data-set');
        var set = D.setOf(sid);
        if (!set || !set.items.length) return;
        var first = set.items[0];
        var target = box.querySelector('[data-armor="' + first.key + '"]');
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.classList.add('flash');
          setTimeout(function () { target.classList.remove('flash'); }, 900);
        }
      });
    });
  }

  function openCard(key) {
    var r = D.byKey(key);
    if (!r) return;
    var C = global.ArmorCard;
    if (C && C.open) C.open(r);
  }

  /* ---------- 获取方式筛选条 ---------- */
  function renderHow() {
    var box = $('armorHow');
    if (!box) return;
    var L = state.layer;
    /* 每个档在当前图层下有多少件 —— 数字会随图层变，
       不然会出现「点进去发现 0 件」的空档。 */
    var cnt = {};
    D.all.forEach(function (r) {
      if (L != null && r.layer !== L) return;
      var h = r.how || '其他';
      cnt[h] = (cnt[h] || 0) + 1;
    });
    var html = '<button type="button" class="arm-h' + (state.how ? '' : ' on') +
      '" data-how="">全部</button>';
    D.howList().forEach(function (x) {
      if (!cnt[x.how]) return;
      html += '<button type="button" class="arm-h' + (state.how === x.how ? ' on' : '') +
        '" data-how="' + esc(x.how) + '">' + esc(x.how) +
        '<span class="arm-h-n">' + cnt[x.how] + '</span></button>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('[data-how]'), function (b) {
      b.addEventListener('click', function () {
        state.how = b.getAttribute('data-how');
        renderHow();
        render();
      });
    });
  }

  /* ---------- 全选/清空 ---------- */
  function allOrClear(sel) {
    list().forEach(function (r) { state.sel[r.key] = sel; });
    save();
    render();
    if (onPick) onPick();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    var pane = $('armorPane');
    if (!pane) return;
    load();

    var inp = $('armorSearch');
    if (inp) {
      inp.addEventListener('input', function () {
        state.q = inp.value || '';
        render();
      });
    }
    var all = $('armorAll'), clr = $('armorClear');
    if (all) all.addEventListener('click', function () { allOrClear(true); });
    if (clr) clr.addEventListener('click', function () { allOrClear(false); });

    /* 图层切换时重建（面板跟着地图走，跟材料一致） */
    var ls = $('layerSwitch');
    if (ls) ls.addEventListener('click', function () {
      setTimeout(function () {
        if (state.layer == null) return;
        state.layer = currentLayer();
        renderHow();
        render();
      }, 30);
    });

    /* 面板显示时才同步图层，避免一进页面就算错 */
    renderHow();
    render();
  }

  /* ---------- 对外 ---------- */
  global.ArmorPanel = {
    init: init,
    show: function () {
      state.layer = currentLayer();
      renderHow();
      render();
    },
    setPickHandler: function (fn) { onPick = fn; },
    selected: function () { return state.sel; },
    isSel: function (k) { return !!state.sel[k]; },
    setSel: function (k, v) {
      state.sel[k] = !!v; save();
      render();
    },
    open: openCard,
    stats: function () { return D.stats; }
  };
})(window);