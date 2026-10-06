/* ============================================================
 * 任务板块 · M3 · 数据适配层（TOTKMAP V2.1）
 * ------------------------------------------------------------
 * 职责：把 app/data/task-plan.js（M1/M2 产出的纯数据）适配成
 *       前端好用的形态 —— 清洗文本、建索引、算统计。
 *
 * 本文件不含任何 DOM / Leaflet 操作，可以单独在 node 里测。
 *
 * 数据来源与可信度（详见 V2.1技术方案-隐患与关键技术.md）：
 *   - key / name / cat / steps / reqs / flowPts → ROM RSDB +官方汉化（L1 权威）
 *   - guide段（前置/开启/注意/奖励）→ markers.js 玩家攻略文本（L2 参考）
 *   - 小游戏类 26 条已在 M2阶段剔除，不进任务板块
 * ============================================================ */
(function (global) {
  'use strict';

  var PLAN = global.TOTK_TASK_PLAN || [];

  /* ---------- 文本清洗 ---------- */

  /* ROM 的 MSBT 字符串以控制字符收尾，直接吐到页面上会显示成方块或乱码。
     实测 steps[].text 里常见 0x02 / 0x03（还有 0x0E 之类），一律剥掉。
     同时清掉首尾空白与残留的不可见字符。 */
  var CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  function clean(s) {
    if (s == null) return '';
    return String(s).replace(CTRL, '').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  }
  /* 攻略文本常见「点击左下角查看攻略」这类网页残留，与 app.js 的清理一致 */
  function cleanGuide(s) {
    return clean(s)
      .replace(/点击左下角查看攻略[，。]?/g, '')
      .replace(/详情可点击左下角的查看攻略[，。]?进行查看/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  /* 去掉正文里作者用来强调地名的【】，界面上不显示括号 */
  function stripBracket(s) {
    return clean(s).replace(/【/g, '').replace(/】/g, '').trim();
  }

  /* ---------- 图层 / 分组常量 ---------- */
  var LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' };
  /* ★ 界面展示顺序（主线 → 重要支线 → 普通支线 → 其他）。
     用数组而不是对象，遍历顺序才不会依赖 JS 对象的键序。 */
  var CAT_ORDER = ['Main', 'ImportantMini', 'Sub', 'Other'];
  var CAT_CN = { Main: '主线任务', ImportantMini: '重要支线', Sub: '普通支线', Other: '其他任务' };
  var GROUP_CN = CAT_CN;

  /* ROM 的 cat → 界面分组名。与 M2 的 build_task_plan.py 保持一致。 */
  function groupOf(cat) {
    return CAT_CN[cat] || '其他任务';
  }

  /* ---------- 主处理 ---------- */
  var TASKS = [];
  var BY_NAME = {};      // 官方任务名 → task（reqs 的 reqName 反查用）
  var BY_KEY = {};

  function build() {
    TASKS = [];
    BY_NAME = {};
    BY_KEY = {};

    PLAN.forEach(function (raw, i) {
      var g = raw.guide || {};

      /* 攻略段：清洗 + 去括号 + 丢弃「无」这类占位 */
      var guide = {
        requires: arr(g.requires),
        start: stripBracket(g.start),
        note: stripBracket(g.note),
        reward: arr(g.reward),
        unlocks: arr(g.unlocks)
      };

      /* 官方步骤（★ 用 stepsUI，2026-10-06 起）
       * ------------------------------------------------------------
       * raw.steps 是 ROM 的**事件触发器数组**，不是玩家步骤列表：
       * 1077 条里 600 条是空壳（Ready / Collect2nd 这类纯钩子，
       * 游戏内也不显示文字），还有重复文案和未替换的变量占位符。
       * 之前这里只按 text 非空过滤，Result 空壳虽然被丢掉了，
       * 但**没做去重**，且清洗口径与数据层不一致。
       * 现在统一由 tools/clean_steps.py 离线产出 stepsUI，
       * 前端只做 HTML 转义，不再自己判断哪些该留。
       * hasStepText=false 表示官方词条文件本身不存在 → 卡片要如实说明。 */
      var stepsUI = (raw.stepsUI || []).map(function (s) {
        return { name: s.name || '', text: clean(s.text) };
      });

      var t = {
        /* --- 身份 --- */
        id: 'tk' + i,
        idx: i,
        key: raw.key || null,
        name: raw.name || raw.key || '未命名任务',
        nameSrc: raw.nameSrc,          /* rom=官方中文名；guide=社区起名 */
        cat: raw.cat || 'Other',
        group: groupOf(raw.cat),

        /* --- 坐标（★ 只用 gx/gy/gz，绝不用 mapX/mapY）
             Leaflet latlng = (gz, gx)，见 app.js 坐标系注释 --- */
        gx: num(raw.gx),
        gy: num(raw.gy),
        gz: num(raw.gz),
        hasHeight: !!raw.hasHeight,
        layer: raw.layer || 18,
        romLayer: raw.romLayer || null,
        onMap: !!raw.onMap,

        /* --- 流程 --- */
        tier: raw.tier || 'L3',        /* L1=多点可画线 / L2=单点 / L3=无点 */
        flowPts: (raw.flowPts || []).map(function (p) {
          return { gx: num(p.gx), gy: num(p.gy), gz: num(p.gz) };
        }),
        steps: stepsUI,                /* 展示用（已清洗） */
        stepsUI: stepsUI,              /* 同上，别名：卡片读这个名 */
        nSteps: raw.nSteps || 0,       /* ROM 触发点总数（仅用于对照说明） */
        nStepsUI: raw.nStepsUI != null ? raw.nStepsUI : stepsUI.length,
        hasStepText: raw.hasStepText !== false,

        /* --- 任务链 --- */
        reqs: raw.reqs || [],           /* [{type,key,reqName,linkable}] */
        unlockList: raw.unlockList || [],

        /* --- 攻略 --- */
        guide: guide,
        overlap: raw.overlap || [],      /* 同坐标的其他任务（卡片要列清） */

        /* --- 杂项 --- */
        sort: raw.sort != null ? raw.sort : null,
        npc: raw.npc || null,
        npcCn: raw.npcCn || null,
        loc: raw.loc || null,
        locCn: raw.locCn || null,
        oldCat: raw.oldCat || null,      /* 玩家标点侧的旧分类名，仅参考 */
        src: raw.src || null,
        hasName: raw.nameSrc === 'rom'
      };

      TASKS.push(t);
      if (t.key) BY_KEY[t.key] = t;
      if (t.nameSrc === 'rom' && !BY_NAME[t.name]) BY_NAME[t.name] = t;
    });
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }
  /* 数组字段清洗：丢弃「无」「-」等占位与空串 */
  function arr(a) {
    if (!Array.isArray(a)) return [];
    return a.map(clean).filter(function (s) {
      return s && s !== '无' && s !== '无。' && s !== '-' && s !== '—';
    });
  }

  build();

  /* ---------- 统计（面板标题上的数字） ---------- */
  function statsByLayer(layerId) {
    var g = { Main: 0, ImportantMini: 0, Sub: 0, Other: 0 };
    TASKS.forEach(function (t) {
      if (t.layer !== layerId) return;
      if (!t.onMap) return;
      g[t.cat] = (g[t.cat] || 0) + 1;
    });
    return CAT_ORDER.map(function (cat) {
      return { cat: cat, name: CAT_CN[cat], count: g[cat] || 0 };
    });
  }

  /* 该层可上图任务的总��（标题右侧显示） */
  function totalByLayer(layerId) {
    var n = 0;
    TASKS.forEach(function (t) {
      if (t.layer === layerId && t.onMap) n++;
    });
    return n;
  }

  /* 按分组取该层任务。
     排序：先按界面分组顺序（主线→支线→其他），同组内按 ROM 的 sort 值，
     sort 缺失时退回 idx（保持 M2 的原始顺序，不重排）。 */
  function listBy(layerId, cat) {
    var out = [];
    TASKS.forEach(function (t) {
      if (t.layer !== layerId) return;
      if (!t.onMap) return;
      if (cat && t.cat !== cat) return;
      out.push(t);
    });
    out.sort(function (a, b) {
      var d = CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat);
      if (d) return d;
      var sa = a.sort != null ? a.sort : a.idx;
      var sb = b.sort != null ? b.sort : b.idx;
      return sa - sb;
    });
    return out;
  }

  /* 名称搜索（任务名 / key / 攻略里出现的词） */
  function search(q) {
    var ql = String(q || '').trim().toLowerCase();
    if (!ql) return [];
    var out = [];
    for (var i = 0; i < TASKS.length; i++) {
      var t = TASKS[i];
      if (String(t.name).toLowerCase().indexOf(ql) >= 0 ||
          String(t.key || '').toLowerCase().indexOf(ql) >= 0) {
        out.push(t);
        if (out.length >= 40) break;
      }
    }
    return out;
  }

  global.TaskData = {
    tasks: TASKS,
    byName: function (n) { return BY_NAME[n] || null; },
    byKey: function (k) { return BY_KEY[k] || null; },
    groupOf: groupOf,
    catCn: CAT_CN,
    catOrder: CAT_ORDER,
    layerName: function (l) { return LAYER_NAME[l] || ''; },
    statsByLayer: statsByLayer,
    totalByLayer: totalByLayer,
    listBy: listBy,
    search: search,
    clean: clean
  };
})(window);