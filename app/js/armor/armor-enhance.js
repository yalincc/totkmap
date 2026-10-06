/* ============================================================
 * 防具增强：在现有「探索卡片」上补防具专属信息（V2.1 M6.6）
 * ------------------------------------------------------------
 * ★ 方向修正（M6.5 我走错了）：
 *   防具在地图上**早就有图标**（catalogs.js 里4 个「防具」分类，
 *   地表 76 / 地底 27 / 天空 11 + 6 个「防具店」，共 120 个标点），
 *   点图标打开的就是 exploreCard。M6.5 我另开一个 Tab 做图标网格，
 *   属于重复造轮子——老大要的是「在原有防具卡片上完善信息」。
 *
 * 本模块只做一件事：**当用户点的标点是防具时，往 exploreCard 里补信息**。
 *   - 不新增 Tab、不新增面板、不改地图渲染
 *   - exploreCard 的现有字段（区域/塔域/坐标/按钮/标记完成）一个都不动
 *   - 只是多出一块「防具信息」，且只在防具标点上出现
 *
 * 数据来源：app/data/armors.js（136 件结构化：防御/买价/部位/套装/强化链next）
 *   + tools/build_armor_upgrade.py 生成的强化数据（每级防御/星星/材料）
 *
 * 命名：叫「防具」不叫「装备」—— 防具是唯一不会损坏的装备。
 * ============================================================ */
(function (global) {
  'use strict';

  var ARMORS = global.TOTK_ARMORS || [];
  var UPGRADE = global.TOTK_ARMOR_UPGRADE || {};
  if (!ARMORS.length) { console.warn('[防具增强] TOTK_ARMORS 未加载'); return; }

  /* ---------- 名称匹配：地图标点 → armors.js 记录 ---------- */
  var BY_NAME = {};
  var BY_SET = {};      /* 套装名 → 同套记录（用于「怪物面具」「暗黑套装」这类统称） */
  ARMORS.forEach(function (a) {
    BY_NAME[a.name] = a;
    if (a.set) (BY_SET[a.set] = BY_SET[a.set] || []).push(a);
  });

  /* 三级匹配，逐级放宽：
   *   ① 名字全等            —— 「鬼神服」
   *   ② 套装名等��标点名   —— 「暗黑套装」→ set=暗黑 的三件
   *   ③ 去掉后缀再比套装    —— 「海利亚套装」/「卓拉铠甲」这类官方叫法
   * 说明：地图标点里有一部分是「整套一起给」的统称（怪物面具=4 个面具合一点），
   *   按名字匹配不到，只能落到套装维度。这是有意为之，不是 bug。 */
  function match(ptName) {
    var n = String(ptName || '').trim();
    if (!n) return null;
    if (BY_NAME[n]) return { armor: BY_NAME[n], mode: 'name' };

    var s = n.replace(/\s+/g, '');
    if (BY_SET[s]) return { set: s, items: BY_SET[s], mode: 'set' };

    /* 去后缀：「…套装」「…铠甲」「…之铠」→ 取前缀当套装名试 */
    var base = s.replace(/(套装|铠甲|之铠|之服|礼装|便服|和服|服套装)$/g, '');
    if (base && BY_SET[base]) return { set: base, items: BY_SET[base], mode: 'set' };

    /* 兜底：名字包含套装名（「神兽兵装·鲁达尼亚」这种） */
    var hit = null;
    Object.keys(BY_SET).forEach(function (k) {
      if (k && s.indexOf(k) >= 0) hit = hit || k;
    });
    if (hit) return { set: hit, items: BY_SET[hit], mode: 'set' };
    return null;
  }

  /* ---------- 强化数据 ---------- */
  function upgradeOf(a) {
    /* ★ 参数是「防具对象」不是 key 字符串。
     * 传错时（UPGRADE["xxx"] → UPGRADE[undefined]）会**静默返回空**，
     * 表现为「强化数据在、条数也对、但全都说不可强化」，极难排查。
     * （我自己核对时传了字符串，stats 一看 0 就以为功能坏了。）
     * 所以这里显式拦一道。 */
    var key = (typeof a === 'string') ? a : (a && a.key);
    if (typeof a === 'string') {
      if (global.console && console.warn) {
        console.warn('[防具] upgradeOf 应传防具对象而非 key 字符串：' + a);
      }
    }
    var rec = UPGRADE[key];
    if (!rec || !rec.steps || !rec.steps.length) {
      return { steps: [], maxLevel: 1, upgradeable: false };
    }
    return { steps: rec.steps, maxLevel: rec.steps.length, upgradeable: rec.steps.length > 1 };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 渲染 ----------
     * 强化只显示摘要（当前防御 → 满级防御 + 最高几级），
     * 详细的每级材料留给 totk-site 图鉴（老大要求：文字太多该外链）。
     * 「查看图鉴」按钮这轮先留位不实现跳转，等老大发话。 */
  function blockFor(ptName) {
    var hit = match(ptName);
    if (!hit) return '';

    /* --- 情况 A：标点是「整套统称」→ 列同套几件 --- */
    if (!hit.armor) {
      var items = hit.items.map(function (a) {
        return '<span class="ae-piece" title="' + esc(a.slot + ' · 防御 ' + (a.def != null ? a.def : '—')) + '">' +
          '<img src="' + esc(a.icon || '') + '" alt="">' +
          esc(a.name) + '</span>';
      }).join('');
      return '<div class="ae" data-mode="set" data-set="' + esc(hit.set) + '">' +
        '<div class="ae-h">套装 · ' + esc(hit.set) + '<span class="ae-src">共 ' +
        hit.items.length + ' 件</span></div>' +
        '<div class="ae-pieces">' + items + '</div>' +
        '</div>';
    }

    /* --- 情况 B：标点对应单件 --- */
    var a = hit.armor;
    var up = upgradeOf(a);
    var h = '<div class="ae" data-mode="one" data-key="' + esc(a.key) + '">';

    /* 头：图标 + 名字 + 部位 */
    h += '<div class="ae-top">';
    if (a.icon) {
      h += '<img class="ae-ic" src="' + esc(a.icon) + '" alt="' + esc(a.name) + '">';
    }
    h += '<div class="ae-id">' +
      '<div class="ae-n">' + esc(a.name) + '</div>' +
      '<div class="ae-s">' + esc(a.slot) + ' · ' + esc(a.set) + '</div>' +
      '</div>';
    h += '</div>';

    /* 数值：防御 / 买价 */
    h += '<div class="ae-rows">';
    if (a.def != null) {
      h += '<div class="ae-row"><span class="ae-l">防御</span><span class="ae-v">' +
        a.def + (up.upgradeable ? '<span class="ae-arrow"> → ' +
          (up.steps[up.steps.length - 1].def != null ? up.steps[up.steps.length - 1].def : '—') +
          '</span>（满级）' : '') + '</span></div>';
    }
    if (a.buy != null) {
      h += '<div class="ae-row"><span class="ae-l">售价 / 回收</span><span class="ae-v">' +
        a.buy + ' / ' + (a.sell != null ? a.sell : '—') + '</span></div>';
    }
    h += '</div>';

    /* 强化摘要：只给「最高 N 级 + 最后一级材料」，不铺 5 行 */
    if (up.upgradeable) {
      var top = up.steps[up.steps.length - 1];
      var mats = (top.mats || []).map(function (m) { return m.zh + '×' + m.n; });
      h += '<div class="ae-row"><span class="ae-l">强化</span><span class="ae-v">' +
        '可升至 ' + up.maxLevel + ' 级（防御 ' +
        (up.steps[0].def != null ? up.steps[0].def : '—') + ' → ' +
        (top.def != null ? top.def : '—') + '）' +
        (mats.length ? '<span class="ae-dim">满级需 ' + esc(mats.join('、')) + '</span>' : '') +
        '</span></div>';
    } else {
      h += '<div class="ae-row"><span class="ae-l">强化</span>' +
        '<span class="ae-v ae-dim">不可强化</span></div>';
    }

    /* 关联任务（armors.js 的 reqTasks，17 件有） */
    if (a.reqTasks && a.reqTasks.length) {
      var ts = a.reqTasks.filter(function (t) { return t && t.key; })
        .map(function (t) {
          return '<button type="button" class="ae-task" data-go-task="' + esc(t.key) + '">' +
            esc(t.name) + '</button>';
        }).join('');
      if (ts) {
        h += '<div class="ae-row"><span class="ae-l">关联任务</span>' +
          '<span class="ae-v ae-tasks">' + ts + '</span></div>';
      }
    }

    /* 同套其它部件（套装链接） */
    var sib = ARMORS.filter(function (x) {
      return x.setId === a.setId && x.key !== a.key;
    });
    if (sib.length) {
      var ss = sib.map(function (x) {
        return '<button type="button" class="ae-sib" data-go-armor="' + esc(x.key) + '">' +
          (x.icon ? '<img src="' + esc(x.icon) + '" alt="">' : '') +
          esc(x.name) + '</button>';
      }).join('');
      h += '<div class="ae-row"><span class="ae-l">同套部件</span>' +
        '<span class="ae-v ae-sibs">' + ss + '</span></div>';
    }

    /* 官方说明（短，通常一句） */
    if (a.desc) {
      h += '<div class="ae-row"><span class="ae-l">说明</span>' +
        '<span class="ae-v ae-desc">' + esc(a.desc) + '</span></div>';
    }

    /* 商店防具：告诉玩家去哪家店买（地图上没有逐件标点的那些） */
    if (a.how === '商店购买') {
      var sh = shopOf(a.key);
      h += '<div class="ae-row"><span class="ae-l">去哪买</span>' +
        '<span class="ae-v">' + (sh
          ? '<button type="button" class="ae-sib" data-goto-pt="' + esc(sh.id) + '">' +
            esc(sh.name || '防具店') + ' ›</button>'
          : '<span class="ae-dim">地图上没有单独标点，可在地图搜「防具店」</span>') +
        '</span></div>';
    }

    /* 图鉴外链预留：老大说「强化文字太多可外链 totk-site」。
       这轮只留位不跳转，等发话。 */
    h += '<div class="ae-comp-slot" data-site="' + esc(a.sitePath || '') + '"></div>';

    h += '</div>';
    return h;
  }

  /* ---------- 商店防具聚合（M6.7） ----------
   * 为什么要做：
   *   30 件防具是「商店购买」，地图上**没有逐件标点**——只有一个「防具店」
   *   标点代表一整家店（实测 6 个店，覆盖 5 个地区）。玩家看到「热沙护肩」
   *   想知道去哪买，卡片里答不出来。
   *
   * 怎么挂：armors.js 的 gx/gz 就是**实际商店坐标**（逐点核对过：
   *   海利亚系列 → 监视堡垒店、耐火石 → 鼓隆桥店、利特 → 利特村店、
   *   潜行/夜光 → 卡卡利科店、热沙+珠宝 → 卡拉卡拉集市）。
   *   所以按坐标就近归店，阈值 200 游戏单位（约 2 个地标间距），
   *   超出阈值的**不硬塞**（实测 4 个怪物面罩距最近的店 2063 单位，
   *   它们在怪物商人手里，本来就不属于防具店）。
   *
   * ★ 为什么不按 desc 解析：
   *   实测 6 个店里只有 3 个 desc 写了商品清单（卡拉卡拉/鼓隆桥/利特），
   *   卡卡利科那家明明卖潜行+夜光六件却是空的 —— desc 不可靠，坐标可靠。 */
  var SHOP_RADIUS = 200;
  var SHOP_CACHE = null;

  /* 防具店分类的 id */
  function shopCatIds() {
    var out = [];
    (global.TOTK_CATALOGS || []).forEach(function (c) {
      if (c && c.group === '位置' && c.name === '防具店') out.push(c.id);
    });
    return out;
  }

  /* 「防具」分类的 id（用于判断某件是否已有逐件标点） */
  function armorCatIds() {
    var out = [];
    (global.TOTK_CATALOGS || []).forEach(function (c) {
      if (c && c.group === '位置' && /^防具/.test(c.name)) out.push(c.id);
    });
    return out;
  }

  /* 已经有逐件地图标点的防具名集合 */
  var HAS_PT = null;
  function hasOwnMarker() {
    if (HAS_PT) return HAS_PT;
    var cats = armorCatIds();
    var s = {};
    (global.TOTK_MARKERS || []).forEach(function (m) {
      if (cats.indexOf(m.cat) >= 0 && m.name) s[m.name.trim()] = true;
    });
    return (HAS_PT = s);
  }

  /* { 店标点 → [防具, ...] }，只收录「无逐件标点且能归店」的 */
  function shopGoods() {
    if (SHOP_CACHE) return SHOP_CACHE;
    var cats = shopCatIds();
    if (!cats.length) return (SHOP_CACHE = {});
    var shops = (global.TOTK_MARKERS || []).filter(function (m) {
      return cats.indexOf(m.cat) >= 0;
    });
    var own = hasOwnMarker();
    var map = {};
    ARMORS.forEach(function (a) {
      if (a.how !== '商店购买') return;
      if (a.gx == null || a.gz == null) return;
      /* ★ 已经有个自己的地图标点了（实测格鲁德小镇的热沙/珠宝 11 件都有），
         走正常路径即可，别再往店里塞一遍造成重复。 */
      if (own[a.name]) return;
      var best = null, bd = 1e18;
      shops.forEach(function (s) {
        if (s.layer !== a.layer) return;
        var d = Math.sqrt((s.x - a.gz) * (s.x - a.gz) + (s.y - a.gx) * (s.y - a.gx));
        if (d < bd) { bd = d; best = s; }
      });
      /* 超出阈值不归店——宁可少给也不错给，
         指着一个 2000 单位外的店会让玩家白跑路。 */
      if (!best || bd > SHOP_RADIUS) return;
      if (!map[best.id]) map[best.id] = { shop: best, items: [] };
      map[best.id].items.push(a);
    });
    return (SHOP_CACHE = map);
  }

  /* 单件防具 → 它在哪家店买（买不到返回 null） */
  function shopOf(armorKey) {
    var g = shopGoods();
    var found = null;
    Object.keys(g).forEach(function (sid) {
      g[sid].items.forEach(function (a) { if (a.key === armorKey) found = g[sid].shop; });
    });
    return found;
  }

  /* 「防具店」标点 → 店里卖的防具列表（渲染用） */
  function blockForShop(shopPt) {
    var g = shopGoods();
    var hit = g[shopPt.id];
    var rows;
    if (hit && hit.items.length) {
      rows = hit.items.map(function (a) {
        return '<button type="button" class="ae-piece" data-go-armor="' + esc(a.key) + '">' +
          (a.icon ? '<img src="' + esc(a.icon) + '" alt="">' : '') +
          esc(a.name) + '<span class="ae-price">' + (a.buy != null ? a.buy : '') + '</span></button>';
      }).join('');
    } else {
      /* 归店失败的那些不列——地图 desc 已经写了能买什么，
         硬列会给出「这家店卖这个」的错误信息。 */
      rows = '<div class="ae-none">该店的具体商品见上方说明</div>';
    }
    return '<div class="ae" data-mode="shop" data-shop="' + esc(shopPt.id) + '">' +
      '<div class="ae-h">店内防具<span class="ae-src">' +
      (hit && hit.items.length ? hit.items.length + ' 件可定位' : '清单未收录') + '</span></div>' +
      '<div class="ae-pieces">' + rows + '</div>' +
      '</div>';
  }

  /* ---------- 对外：给 exploreCard 用 ---------- */
  function isArmorCat(catId) {
    var C = global.TOTK_CATALOGS || [];
    for (var i = 0; i < C.length; i++) {
      if (C[i] && C[i].id === catId && C[i].group === '位置') {
        return /^防具/.test(C[i].name);
      }
    }
    return false;
  }

  /* 按标点 id 找标点（供「去哪家店买」跳转） */
  function markerById(id) {
    var M = global.TOTK_MARKERS || [];
    for (var i = 0; i < M.length; i++) if (String(M[i].id) === String(id)) return M[i];
    return null;
  }

  global.ArmorEnhance = {
    blockFor: blockFor,
    blockForShop: blockForShop,
    isShopCat: function (catId) { return shopCatIds().indexOf(catId) >= 0; },
    markerById: markerById,
    shopOf: shopOf,
    shopGoods: shopGoods,
    match: match,
    isArmorCat: isArmorCat,
    /* 供验收用 */
    stats: function () {
      var ids = {};
      ARMORS.forEach(function (a) {
        var sid = a.setId || a.key.replace(/_(Head|Upper|Lower)$/, '');
        ids[sid] = 1;
      });
      return {
        防具条数: ARMORS.length,
        名字索引: Object.keys(BY_NAME).length,
        /* ★ 按 **setId** 去重，不是按套装名。
         * 同名不同 ID 是常态（海利亚套装有 Armor_001 与 Armor_005 两个 ID），
         * 用套装名去重会漏算（实测 64 vs 真实 67）。 */
        套装数: Object.keys(ids).length,
        套装名数: Object.keys(BY_SET).length,
        可强化: ARMORS.filter(function (a) { return upgradeOf(a).upgradeable; }).length
      };
    },
    upgradeOf: upgradeOf
  };
})(window);