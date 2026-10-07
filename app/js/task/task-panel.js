/* ============================================================
 * 任务板块 · M3 · 侧栏面板（TOTKMAP V2.1）
 * ------------------------------------------------------------
 * 在 app.js 的分类列表末尾注入一个「任务」大组，内含 4 个小分类：
 *   主剧情挑战 / 情节挑战 / 神庙挑战 / 迷你挑战（= 游戏「冒险笔记」四档）
 * 勾选后在地图上画任务点，点击弹任务卡片。
 *
 * ★ 与 app.js 完全隔离
 *   - 不改app.js 任何逻辑；分类项由本模块自己渲染进 #catalogList
 *   - 选中状态存window.TOTK_TASK_SEL（localStorage），与 app.js 的
 *     分类勾选完全分开，互不干扰
 *   - 想彻底下线任务板块：删index.html 里本模块 + 面板的 script 标签
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.TaskData;
  if (!D) { console.warn('[任务板块] TaskData 未加载，面板不初始化'); return; }

  var LS = 'totkmap_task_sel_v1';

  var map = null;
  var group = null;          // 任务点的 LayerGroup
  var curLayer = 18;
  var ready = false;
  var lastSig = '';
  /* 完成态版本号：TaskDone 每次变化（手动标记/ 载入存档）自增，
     混进 signature 里做重绘判据。见 signature() 注释。 */
  var doneRev = 0;
  var userOn = {};           // {layer: {cat:true}} 用户勾选意图
  /* task key → Leaflet marker 引用。每次 render() 重建 layerGroup 时清空。
   * 用途：TaskPanel.locate() 要把**真实 marker** 交给 app.js 的 gotoMarker，
   * 否则光圈（按 marker 屏幕位置画的独立光圈 DOM）不会出现。 */
  var mkIndex = {};

  /* ---------- 小工具 ---------- */
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

  /* ---------- 选中状态 ---------- */
  /* ★ 迁移（2026-10-07 迷你挑战单列时加）
   *
   * 症状：改分类后，任务面板五档全部显示 0 且勾不上，地图上一个任务点都不画。
   * 原因：localStorage 里存的是**旧格式的键**，而新代码按**官方四档 group** 查。
   *   键名对不上 → isOn() 全返回 false → 用户勾选意图整个失效。
   *
   * ★ 这类坑我踩过两次（M6.9 迷你挑战单列 / 本次改官方四档），所以现在
   *   把历次旧键都列全，以后再改分类名只需往这里加一行。
   *
   * 迁移对照：
   *   Main         → 主剧情挑战   （旧「主线」，官方叫法不同）
   *   ImportantMini→ 情节挑战     （旧「重要支线」）
   *   Sub          → 神庙挑战     （旧「普通支线」）
   *   Other/迷你挑战 → 迷你挑战
   *   ⚠ 「其他」这一档已随 FindSunaNui2 删除而消失（2026-10-07），
   *     旧存储里若有「其他」，映射到迷你挑战（它本来就是被误分进去的）。
   */
  var LEGACY_CAT_MAP = {
    'Main': '主剧情挑战',
    'ImportantMini': '情节挑战',
    'Sub': '神庙挑战',
    'Other': '迷你挑战',
    '主线': '主剧情挑战',
    '重要支线': '情节挑战',
    '普通支线': '神庙挑战',
    '其他': '迷你挑战'
  };

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(LS); } catch (e) { /* 隐私模式 */ }
    try { userOn = JSON.parse(raw || '{}') || {}; }
    catch (e) { userOn = {}; }

    /* 旧键迁移：把 ROM cat 名（Main/Sub/…）改成中文 group。
       改键命名而不迁移存量localStorage，勾选意图会整个失效。 */
    var needSave = false;
    Object.keys(userOn).forEach(function (layer) {
      var m = userOn[layer];
      if (!m || typeof m !== 'object') return;
      Object.keys(m).forEach(function (k) {
        if (LEGACY_CAT_MAP[k] && LEGACY_CAT_MAP[k] !== k) {
          m[LEGACY_CAT_MAP[k]] = m[k];
          delete m[k];
          needSave = true;
        }
      });
    });

    /* ★★ 关键：某层完全没有记录时，**默认把该层所有分类勾上**。
       *
       * 为什么必须有这一步（2026-10-07 事故）：
       *   load() 只从 localStorage 读，读不到就是空对象，
       *   isOn() 于是全返回 false → 分类项渲染出来但**一个都没勾** →
       *   render() 里 Object.keys(on).length === 0 直接 return →
       *   **地图上一个任务点都不画**，看上去像「任务大分类完全不显示」。
       *
       *   原设计意图是「任务分类默认全开」（用户看到五档带勾、地图一片点），
       *   但这个默认只存在于老用户的 localStorage 里；
       *   新用户 / 清过缓存 / 换键名后就全空了。
       *   所以默认必须由代码兜住，不能指望存储。
       */
    if (raw === null) {
      /* 首次访问：把所有有任务的分类默认勾上 */
      needSave = true;
    }
    [18, 19, 20].forEach(function (layer) {
      if (userOn[layer] && Object.keys(userOn[layer]).length) return;
      var stats = D.statsByLayer(layer);
      if (!stats.length) return;
      /* 这层有任务的分类才勾，count=0 的不勾（也没必要显示） */
      var picked = {};
      var any = false;
      stats.forEach(function (s) { if (s.count > 0) { picked[s.cat] = true; any = true; } });
      if (any) userOn[layer] = picked;
    });

    if (needSave) save();
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify(userOn)); } catch (e) { /* 隐私模式忽略 */ }
  }
  function isOn(cat) {
    var m = userOn[curLayer];
    return !!(m && m[cat]);
  }
  /* 切层后按用户意图补勾高亮。
     ★ 只改DOM 高亮，绝不删userOn 里的键——
       否则「切到某层→ 某分类在这层count=0 → 被删 → 切回原层意图丢了」。
       count=0 的分类在 injectPanel 里本来就不会渲染出来，无需清理状态。 */
  function ensureChecked() {
    var m = userOn[curLayer];
    if (!m) return;
    D.catOrder.forEach(function (cat) {
      var el = document.querySelector('#catalogList .tk-cat[data-tkcat="' + cat + '"]');
      if (el) el.classList.toggle('active', !!m[cat]);
    });
  }
  function signature() {
    var m = userOn[curLayer] || {};
    var s = curLayer + '|' + doneRev + '|';   /* doneRev：完成态一变就强制重绘，
                                               不去遍历 259 个任务算哈希（那样每次
                                               tick 都是 259 次查表，浪费） */
    D.catOrder.forEach(function (cat) {
      s += m[cat] ? '1' : '0';
    });
    return s;
  }

  /* ---------- 侧栏注入 ---------- */
  /* app.js 每次切层会重建整个 #catalogList（innerHTML 替换），
     所以每次都要重新注入一次任务组。 */
  function injectPanel() {
    var list = $('catalogList');
    if (!list) return;
    if (list.querySelector('.tk-group')) return;   /* 已注入 */

    var stats = D.statsByLayer(curLayer);
    /* 全是0（这层没任务）就不显示，避免出现空组 */
    var total = 0, totalDone = 0;
    stats.forEach(function (s) {
      total += s.count;
      /* 完成数：本层该分组里已完成的任务（存档态 + 手动态，见 task-done.js） */
      if (window.TaskDone) {
        D.listBy(curLayer, s.cat).forEach(function (t) {
          if (window.TaskDone.isDone(t.key)) totalDone++;
        });
      }
    });
    if (!total) return;

    /* ★ 标题要标明「本图层」（2026-10-07）
     *
     * 问题：原来只写「任务 0/233」，老大看到 233 与全库 253 不符，以为数据错了。
     * 真相：statsByLayer(curLayer) **只统计当前图层**——
     *   地表 234 条（onMap 233）/ 地底 3 / 天空 16 = 全库 253。
     * 切到地底层只剩 3 条（台账 P5 记的「图层归属倾斜」就是这个）。
     * 数据没问题，是**标题没交代口径**。
     *
     * 改法：标题带图层名 + 补全库总数，让人一眼看出这是分层统计。
     * 「全库」用斜体小字跟在后面，避免有人误以为本层只有这么多条。
     * ★ 全库数是**去重后的任务总数**（253），不是各层相加——
     *   跨层任务（2026-10-07 起11 条）在两层都出现，相加会得到 263。
     */
    var layerCn = { 18: '地表', 19: '地底', 20: '天空' }[curLayer] || '';
    var allTotal = 0;
    for (var li = 18; li <= 20; li++) {
      allTotal += D.totalByLayer ? D.totalByLayer(li) : 0;
    }
    var html = '<div class="group-title tk-group">任务·' + esc(layerCn) +
      '<span class="tk-count">' + totalDone + '/' + total +
      (allTotal && allTotal !== total
        ? '<span class="tk-count-all">全库 ' + D.totalAllLayers() + '</span>' : '') +
      '</span></div>';
    html += '<div class="cat-grid tk-grid">';
    stats.forEach(function (s) {
      if (s.count <= 0) return;
      var on = isOn(s.cat) ? ' active' : '';
      html += '<div class="cat-item tk-cat' + on + '" data-tkcat="' + esc(s.cat) + '">' +
        '<img src="assets/icons/' + taskIcon(s.cat) + '" alt="">' +
        '<span class="cat-name">' + esc(s.name) + '</span>' +
        '<span class="cat-count">' + s.count + '</span>' +
        '</div>';
    });
    html += '</div>';

    /* 用 children 取（不用 firstChild/lastChild —— innerHTML 里若有空白文本节点，
       lastChild 会拿到文本节点而非元素，事件就绑不上，表现为「勾了没反应」。 */
    var box = document.createElement('div');
    box.innerHTML = html;
    var g = box.children[0], gr = box.children[1];
    if (!g || !gr) return;
    list.appendChild(g);
    list.appendChild(gr);

    gr.addEventListener('click', function (e) {
      var el = e.target && e.target.closest && e.target.closest('.tk-cat');
      if (!el) return;
      var cat = el.getAttribute('data-tkcat');
      var m = userOn[curLayer] || (userOn[curLayer] = {});
      if (m[cat]) delete m[cat]; else m[cat] = true;
      el.classList.toggle('active', !!m[cat]);
      save();
      tick();
    });
  }

  /* 分类图标复用现有 assets/icons，不新增图片 */
  function taskIcon(cat) {
    /* 五档共用同一个图标（本来就没有分类专属图标）。
       分类靠标题文字 + 右侧计数区分，不靠图标。 */
    return 'origin_3845393_70484.png';
  }

  /* ---------- 地图绘制 ---------- */
  /* 任务点用「方形徽标」，与站内现有圆形图标（神庙/鸟望台/克洛格）明显区分。
     z5 全图下圆点太小会淹没在图标海里，方形+ 深色底 + 亮色边最醒目。
     ★ divIcon 只能放 HTML，所以 data-tkkey 挂在里面的 .tk-dot 上
       （挂在 divIcon 的 className 上取不到，那是 Leaflet 自己生成的）。

     V2.1M5.1：完成态= 右上角绿勾 + 整体降透明，语义与探索侧
     （.mk-done-check）完全一致。同时 glyph 换成 ✓，双通道编码：
     形状给流程档位，勾给完成态，色块给任务分类。 */
  /* 该任务在指定层内应画在哪个点上（2026-10-07）
   *
   * ★ 判层优先用 **task-plan.js 的 `t.layers`**（数据层已含人工覆盖），
   *   没有可用信息时才退回 `layerOfY()` 纯高度判断。
   *
   * 为什么改（2026-10-07）：
   *   原来的 `layerOfY()` 硬阈值 `gy >= 700` 与数据源头extract_quests.py 一致，
   *   但那条线不成立——天空任务高度分布 248~2002，地面最高 1563。
   *   结果「未知的天空巨人」（西海布拉天空诸岛，h=544）被画到地表，
   *   在天空层切过去找不到它。
   *
   * 为什么不把 `layerOfY` 的阈值改成 ~500（V1.8.1 文档结论）：
   *   实测会误判 18 条，其中「死亡破火山口的神庙与水晶」(h=630)、
   *   「为奥尔汀带来和平！」(h=557) 明显在**地面**。
   *   判层已改走人工覆盖表（build_task_plan.py 的 MANUAL_LAYERS），
   *   前端只消费 `t.layers`，不再自己算高度阈值。
   */
  function layerOfY(y) {
    if (y == null) return null;
    if (y < -250) return 19;
    if (y >= 700) return 20;
    return 18;
  }
  /* 这个流程点属于哪一层？
   * ★ 优先用「主坐标+flowPts 反推」不可靠（同一任务不同点不同层），
   *   所以改成：**只要该点的高度与任务声明的图层不冲突，就认为它属于该层**。
   *   判据：`t.layers` 含 layerId 时，在该层里挑第一个高度不冲突的点。
   */
  function pointInLayer(t, layerId) {
    var i, p;
    var layers = t.layers || null;
    if (layers && layers.length) {
      if (layers.indexOf(layerId) < 0) return null;   /* 这任务不在该层 */
      /* 该层内的点：取第一个被判为该层的 flowPt；都判不出就退回主坐标 */
      for (i = 0; i < (t.flowPts || []).length; i++) {
        p = t.flowPts[i];
        if (layerOfY(p.gy) === layerId) return p;
      }
      /* flowPts 判不出（如人工钉住的层没有对应高度）→ 用主坐标。
         ★ 实战验证（2026-10-07）：「未知的天空巨人」layers=[18,20]，
           flowPts = [{天空诸岛 h=650}, {城堡 h=113}]，
           主坐标就是**天空诸岛那个**（h=650）——
           所以天空层挑不出点时退回主坐标，位置仍然正确。
           这里靠的是「主坐标 = 第一个流程点」这个既有约定（dedup_flow 保持原序），
           不是碰运气：真出问题时表现为「天空层点画到了地表位置」，可按此排查。 */
      if (t.gx != null && t.gz != null) return { gx: t.gx, gz: t.gz };
      return null;
    }
    /* 没有 layers 字段（理论上不会，数据层一定有）→ 退回旧逻辑 */
    for (i = 0; i < (t.flowPts || []).length; i++) {
      p = t.flowPts[i];
      if (layerOfY(p.gy) === layerId) return p;
    }
    if (layerOfY(t.gy) === layerId) return { gx: t.gx, gz: t.gz };
    return null;
  }

  function taskIconDot(t) {
    /* ★ 按 group 判色（2026-10-07 迷你挑战单列）。
     * 原来按 t.cat（ROM 四档）判，迷你挑战会落到 'oth' 灰色里，
     * 地图上跟「其他」分不开。现在迷你挑战有自己的紫蓝色。 */
    /* ★ 按官方四档 group 判色（2026-10-07 分类改造）。
     * 四档对应游戏「冒险笔记」：主剧情挑战（金）/ 情节挑战（绿）/
     * 神庙挑战（蓝）/ 迷你挑战（紫）。原来有第五档「其他」的灰色，
     * 随FindSunaNui2 删除后已无成员。 */
    var gk = t.group || '迷你挑战';
    var cls = 'tk-dot tk-' + (gk === '主剧情挑战' ? 'main'
      : gk === '情节挑战' ? 'imp'
        : gk === '神庙挑战' ? 'sub'
          : 'mini');
    var isDone = !!(global.TaskDone && t.key && global.TaskDone.isDone(t.key));
    var glyph = isDone ? '✓' : t.tier === 'L1' ? '◆' : t.tier === 'L2' ? '●' : '○';
    if (isDone) cls += ' is-done';
    return L.divIcon({
      className: 'tk-dot-wrap',
      /* data-tkkey 给验收脚本和流程线做稳定标识 */
      html: '<div class="' + cls + '" data-tkkey="' + esc(t.key || '') + '" title="' +
            esc(t.name) + '">' + glyph + '</div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function render() {
    if (!map) return;
    if (group) { map.removeLayer(group); group = null; }
    mkIndex = {};              /* 旧 marker 已随 layerGroup 销毁，索引必须清 */
    if (!ready) return;

    var on = {};
    D.catOrder.forEach(function (cat) { if (isOn(cat)) on[cat] = true; });
    if (!Object.keys(on).length) return;

    var g = L.layerGroup();
    var list = D.listBy(curLayer);
    list.forEach(function (t) {
      /* ★ 按 group 查，不是 t.cat（2026-10-07 迷你挑战单列）。
       * 上面 on 的键是官方四档 group（主剧情挑战/情节挑战/神庙挑战/迷你挑战），
       * 而 t.cat 还是 ROM 名（Main/ImportantMini/Sub/Other）——
       * 用 t.cat 查就是键对不上，**每个任务都在这里被 return 掉**，
       * 表现是「分类面板五档都在、勾了也勾不上、地图上一个点都不画」。
       * 漏改这一处的教训：换了键命名要grep 全部读取点，别只改「看起来相关」的。 */
      if (!on[t.group]) return;
      var isDone = !!(global.TaskDone && t.key && global.TaskDone.isDone(t.key));
      /* ★★ 跨层任务要画在**当前层内的那个点**上（2026-10-07 老大定：所有涉及层都显示）
       *
       * 原来不管哪一层都画 `t.gz/t.gx`（主点= 第一个流程点），
       * 于是「切到地底层，看到的却是地表那个点」——点虽然出现了，位置是错的。
       * 现在用 pointInLayer() 在 flowPts 里找一个真属于当前层的点；
       * 找不到（高度数据缺失等）才退回主点。
       *
       * ★ Leaflet latlng = (gz, gx)，见 app.js 坐标系注释。 */
      var pt = pointInLayer(t, curLayer);
      if (!pt) { pt = { gz: t.gz, gx: t.gx }; }
      var m = L.marker([pt.gz, pt.gx], {
        icon: taskIconDot(t),
        title: t.name,
        riseOnHover: true,
        /* ★★ zIndexOffset 900：必须压过流程线节点（task-flow.js 用 600/700）。
         *
         * 踩过的坑（2026-10-07老大报「追踪后任务图标消失，打不开卡片」）：
         *   流程线的序号节点和「起」标记画在**和任务点完全相同的坐标**上，
         *   而它们的 zIndexOffset 是 600/700，任务点默认 0
         *   → 节点把任务图标整个盖住，点不到、卡片打不开、连取消追踪都做不到。
         *   Leaflet 同名 markerPane 内按 zIndex 决定叠放顺序，
         *   所以这里给任务点一个稳定的更高层级，**不依赖坐标是否相同**。
         *   （节点缩小一点、给任务点留白也解决不了——它们中心重合。） */
        zIndexOffset: 900
      });
      /* 已完成的加✓ 前缀，与探索侧 tooltip 口径一致 */
      m.bindTooltip((isDone ? '✓ ' : '') + t.name, {
        direction: 'top', offset: [0, -8],
        className: 'mk-label tk-tip' + (isDone ? ' done-label' : '')
      });
      m.on('click', function (e) {
        if (global.TaskCard) global.TaskCard.open(t, e);
      });
      m.addTo(g);
      /* 记住 marker 引用，供 TaskPanel.locate() 取真实 marker 做定位高亮。
       * ★ 为什么必须存：app.js 的 gotoMarker 画光圈靠 `state.markers[m.id]`
       *   拿真实 marker 的屏幕位置，传一个没有 id 的「代理标点」进去，
       *   光圈那段会直接 return —— 只弹 toast，看不到任何发光效果。
       *   每次 render() 重建 layerGroup，所以索引也要一起清。 */
      if (t.key) mkIndex[t.key] = m;
      /* ★ 重建后把追踪光环补回来。
       *   render() 会在切图层 / 改分类勾选时重建全部 marker，DOM 是新的，
       *   之前 task-flow.js 用 markByKey 加的 is-tracked class 会**全部丢失**——
       *   表现是「流程线还在、追踪中，但任务图标的光环消失了」。
       *   这里主动问一次「这个任务正在被追踪吗」，是唯一可靠的重建时机。 */
      if (t.key && global.TaskFlow && global.TaskFlow.isTracking
          && global.TaskFlow.isTracking(t.key)) {
        setTimeout(function () {
          var el = m.getElement && m.getElement();
          var dot = el && el.querySelector ? el.querySelector('.tk-dot') : null;
          if (dot && dot.classList) dot.classList.add('is-tracked');
        }, 0);
      }
    });
    g.addTo(map);
    group = g;
  }

  /* ---------- 循环 ---------- */
  function tick() {
    if (!ready) return;
    injectPanel();       /* app.js 重建列表后要补回来 */
    ensureChecked();     /* 切层后按用户意图补勾高亮 */
    var sig = signature();
    if (sig !== lastSig) { lastSig = sig; render(); }
  }

  /* app.js 改的是普通对象（state.selected），没有 change 事件，只能轮询 */
  function observe() {
    setInterval(tick, 150);
  }

  function observeLayer() {
    var sw = $('layerSwitch');
    if (!sw) return;
    var obs = new MutationObserver(function () {
      var l = currentLayer();
      if (l !== curLayer) {
        curLayer = l;
        lastSig = '';        /* 强制重画 */
        tick();
      }
    });
    obs.observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    map = (global.TOTK && global.TOTK.map) || null;
    if (!map) { setTimeout(init, 300); return; }
    curLayer = currentLayer();
    load();
    lastSig = '';
    injectCSS();
    observeLayer();
    injectPanel();
    observe();
    render();
    ready = true;

    global.TaskPanel = {
      render: render,
      isOn: isOn,
      refresh: tick,
      stats: function () { return D.statsByLayer(curLayer); },
      /* ---------- 给task-flow.js 的追踪光环用 ----------
       * 需求：追踪某任务时，给它的地图图标加一个脉动光环 class。
       * 追踪关掉卡片后地图上只剩「线 + 节点」，玩家不知道线属于哪个任务；
       * 光环既标示归属，也提示「点这个图标能回卡片取消追踪」。
       *
       * 为什么不自己再画一个 marker：那样会在同一坐标再叠一个元素，
       * 又回到「谁盖住谁」的老问题（见 render() 里 zIndexOffset 900 的注释）。
       * 直接给现有 marker 的 DOM 加 class 最小、也最稳。
       *
       * 找不到 marker 时静默返回 false —— 可能是该分类被取消勾选、
       * 任务不在当前层，追踪功能不该因此报错。 */
      markByKey: function (key, on) {
        if (!key) return false;
        var m = mkIndex[key];
        if (!m || !m.getElement) return false;
        var el = m.getElement();
        if (!el) return false;
        var dot = el.querySelector('.tk-dot') || el;
        if (dot.classList) dot.classList.toggle('is-tracked', !!on);
        return true;
      },
      /* ---------- V2.1（2026-10-07）：给任务卡片的「定位」按钮用 ----------
       * 需求：点坐标右边的定位图标 → 地图跳到这个任务图标所在位置。
       *
       * 为什么必须有这个：任务点画在**独立的 Leaflet 图层**里（render() 的
       * group），分类勾选状态是 `userOn[layer][group]`，**不在** app.js 的
       * `state.selected` 里。所以 app.js 的 gotoMarker 帮不上任务点——
       * 它的「自动勾分类」只认state.selected。
       *
       * 所以这里先把该任务**所在层 + 所在分类**确保勾上并重绘，
       * 再由调用方走 gotoMarker 飞行+ 光圈。返回坐标供调用方使用。
       */
      locate: function (t, opts) {
        if (!t) return null;
        opts = opts || {};
        var layers = (t.layers && t.layers.length) ? t.layers : [t.layer];
        /* 该切到哪一层？
         * ★「留在当前层」vs「切到目标层」的取舍（2026-10-07 修）：
         *   原来只要当前层在 `t.layers` 里就**不切**——多目标任务在任一层
         *   都能显示，从卡片点定位时停在原地本来是合理的。
         *   但搜索/列表点定位的目的就是「飞到那个点**所在的地方**」，
         *   停在错误的层等于没定位：「未知的天空巨人」layers=[18,20]，
         *   停在地表就找不到它在天空诸岛。
         *   所以加 `opts.preferLayer`：调用方指定要去的层
         *   （搜索结果、任务卡定位按钮都传）。不传时保持旧行为。 */
        var l;
        if (opts.preferLayer != null && layers.indexOf(opts.preferLayer) >= 0) {
          l = opts.preferLayer;
        } else if (layers.indexOf(curLayer) >= 0) {
          l = curLayer;
        } else {
          l = layers[0];
        }
        if (l != null && l !== curLayer) {
          if (global.TOTK && global.TOTK.switchLayer) global.TOTK.switchLayer(l);
          /* switchLayer 会重建 #catalogList 并触发 tick → curLayer 异步更新，
             这里同步一次，保证下面 isOn() / pointInLayer() 用的是新层。 */
          curLayer = l;
        }
        /*勾上该任务所属分类，否则 render() 会跳过它、地图上找不到点 */
        var g = t.group;
        if (g && !isOn(g)) {
          userOn[curLayer] = userOn[curLayer] || {};
          userOn[curLayer][g] = true;
          save();
        }
        render();
        /* 优先用该层内的那个点（跨层任务每个层各有各的坐标） */
        var pt = pointInLayer(t, curLayer) || { gx: t.gx, gz: t.gz };
        /* ★ 把真实 marker 带回去：调用方靠它拿 getElement() 的屏幕位置，
         *   gotoMarker 的光圈就是按这个位置画的。
         *   只回坐标的话地图会飞，但**没有任何发光效果**。 */
        return { gx: pt.gx, gz: pt.gz, layer: curLayer, marker: mkIndex[t.key] || null };
      },
      /* 完成数变化时刷新标题上的 done/total。
         injectPanel 有「已注入就不重复注入」的短路，所以这里直接改
         已存在的计数节点，而不是重跑 injectPanel。 */
      refreshDoneCount: function () {
        var el = document.querySelector('.tk-group .tk-count');
        if (!el) return;
        var total = 0, done = 0;
        D.statsByLayer(curLayer).forEach(function (s) {
          total += s.count;
          if (global.TaskDone) {
            D.listBy(curLayer, s.cat).forEach(function (t) {
              if (global.TaskDone.isDone(t.key)) done++;
            });
          }
        });
        el.textContent = done + '/' + total;
      }
    };

    /* 订阅完成态变化：手动标记、或加载存档后，标题数字要跟着动。
       ★ 地图任务点的重绘**不在这里做**——只把 doneRev 加一，
         下一轮 tick()（150ms 轮询）比对 signature 发现变了自然会重画。
         早先在这里直接调 render() 是冗余的：存档加载时 TaskDone 连续
         notify 十几次，每次全量重建 254 个 marker，明显卡顿。
         地图任务点重绘的判据见 signature() 里的 doneRev 注释。 */
    if (global.TaskDone) {
      global.TaskDone.onChange(function () {
        doneRev++;
        if (ready) global.TaskPanel.refreshDoneCount();
      });
    }
  }

  /* ---------- 样式（.tk- 前缀，与 app.js 的样式完全隔离） ---------- */
  function injectCSS() {
    if ($('task-css')) return;
    var st = document.createElement('style');
    st.id = 'task-css';
    st.textContent = TASK_CSS;
    document.head.appendChild(st);
  }

  var TASK_CSS = [
    /* 分组标题右侧的任务总数 */
    '.tk-group { display:flex; align-items:center; }',
    '.tk-group::after { content:""; flex:1; }',
    '.tk-group .tk-count {',
    '  margin-left:8px; font-size:11px; color:rgba(255,255,255,.3);',
    '  font-variant-numeric:tabular-nums; }',
    /* 「全库 N」：斜体更淡，区分于本层数字。
       它的作用是让人一眼看出标题里的数字是**分层统计**而不是全量，
       避免切到地底层看到「0/3」时以为数据丢了。 */
    '.tk-count-all { margin-left:7px; font-style:italic; color:rgba(255,255,255,.2); }',
    /* 任务点在地图上：方形徽标，按种类分色。glyph 区分流程档位
       ◆=L1 有流程线可画 ●=L2 单点 ○=L3 仅列表（玩家看不到 L1/L2 术语，只看到形状不同） */
    '.tk-dot-wrap { background:none; border:none; }',
    '.tk-dot {',
    '  width:18px; height:18px; border-radius:5px;',
    '  display:flex; align-items:center; justify-content:center;',
    '  font-size:10px; line-height:1; font-weight:700;',
    '  border:2px solid rgba(20,22,28,.92);',
    '  box-shadow:0 1px 5px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.14);',
    '  transition:transform .12s; user-select:none; }',
    '.tk-dot-wrap:hover .tk-dot { transform:scale(1.3); z-index:900; }',
    /* 追踪中（task-flow.js 的「任务目标」按钮点亮后）：脉动光环。
     * 作用 = 告诉玩家「这条流程线属于这个图标」，也是回卡片的指引。
     * ★ 动画放在 box-shadow 上而不是 transform —— Leaflet 用 transform
     *   定位 marker，动画它会让图标位置漂移。 */
    '.tk-dot.is-tracked {',
    '  box-shadow:0 0 0 3px rgba(234,194,126,.75), 0 1px 5px rgba(0,0,0,.6),',
    '             0 0 0 1px rgba(255,255,255,.14);',
    '  animation:tkTrackPulse 1.6s ease-in-out infinite; }',
    '@keyframes tkTrackPulse {',
    '  0%,100% { box-shadow:0 0 0 3px rgba(234,194,126,.75), 0 1px 5px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.14); }',
    '  50%     { box-shadow:0 0 0 6px rgba(234,194,126,.28), 0 1px 5px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.14); } }',
    '.tk-dot.is-tracked.is-done { opacity:.75; }',
    /* 官方四档配色（2026-10-07）。分类名与游戏「冒险笔记」一致。 */
    '.tk-main { background:#eac27e; color:#3a2f18; }',   /* 主剧情挑战：金（23 条） */
    '.tk-imp  { background:#7ec8a9; color:#1d3b30; }',   /* 情节挑战：绿（60 条） */
    '.tk-sub  { background:#6fb3e0; color:#16324a; }',   /* 神庙挑战：蓝（31 条） */
    '.tk-mini { background:#b8a0e8; color:#2b1f45; }',   /* 迷你挑战：紫（139 条） */
    /* --- V2.1M5.1 完成态 ---
       语义与探索侧 .mk-done-check 一致：右上角绿勾= 已完成。
       额外压低不透明度 + 去饱和，让已完成任务在密集图标海里退到背景，
       未完成的自动跳出来 —— 这比只加个勾更省眼力。 */
    '.tk-dot.is-done {',
    '  opacity:.42; filter:saturate(.45);',
    '  box-shadow:0 1px 3px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }',
    '.tk-dot.is-done:hover { opacity:.9; filter:none; }',
    /* 悬停标签与现有 .mk-label 同风格 */
    '.tk-tip { white-space:nowrap; }'
  ].join('\n');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);