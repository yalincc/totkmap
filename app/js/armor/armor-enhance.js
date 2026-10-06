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
    var rec = UPGRADE[a.key];
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

    /* 图鉴外链预留：老大说「强化文字太多可外链 totk-site」。
       这轮只留位不跳转，等发话。 */
    h += '<div class="ae-comp-slot" data-site="' + esc(a.sitePath || '') + '"></div>';

    h += '</div>';
    return h;
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

  global.ArmorEnhance = {
    blockFor: blockFor,
    match: match,
    isArmorCat: isArmorCat,
    /* 供验收用 */
    stats: function () {
      var names = Object.keys(BY_NAME), sets = Object.keys(BY_SET);
      return {
        防具条数: ARMORS.length,
        名字索引: names.length,
        套装数: sets.length,
        可强化: ARMORS.filter(function (a) { return upgradeOf(a).upgradeable; }).length
      };
    },
    upgradeOf: upgradeOf
  };
})(window);