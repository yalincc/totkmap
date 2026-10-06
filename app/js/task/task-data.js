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

  /* key → 可读形态（只在 ROM 没有官方中文名时用）
   * ------------------------------------------------------------
   * 12 条任务实测 nameSrc=key，直接显示 `Mercenary_Akkare_Bloody`
   * 对玩家零信息量。这里按 _ 拆词做「尽力而为」的可读化：
   *   Mercenary_Akkare_Bloody → 佣兵 · Akkare · Bloody
   * 说明：
   *   - 只做**词间分隔**，不做词翻译。凭空猜中文地名会误导玩家。
   *   - Bloody / _After / _CanBeStart 这类后缀单独拆出来，
   *     因为它们承载了「这条是前传还是后续」的信息。
   *   - 猜不出来就原样返回（下面调用处还有 key兜底）。
   */
  var KEY_WORD_HINT = {
    Mercenary: '佣兵', PhotoSpot: '写真', Hateno: '哈特诺村',
    MushroomSisters: '蘑菇姐妹', Uotori: '沃托里', Zora: '卓拉',
    Rito: '里特', Goron: '鼓隆', Gerudo: '格鲁德', Sheikah: '希卡',
    Tribune: '大陆新闻', MonsterFigures: '怪物收藏品', Research: '调查',
    HatenoPurchase: '哈特诺购物'
  };
  function prettyKey(key) {
    if (!key) return '';
    var parts = String(key).split(/[_]/).filter(Boolean);
    if (!parts.length) return key;
    var out = parts.map(function (p) {
      /* 整段能对上表就直接给中文 */
      for (var hint in KEY_WORD_HINT) {
        if (p === hint) return KEY_WORD_HINT[hint];
        if (p.indexOf(hint) === 0) return KEY_WORD_HINT[hint] + '·' + p.slice(hint.length);
      }
      /* 英文小写词 → 首字母大写，让驼峰/全大写看起来像词而不是乱码 */
      if (/^[A-Z0-9_]+$/.test(p)) return p.charAt(0) + p.slice(1).toLowerCase();
      return p;
    });
    return out.join(' · ');
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
        /* name 三级兜底：官方中文名 → 可读化 key → key 原样。
           ★ 判「有没有官方中文名」必须靠 nameSrc，**不能靠 raw.name**：
             数据里没中文名的条目，name 字段本身就被写成了 key
             （nameSrc='key'、rawName 为空），判 raw.name 永远为真——
             这坑踩过一次（12 条全被误判成「有名字」）。
           实测 12 条nameSrc='key'：Mercenary_*_Bloody 6 条、
           Npc_BaseCamp_Assistant_ReactingStatue 4 条、
           FindSunaNui2、IchikaraDaughterPhoto。
           直接显示 Mercenary_Akkare_Bloody 对玩家零信息量，
           所以加一层可读化：拆词 + 分隔符 + 常见词表。
           ⚠ 只做词间分隔不做词翻译，凭空猜中文地名会误导玩家。 */
        name: (raw.nameSrc === 'key' ? prettyKey(raw.key) : raw.name) ||
              raw.name || raw.key || '未命名任务',
        hasRealName: raw.nameSrc !== 'key',   /* 界面据此提示「官方无中文名」 */
        nameSrc: raw.nameSrc,          /* rom=官方中文名；guide=社区起名；key=ROM 里就没中文 */
        cat: raw.cat || 'Other',
        group: groupOf(raw.cat),
        /* kindCn = 「情节/迷你挑战」这套玩家视角的分类（M5新增，
           由 tools/add_kindcn.py 离线产出）。
           与 cat/group 的区别：
             cat/group 是 ROM 官方分类（主线/重要支线/普通支线/其他）
             kindCn    是任务性质（主线剧情/迷你挑战/神庙探索/收集要素…）
           两者正交：Other 里既有 121 条迷你挑战，也有 6 条地区任务。 */
        kindCn: raw.kindCn || '其他任务',

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

  /* ---------- M6：任务链 / 系列推导 ----------
   * ------------------------------------------------------------
   * 「系列任务」在数据里没有现成字段，只能从两个信号推出来，
   * 两个都不可靠，所以**互证**后只用高置信度的：
   *
   *   信号A · 解锁链（权威，来自 ROM 的 unlocks）
   *     A unlocks B → B 的 reqs 里有 A，且是 linkable（能点到库内）。
   *     实测 34 条任务有 unlocks，能串成 3~6 环的链。
   *     这条最可靠，但它只覆盖「有明确解锁条件」的任务。
   *
   *   信号 B · key 前缀（启发式，来自任务命名惯例）
   *     PhotoSpot_Challenge_01~14、Hateno_*13条、MushroomSisters_*、
   *     Uotori_*、Mercenary_*… 前缀相同的往往是一串任务。
   *     但**不能单用**：比如Zora_/Rito_/Goron 只是「种族名」不是系列；
   *     GerudoDesertTreasure 和 GerudoCanyon 也没共用一条线。
   *     所以只在「同前缀 >= 3 条」时才认作系列，且排除已知假阳性。
   *
   * 交叉验证结果：signal A 找到的链，前缀法都能对上（MonsterFigures01-05、
   *   Hateno_TellMeTeacher01/02、ResearchLanayru…），
   *   说明两个信号指向同一批真实系列，可以合并使用。
   */

  /* 前缀法的假阳性黑名单：这些前缀看着像系列，实际是一堆无关任务
     （Zora_ 是卓拉族所有任务、Rito_ 是里特族、Goron_ 是鼓隆族…）。 */
  var PREFIX_FALSE = {
    Zora: 1, Rito: 1, Goron: 1, Gerudo: 1, Sheikah: 1, Korok: 1,
    Npc: 1, Connect: 1, Raise: 1, DefeatHugeEnemy: 1
  };
  var MIN_SERIES = 3;   /* 前缀法门槛：少于 3 条不算系列（2 条可能是巧合） */

  /* 建索引：key 前缀 → 任务列表 */
  var BY_PREFIX = {};
  TASKS.forEach(function (t) {
    if (!t.key) return;
    var p = t.key.split('_')[0];
    if (!p) return;
    (BY_PREFIX[p] = BY_PREFIX[p] || []).push(t);
  });

  /* 把解锁关系建成「上一环 → 下一环」的有向图 */
  var NEXT_OF = {};    /* key → [后续任务 key...] */
  var PREV_OF = {};    /* key → [前置任务 key...] */
  TASKS.forEach(function (t) {
    if (!t.key) return;
    /* 用 unlockList 里 linkable 的项做边——它已经是「能点到库内任务」的形态 */
    (t.unlockList || []).forEach(function (u) {
      if (!u.linkable || !u.key || !BY_KEY[u.key]) return;
      (NEXT_OF[t.key] = NEXT_OF[t.key] || []).push(u.key);
      (PREV_OF[u.key] = PREV_OF[u.key] || []).push(t.key);
    });
    /* 反向补边：有些任务只在 reqs 里写了前置，没写 unlocks。
       用 reqs 里 linkable 的项也建边（去重）。 */
    (t.reqs || []).forEach(function (r) {
      if (r.type !== 'quest' || !r.linkable || !r.key || !BY_KEY[r.key]) return;
      if ((NEXT_OF[r.key] || []).indexOf(t.key) >= 0) return;
      (NEXT_OF[r.key] = NEXT_OF[r.key] || []).push(t.key);
      (PREV_OF[t.key] = PREV_OF[t.key] || []).push(r.key);
    });
  });

  /* 从某环出发，沿解锁链往前后走，得出整条链（有序）。
     有环时（B→A→B）用 visited 兜住，不会死循环。
     ★ 顺序：前向走用 push 追加，后向走用 unshift 插到队首
       （后向是「从我往回找祖先」，越往回走越靠前）。 */
  function walk(key, dir) {
    var out = [], seen = {}, cur = key;
    while (cur && !seen[cur]) {
      seen[cur] = 1;
      var t = BY_KEY[cur];
      if (!t) break;
      if (dir === 'fwd') out.push(t); else out.unshift(t);
      var nxt = dir === 'fwd' ? (NEXT_OF[cur] || [])[0] : (PREV_OF[cur] || [])[0];
      cur = nxt;
    }
    return out;
  }

  /* 链条信息（卡片顶部要显示「第 N/M 环」）
     ★ 必须先回溯到链首再整条走一遍：
       只从当前环往前走会截断（从第4 环出发只看到后面 2 环，
       于是「第 4/2 环」这种荒谬序号）。 */
  var CHAIN_CACHE = {};
  function chainOf(key) {
    if (!key) return null;
    if (CHAIN_CACHE[key] !== undefined) return CHAIN_CACHE[key];
    var head = key;
    /* 回溯到链首（PREV_OF 第一条就是最直接的前驱） */
    var guard = 0;
    while ((PREV_OF[head] || []).length && guard++ < 50) {
      head = PREV_OF[head][0];
    }
    var list = walk(head, 'fwd');
    if (list.length < 3) {
      return (CHAIN_CACHE[key] = null);
    }
    /* 缓存整条链上每一环的结果，别让 5 个任务各走一遍 */
    var idx = -1;
    list.forEach(function (t, i) {
      if (t.key === key) idx = i;
      CHAIN_CACHE[t.key] = null;/* 先占位，防止下面再读时递归爆栈 */
    });
    list.forEach(function (t, i) {
      CHAIN_CACHE[t.key] = {
        list: list, index: i, total: list.length,
        isFirst: i === 0, isLast: i === list.length - 1
      };
    });
    return CHAIN_CACHE[key];
  }

  /* 系列（同前缀的一串任务，如 15 条PhotoSpot）。
     注意与 chainOf 的区别：
       chain = 有严格前后顺序（做完 A 才解锁 B）
       series = 同主题的一批任务，顺序不重要（15 个驿站画作随便做）
     所以 PhotoSpot 是 series 不是 chain。 */
  var SERIES_CACHE = {};
  function seriesOf(key) {
    if (!key) return null;
    if (SERIES_CACHE[key] !== undefined) return SERIES_CACHE[key];
    var t = BY_KEY[key];
    if (!t || !t.key) return (SERIES_CACHE[key] = null);
    var p = t.key.split('_')[0];
    var same = BY_PREFIX[p] || [];
    /* 前缀法只认>= 3 条且不在黑名单 */
    if (same.length < MIN_SERIES || PREFIX_FALSE[p]) {
      return (SERIES_CACHE[key] = null);
    }
    /* 如果这批任务里多数有严格解锁链，那用chain 表达更准确，不重复标系列 */
    var chained = same.filter(function (x) { return !!chainOf(x.key); }).length;
    if (chained >= same.length * 0.7) {
      return (SERIES_CACHE[key] = null);
    }
    SERIES_CACHE[key] = {
      prefix: p,
      list: same,
      total: same.length,
      index: same.findIndex(function (x) { return x.key === key; }),
      /* 系列名用最短的那条任务名当标题：15 条 PhotoSpot 名字都是「装点XX驿站的画作」，
         硬拼会很长。不如直接按数量+类型说「同系列 15 个任务」。 */
      doneCount: same.filter(function (x) {
        return global.TaskDone && global.TaskDone.isDone(x.key);
      }).length
    };
    return SERIES_CACHE[key];
  }

  /* 卡片用：链条与系列合并成一个「任务链」区块的数据 */
  function relationsOf(key) {
    var chain = chainOf(key);
    var series = seriesOf(key);
    var t = BY_KEY[key];
    return {
      chain: chain,
      series: series,
      /* 前驱 / 后继（即使不构成链条也要显示，
         「这任务要先做哪个」是最常被问的） */
      prev: ((PREV_OF[key] || []).map(byKeySafe)).filter(Boolean),
      next: ((NEXT_OF[key] || []).map(byKeySafe)).filter(Boolean)
    };
  }
  function byKeySafe(k) { return BY_KEY[k] || null; }

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
    clean: clean,
    /* M6：任务链 / 系列（卡片与地图上的「这是第几环」靠这三个） */
    chainOf: chainOf,
    seriesOf: seriesOf,
    relationsOf: relationsOf
  };
})(window);