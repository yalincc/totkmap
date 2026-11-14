/* ============ TOTKMAP · 存档修改器 页面逻辑（v3 4-Tab 重构） ============
 *
 * 职责边界：
 *   save-writer.js  负责「字节怎么改」（定位、写入、校验），一行 UI 逻辑都没有
 *   本文件          只负责「4-Tab 交互、预览确认、单文件导出」
 */
(function () {
  'use strict';

  var NAVI = 'http://127.0.0.1:8766';
  var BAG_PAGE_SIZE = 24;

  var state = {
    sw: null,
    file: null,
    source: '',
    activeTab: 'bag',
    pouch: {},
    eqCat: 'weapons',
    eqEdits: {},        // 'weapons|3' -> { life?, eff?, effVal?, inf? }
    bagItems: [],       // [{ key, cat, i, name, cn, group, qty }]
    bagEdits: {},       // 'materials|0' -> qty
    bagCat: 'all',
    bagQuery: '',
    bagPage: 1,
    bagShowAll: false,
    bagSelKey: null,
    pending: null,
    dlBufs: null,
    dlDone: false,
    origin: { rupee: 0, hearts: 0, stamina: 0, energy: 0 },
    pos: null,
    bp: null,
    bpImports: [],      // [{ i, data, camPos, camAt, from, summary }]
    bpSelSlot: 0,
    bpAliases: (function () { try { return JSON.parse(localStorage.getItem('totkmap_bp_aliases') || '{}'); } catch (_) { return {}; } })(),
    bpLibrary: (function () {
      try {
        var raw = localStorage.getItem('totkmap_bp_library');
        if (raw !== null) return JSON.parse(raw);
      } catch (_) {}
      return (window.TOTK_BLUEPRINTS_PRESET || []).slice();
    })(),
    bpPresetSel: {},
    undoStack: []       // 操作历史栈，支持 Ctrl+Z / 撤销上一步
  };

  function saveBpLibrary() {
    try { localStorage.setItem('totkmap_bp_library', JSON.stringify(state.bpLibrary || [])); } catch (_) {}
  }

  function cloneSimple(o) { return JSON.parse(JSON.stringify(o || {})); }
  function segValOf(id) { var v = $(id) ? $(id).dataset.value : ''; return v === '' ? '' : +v; }

  function snapState() {
    return {
      rupee: $('inRupee') ? $('inRupee').value : '',
      hearts: $('inHearts') ? $('inHearts').value : '',
      stamina: segValOf('segStamina'),
      energy: segValOf('segEnergy'),
      bagEdits: cloneSimple(state.bagEdits),
      eqEdits: cloneSimple(state.eqEdits),
      bpImports: state.bpImports.slice()
    };
  }
  function pushUndo() {
    if (!state.sw) return;
    state.undoStack.push(snapState());
    if (state.undoStack.length > 50) state.undoStack.shift();
    updateUndoBtn();
  }
  function updateUndoBtn() {
    var b = $('btnUndoStep');
    if (b) b.disabled = !state.sw || state.undoStack.length === 0;
  }
  function popUndo() {
    if (!state.undoStack.length) return;
    var s = state.undoStack.pop();
    if ($('inRupee')) $('inRupee').value = s.rupee;
    if ($('inHearts')) $('inHearts').value = s.hearts;
    setSeg('segStamina', s.stamina === '' ? null : s.stamina);
    setSeg('segEnergy', s.energy === '' ? null : s.energy);
    state.bagEdits = s.bagEdits || {};
    state.eqEdits = s.eqEdits || {};
    state.bpImports = s.bpImports || [];
    renderBag();
    renderEquip();
    renderBpPending();
    updateFoot();
    updateUndoBtn();
  }

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nameOf(actor) {
    if (!actor || !window.EQUIP_NAMES) return null;
    if (window.EQUIP_NAMES[actor]) return window.EQUIP_NAMES[actor];
    if (actor.slice(-9) === '_NoBurned') return window.EQUIP_NAMES[actor.slice(0, -9)] || null;
    return null;
  }
  function matNameOf(actor) {
    return (window.MAT_NAMES && window.MAT_NAMES[actor]) || null;
  }

  var FUSE_PRESETS = [
    { id: 'Item_Enemy_151', cn: '白银莱尼尔的刃角', tag: '+55攻', life: 0 },
    { id: 'Item_Enemy_218', cn: '白银莱尼尔的碎角', tag: '+51攻', life: 0 },
    { id: 'Item_Enemy_69', cn: '吉波得之骨', tag: '+40攻', life: 0 },
    { id: 'Item_Enemy_210', cn: '莫尔德拉吉克的颚骨', tag: '+32攻', life: 0 },
    { id: 'Item_Enemy_137', cn: '岩石巨人之心', tag: '+33攻', life: 0 },
    { id: 'Item_Ore_A', cn: '钻石', tag: '+25攻', life: 0 },
    { id: 'Item_Ore_B', cn: '红宝石', tag: '火属性', life: 0 },
    { id: 'Item_Ore_C', cn: '蓝宝石', tag: '冰属性', life: 0 },
    { id: 'Item_Ore_D', cn: '黄玉', tag: '雷属性', life: 0 },
    { id: 'SpObj_FlameThrower_A_01', cn: '火龙头', tag: '左纳乌', life: 54000 },
    { id: 'SpObj_SnowMachine_A_01', cn: '冰龙头', tag: '左纳乌', life: 54000 },
    { id: 'SpObj_ElectricBoxGenerator_A_01', cn: '雷龙头', tag: '左纳乌', life: 54000 },
    { id: 'SpObj_Cannon_A_01', cn: '大炮', tag: '左纳乌', life: 54000 },
    { id: 'SpObj_Rocket_A_01', cn: '火箭', tag: '盾滑', life: 100 },
    { id: 'SpObj_SlipBoard_A_01', cn: '滑橇', tag: '盾滑', life: 500 },
    { id: 'Weapon_Shield_030', cn: '海利亚盾', tag: '耐久800', life: 800 }
  ];
  function fuseNameOf(actor) {
    if (!actor) return '';
    var FN = window.FUSE_NAMES || {};
    var norm = actor.replace(/_ForAttachment$/, '');
    var hit = FN[actor] || FN[norm] || matNameOf(actor) || matNameOf(norm) || nameOf(actor) || nameOf(norm);
    if (hit) return hit;
    if (norm.indexOf('SpObj_') === 0) {
      var cap = norm.replace(/_([AB]_\d+)$/, '_Capsule_$1');
      if (cap !== norm && matNameOf(cap)) return matNameOf(cap);
      var stem = norm.split('_').slice(0, 2).join('_') + '_';
      var fnKeys = Object.keys(FN);
      for (var fi = 0; fi < fnKeys.length; fi++) {
        if (fnKeys[fi].indexOf(stem) === 0) return FN[fnKeys[fi]];
      }
    }
    return actor;
  }
  function defaultFuseLife(actor) {
    if (!actor) return -1;
    for (var i = 0; i < FUSE_PRESETS.length; i++) {
      if (FUSE_PRESETS[i].id === actor) return FUSE_PRESETS[i].life;
    }
    if (window.EQUIP_DURABILITY && window.EQUIP_DURABILITY[actor]) return window.EQUIP_DURABILITY[actor];
    if (actor.indexOf('SpObj_') === 0) return 54000;
    return 0;
  }

  function showMsg(html, cls) {
    var box = $('loadMsg');
    if (!box) return;
    if (!html) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="tip ' + (cls || '') + '">' + html + '</div>';
  }
  function showBpMsg(html, cls) {
    var box = $('bpMsg');
    if (!box) { showMsg(html, cls); return; }
    if (!html) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="tip ' + (cls || '') + '" style="margin-top:10px">' + html + '</div>';
  }

  function fmt(n) {
    return typeof n === 'number' ? (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(2)) : n;
  }
  function thou(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
  }

  function segVal(id) {
    var v = $(id).dataset.value;
    return v === '' ? null : +v;
  }
  function setSeg(id, v) {
    var box = $(id);
    box.dataset.value = (v === null || v === undefined) ? '' : String(v);
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.v === box.dataset.value);
    });
  }

  function switchTab(tabId) {
    var valid = { bag: 1, equip: 1, bp: 1 };
    if (!valid[tabId]) tabId = 'bag';
    state.activeTab = tabId;
    Array.prototype.forEach.call(document.querySelectorAll('#mainTabs .mtab'), function (b) {
      b.classList.toggle('on', b.dataset.tab === tabId);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-pane'), function (p) {
      p.classList.toggle('on', p.id === 'pane-' + tabId);
    });
  }

  /* ---------- 加载存档 ---------- */
  function loadFromArrayBuffer(buf, source) {
    var sw;
    try {
      sw = SaveWriter.open(buf);
    } catch (e) {
      showMsg('<b>打不开这个文件：</b>' + esc(e.message), 'warn');
      return;
    }
    state.sw = sw;
    state.file = buf;
    state.source = source;
    state.eqEdits = {};
    state.bagEdits = {};
    state.bagSelKey = null;
    state.bagPage = 1;
    state.undoStack = [];
    updateUndoBtn();

    $('topMeta').hidden = false;
    $('chipVer').textContent = sw.version;
    $('chipSize').textContent = sw.size.toLocaleString() + ' 字节';
    $('verDot').classList.toggle('bad', !sw.isKnownVersion);

    $('sbFileName').textContent = 'progress.sav';
    if ($('sbReady')) $('sbReady').textContent = '· 已就绪';
    $('sbSub').textContent = '游戏版本 ' + sw.version + ' · Switch / PC 重编译版 · ' + (sw.size / (1024 * 1024)).toFixed(2) + ' MB';

    ['materials', 'arrows', 'zonai', 'weapons', 'bows', 'shields'].forEach(function (cat) {
      state.pouch[cat] = sw.readPouch(cat, true);
    });

    var sc = sw.readScalars().values;
    state.origin = {
      rupee: sc.rupee || 0,
      hearts: (sc.maxLife || 0) / 4,
      stamina: sc.stamina || 0,
      energy: sc.energy || 0
    };

    buildBagItems();
    renderBag();
    renderEquip();

    state.bp = sw.readBlueprints();
    state.bpImports = [];
    if ($('bpSharePanel')) $('bpSharePanel').hidden = true;
    renderBlueprints();

    $('btnApply').disabled = false;
    $('btnReset').disabled = false;
    updateFoot();

    var hashTab = (location.hash || '').replace(/^#/, '');
    if (hashTab === 'blueprint') hashTab = 'bp';
    if (hashTab) switchTab(hashTab);
  }

  /* ---------- Tab 2: 背包物品（4列网格 + 分类 + 搜索 + 分页） ---------- */
  function buildBagItems() {
    var list = [];
    var m = state.pouch.materials, z = state.pouch.zonai, a = state.pouch.arrows;
    if (m && m.ok) {
      m.items.forEach(function (it) {
        var g = window.SaveWriter.classifyMaterial(it.name);
        list.push({
          key: 'materials|' + it.i, cat: 'materials', i: it.i,
          name: it.name, cn: matNameOf(it.name) || it.name, group: g, qty: it.qty
        });
      });
    }
    if (z && z.ok) {
      z.items.forEach(function (it) {
        list.push({
          key: 'zonai|' + it.i, cat: 'zonai', i: it.i,
          name: it.name, cn: matNameOf(it.name) || it.name, group: 'zonai', qty: it.qty
        });
      });
    }
    if (a && a.ok) {
      a.items.forEach(function (it) {
        list.push({
          key: 'arrows|' + it.i, cat: 'arrows', i: it.i,
          name: it.name, cn: matNameOf(it.name) || it.name, group: 'arrows', qty: it.qty
        });
      });
    }
    state.bagItems = list;
    $('tabBagBadge').textContent = list.length || '0';
  }

  function bagFiltered() {
    var q = state.bagQuery.toLowerCase();
    return state.bagItems.filter(function (it) {
      if (state.bagCat !== 'all' && it.group !== state.bagCat) return false;
      if (q && it.cn.toLowerCase().indexOf(q) < 0 && it.name.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function renderBag() {
    var counts = { all: state.bagItems.length };
    state.bagItems.forEach(function (it) { counts[it.group] = (counts[it.group] || 0) + 1; });

    var cats = [{ key: 'all', label: '全部' }]
      .concat(window.SaveWriter.MAT_GROUPS.map(function (g) { return { key: g.key, label: g.label }; }))
      .concat([{ key: 'zonai', label: '左纳乌装置' }, { key: 'arrows', label: '箭矢' }]);

    $('bagCatPills').innerHTML = cats.map(function (c) {
      var n = counts[c.key] || 0;
      if (c.key !== 'all' && !n) return '';
      return '<button type="button" class="bag-cat-pill' + (state.bagCat === c.key ? ' on' : '') +
        '" data-g="' + c.key + '">' + esc(c.label) + ' (' + n + ')</button>';
    }).join('');

    var filtered = bagFiltered();
    var totalPages = Math.max(1, Math.ceil(filtered.length / BAG_PAGE_SIZE));
    if (state.bagPage > totalPages) state.bagPage = totalPages;
    var view = state.bagShowAll
      ? filtered
      : filtered.slice((state.bagPage - 1) * BAG_PAGE_SIZE, state.bagPage * BAG_PAGE_SIZE);

    var grid = $('bagItemGrid');
    if (!view.length) {
      grid.innerHTML = '<div class="empty">没有匹配的物品</div>';
      $('bagPager').hidden = true;
      return;
    }

    grid.innerHTML = view.map(function (it) {
      var edited = state.bagEdits[it.key] !== undefined;
      var curQty = edited ? state.bagEdits[it.key] : it.qty;
      var sel = state.bagSelKey === it.key;
      return '<div class="bag-card' + (sel ? ' sel' : '') + (edited ? ' mod' : '') + '" data-key="' + esc(it.key) + '">' +
        '<div class="bag-info">' +
          '<div class="bag-name" title="' + esc(it.cn) + '">' + esc(it.cn) + '</div>' +
          '<div class="bag-qty">持有 <b class="' + (edited ? 'mod' : '') + '">' + curQty + '</b>' + (edited ? ' (原 ' + it.qty + ')' : '') + '</div>' +
        '</div>' +
        (edited ? '<button type="button" class="undo-mini bag-undo" data-key="' + esc(it.key) + '" title="恢复原数量">↩</button>' : '') +
      '</div>';
    }).join('');

    var pager = $('bagPager');
    if (filtered.length > BAG_PAGE_SIZE) {
      pager.hidden = false;
      $('bagPageInfo').textContent = state.bagShowAll
        ? '共 ' + filtered.length + ' 项（已全部展开）'
        : '共 ' + filtered.length + ' 项 · 第 ' + state.bagPage + '/' + totalPages + ' 页';
      $('btnBagPrev').disabled = state.bagShowAll || state.bagPage <= 1;
      $('btnBagNext').disabled = state.bagShowAll || state.bagPage >= totalPages;
      $('btnBagShowAll').textContent = state.bagShowAll ? '分页显示' : '展开全部';
    } else {
      pager.hidden = true;
    }

    var bar = $('bagEditorBar');
    if (state.bagSelKey) {
      var selItem = state.bagItems.filter(function (x) { return x.key === state.bagSelKey; })[0];
      if (selItem) {
        bar.hidden = false;
        $('bagEdName').textContent = selItem.cn;
        $('bagEdSub').textContent = selItem.cn !== selItem.name ? selItem.name : '';
        $('bagEdQty').value = state.bagEdits[selItem.key] !== undefined ? state.bagEdits[selItem.key] : selItem.qty;
      } else {
        bar.hidden = true;
      }
    } else {
      bar.hidden = true;
    }
  }

  function setSingleBagQty(key, qty) {
    var it = state.bagItems.filter(function (x) { return x.key === key; })[0];
    if (!it) return;
    pushUndo();
    var v = Math.max(1, Math.min(999, parseInt(qty, 10) || 1));
    if (v === it.qty) delete state.bagEdits[key];
    else state.bagEdits[key] = v;
    renderBag();
    updateFoot();
  }

  /* ---------- Tab 3: 装备强化（3列紧凑卡片 + 实时状态标签） ---------- */
  var EFFECT_LABELS = {
    'None': '无词条',
    'AttackUp': '攻击力提升',
    'AttackUpPlus': '攻击力大提升',
    'DurabilityUp': '耐久提升',
    'DurabilityUpPlus': '耐久大提升',
    'FinishBlow': '终结一击强化',
    'LongThrow': '投掷距离提升',
    'RapidFire': '速射',
    'ThreeWayZoom': '三连射',
    'FiveWay': '五连射',
    'GuardUp': '防御力提升',
    'GuardUpPlus': '防御力大提升'
  };
  function effLabel(e) { return EFFECT_LABELS[e] || e || '—'; }

  var EFFECT_ALL = ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'FinishBlow', 'LongThrow'];
  var EFFECT_BY_CAT = {
    weapons: ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'FinishBlow', 'LongThrow'],
    bows: ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'RapidFire', 'ThreeWayZoom', 'FiveWay'],
    shields: ['None', 'DurabilityUp', 'DurabilityUpPlus', 'GuardUp', 'GuardUpPlus']
  };

  function eqStatusParts(it, saved, SW) {
    var curEff = (saved && saved.eff !== undefined) ? saved.eff : (it.eff || 'None');
    var curVal = (saved && saved.effVal !== undefined) ? saved.effVal : it.effVal;
    var curLife = (saved && typeof saved.life === 'number') ? saved.life : it.life;
    var baseDur = window.EQUIP_DURABILITY && window.EQUIP_DURABILITY[it.name];
    var isInf = (curEff === 'DurabilityUp' || curEff === 'DurabilityUpPlus') && curVal === SW.INF_DURABILITY;
    var isAtk = curEff === 'AttackUp' || curEff === 'AttackUpPlus' || curEff === 'GuardUp' || curEff === 'GuardUpPlus';
    var effMod = !!(saved && saved.eff !== undefined);
    var lifeMod = !!(saved && typeof saved.life === 'number');
    var effText = effLabel(curEff) + (SW.needsValue(curEff) && !isInf && curVal ? ' +' + curVal : '');
    var durText = isInf ? '∞ 永不损坏' : ('耐久 ' + (curLife !== undefined ? curLife : '?') + (baseDur ? '/' + baseDur : ''));
    return {
      effHtml: '<span class="stag eq-eff-tag' + (effMod ? ' mod-val' : (isAtk ? ' atk' : '')) + '">' + esc(effText) + '</span>',
      durHtml: '<span class="stag' + (lifeMod ? ' mod-val' : (isInf ? ' inf' : '')) + '">' + esc(durText) + '</span>' +
        (saved ? '<span class="stag mod">已改</span>' : '')
    };
  }

  function updateEqUndoCatBtn() {
    var btn = $('btnEqUndoCat');
    if (!btn) return;
    var prefix = state.eqCat + '|';
    var has = Object.keys(state.eqEdits).some(function (k) { return k.indexOf(prefix) === 0; });
    btn.hidden = !has;
  }

  function renderEquip() {
    var totalEq = 0;
    ['weapons', 'bows', 'shields'].forEach(function (cat) {
      var r = state.pouch[cat];
      var cnt = (r && r.ok) ? r.items.length : 0;
      totalEq += cnt;
      var el = document.querySelector('.eq-tab .cnt[data-cnt="' + cat + '"]');
      if (el) el.textContent = (r && r.ok) ? cnt : '—';
    });
    if ($('tabEquipBadge')) $('tabEquipBadge').textContent = totalEq || '0';
    updateEqUndoCatBtn();

    var r = state.pouch[state.eqCat];
    var box = $('eqList');
    if (!r || !r.ok) {
      box.innerHTML = '<div class="empty">' + esc(r ? r.error : '读取失败') + '</div>';
      return;
    }
    if (!r.items.length) {
      box.innerHTML = '<div class="empty">这一栏是空的</div>';
      return;
    }

    var allowed = EFFECT_BY_CAT[state.eqCat] || EFFECT_ALL;
    var opts = allowed.map(function (e) {
      return '<option value="' + e + '">' + effLabel(e) + '</option>';
    }).join('');
    var SW = window.SaveWriter;
    var canFuse = (state.eqCat === 'weapons' || state.eqCat === 'shields');

    box.innerHTML = r.items.map(function (it) {
      var key = state.eqCat + '|' + it.i;
      var saved = state.eqEdits[key];
      var cn = nameOf(it.name);
      var title = cn ? esc(cn) : esc(it.name);
      var parts = eqStatusParts(it, saved, SW);
      var curCombName = (saved && saved.combName !== undefined) ? saved.combName : (it.combName || '');
      var curCombLife = (saved && typeof saved.combLife === 'number') ? saved.combLife : it.combLife;
      var combMod = !!(saved && saved.combName !== undefined);
      var fuseText = curCombName ? ('余料：' + fuseNameOf(curCombName)) : '＋ 添加余料…';
      var fuseRowHtml = canFuse ? (
        '<div class="eq-card-fuse">' +
          '<div class="eq-fuse-wrap">' +
            '<button type="button" class="eq-fuse-btn' + (curCombName ? ' has' : '') + (combMod ? ' is-mod' : '') + '" title="' + esc(curCombName ? fuseNameOf(curCombName) + ' (' + curCombName + ')' : '选择余料附着') + '">' + esc(fuseText) + '</button>' +
            (curCombName ? '<button type="button" class="eq-fuse-clr" title="清除余料">×</button>' : '') +
          '</div>' +
          '<input type="number" class="eq-comb-life" min="0" max="99999" placeholder="' + (curCombName ? (typeof curCombLife === 'number' && curCombLife >= 0 ? '耐久 ' + curCombLife : '耐久') : '无余料') + '"' + (curCombName ? '' : ' disabled') + ' aria-label="余料耐久">' +
        '</div>'
      ) : '';
      return '' +
        '<div class="eq-card' + (saved ? ' mod' : '') + '" data-i="' + it.i + '" data-cat="' + state.eqCat + '">' +
          '<div class="eq-card-top">' +
            '<div class="eq-card-title" title="' + esc(title) + '">' + title + '</div>' +
            parts.effHtml +
            '<button type="button" class="undo-mini eq-undo" data-key="' + esc(key) + '" title="撤销该装备修改"' + (saved ? '' : ' hidden') + '>↩</button>' +
          '</div>' +
          '<div class="eq-card-dur">' +
            '<div class="eq-dur-info">' + parts.durHtml + '</div>' +
            '<input type="number" class="eq-life" min="1" max="99999" placeholder="改耐久" aria-label="耐久">' +
          '</div>' +
          '<div class="eq-card-eff">' +
            '<select class="eq-eff" aria-label="附加属性"><option value="">改词条…</option>' + opts + '</select>' +
            '<span class="eq-valwrap">' +
              '<input type="number" class="eq-val" disabled aria-label="附加数值">' +
              '<button type="button" class="eq-inf" title="设为无限耐久" aria-label="无限耐久">∞</button>' +
            '</span>' +
          '</div>' +
          fuseRowHtml +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.eq-card'), function (el) {
      var i = +el.dataset.i;
      var it = r.items.filter(function (x) { return x.i === i; })[0];
      if (!it) return;

      var key = state.eqCat + '|' + i;
      var sel = el.querySelector('.eq-eff');
      var val = el.querySelector('.eq-val');
      var inf = el.querySelector('.eq-inf');
      var wrap = el.querySelector('.eq-valwrap');
      var lifeIn = el.querySelector('.eq-life');
      var combLifeIn = el.querySelector('.eq-comb-life');
      var fuseBtn = el.querySelector('.eq-fuse-btn');
      var fuseClr = el.querySelector('.eq-fuse-clr');
      var durInfoEl = el.querySelector('.eq-dur-info');
      var origEff = it.eff || 'None';
      var origVal = it.effVal;

      function promptOf(e) {
        if (!e || !SW.needsValue(e)) return '';
        return SW.valueLabel(e) || '';
      }
      function setInf(on) {
        el.dataset.inf = on ? '1' : '';
        wrap.classList.toggle('inf-mode', on);
        inf.classList.toggle('on', on);
        val.placeholder = on ? '∞ 无限' : promptOf(sel.value);
        if (on) { val.value = ''; val.disabled = true; }
        else { val.disabled = !SW.needsValue(sel.value || ''); }
      }
      function sync(fill) {
        var e = sel.value;
        var need = !!e && SW.needsValue(e);
        var rng = e ? SW.valueRange(e) : null;
        var isDur = e === 'DurabilityUp' || e === 'DurabilityUpPlus';
        inf.classList.toggle('show', isDur);
        if (rng) { val.min = rng[0]; val.max = rng[1]; }
        else { val.removeAttribute('min'); val.removeAttribute('max'); }
        if (isDur && e === origEff && origVal === SW.INF_DURABILITY) { setInf(true); return; }
        setInf(false);
        if (!need) { val.value = ''; return; }
        if (fill) {
          var keep = (e === origEff && typeof origVal === 'number' && origVal > 0);
          val.value = keep ? origVal : 10;
        }
      }
      function syncModStyle() {
        lifeIn.classList.toggle('is-mod', lifeIn.value.trim() !== '');
        var hasEff = sel.value !== '';
        sel.classList.toggle('is-mod', hasEff);
        val.classList.toggle('is-mod', hasEff && !val.disabled && val.value.trim() !== '');
        if (combLifeIn) combLifeIn.classList.toggle('is-mod', combLifeIn.value.trim() !== '');
      }
      function persist() {
        pushUndo();
        var prev = state.eqEdits[key];
        var lifeRaw = lifeIn.value.trim();
        var rec = null;
        if (lifeRaw !== '') {
          var lv = parseInt(lifeRaw, 10);
          if (isFinite(lv)) { rec = rec || {}; rec.life = lv; }
        }
        if (sel.value !== '') {
          rec = rec || {};
          rec.eff = sel.value;
          if (sel.value === 'None') rec.effVal = 0;
          else if (SW.needsValue(sel.value)) {
            if (el.dataset.inf === '1') { rec.effVal = SW.INF_DURABILITY; rec.inf = true; }
            else {
              var vn = parseInt(val.value.trim(), 10);
              rec.effVal = isFinite(vn) ? vn : 10;
            }
          }
        }
        if (prev && prev.combName !== undefined) {
          rec = rec || {};
          rec.combName = prev.combName;
        }
        if (combLifeIn && !combLifeIn.disabled && combLifeIn.value.trim() !== '') {
          var clv = parseInt(combLifeIn.value.trim(), 10);
          if (isFinite(clv)) { rec = rec || {}; rec.combLife = clv; }
        } else if (prev && prev.combName === '' && typeof prev.combLife === 'number') {
          rec = rec || {};
          rec.combLife = prev.combLife;
        }
        if (rec) state.eqEdits[key] = rec;
        else delete state.eqEdits[key];
        el.classList.toggle('mod', !!rec);
        var uBtn = el.querySelector('.eq-undo');
        if (uBtn) uBtn.hidden = !rec;
        var parts = eqStatusParts(it, rec, SW);
        var effTag = el.querySelector('.eq-eff-tag');
        if (effTag) effTag.outerHTML = parts.effHtml;
        if (durInfoEl) durInfoEl.innerHTML = parts.durHtml;
        syncModStyle();
        updateEqUndoCatBtn();
        updateFoot();
      }

      lifeIn.addEventListener('input', persist);
      if (combLifeIn) combLifeIn.addEventListener('input', persist);
      if (fuseBtn) fuseBtn.addEventListener('click', function () { openFusePicker(state.eqCat, i); });
      if (fuseClr) fuseClr.addEventListener('click', function () { setFuseEdit(state.eqCat, i, '', -1); });
      val.addEventListener('input', persist);
      sel.addEventListener('change', function () { sync(true); persist(); });
      inf.addEventListener('click', function () {
        if (el.dataset.inf === '1') { setInf(false); val.value = 10; }
        else { setInf(true); }
        persist();
      });

      sync(false);
      var saved = state.eqEdits[key];
      if (saved) {
        if (typeof saved.life === 'number') lifeIn.value = saved.life;
        if (saved.eff) {
          sel.value = saved.eff;
          sync(true);
          if (saved.inf) setInf(true);
          else if (typeof saved.effVal === 'number') val.value = saved.effVal;
        }
        if (combLifeIn && typeof saved.combLife === 'number' && saved.combLife >= 0 && !combLifeIn.disabled) {
          combLifeIn.value = saved.combLife;
        }
      }
      syncModStyle();
    });
  }

  /* ---------- Tab 3: 蓝图工坊（30槽拖拽 + 本地蓝图库 JSON 导入导出） ---------- */
  function allPresets() {
    return state.bpLibrary || [];
  }

  function bpInspectSlot(s) {
    if (!s || !s.used || !window.Blueprint || !window.Blueprint.inspect) return null;
    if (!s._info) s._info = window.Blueprint.inspect(s.data);
    return s._info;
  }

  function bpLabel(s) {
    var no = '#' + String(s.i + 1).padStart(2, '0');
    var alias = state.bpAliases && state.bpAliases[s.i];
    if (!s.used) return no + (alias ? ' · [' + alias + '] 空槽' : ' · 空槽');
    var info = bpInspectSlot(s);
    var parts = info && info.valid ? info.actorCount + ' 零件：' + info.summary : '有蓝图';
    return no + (alias ? ' · [' + alias + '] ' : ' · ') + parts;
  }

  function nextContiguousSlot() {
    if (!state.bp || !state.bp.ok) return 0;
    var qMap = {};
    state.bpImports.forEach(function (it) { qMap[it.i] = true; });
    for (var i = 0; i < state.bp.slots.length; i++) {
      var s = state.bp.slots[i];
      if (!s.used && !qMap[s.i]) return s.i;
    }
    return state.bp.slots.length - 1;
  }

  function renderBlueprints() {
    var src = $('bpSlot'), cnt = $('bpCount'), tbody = $('bpSlotBody');
    var b = state.bp;
    if (!b || !b.ok) {
      if (cnt) cnt.textContent = b ? b.error : '读取失败';
      if (src) src.innerHTML = '';
      if (tbody) tbody.innerHTML = '<tr><td colspan="3" class="empty">加载存档后显示 30 个蓝图槽</td></tr>';
      if ($('bpExport')) $('bpExport').disabled = true;
      if ($('bpShare')) $('bpShare').disabled = true;
      return;
    }

    var used = 0, firstUsed = -1;
    b.slots.forEach(function (s) { if (s.used) { used++; if (firstUsed < 0) firstUsed = s.i; } });
    cnt.textContent = b.count + ' 槽 · 已用 ' + used;
    src.innerHTML = b.slots.map(function (s) {
      return '<option value="' + s.i + '">' + esc(bpLabel(s)) + '</option>';
    }).join('');
    if (firstUsed >= 0) src.value = String(state.bpSelSlot >= 0 && b.slots[state.bpSelSlot] ? state.bpSelSlot : firstUsed);
    if ($('bpSlotAlias')) $('bpSlotAlias').value = (state.bpAliases && state.bpAliases[+src.value]) || '';
    if ($('bpExport')) $('bpExport').disabled = firstUsed < 0;
    if ($('bpShare')) $('bpShare').disabled = firstUsed < 0;

    var qBySlot = {};
    state.bpImports.forEach(function (q, idx) { qBySlot[q.i] = { q: q, idx: idx }; });
    var nextEmpty = nextContiguousSlot();

    if (!tbody) return;
    tbody.innerHTML = b.slots.map(function (s) {
      var qInfo = qBySlot[s.i];
      var alias = state.bpAliases && state.bpAliases[s.i];
      var info = s.used ? bpInspectSlot(s) : null;
      var partsText = (info && info.valid) ? (info.actorCount + '件 · ' + info.summary) : (s.used ? '已占用（无明细）' : '空槽');

      var cls = [];
      if (qInfo) cls.push('queued');
      else if (s.used) cls.push('used');
      else if (s.i === nextEmpty) cls.push('next-empty');
      if (state.bpSelSlot === s.i) cls.push('selected');

      var descHtml = '';
      if (qInfo) {
        descHtml = '<span class="bp-alias-tag" style="color:var(--tk-gold);background:rgba(212,169,90,.16)">待写入 · ' + esc(qInfo.q.from || '蓝图') + '</span>' +
          '<span class="bp-parts-txt">' + esc(qInfo.q.summary || partsText) + '</span>';
      } else {
        descHtml = (alias ? '<span class="bp-alias-tag">' + esc(alias) + '</span>' : '') +
          '<span class="bp-parts-txt">' + esc(partsText) + (s.i === nextEmpty && !s.used ? '（可拖放到此）' : '') + '</span>';
      }

      var opsHtml = '';
      if (qInfo) {
        opsHtml = '<button type="button" class="btn-mini bp-slot-rm" data-qidx="' + qInfo.idx + '">移除</button>';
      } else if (s.used) {
        opsHtml = '<button type="button" class="btn-mini bp-row-exp" data-slot="' + s.i + '">导出</button>' +
                  '<button type="button" class="btn-mini bp-row-shr" data-slot="' + s.i + '">分享</button>';
      } else {
        opsHtml = '<span style="font-size:12px;color:var(--tk-text-3)">—</span>';
      }

      return '<tr class="' + cls.join(' ') + '" data-slot="' + s.i + '">' +
        '<td><b>#' + String(s.i + 1).padStart(2, '0') + '</b></td>' +
        '<td>' + descHtml + '</td>' +
        '<td><div class="bp-row-ops">' + opsHtml + '</div></td>' +
      '</tr>';
    }).join('');
  }

  function renderBpPending() {
    if ($('tabBpBadge')) $('tabBpBadge').textContent = state.bpImports.length;
    renderBlueprints();
  }

  function bpSetImport(caiBytes, from, targetIdx) {
    if (!state.bp || !state.bp.ok) { showBpMsg('先加载存档，再导入蓝图。', 'warn'); return; }
    try {
      var parsed = window.Blueprint.parseCai(caiBytes);
      var info = window.Blueprint.inspect(parsed.data);
      var next = nextContiguousSlot();
      var rawTarget = typeof targetIdx === 'number' ? targetIdx : next;
      var tgtSlot = state.bp.slots[rawTarget];
      /* 流式防断层：允许覆盖已占槽/已有队列槽，若拖到更后面的空槽则自动顺延对齐到首个连续空槽 */
      var qExists = state.bpImports.some(function (it) { return it.i === rawTarget; });
      var i = (tgtSlot && (tgtSlot.used || qExists || rawTarget <= next)) ? rawTarget : next;
      var rec = {
        i: i, data: parsed.data, camPos: parsed.camPos, camAt: parsed.camAt,
        from: from || '蓝图',
        summary: info.valid ? (info.actorCount + ' 零件：' + info.summary) : ''
      };
      pushUndo();
      var replaced = false;
      for (var k = 0; k < state.bpImports.length; k++) {
        if (state.bpImports[k].i === i) { state.bpImports[k] = rec; replaced = true; break; }
      }
      if (!replaced) state.bpImports.push(rec);
      renderBpPending();
      updateFoot();
    } catch (e) { showBpMsg('<b>导入失败：</b>' + esc(e.message), 'warn'); }
  }

  function bpBatchQueue(entries) {
    if (!state.bp || !state.bp.ok) { showBpMsg('先加载存档，再批量导入蓝图。', 'warn'); return; }
    var added = 0, skipped = 0, errs = [];
    for (var k = 0; k < entries.length; k++) {
      var slotIdx = nextContiguousSlot();
      var qExists = state.bpImports.some(function (it) { return it.i === slotIdx; });
      if (state.bp.slots[slotIdx] && state.bp.slots[slotIdx].used && !qExists && slotIdx === state.bp.slots.length - 1) {
        skipped += (entries.length - k); break;
      }
      try {
        var parsed = window.Blueprint.parseCai(entries[k].caiBytes);
        var info = window.Blueprint.inspect(parsed.data);
        state.bpImports.push({
          i: slotIdx, data: parsed.data, camPos: parsed.camPos, camAt: parsed.camAt,
          from: entries[k].from || '蓝图',
          summary: info.valid ? (info.actorCount + ' 零件：' + info.summary) : ''
        });
        added++;
      } catch (e) {
        errs.push((entries[k].from || ('#' + (k + 1))) + '：' + e.message);
      }
    }
    renderBpPending();
    updateFoot();
    if (errs.length) showBpMsg('批量导入部分失败（成功 ' + added + ' 个）：' + esc(errs[0]), 'warn');
    else if (skipped > 0) showBpMsg('已填入 ' + added + ' 个空槽，剩余 ' + skipped + ' 个因空槽不足未填入。', 'warn');
    else if (added > 0) showBpMsg('已将 <b>' + added + '</b> 张蓝图加入写入队列。', 'ok');
  }

  function bpSlot() {
    if (!state.bp || !state.bp.ok) return null;
    return state.bp.slots[+$('bpSlot').value] || null;
  }

  function bpExport(slotIdx) {
    var s = (typeof slotIdx === 'number' && state.bp && state.bp.ok) ? state.bp.slots[slotIdx] : bpSlot();
    if (!s || !s.used) { showBpMsg('这个槽里没有蓝图，换一个再导出。', 'warn'); return; }
    try {
      var cai = window.Blueprint.toCai(s);
      window.Blueprint.download(cai, 'blueprint_' + String(s.i + 1).padStart(2, '0') + '.cai');
      showBpMsg('<b>已导出 .cai。</b>', 'ok');
    } catch (e) { showBpMsg('<b>导出失败：</b>' + esc(e.message), 'warn'); }
  }

  function bpShare(slotIdx) {
    var s = (typeof slotIdx === 'number' && state.bp && state.bp.ok) ? state.bp.slots[slotIdx] : bpSlot();
    if (!s || !s.used) { showBpMsg('这个槽里没有蓝图，换一个再分享。', 'warn'); return; }
    try {
      var code = window.Blueprint.encodeShare(window.Blueprint.toCai(s));
      $('bpShareText').value = code;
      if ($('bpShareDlgTitle')) $('bpShareDlgTitle').textContent = '分享码 · #' + String(s.i + 1).padStart(2, '0');
      if ($('bpSharePanel')) {
        $('bpSharePanel').hidden = false;
        $('bpSharePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (e) { showBpMsg('<b>生成分享码失败：</b>' + esc(e.message), 'warn'); }
  }

  function renderBlueprintPresets() {
    var tbody = $('bpPresetBody');
    if (!tbody) return;
    var list = allPresets();
    if ($('bpLibFootInfo')) {
      $('bpLibFootInfo').textContent = '已加载 ' + list.length + ' 款蓝图';
    }
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="2" class="empty">当前蓝图库为空，可点击下方「加载推荐蓝图」或右上角导入 .json</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (p, idx) {
      var chk = state.bpPresetSel[p.id] ? ' checked' : '';
      var parts = ((p.parts && p.parts.length) ? p.parts.join('、') : (p.desc || '')).replace(/\s*×\s*/g, '×');
      return '<tr draggable="true" data-idx="' + idx + '" title="双击或拖动到左侧槽位放入">' +
        '<td><input type="checkbox" class="bp-preset-chk" data-id="' + esc(p.id) + '"' + chk + '></td>' +
        '<td>' +
          '<span class="bp-lib-name-badge">' + esc(p.name) + '</span>' +
          '<span class="bp-lib-ore-badge">' + (p.costOre || '?') + '矿</span>' +
          '<span class="bp-parts-txt">' + esc(parts) + '</span>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  /* ---------- 收集用户意图 ---------- */
  function collectPlan() {
    var p = {};

    var rupee = $('inRupee').value.trim();
    if (rupee !== '') { var rv = parseInt(rupee, 10); if (isFinite(rv)) p.rupee = rv; }

    var hearts = $('inHearts').value.trim();
    if (hearts !== '') { var hv = parseInt(hearts, 10); if (isFinite(hv)) p.hearts = hv; }

    var st = segVal('segStamina');
    if (st !== null) p.stamina = st;
    var en = segVal('segEnergy');
    if (en !== null) p.energy = en;

    /* 单个背包物品数量微调 */
    var pouchQty = [];
    Object.keys(state.bagEdits).forEach(function (k) {
      var bar = k.indexOf('|');
      pouchQty.push({ cat: k.slice(0, bar), i: +k.slice(bar + 1), qty: state.bagEdits[k] });
    });
    if (pouchQty.length) p.pouchQty = pouchQty;

    var items = [];
    Object.keys(state.eqEdits).forEach(function (k) {
      var bar = k.indexOf('|');
      var rec = state.eqEdits[k];
      var one = { cat: k.slice(0, bar), i: +k.slice(bar + 1) };
      if (typeof rec.life === 'number') one.life = rec.life;
      if (typeof rec.eff === 'string') {
        one.eff = rec.eff;
        if (typeof rec.effVal === 'number') one.effVal = rec.effVal;
      }
      if (typeof rec.combName === 'string') one.combName = rec.combName;
      if (typeof rec.combLife === 'number') one.combLife = rec.combLife;
      if (one.life !== undefined || one.eff !== undefined || one.combName !== undefined || one.combLife !== undefined) items.push(one);
    });
    if (items.length) p.items = items;

    if (state.bpImports.length) p.blueprints = state.bpImports;

    return p;
  }

  /* ---------- 预览与单文件导出 ---------- */
  function openPreview() {
    var plan = collectPlan();
    if (!Object.keys(plan).length) {
      showMsg('还没选要改什么 —— 改完任意一项再点提交导出。', '');
      return;
    }

    var res;
    try {
      res = state.sw.apply(plan);
    } catch (e) {
      showMsg('<b>生成失败：</b>' + esc(e.message), 'warn');
      return;
    }
    if (!res.ok) { showMsg('<b>改不了：</b>' + esc(res.error), 'warn'); return; }
    if (!res.changed) { showMsg('你填的值和存档里现在的一样，没有需要写的字节。', ''); return; }

    state.pending = res;
    var groups = {};
    res.edits.forEach(function (e) {
      if (/^蓝图/.test(e.label)) return;
      var key = e.label.replace(/#\d+/, '').replace(/ \d+$/, '');
      if (!groups[key]) groups[key] = { n: 0, label: key, samples: [] };
      groups[key].n++;
      if (groups[key].samples.length < 3) groups[key].samples.push(e);
    });

    function one(e, which) {
      var t = which === 'from' ? e.fromText : e.toText;
      if (t !== undefined) return effLabel(t);
      var v = which === 'from' ? e.from : e.to;
      if (v === window.SaveWriter.INF_DURABILITY) return '∞';
      return fmt(v);
    }

    var html = '';
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      if (g.n === 1) {
        var e0 = g.samples[0];
        html += '<div class="chg"><span class="nm">' + esc(e0.label) + '</span>' +
          '<span class="va">' + esc(one(e0, 'from')) + ' → <b>' + esc(one(e0, 'to')) + '</b></span></div>';
      } else {
        var preview = g.samples.map(function (e) { return one(e, 'from') + '→' + one(e, 'to'); }).join('、');
        html += '<div class="chg"><span class="nm">' + esc(g.label) + ' × ' + g.n + ' 项</span>' +
          '<span class="va">' + esc(preview) + ' …</span></div>';
      }
    });
    if (state.bpImports.length) {
      state.bpImports.forEach(function (b) {
        var tgt = state.bp && state.bp.slots && state.bp.slots[b.i];
        var act = tgt && tgt.used ? '覆盖' : '写入';
        html += '<div class="chg"><span class="nm">蓝图 · #' + String(b.i + 1).padStart(2, '0') + '</span>' +
          '<span class="va">' + act + ' ← <b>' + esc(b.from || '蓝图') + '</b></span></div>';
      });
    }

    var vr = res.verify();
    html += '<div class="tip ok">共改动 <b class="num">' + res.changed + '</b> 处、' +
      '<b class="num">' + vr.bytes + '</b> 个字节，文件长度不变。点击「导出 progress.sav」直接获取改好的存档。</div>';

    $('previewBody').innerHTML = html;
    $('previewMask').classList.remove('hidden');
    $('btnDownload').focus();
  }

  function fileTag() {
    var d = new Date();
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
  }

  function doDownload() {
    var res = state.pending;
    if (!res) return;
    var editedBuf = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength);
    try {
      window.SaveWriter.download(editedBuf, 'progress.sav');
      state.dlDone = true;
      $('btnDownload').textContent = '已完成，关闭';
      $('dlgTitle').textContent = '已导出 progress.sav';
      $('btnCancelPreview').hidden = true;
      showMsg('<b>已导出修改后的 progress.sav。</b>覆盖存档目录对应槽位即可生效。', 'ok');
    } catch (e) {
      showMsg('<b>导出失败：</b>' + esc(e.message), 'warn');
    }
  }

  function closePreview() {
    $('previewMask').classList.add('hidden');
    state.dlDone = false;
    state.pending = null;
    $('btnDownload').disabled = false;
    $('btnDownload').textContent = '导出 progress.sav';
    $('dlgTitle').textContent = '确认要改这些';
    $('btnCancelPreview').hidden = false;
  }

  /* ---------- 状态面板 + 横幅 + 底栏 ---------- */
  function paintStat(id, valHtml, wasHtml, dirty) {
    var el = $(id);
    if (!el) return;
    el.querySelector('.stat-val').innerHTML = valHtml;
    el.querySelector('.stat-was').innerHTML = wasHtml || '';
    el.classList.toggle('dirty', !!dirty);
    el.classList.toggle('mod', !!dirty);
    var u = el.querySelector('.undo-mini');
    if (u) u.hidden = !dirty;
  }

  function updateFoot() {
    if (!state.sw) {
      if ($('btnUndoAllStats')) $('btnUndoAllStats').hidden = true;
      $('footStatus').textContent = '还没有加载存档';
      return;
    }
    var plan = collectPlan();
    var o = state.origin;

    var rUp = typeof plan.rupee === 'number';
    paintStat('statRupee', thou(rUp ? plan.rupee : o.rupee), rUp ? '<s>' + thou(o.rupee) + '</s>' : '', rUp && plan.rupee !== o.rupee);

    var hUp = typeof plan.hearts === 'number';
    paintStat('statHearts', fmt(hUp ? plan.hearts : o.hearts) + '<small>心</small>', hUp ? '<s>' + fmt(o.hearts) + '</s>' : '', hUp && plan.hearts !== o.hearts);

    var sUp = typeof plan.stamina === 'number';
    var sVal = sUp ? plan.stamina : o.stamina;
    paintStat('statStamina', fmt(sVal / 1000) + '<small>圈</small>', sUp ? '<s>' + fmt(o.stamina / 1000) + '</s>' : '', sUp && plan.stamina !== o.stamina);

    var eUp = typeof plan.energy === 'number';
    var eVal = eUp ? plan.energy : o.energy;
    paintStat('statEnergy', fmt(eVal / 1000) + '<small>格</small>', eUp ? '<s>' + fmt(o.energy / 1000) + '</s>' : '', eUp && plan.energy !== o.energy);

    if ($('btnUndoAllStats')) $('btnUndoAllStats').hidden = !(rUp || hUp || sUp || eUp);

    var n = 0;
    if (rUp) n++;
    if (hUp) n++;
    if (sUp) n++;
    if (eUp) n++;
    if (plan.pouchQty) n += plan.pouchQty.length;
    if (plan.pos) n++;
    if (plan.items) n += plan.items.length;
    if (plan.blueprints) n += plan.blueprints.length;

    $('sbCount').textContent = n + ' 项';
    $('sbCount').className = n ? 'mod' : '';
    $('sbState').textContent = n ? '有未导出修改' : '未修改';
    $('sbState').className = n ? 'mod' : '';

    renderModLog(plan, o);

    var src = state.source === 'navi' ? 'navi 直连' : '本地文件';
    $('footStatus').innerHTML = n
      ? '已确认 <b>' + n + '</b> 项修改<span class="sep">·</span>直接导出修改后的 progress.sav'
      : '版本 ' + esc(state.sw.version) + '<span class="sep">·</span>' + esc(src) + '<span class="sep">·</span>还没选要改什么';
  }

  function renderModLog(plan, o) {
    var box = $('modLogList');
    if (!box) return;
    var logs = [];
    if (typeof plan.rupee === 'number' && plan.rupee !== o.rupee) {
      logs.push({ t: 'stat', k: 'rupee', html: '卢比：' + thou(o.rupee) + ' → <b>' + thou(plan.rupee) + '</b>' });
    }
    if (typeof plan.hearts === 'number' && plan.hearts !== o.hearts) {
      logs.push({ t: 'stat', k: 'hearts', html: '生命：' + fmt(o.hearts) + '心 → <b>' + fmt(plan.hearts) + '心</b>' });
    }
    if (typeof plan.stamina === 'number' && plan.stamina !== o.stamina) {
      logs.push({ t: 'stat', k: 'stamina', html: '精力：' + fmt(o.stamina / 1000) + '圈 → <b>' + fmt(plan.stamina / 1000) + '圈</b>' });
    }
    if (typeof plan.energy === 'number' && plan.energy !== o.energy) {
      logs.push({ t: 'stat', k: 'energy', html: '电池：' + fmt(o.energy / 1000) + '格 → <b>' + fmt(plan.energy / 1000) + '格</b>' });
    }
    Object.keys(state.bagEdits).forEach(function (k) {
      var it = state.bagItems.filter(function (x) { return x.key === k; })[0];
      if (it) logs.push({ t: 'bag', k: k, html: '背包 · ' + esc(it.cn) + '：' + it.qty + ' → <b>' + state.bagEdits[k] + '</b>' });
    });
    Object.keys(state.eqEdits).forEach(function (k) {
      var bar = k.indexOf('|'), cat = k.slice(0, bar), idx = +k.slice(bar + 1);
      var r = state.pouch[cat] && state.pouch[cat].items ? state.pouch[cat].items.filter(function (x) { return x.i === idx; })[0] : null;
      var nm = r ? (nameOf(r.name) || r.name) : k;
      var rec = state.eqEdits[k];
      var desc = [];
      if (typeof rec.life === 'number') desc.push('耐久 ' + rec.life);
      if (rec.eff) desc.push(rec.inf ? '∞无限耐久' : (effLabel(rec.eff) + (rec.effVal ? ' +' + rec.effVal : '')));
      if (rec.combName !== undefined) desc.push(rec.combName ? ('余料 ' + fuseNameOf(rec.combName)) : '清除余料');
      if (typeof rec.combLife === 'number' && rec.combName !== '') desc.push('余料耐久 ' + rec.combLife);
      logs.push({ t: 'eq', k: k, html: '装备 · ' + esc(nm) + '：<b>' + esc(desc.join(' / ')) + '</b>' });
    });
    state.bpImports.forEach(function (b, idx) {
      logs.push({ t: 'bp', k: String(idx), html: '蓝图 · #' + String(b.i + 1).padStart(2, '0') + ' ← <b>' + esc(b.from || '蓝图') + '</b>' });
    });

    if (!logs.length) {
      box.innerHTML = '<div class="mod-log-empty">暂无修改，改动后将在此实时显示</div>';
      return;
    }
    box.innerHTML = logs.map(function (it) {
      return '<div class="mod-log-item">' +
        '<span class="mod-log-txt">' + it.html + '</span>' +
        '<button type="button" class="undo-mini" data-log-t="' + it.t + '" data-log-k="' + esc(it.k) + '" title="撤销此项">×</button>' +
      '</div>';
    }).join('');
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btnBack').addEventListener('click', function () { location.href = '../index.html'; });

    Array.prototype.forEach.call(document.querySelectorAll('#mainTabs .mtab'), function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
    });

    $('btnPick').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      showMsg('正在读取 ' + esc(f.name) + ' …');
      var fr = new FileReader();
      fr.onload = function () { loadFromArrayBuffer(fr.result, 'file'); showMsg(''); };
      fr.onerror = function () { showMsg('读文件失败', 'warn'); };
      fr.readAsArrayBuffer(f);
    });

    /* 整页支持拖入 progress.sav */
    document.body.addEventListener('dragover', function (e) {
      if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
        e.preventDefault();
      }
    });
    document.body.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/\.sav$/i.test(f.name)) return;
      e.preventDefault();
      var fr = new FileReader();
      fr.onload = function () { loadFromArrayBuffer(fr.result, 'file'); showMsg(''); };
      fr.readAsArrayBuffer(f);
    });

    $('btnFromNavi').addEventListener('click', function () {
      if (location.protocol === 'file:') {
        showMsg('<b>离线 file:// 方式打不开自动读取</b>，请直接选择存档文件。', 'warn');
        return;
      }
      var btn = $('btnFromNavi');
      btn.disabled = true;
      showMsg('正在向 totknavi 要最新存档…');
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
      fetch(NAVI + '/save?t=' + Date.now(), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (ab) { if (timer) clearTimeout(timer); btn.disabled = false; showMsg(''); loadFromArrayBuffer(ab, 'navi'); })
        .catch(function () {
          if (timer) clearTimeout(timer); btn.disabled = false;
          showMsg('<b>连不上 totknavi</b>，可直接点击左边「选择存档文件」。', 'warn');
        });
    });

    /* 顶部拖放热区反馈 */
    var dropBox = $('saveBanner');
    if (dropBox) {
      dropBox.addEventListener('dragenter', function (e) {
        if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
          dropBox.classList.add('drag-over');
        }
      });
      dropBox.addEventListener('dragleave', function (e) {
        if (!dropBox.contains(e.relatedTarget)) dropBox.classList.remove('drag-over');
      });
      dropBox.addEventListener('drop', function () { dropBox.classList.remove('drag-over'); });
    }

    /* 一键数值全满 & 基础数值修改 + 单项撤销 */
    if ($('btnMaxAllStats')) {
      $('btnMaxAllStats').addEventListener('click', function () {
        if (!state.sw) { showMsg('请先加载存档再一键全满。', 'warn'); return; }
        pushUndo();
        $('inRupee').value = '999999';
        $('inHearts').value = '40';
        setSeg('segStamina', 3000);
        setSeg('segEnergy', 16000);
        updateFoot();
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.qbtn'), function (b) {
      b.addEventListener('click', function () {
        pushUndo();
        if (b.dataset.hearts) $('inHearts').value = b.dataset.hearts;
        if (b.dataset.rupee) $('inRupee').value = b.dataset.rupee;
        Array.prototype.forEach.call(b.parentNode.querySelectorAll('.qbtn'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        updateFoot();
      });
    });

    ['segStamina', 'segEnergy'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        pushUndo();
        setSeg(id, b.dataset.v === '' ? null : +b.dataset.v);
        updateFoot();
      });
    });

    ['inRupee', 'inHearts'].forEach(function (id) {
      $(id).addEventListener('focus', function () { this._undoPushed = false; });
      $(id).addEventListener('input', function () {
        if (!this._undoPushed) { pushUndo(); this._undoPushed = true; }
        updateFoot();
      });
    });

    if ($('btnUndoAllStats')) {
      $('btnUndoAllStats').addEventListener('click', function () {
        pushUndo();
        $('inRupee').value = '';
        $('inHearts').value = '';
        setSeg('segStamina', null);
        setSeg('segEnergy', null);
        updateFoot();
      });
    }

    /* Tab 2: 背包物品 */
    $('bagSearch').addEventListener('input', function () {
      state.bagQuery = this.value.trim();
      state.bagPage = 1;
      renderBag();
    });
    $('bagCatPills').addEventListener('click', function (e) {
      var b = e.target.closest('.bag-cat-pill');
      if (!b) return;
      state.bagCat = b.dataset.g;
      state.bagPage = 1;
      renderBag();
    });
    $('bagItemGrid').addEventListener('click', function (e) {
      var u = e.target.closest('.bag-undo');
      if (u) {
        e.stopPropagation();
        pushUndo();
        delete state.bagEdits[u.dataset.key];
        renderBag();
        updateFoot();
        return;
      }
      var card = e.target.closest('.bag-card');
      if (!card) return;
      state.bagSelKey = card.dataset.key;
      renderBag();
    });
    $('bagEdQty').addEventListener('change', function () {
      if (state.bagSelKey) setSingleBagQty(state.bagSelKey, this.value);
    });
    $('bagEditorBar').addEventListener('click', function (e) {
      var b = e.target.closest('[data-bqty]');
      if (!b || !state.bagSelKey) return;
      setSingleBagQty(state.bagSelKey, +b.dataset.bqty);
    });
    function batchSetBag(items, qty) {
      pushUndo();
      items.forEach(function (it) {
        if (qty === it.qty) delete state.bagEdits[it.key];
        else state.bagEdits[it.key] = qty;
      });
      renderBag();
      updateFoot();
    }
    $('btnBagFill999').addEventListener('click', function () { batchSetBag(bagFiltered(), 999); });
    $('btnBagFill99').addEventListener('click', function () { batchSetBag(bagFiltered(), 99); });
    $('btnBagFill1').addEventListener('click', function () { batchSetBag(bagFiltered(), 1); });
    $('btnBagFillAll').addEventListener('click', function () { batchSetBag(state.bagItems, 999); });
    $('btnBagPrev').addEventListener('click', function () { if (state.bagPage > 1) { state.bagPage--; renderBag(); } });
    $('btnBagNext').addEventListener('click', function () { state.bagPage++; renderBag(); });
    $('btnBagShowAll').addEventListener('click', function () { state.bagShowAll = !state.bagShowAll; renderBag(); });

    /* Tab 2: 装备切换 + 单项撤销 + 批量改耐久（不碰词条） */
    function batchSetEquipDurability(cats, mode) {
      if (!state.sw) { msg('loadMsg', '请先加载存档', 'err'); return; }
      var touched = 0;
      cats.forEach(function (cat) {
        var r = state.pouch[cat];
        if (r && r.ok && r.items.length) touched += r.items.length;
      });
      if (!touched) return;
      pushUndo();
      cats.forEach(function (cat) {
        var r = state.pouch[cat];
        if (!r || !r.ok) return;
        r.items.forEach(function (it) {
          var key = cat + '|' + it.i;
          var targetLife = mode === 'base'
            ? ((window.EQUIP_DURABILITY && window.EQUIP_DURABILITY[it.name]) || 100)
            : mode;
          var rec = state.eqEdits[key] ? cloneSimple(state.eqEdits[key]) : {};
          if (targetLife === it.life) {
            delete rec.life;
          } else {
            rec.life = targetLife;
          }
          if (Object.keys(rec).length) state.eqEdits[key] = rec;
          else delete state.eqEdits[key];
        });
      });
      renderEquip();
      updateFoot();
    }
    if ($('btnEqFill999')) $('btnEqFill999').addEventListener('click', function () { batchSetEquipDurability([state.eqCat], 999); });
    if ($('btnEqFillAll999')) $('btnEqFillAll999').addEventListener('click', function () { batchSetEquipDurability(['weapons', 'bows', 'shields'], 999); });
    if ($('btnEqUndoCat')) {
      $('btnEqUndoCat').addEventListener('click', function () {
        var prefix = state.eqCat + '|';
        var keys = Object.keys(state.eqEdits).filter(function (k) { return k.indexOf(prefix) === 0; });
        if (!keys.length) return;
        pushUndo();
        keys.forEach(function (k) { delete state.eqEdits[k]; });
        renderEquip();
        updateFoot();
      });
    }

    /* 余料附着弹窗逻辑 */
    var fuseTarget = null;
    var fuseCatalog = null;
    function buildFuseCatalog() {
      if (fuseCatalog) return fuseCatalog;
      var list = [], seen = {};
      function add(id, cn, tag) {
        if (!id || seen[id] || id.length >= 64) return;
        if (id === 'SpObj_ElectricBoxGenerCapsule_ator') return;
        if (id.indexOf('SpObj_') === 0) {
          id = id.replace(/_Capsule_([AB]_\d+)$/, '_$1');
        }
        if (seen[id]) return;
        seen[id] = 1;
        list.push({ id: id, cn: cn || id, tag: tag || '', q: (cn + ' ' + id).toLowerCase() });
      }
      FUSE_PRESETS.forEach(function (p) { add(p.id, p.cn, p.tag); });
      if (window.MAT_NAMES) {
        Object.keys(window.MAT_NAMES).forEach(function (k) {
          if (/^(Item_Cook_|Item_Roast|Obj_)/.test(k)) return;
          add(k, window.MAT_NAMES[k], k.indexOf('SpObj_') === 0 ? '左纳乌' : '素材');
        });
      }
      if (window.EQUIP_NAMES) {
        Object.keys(window.EQUIP_NAMES).forEach(function (k) {
          if (k.indexOf('Weapon_Bow_') === 0) return;
          add(k, window.EQUIP_NAMES[k], k.indexOf('Weapon_Shield_') === 0 ? '盾' : '武器');
        });
      }
      if (window.FUSE_NAMES) {
        Object.keys(window.FUSE_NAMES).forEach(function (k) {
          add(k, window.FUSE_NAMES[k], k.indexOf('SpObj_') === 0 ? '左纳乌' : '物体');
        });
      }
      fuseCatalog = list;
      return list;
    }
    window.setFuseEdit = function (cat, idx, combName, combLife) {
      var r = state.pouch[cat];
      var it = r && r.items ? r.items.filter(function (x) { return x.i === idx; })[0] : null;
      if (!it) return;
      var key = cat + '|' + idx;
      pushUndo();
      var rec = state.eqEdits[key] ? cloneSimple(state.eqEdits[key]) : {};
      if (combName === (it.combName || '')) {
        delete rec.combName;
      } else {
        rec.combName = combName;
      }
      if (typeof combLife === 'number') {
        if (combLife === it.combLife) delete rec.combLife;
        else rec.combLife = combLife;
      }
      if (Object.keys(rec).length) state.eqEdits[key] = rec;
      else delete state.eqEdits[key];
      renderEquip();
      updateFoot();
    };
    function renderFuseList(kw) {
      var box = $('fuseResults');
      if (!box) return;
      var q = (kw || '').trim().toLowerCase();
      var all = buildFuseCatalog();
      var hits = q ? all.filter(function (x) { return x.q.indexOf(q) >= 0; }) : all.slice(0, 60);
      if (!hits.length) {
        box.innerHTML = '<div class="empty" style="padding:16px">没有匹配的余料</div>';
        return;
      }
      box.innerHTML = hits.slice(0, 80).map(function (x) {
        return '<button type="button" class="fuse-row" data-fid="' + esc(x.id) + '">' +
          '<span>' + esc(x.cn) + (x.tag ? ' <small style="color:var(--tk-gold)">' + esc(x.tag) + '</small>' : '') + '</span>' +
          '<small>' + esc(x.id) + '</small>' +
        '</button>';
      }).join('');
    }
    function closeFusePicker() {
      $('fuseMask').classList.add('hidden');
      fuseTarget = null;
    }
    window.openFusePicker = function (cat, idx) {
      var r = state.pouch[cat];
      var it = r && r.items ? r.items.filter(function (x) { return x.i === idx; })[0] : null;
      if (!it) return;
      fuseTarget = { cat: cat, idx: idx };
      $('fuseTargetName').textContent = nameOf(it.name) || it.name;
      $('fusePresets').innerHTML = FUSE_PRESETS.map(function (p) {
        return '<button type="button" class="fuse-chip" data-fid="' + esc(p.id) + '">' + esc(p.cn) + '<small>' + esc(p.tag) + '</small></button>';
      }).join('');
      $('fuseSearch').value = '';
      renderFuseList('');
      $('fuseMask').classList.remove('hidden');
      setTimeout(function () { $('fuseSearch').focus(); }, 20);
    };
    if ($('fuseMask')) {
      $('fusePresets').addEventListener('click', function (e) {
        var b = e.target.closest('[data-fid]');
        if (!b || !fuseTarget) return;
        var id = b.dataset.fid;
        setFuseEdit(fuseTarget.cat, fuseTarget.idx, id, defaultFuseLife(id));
        closeFusePicker();
      });
      $('fuseResults').addEventListener('click', function (e) {
        var b = e.target.closest('[data-fid]');
        if (!b || !fuseTarget) return;
        var id = b.dataset.fid;
        setFuseEdit(fuseTarget.cat, fuseTarget.idx, id, defaultFuseLife(id));
        closeFusePicker();
      });
      $('fuseSearch').addEventListener('input', function () { renderFuseList(this.value); });
      $('btnFuseClear').addEventListener('click', function () {
        if (!fuseTarget) return;
        setFuseEdit(fuseTarget.cat, fuseTarget.idx, '', -1);
        closeFusePicker();
      });
      $('btnCloseFuse').addEventListener('click', closeFusePicker);
      $('btnCancelFuse').addEventListener('click', closeFusePicker);
      $('fuseMask').addEventListener('click', function (e) { if (e.target === $('fuseMask')) closeFusePicker(); });
    }

    $('eqList').addEventListener('click', function (e) {
      var u = e.target.closest('.eq-undo');
      if (!u) return;
      pushUndo();
      delete state.eqEdits[u.dataset.key];
      renderEquip();
      updateFoot();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.eq-tab'), function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.eq-tab'), function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        state.eqCat = t.dataset.cat;
        renderEquip();
        updateFoot();
      });
    });

    /* Tab 3: 蓝图 30 槽表格拖拽 + 行内操作 + 分享弹窗关闭 */
    $('bpSlotBody').addEventListener('click', function (e) {
      var rm = e.target.closest('.bp-slot-rm');
      if (rm) {
        pushUndo();
        state.bpImports.splice(+rm.dataset.qidx, 1);
        renderBpPending();
        updateFoot();
        return;
      }
      var exp = e.target.closest('.bp-row-exp');
      if (exp) { bpExport(+exp.dataset.slot); return; }
      var shr = e.target.closest('.bp-row-shr');
      if (shr) { bpShare(+shr.dataset.slot); return; }

      var tr = e.target.closest('tr[data-slot]');
      if (!tr) return;
      state.bpSelSlot = +tr.dataset.slot;
      $('bpSlot').value = String(state.bpSelSlot);
      if ($('bpSlotAlias')) $('bpSlotAlias').value = (state.bpAliases && state.bpAliases[state.bpSelSlot]) || '';
      renderBlueprints();
    });
    $('bpSlotBody').addEventListener('dragover', function (e) {
      var tr = e.target.closest('tr[data-slot]');
      if (!tr) return;
      e.preventDefault();
      tr.classList.add('drag-over');
    });
    $('bpSlotBody').addEventListener('dragleave', function (e) {
      var tr = e.target.closest('tr[data-slot]');
      if (tr) tr.classList.remove('drag-over');
    });
    $('bpSlotBody').addEventListener('drop', function (e) {
      var tr = e.target.closest('tr[data-slot]');
      if (!tr) return;
      e.preventDefault();
      tr.classList.remove('drag-over');
      var idxStr = e.dataTransfer.getData('text/plain');
      if (idxStr === '') return;
      var p = allPresets()[+idxStr];
      if (!p) return;
      try {
        var cai = window.Blueprint.decodeShare(p.shareCode);
        bpSetImport(cai, p.name, +tr.dataset.slot);
      } catch (err) {
        showBpMsg('蓝图载入失败：' + esc(err.message), 'warn');
      }
    });

    if ($('bpExport')) $('bpExport').addEventListener('click', function () { bpExport(); });
    if ($('bpShare')) $('bpShare').addEventListener('click', function () { bpShare(); });
    if ($('btnCloseShare')) $('btnCloseShare').addEventListener('click', function () { $('bpSharePanel').hidden = true; });
    if ($('btnCloseShareFoot')) $('btnCloseShareFoot').addEventListener('click', function () { $('bpSharePanel').hidden = true; });
    $('bpCopy').addEventListener('click', function () {
      var t = $('bpShareText');
      t.select();
      try { document.execCommand('copy'); showBpMsg('分享码已复制。', 'ok'); }
      catch (e) { if (navigator.clipboard) navigator.clipboard.writeText(t.value); }
    });

    $('bpFile').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = '';
      if (!files.length) return;
      var caiFiles = [], jsonFiles = [];
      files.forEach(function (f) {
        if (/\.json$/i.test(f.name)) jsonFiles.push(f);
        else caiFiles.push(f);
      });
      jsonFiles.forEach(function (jf) {
        var fr = new FileReader();
        fr.onload = function () {
          try {
            var arr = JSON.parse(fr.result);
            if (!Array.isArray(arr)) throw new Error('JSON 根必须是蓝图数组');
            var added = 0;
            arr.forEach(function (it, k) {
              if (it && it.shareCode) {
                state.bpLibrary.push({
                  id: it.id || ('custom_' + Date.now() + '_' + k),
                  name: it.name || ('导入蓝图 #' + (k + 1)),
                  parts: it.parts || [],
                  costOre: it.costOre || 0,
                  shareCode: it.shareCode
                });
                added++;
              }
            });
            saveBpLibrary();
            renderBlueprintPresets();
            showBpMsg('已从 <b>' + esc(jf.name) + '</b> 导入 ' + added + ' 个蓝图到右侧蓝图库。', 'ok');
          } catch (err) { showBpMsg('JSON 解析失败：' + esc(err.message), 'warn'); }
        };
        fr.readAsText(jf);
      });
      if (caiFiles.length) {
        Promise.all(caiFiles.map(function (file) {
          return new Promise(function (resolve) {
            var r = new FileReader();
            r.onload = function () { resolve({ bytes: new Uint8Array(r.result), name: file.name }); };
            r.onerror = function () { resolve({ bytes: null, name: file.name }); };
            r.readAsArrayBuffer(file);
          });
        })).then(function (items) {
          var added = 0, errs = [];
          items.forEach(function (item, k) {
            if (!item.bytes) { errs.push(item.name + ' 读取失败'); return; }
            try {
              var parsed = window.Blueprint.parseCai(item.bytes);
              var info = window.Blueprint.inspect(parsed.data);
              var caiFull = window.Blueprint.toCai({ data: parsed.data, camPos: parsed.camPos, camAt: parsed.camAt });
              var shareCode = window.Blueprint.encodeShare(caiFull);
              var parts = (info.parts || []).map(function (pt) {
                return pt.name + (pt.count > 1 ? '×' + pt.count : '');
              });
              state.bpLibrary.push({
                id: 'cai_' + Date.now() + '_' + k,
                name: item.name.replace(/\.cai$/i, '') || ('蓝图 #' + (k + 1)),
                parts: parts,
                costOre: (info.actorCount || 0) * 3,
                shareCode: shareCode
              });
              added++;
            } catch (err) {
              errs.push(item.name + '：' + err.message);
            }
          });
          if (added) {
            saveBpLibrary();
            renderBlueprintPresets();
          }
          if (errs.length) showBpMsg('部分 .cai 导入失败（成功 ' + added + ' 个）：' + esc(errs[0]), 'warn');
          else if (added) showBpMsg('已将 <b>' + added + '</b> 个 .cai 蓝图添加到右侧本地蓝图库（双击或拖入左侧槽位使用）。', 'ok');
        });
      }
    });

    $('bpExportJson').addEventListener('click', function () {
      var list = allPresets();
      var blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
      window.SaveWriter.download(blob, 'totk_blueprints.json');
      showBpMsg('已导出蓝图库 <b>totk_blueprints.json</b>（共 ' + list.length + ' 款）。', 'ok');
    });

    $('bpCodeLoad').addEventListener('click', function () {
      try { bpSetImport(window.Blueprint.decodeShare($('bpCode').value), '分享码'); }
      catch (e) { showBpMsg('<b>分享码读不了：</b>' + esc(e.message), 'warn'); }
    });

    $('bpPresetSelAll').addEventListener('click', function () {
      var list = allPresets();
      var allOn = list.length && list.every(function (p) { return !!state.bpPresetSel[p.id]; });
      list.forEach(function (p) { state.bpPresetSel[p.id] = !allOn; });
      renderBlueprintPresets();
    });
    $('bpPresetBatch').addEventListener('click', function () {
      var chosen = allPresets().filter(function (p) { return !!state.bpPresetSel[p.id]; });
      if (!chosen.length) { showBpMsg('请先勾选要批量填入的蓝图。', 'warn'); return; }
      var entries = [];
      for (var i = 0; i < chosen.length; i++) {
        try { entries.push({ caiBytes: window.Blueprint.decodeShare(chosen[i].shareCode), from: chosen[i].name }); }
        catch (e) { showBpMsg('预设【' + esc(chosen[i].name) + '】解码失败：' + esc(e.message), 'warn'); return; }
      }
      bpBatchQueue(entries);
    });

    $('bpPresetBody').addEventListener('dragstart', function (e) {
      var tr = e.target.closest('tr[data-idx]');
      if (tr) e.dataTransfer.setData('text/plain', tr.dataset.idx);
    });
    $('bpPresetBody').addEventListener('change', function (e) {
      if (e.target.classList.contains('bp-preset-chk')) {
        state.bpPresetSel[e.target.dataset.id] = e.target.checked;
      }
    });
    /* 双击右侧蓝图行放入左侧空槽 */
    $('bpPresetBody').addEventListener('dblclick', function (e) {
      if (e.target.closest('input[type="checkbox"]')) return;
      var tr = e.target.closest('tr[data-idx]');
      if (!tr) return;
      var p = allPresets()[+tr.dataset.idx];
      if (!p) return;
      if (!state.bp || !state.bp.ok) { showBpMsg('请先加载存档再放入蓝图。', 'warn'); return; }
      try {
        bpSetImport(window.Blueprint.decodeShare(p.shareCode), p.name);
        showBpMsg('已将【' + esc(p.name) + '】加入待写入槽位。', 'ok');
      } catch (err) {
        showBpMsg('蓝图载入失败：' + esc(err.message), 'warn');
      }
    });

    if ($('bpDeleteSelected')) {
      $('bpDeleteSelected').addEventListener('click', function () {
        var before = state.bpLibrary.length;
        var next = state.bpLibrary.filter(function (p) { return !state.bpPresetSel[p.id]; });
        var removed = before - next.length;
        if (!removed) { showBpMsg('请先勾选要清除的蓝图（可点全选一键清空）。', 'warn'); return; }
        state.bpLibrary = next;
        state.bpPresetSel = {};
        saveBpLibrary();
        renderBlueprintPresets();
        showBpMsg('已从蓝图库清除 ' + removed + ' 款蓝图。', '');
      });
    }
    if ($('bpLoadRecommended')) {
      $('bpLoadRecommended').addEventListener('click', function () {
        var recs = window.TOTK_BLUEPRINTS_PRESET || [];
        var exist = {};
        state.bpLibrary.forEach(function (p) { exist[p.id || p.shareCode] = true; });
        var added = 0;
        recs.forEach(function (r) {
          var key = r.id || r.shareCode;
          if (!exist[key]) { state.bpLibrary.push(r); exist[key] = true; added++; }
        });
        saveBpLibrary();
        renderBlueprintPresets();
      });
    }

    /* 顶部修改日志：点击 × 直接撤销任意单项 */
    if ($('modLogList')) {
      $('modLogList').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-log-t]');
        if (!btn) return;
        pushUndo();
        var t = btn.dataset.logT, k = btn.dataset.logK;
        if (t === 'stat') {
          if (k === 'rupee') $('inRupee').value = '';
          else if (k === 'hearts') $('inHearts').value = '';
          else if (k === 'stamina') setSeg('segStamina', null);
          else if (k === 'energy') setSeg('segEnergy', null);
        } else if (t === 'bag') {
          delete state.bagEdits[k];
          renderBag();
        } else if (t === 'eq') {
          delete state.eqEdits[k];
          renderEquip();
        } else if (t === 'bp') {
          state.bpImports.splice(+k, 1);
          renderBpPending();
        }
        updateFoot();
      });
    }

    /* 蓝图槽位别名 + 队列移除 */
    if ($('bpSlot')) {
      $('bpSlot').addEventListener('change', function () {
        state.bpSelSlot = +this.value;
        if ($('bpSlotAlias')) $('bpSlotAlias').value = (state.bpAliases && state.bpAliases[state.bpSelSlot]) || '';
        renderBlueprints();
      });
    }
    if ($('bpSaveAlias')) {
      $('bpSaveAlias').addEventListener('click', function () {
        var idx = $('bpSlot') && $('bpSlot').value !== '' ? +$('bpSlot').value : state.bpSelSlot;
        var val = $('bpSlotAlias') ? $('bpSlotAlias').value.trim() : '';
        if (val) state.bpAliases[idx] = val;
        else delete state.bpAliases[idx];
        try { localStorage.setItem('totkmap_bp_aliases', JSON.stringify(state.bpAliases)); } catch (_) {}
        renderBlueprints();
        showBpMsg(val ? ('已为槽位 #' + String(idx + 1).padStart(2, '0') + ' 保存别名「' + esc(val) + '」。') : '已清除该槽位别名。', 'ok');
      });
    }

    /* 撤销上一步 & 重置 */
    if ($('btnUndoStep')) {
      $('btnUndoStep').addEventListener('click', popUndo);
    }
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (state.undoStack.length) { e.preventDefault(); popUndo(); }
      }
    });

    /* 重置 */
    $('btnReset').addEventListener('click', function () {
      state.undoStack = [];
      updateUndoBtn();
      ['inRupee', 'inHearts'].forEach(function (id) { $(id).value = ''; });
      setSeg('segStamina', null); setSeg('segEnergy', null);
      Array.prototype.forEach.call(document.querySelectorAll('.qbtn'), function (x) { x.classList.remove('on'); });
      state.eqEdits = {};
      state.bagEdits = {};
      state.bagSelKey = null;
      state.bpImports = [];
      if ($('bpSharePanel')) $('bpSharePanel').hidden = true;
      showBpMsg('');
      $('bpCode').value = '';
      renderBag();
      renderEquip();
      renderBpPending();
      updateFoot();
      showMsg('');
    });

    /* 预览与导出 */
    $('btnApply').addEventListener('click', openPreview);
    $('btnClosePreview').addEventListener('click', closePreview);
    $('btnCancelPreview').addEventListener('click', closePreview);
    $('btnDownload').addEventListener('click', function () {
      if (state.dlDone) closePreview();
      else doDownload();
    });
    $('btnDownloadBackup').addEventListener('click', function () {
      if (!state.file) return;
      window.SaveWriter.download(state.file.slice(0), 'progress_backup_' + fileTag() + '.sav');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('previewMask').classList.contains('hidden')) closePreview();
        if ($('bpSharePanel') && !$('bpSharePanel').hidden) $('bpSharePanel').hidden = true;
      }
    });

    renderBlueprintPresets();
  }

  if (!window.SaveWriter) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:20px;color:#e0715f">核心库 save-writer.js 没加载成功。</div>');
    return;
  }

  bind();
  renderBlueprints();
  var initTab = (location.hash || '').replace(/^#/, '');
  if (initTab === 'blueprint') initTab = 'bp';
  if (initTab) switchTab(initTab);
  window.addEventListener('hashchange', function () {
    var ht = (location.hash || '').replace(/^#/, '');
    if (ht === 'blueprint') ht = 'bp';
    if (ht) switchTab(ht);
  });
  updateFoot();
})();
