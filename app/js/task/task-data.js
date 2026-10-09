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

  /* ★ 界面分组 = 游戏官方四档「冒险笔记」分类（2026-10-07 老大定调）。
   *
   * 老大原话：「现在你的任务分类不大合适，应该尊重游戏本身的分类，
   *            这样比较容易查找。」
   *
   * 判据是 ROM 的 sort 字段（SortIndex），由 tools/build_task_plan.py 的
   * group_of() 算好写进 raw.group。实测四档与游戏官方**精确一致**：
   *   sort < 100   → 主剧情挑战 23（官方 23）
   *   100 ~ 999    → 情节挑战   60（官方 60）
   *   1000 ~ 4999  → 神庙挑战   31（官方 31）
   *   >= 5000      → 迷你挑战  139（官方 139）
   *
   * 为什么不按 ROM 的 cat（Main/ImportantMini/Sub/Other）：
   *   cat 只有四档，是 ROM 的粗粒度归类，把迷你挑战塞进了 Other，
   *   与游戏「冒险笔记」里看到的分类对不上，用户按分类筛任务时找不到东西。
   *
   * 换口径的连带影响：所有按 cat 过滤/统计的地方都要改成 group。
   * 用数组而不是对象，遍历顺序才不会依赖 JS 对象的键序。 */
  var CAT_ORDER = ['主剧情挑战', '情节挑战', '神庙挑战', '迷你挑战'];
  var CAT_CN = {
    '主剧情挑战': '主剧情挑战',
    '情节挑战': '情节挑战',
    '神庙挑战': '神庙挑战',
    '迷你挑战': '迷你挑战'
  };
  var GROUP_CN = CAT_CN;
  /* 旧代码还有按 ROM cat 名问的（如 armor 掉落区、reqs 反查），
     保留一个映射表兜底，别让它们因为找不到键而全部落到最后一项。
     ★ 这张表只在 raw.group 缺失时才用——正常路径一律读 group。 */
  var ROM_CAT_TO_GROUP = {
    Main: '主剧情挑战', ImportantMini: '情节挑战',
    Sub: '神庙挑战', Other: '迷你挑战'
  };

  /* 任务 → 界面分组名。优先用数据里算好的 group，缺失时按 ROM cat 兜底。 */
  function groupOf(t) {
    if (t && t.group) return t.group;
    var cat = typeof t === 'string' ? t : (t && t.cat);
    return ROM_CAT_TO_GROUP[cat] || '迷你挑战';
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
        /* ★ V2.3-2/3：交付（任务物品/拍照/送人）——必须透传，否则卡片交付行永远不显示 */
        deliver: stripBracket(g.deliver),
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
        /* 界面分组：build_task_plan.py 已按 sort 派生 group（官方四档）算好 */
        group: raw.group || ROM_CAT_TO_GROUP[raw.cat] || '迷你挑战',
        /* kindCn = 「情节/迷你挑战」这套玩家视角的分类（M5新增，
           由 tools/add_kindcn.py 离线产出）。
           与 cat/group 的区别：
             group是游戏官方四档（主剧情挑战/情节挑战/神庙挑战/迷你挑战）
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
        /* ★★ 该任务**涉及的所有图层**（2026-10-07 老大定：多点任务所有涉及层都显示）。
         *
         * 原来只有 `layer` 一个值，按**第一个流程点**的高度判定 ——
         * 于是跨层任务在别的层完全看不到：全库 253 条里有 11 条涉及多层，
         * 切到地底层只剩 3 条任务、天空层16 条，看着像「那两层没任务」。
         *
         * 改后各层可见数：地表 233→236 / 地底 3→7 / 天空 16→21。
         *
         * ★ `layer` 字段**保留不变**（导航、串流程线仍需要一个"主层"，
         *   一般是第一个流程点所在层）。所有「这层有哪些任务」的判断改用 layers。
         * 缺失时退回 [layer] 兜底，老数据不至于一个都查不到。*/
        layers: (raw.layers && raw.layers.length) ? raw.layers.slice() : [raw.layer || 18],
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
        /* V2.3.1：档内序号（卡片标题 #N / 地图 tooltip / 搜索 #N 共用一套） */
        no: raw.no || 0,
        groupTotal: raw.groupTotal || 0,
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
  /* ★ 该任务是否属于这一层（2026-10-07）
   *
   * **所有「这层有哪些任务」的判断都该走这个函数**，别再直接比 `t.layer`。
   * `t.layer` 只是「主层」（第一个流程点所在层），跨层任务在别的层也该出现。
   * 数据层给了 `layers`（涉及的所有层）；老数据没有时退回 `layer`。
   */
  function inLayer(t, layerId) {
    if (!t) return false;
    if (t.layers && t.layers.length) return t.layers.indexOf(layerId) >= 0;
    return t.layer === layerId;
  }

  function statsByLayer(layerId) {
    var g = {};
    TASKS.forEach(function (t) {
      if (!inLayer(t, layerId)) return;
      if (!t.onMap) return;
      var k = t.group || '迷你挑战';
      g[k] = (g[k] || 0) + 1;
    });
    return CAT_ORDER.map(function (cat) {
      return { cat: cat, name: CAT_CN[cat], count: g[cat] || 0 };
    });
  }

  /* 该层可上图任务的总��（标题右侧显示） */
  function totalByLayer(layerId) {
    var n = 0;
    TASKS.forEach(function (t) {
      if (inLayer(t, layerId) && t.onMap) n++;
    });
    return n;
  }

  /* 全库任务总数（**去重**，不是各层相加）
   *
   * 跨层任务（2026-10-07 起 11 条）在两个层都出现，`totalByLayer` 相加会得到 263
   * 而不是真实的 253。侧栏标题要用真实总数，所以单独提供这个。
   */
  function totalAllLayers() {
    return TASKS.filter(function (t) { return t.onMap; }).length;
  }

  /* 按分组取该层任务。
     排序：先按官方四档顺序（主剧情→情节→神庙→迷你），同组内按 ROM 的 sort 值，
     sort 缺失时退回 idx（保持 M2 的原始顺序，不重排）。 */
  function listBy(layerId, cat) {
    var out = [];
    TASKS.forEach(function (t) {
      if (!inLayer(t, layerId)) return;
      if (!t.onMap) return;
      if (cat && (t.group || '迷你挑战') !== cat) return;
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

  /* 搜索别名（2026-10-07）
   * ★ 起因：WANTED 系列共 6 条，但**只有 3 条名字里带 WANTED**
   *   （岩石巨人/莫尔德拉吉克/西诺克斯），另外 3 条叫「未知的天空巨人」
   *   「未知的三首之怪物」「未知的巨大之影」—— 搜 "WANTED" 只出 3 条，
   *   玩家会以为另外 3 条不存在。
   *   它们同属一个系列（同一 NPC 谷拉廉斯接单、分两批），
   *   所以给这 3 条补 WANTED 别名，搜系列名出全套 6 条。
   *
   * 语义：别名只影响**搜索命中**，不改显示名、不改分类、不改坐标。
   * key → 别名，多个用空格分隔（都会被匹配）。
   */
  var SEARCH_ALIAS = {
    'DefeatHugeEnemy_4': 'WANTED 未知的天空巨人',
    'DefeatHugeEnemy_5': 'WANTED 未知的三首之怪物',
    'DefeatHugeEnemy_6': 'WANTED 未知的巨大之影',
    /* 「讨伐」是这套任务在游戏内的另一个叫法，顺手一起接上 */
    'DefeatHugeEnemy_1': 'WANTED 讨伐',
    'DefeatHugeEnemy_2': 'WANTED 讨伐',
    'DefeatHugeEnemy_3': 'WANTED 讨伐'
  };

  /* 名称搜索（任务名 / key / 别名 / 攻略里出现的词） */
  function search(q) {
    var ql = String(q || '').trim().toLowerCase();
    if (!ql) return [];
    var out = [];
    for (var i = 0; i < TASKS.length; i++) {
      var t = TASKS[i];
      var hay = String(t.name) + ' ' + String(t.key || '') + ' ' +
                String(SEARCH_ALIAS[t.key] || '');
      if (hay.toLowerCase().indexOf(ql) >= 0) {
        out.push(t);
        if (out.length >= 40) break;
      }
    }
    return out;
  }

  /* ★ V2.3.1：按档内序号查（搜索「#8」用）。
   * 四档各自从 1 编号（主剧情 1~23 / 情节 1~60 / 神庙 1~31 / 迷你 1~139），
   * 同序号最多 4 条（每档一条）；只有可上图任务参与编号。 */
  function byNo(n) {
    var nn = parseInt(n, 10);
    if (!(nn >= 1)) return [];
    return TASKS.filter(function (t) { return t.onMap && t.no === nn; });
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

  /* ============================================================
   * M6.1：防具掉落反查（armorsOf）
   * ------------------------------------------------------------
   * 方向是「任务 → 能拿到哪些防具」，不是「防具 → 属于哪个任务」。
   * 原因：136 件防具里只有 17 件来自任务（宝箱 53 / 商店 30 / 洞窟 20），
   * 反向做的话覆盖率天然低；而且真正想查的是「做完这个任务能拿什么」。
   *
   * 两个数据来源，置信度分开：
   *   A. armors.js 的 reqTasks —— extract_armors.py 按「防具名出现在任务名里」
   *      匹配，conf=high 才是同名实指；conf=low 多半是地名巧合。
   *      实测坑：「卓拉铠甲」会挂到「卓拉领地的希多」上，纯属「卓拉」撞词。
   *      → low 全部丢弃，不给用户看错东西。
   *   B. 任务自己的 guide.reward文本 —— 攻略作者自己写的掉落，最准。
   *      但攻略爱用比喻：「铠甲蘑菇*10」「铠甲鲷鱼*3」是菜名不是防具。
   *      → 用 armors.js 的真实 name 精确对撞，对不上的丢弃。
   *
   * 合并后按套装去重：同一套的 3 件（头/身/腿）只说一次，
   * 否则「织梦之勇者」会在卡片里连占三行。
   */
  var ARMORS = global.TOTK_ARMORS || [];
  var ARMOR_INDEX = null;   /* name -> armor记录，懒建 */
  var ARMOR_BY_TASK = null;/* taskKey -> [armor]，懒建 */

  function armorIndex() {
    if (ARMOR_INDEX) return ARMOR_INDEX;
    ARMOR_INDEX = {};
    ARMORS.forEach(function (a) {
      if (a.name) ARMOR_INDEX[a.name] = a;
      /* 「“卓拉护胫”」这种攻略里带引号的写法 */
      var clean = String(a.name).replace(/[“”"'「」]/g, '');
      ARMOR_INDEX[clean] = a;
    });
    return ARMOR_INDEX;
  }

  var ARMOR_WORD = /防具|铠甲|套装|护胫|护肩|帽|兜帽|上衣|裤子|紧身|服$/;
  /* 明显是食材/菜名/道具的误伤：攻略爱这么写 */
  var ARMOR_FALSE = /蘑菇|鲷鱼|稠鱼|料理|菜|肉|果实|根|花|鱼|贝| Certifications/;

  function armorReward(t) {
    var g = t.guide;
    if (!g || !g.reward || !g.reward.length) return [];
    var idx = armorIndex();
    var out = [];
    g.reward.forEach(function (r) {
      if (!r) return;
      if (ARMOR_FALSE.test(r)) return;/* 「铠甲蘑菇」不是防具 */
      if (!ARMOR_WORD.test(r)) return;/* 不像装备词 */
      var a = idx[r] || idx[String(r).replace(/[“”"'「」]/g, '')];
      /* ★ 必须能对撞上 armors.js 里的真实条目才认。
       *   攻略写「神兽兵装·露塔」「异次元恶灵铠甲」这类，后者能对上，
       *   前者对不上就不显示——宁可少给，不给错。 */
      if (a) out.push({ armor: a, from: 'guide', conf: 'high' });
    });
    return out;
  }

  function armorsOf(key) {
    if (!key) return null;
    /* armors.js 没加载（脚本顺序错了、或将来下线防具数据）时静默返回 null，
     * 卡片就不渲染这一区。不抛错——掉落实得是可选信息，不能拖垮整张卡。 */
    if (!ARMORS.length) return null;
    if (ARMOR_BY_TASK && ARMOR_BY_TASK[key] !== undefined) return ARMOR_BY_TASK[key];
    var t = BY_KEY[key];
    if (!t) return (ARMOR_BY_TASK = ARMOR_BY_TASK || {}, ARMOR_BY_TASK[key] = null);

    var seen = {};   /* armorKey -> 记录 */
    var list = [];
    function put(a, from, conf) {
      if (!a || !a.key || seen[a.key]) return;
      seen[a.key] = 1;
      list.push({
        key: a.key, name: a.name, set: a.set, slot: a.slot,
        icon: a.icon, def: a.def, rank: a.rank,
        how: a.how, howFrom: from, conf: conf
      });
    }

    /* 来源 A：armors.js 的 reqTasks，只信 high */
    ARMORS.forEach(function (a) {
      (a.reqTasks || []).forEach(function (r) {
        if (r.key === key && r.conf === 'high') put(a, 'data', 'high');
      });
    });
    /* 来源 B：任务自己的掉落文本 */
    armorReward(t).forEach(function (x) { put(x.armor, 'guide', x.conf) });

    if (!list.length) return (ARMOR_BY_TASK = ARMOR_BY_TASK || {}, ARMOR_BY_TASK[key] = null);

    /* 按套装聚类：同套 3 件合成一条「套装（含头/身/腿）」。
     * 用 setId（Armor_006）而不是 set 名（卓拉）做键——
     * set 名是「套装名去掉部位词」，不同套装可能撞名。 */
    var bySet = {};
    var order = [];
    list.forEach(function (x) {
      var sid = x.setId || x.key.replace(/_(Head|Upper|Lower)$/, '') || x.set;
      if (!bySet[sid]) { bySet[sid] = []; order.push(sid) }
      bySet[sid].push(x);
    });
    var groups = order.map(function (sid) {
      var arr = bySet[sid];
      return {
        set: arr[0].set || sid,
        setId: sid,
        items: arr,
        slots: arr.map(function (x) { return x.slot }),
        conf: arr.some(function (x) { return x.conf === 'high' }) ? 'high' : 'low'
      };
    });
    var res = { groups: groups, total: list.length };
    ARMOR_BY_TASK = ARMOR_BY_TASK || {};
    return (ARMOR_BY_TASK[key] = res);
  }

  global.TaskData = {
    tasks: TASKS,
    byName: function (n) { return BY_NAME[n] || null; },
    byKey: function (k) { return BY_KEY[k] || null; },
    /* ★ 导出 prettyKey（2026-10-07）。
     * 用途：给「ROM 里就没有中文名」的任务显示一个可读的名字。
     * 现状：全库已无 nameSrc='key' 的任务（空壳都清完了），
     *   但这个函数是**兜底逻辑**——将来补数据时遇到没中文名的条目，
     *   卡片不会退化成显示一串英文 key。
     * 导出是为了让验收能直接测它（verify-chain.js 的「无中文名可读化」）。
     * 以前那个用例靠具体样本，样本被删两次就断了 —— 改成函数级测试更稳。 */
    prettyKey: prettyKey,
    groupOf: groupOf,
    catCn: CAT_CN,
    catOrder: CAT_ORDER,
    layerName: function (l) { return LAYER_NAME[l] || ''; },
    inLayer: inLayer,
    statsByLayer: statsByLayer,
    totalByLayer: totalByLayer,
    totalAllLayers: totalAllLayers,
    listBy: listBy,
    search: search,
    byNo: byNo,               /* V2.3.1：搜索「#8」按档内序号直达 */
    clean: clean,
    /* M6：任务链 / 系列（卡片与地图上的「这是第几环」靠这三个） */
    chainOf: chainOf,
    seriesOf: seriesOf,
    relationsOf: relationsOf,
    /* M6.1：任务 → 可获得的防具 */
    armorsOf: armorsOf
  };
})(window);