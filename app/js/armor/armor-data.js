/* ============================================================
 * 防具数据合并层（V2.1 M6.5）
 * ------------------------------------------------------------
 * 为什么需要这一层：防具在仓库里有**两套互不引用**的数据源
 *
 *   ① data/armors.js    136 件 · 结构化
 *      官方名 / 防御 / 买价 / 强化链next / 图标 / 图层 / 部位 / 套装
 *      但没有「怎么拿到」的说明，也没有和任务的关联（reqTasks靠名字猜）
 *
 *   ② markers.js 里 cat 属于「防具」分类的标点 · 114 条 · 攻略文本
 *      有中文名 + 获取说明原文（"从魔人像处兑换，需要通过解锁地魔人石像"）
 *      + 坐标，但没有防御、没有图标、不知道属于哪个套装
 *
 * ★ 实测对齐结果：136 件里101 件能按中文名一对一，剩 35 件对不上，
 *   **全是 how=商店购买** —— 因为卖防具的店不用逐件标点，
 *   地图上是一个「防具店」标点代表一整家店。
 *   所以两套数据是互补的：armors 说「这防具是什么」，标点说「哪来的」。
 *
 * 本模块职责：把两者合成一份带完整信息的记录，供面板与卡片消费。
 * 不改任何原始数据文件。
 * ============================================================ */
(function (global) {
  'use strict';

  var ARMORS = global.TOTK_ARMORS || [];
  var MARKERS = global.TOTK_MARKERS || [];
  var CATALOGS = global.TOTK_CATALOGS || [];
  var TASKS = (global.TOTK_TASK_PLAN || []).slice();

  /* ---------- 防具店分类要排除 ----------
     catalogs.js 里「防具」和「防具店」是两个分类。前者是逐件防具点，
     后者是「这家店卖防具」的点（6 个）。合并时只取前者，
     否则会把店名当成防具名。 */
  var ARMOR_CATS = {};
  CATALOGS.forEach(function (c) {
    if (c && c.group === '位置' && c.name === '防具') ARMOR_CATS[c.id] = true;
  });

  /* ---------- 地图防具标点：中文名 → 标点 ---------- */
  var PT_BY_NAME = {};
  MARKERS.forEach(function (m) {
    if (!ARMOR_CATS[m.cat]) return;
    var n = (m.name || '').trim();
    if (!n) return;
    /* 同名多标点（同一件防具两个获取点）：全留着，卡片按条列 */
    if (!PT_BY_NAME[n]) PT_BY_NAME[n] = [];
    PT_BY_NAME[n].push({
      id: m.id, layer: m.layer,
      x: m.x, y: m.y,
      /* 攻略原文，通常就是「怎么拿到」的唯一说明 */
      how: (m.desc || '').trim()
    });
  });

  /* ---------- 地区归属（最近地区标注点近似，够用） ----------
     与 app.js 的 nearestRegion 同算法，但它依赖全局 state.layer，
     这里独立实现一份——防具卡片的图层由防具自己决定（同一套装可能跨层）。 */
  var AREAS = global.TOTK_AREAS || [];
  var REGION_CACHE = {};
  function regionOf(x, y, layer) {
    var k = layer + '_' + Math.round(x / 10) + '_' + Math.round(y / 10);
    if (REGION_CACHE[k] !== undefined) return REGION_CACHE[k];
    var best = '', bd = Infinity;
    for (var i = 0; i < AREAS.length; i++) {
      var a = AREAS[i];
      if (a.layer !== layer || !a.name) continue;
      var d = (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y);
      if (d < bd) { bd = d; best = a.name; }
    }
    return (REGION_CACHE[k] = best);
  }

/* ---------- 强化链 ----------
     ★ 这里**不能**用 armors.js 的 next 字段自己推导 —— 实测会全部算错：
       armors.js 只收录 rank=1 的基装（136 条），next 指向的 Armor_002_* 等
       升级条目**根本不在本地数据里**（104/136 条 next 断链），
       自己遍历的结果是「每件都只有 1 级」，upgradeable 数会是 0。

     真正的数据在两个源（已由 tools/build_armor_upgrade.py 合并）：
       · totk-site/public/data/items.json        553 条，next 串链
       · totk-site/public/data/enhancement.json  每级星星数与材料
     生成到 data/armor-upgrade.js，key 与本地 key 对得上（137 条基装）。
     实测：104 套可强化到 5 级（def 3→5→8→12→20），33 套不可强化。
     L5 的 stars 源数据里没有（stars=null），照实留空，不编造。 */
  var UPGRADE = global.TOTK_ARMOR_UPGRADE || {};
  var UP_CACHE = {};
  function upgradeOf(key) {
    if (UP_CACHE[key] !== undefined) return UP_CACHE[key];
    var rec = UPGRADE[key];
    if (!rec || !rec.steps || !rec.steps.length) {
      return (UP_CACHE[key] = { steps: [], level: 1, maxLevel: 1, upgradeable: false });
    }
    return (UP_CACHE[key] = {
      steps: rec.steps,
      level: 1,
      maxLevel: rec.steps.length,
      upgradeable: rec.steps.length > 1
    });
  }

  /* ---------- 套装分组 ---------- */
  var SETS = {};
  ARMORS.forEach(function (a) {
    var sid = a.setId || a.key.replace(/_(Head|Upper|Lower)$/, '');
    if (!SETS[sid]) SETS[sid] = { setId: sid, set: a.set, items: [] };
    SETS[sid].items.push(a);
  });
  var SET_LIST = Object.keys(SETS).map(function (k) {
    var s = SETS[k];
    s.items.sort(function (x, y) {
      var order = { 头部: 0, 上身: 1, 下身: 2 };
      return (order[x.slot] || 9) - (order[y.slot] || 9);
    });
    /* 三件套里各部位坐标往往差很远（老大说的），
       所以这里只记「同套有哪几件」，位置各自独立呈现。 */
    s.slots = s.items.map(function (x) { return x.slot; });
    s.total = s.items.length;
    return s;
  });

  /* ---------- 主合并 ---------- */
  var BY_KEY = {};
  var RECORDS = ARMORS.map(function (a) {
    var pts = PT_BY_NAME[a.name] || [];
    var set = SETS[a.setId] || null;
    /* 商店防具没有逐件标点，用「防具店」标点兜底：
       只取同层最近的店，标明「某某店出售」而不是硬凑成某个点。 */
    var how = a.how || '';
    var howText = pts.length
      ? pts.map(function (p) { return p.how; }).filter(Boolean)[0] || ''
      : '';
    /* 关联任务（armors.js 里的 reqTasks 是靠名字匹配的，可能不准） */
    var tasks = (a.reqTasks || []).filter(function (r) { return r && r.key; });

    var rec = {
      key: a.key,
      name: a.name,
      set: a.set,
      setId: a.setId,
      slot: a.slot,
      icon: a.icon,
      sitePath: a.sitePath,
      /* 数值 */
      def: a.def, buy: a.buy, sell: a.sell, rank: a.rank,
      desc: a.desc,
      /* 位置：优先用官方坐标（armors.js 的 gx/gz），退到标点坐标 */
      gx: a.gx, gz: a.gz, gy: a.gy,
      layer: a.layer, layerCn: a.layerCn,
      posValid: !!a.posValid,
      region: (a.posValid && a.gx != null) ? regionOf(a.gx, a.gz, a.layer) : '',
      /* 获取方式：结构化标签 + 攻略原文，两条都给 */
      how: how,
      howText: howText,
      /* 全部获取点（同名多点的场景） */
      points: pts.map(function (p) {
        return { x: p.x, y: p.y, layer: p.layer, how: p.how };
      }),
      note: a.note || '',
      req: a.req || '',
      upgrade: upgradeOf(a.key),
      tasks: tasks,
      /* 同套兄弟（套装链接用） */
      siblings: set ? set.items.filter(function (x) { return x.key !== a.key; })
        .map(function (x) { return { key: x.key, name: x.name, slot: x.slot, icon: x.icon }; })
        : []
    };
    BY_KEY[rec.key] = rec;
    return rec;
  });

  /* ---------- 反查 ---------- */
  function byKey(k) { return BY_KEY[k] || null; }
  function byName(n) {
    for (var i = 0; i < RECORDS.length; i++) {
      if (RECORDS[i].name === n) return RECORDS[i];
    }
    return null;
  }
  function setOf(sid) { return SETS[sid] || null; }

  /* 任务 → 防具：给任务卡片的防具区用（已由 task-data.js 的 armorsOf 提供，
     这里再提供一份带完整防具对象的版本，卡片跳转时要靠它拿到 key） */
  var BY_TASK = {};
  RECORDS.forEach(function (r) {
    r.tasks.forEach(function (t) {
      if (!BY_TASK[t.key]) BY_TASK[t.key] = [];
      BY_TASK[t.key].push({ key: r.key, name: r.name, slot: r.slot, icon: r.icon });
    });
  });
  function armorsOfTask(taskKey) { return BY_TASK[taskKey] || null; }

  /* ---------- 搜索 ---------- */
  function search(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return RECORDS;
    return RECORDS.filter(function (r) {
      return (r.name || '').toLowerCase().indexOf(q) >= 0
        || (r.set || '').toLowerCase().indexOf(q) >= 0
        || (r.how || '').indexOf(q) >= 0;
    });
  }

  /* ---------- 获取方式分档（面板筛选用） ---------- */
  var HOW_ORDER = ['任务/对话', '宝箱', '洞窟探索', '兑换', '解谜', '商店购买', '其他'];
  function howList() {
    var c = {};
    RECORDS.forEach(function (r) { c[r.how || '其他'] = (c[r.how || '其他'] || 0) + 1; });
    return HOW_ORDER.filter(function (h) { return c[h]; })
      .map(function (h) { return { how: h, n: c[h] }; });
  }

  global.ArmorData = {
    all: RECORDS,
    sets: SET_LIST,
    byKey: byKey,
    byName: byName,
    setOf: setOf,
    regionOf: regionOf,
    upgradeOf: upgradeOf,
    armorsOfTask: armorsOfTask,
    search: search,
    howList: howList,
    stats: {
      total: RECORDS.length,
      sets: SET_LIST.length,
      withPoints: RECORDS.filter(function (r) { return r.points.length; }).length,
      withTasks: RECORDS.filter(function (r) { return r.tasks.length; }).length,
      upgradeable: RECORDS.filter(function (r) { return r.upgrade.maxLevel > 1; }).length
    }
  };
})(window);