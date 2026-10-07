/* ============================================================
 * 任务板块 · M3 · 任务卡片（TOTKMAP V2.1）
 * ------------------------------------------------------------
 * 独立卡片（不复用 app.js 的 #exploreCard —— 那个字段结构是给
 * 标点设计的，任务要多显示：任务链 / 官方分步 / 奖励 / 同坐标多任务）。
 *
 * 卡片信息全部来自 task-plan.js，按可信度分层展示：
 *   L1 权威（ROM）  官方分步 steps、任务名、坐标
 *   L2 参考（攻略）开启/注意/奖励/前置
 *   拿不到的      明说「暂无」，不猜、不编
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.TaskData;
  if (!D) { console.warn('[任务板块] TaskData 未加载，卡片不初始化'); return; }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function $(id) { return document.getElementById(id); }
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

  var cur = null;          /* 当前打开的任务 */

  /* ---------- 分区构造 ---------- */

  /* 前置任务：quest型给可点链接，flag 型不给（那是条件标记不是任务名） */
  /* 前置条件
   * ------------------------------------------------------------
   * ★ M6：同一条链里的前驱已由chainHtml 的进度格表达
   *   （能点、能看完成状态），这里再列一遍纯冗余，
   *   而且会让人以为「前置」和「任务链」是两回事。
   *   所以只保留**链条之外**的条件：flag 型、跨链前置、以及
   *   指向不在库内的解锁目标（那种更没法用进度格表达）。
   */
  function reqsHtml(t) {
    if (!t.reqs || !t.reqs.length) return '';
    var D = global.TaskData;
    var chain = D && D.chainOf ? D.chainOf(t.key) : null;
    var inChain = {};
    if (chain) chain.list.forEach(function (x) { inChain[x.key] = 1; });

    var items = t.reqs.filter(function (r) {
      /* 同链前驱 → 已由进度格表达，跳过 */
      if (r.type === 'quest' && inChain[r.key]) return false;
      return true;
    }).map(function (r) {
      if (r.linkable && r.reqName) {
        return '<li><a href="#" class="tk-link" data-tk-goto="' + esc(r.reqName) + '"' +
          (global.TaskDone && global.TaskDone.isDone(r.key)
            ? ' data-tk-done="1" title="（已完成）"' : '') +
          '>' + esc(r.reqName) + '</a></li>';
      }
      /* flag 型：显示条件说明但不链接 */
      /* ★ selfRef 特殊处理（2026-10-07，台账 P1）：
       *   自指被降级成 flag 后，reqName 存的还是**本任务自己的名字**
       *   （decorate_requires 用 key2name 反查，key 就是自己）。
       *   直接显示的话，卡片上会出现「前置条件 · 马儿去向何方」，
       *   而任务名也是马儿去向何方 —— 玩家会以为前置是"再做一个自己"。
       *   正确做法：显示 flag 里的真实信息（这是「满足什么条件才可开始」），
       *   并标注这是条件而非任务。
       *   —— 真实前置缺失的情况已登记为台账 P2/P3（需并入攻略前置）。*/
      if (r.selfRef) {
        return '<li class="tk-flag tk-flag-self">需满足特定条件才能接取（未收录具体条件）</li>';
      }
      return '<li class="tk-flag">' + esc(r.reqName || r.key || '未命名条件') + '</li>';
    });
    if (!items.length) return '';
    return section('前置条件', '<ul class="tk-list">' + items.join('') + '</ul>');
  }

  /* 官方步骤列表（**只出裸列表，不带分区标题**）
   * ------------------------------------------------------------
   * ★ 必须读 stepsUI，不能读 steps（2026-10-06 修正）。
   *   ROM 的 steps 是「事件触发器数组」不是「玩家步骤列表」：
   *   1077 条里 600 条是空壳（Ready / Collect2nd 这类纯钩子，
   *   游戏内也不显示任何文字），12 条文字完全重复，
   *   327 条含未替换的游戏变量占位符。
   *   早期这里直接 map + i+1 编号，空壳照样占号 →
   *   「来自地底的呼唤」显示成 1=空 2=正文 3=正文 4=空 5=正文，
   *   看着像文字没对上，根因在数据。
   *   stepsUI 由 tools/clean_steps.py 离线清洗（去空壳/去重/剥占位符），
   *   原始 steps 保留在数据里给 M4 流程线取坐标用。
   *
   * ★ 分区标题不归这里管：折叠与否、有攻略没攻略，标题都不一样，
   *   统一由 stepsSectionHtml() 决定（见该函数注释里的重复渲染坑）。
   */
  function stepsListHtml(t) {
    var steps = t.stepsUI || [];
    if (!steps.length) {
      /* 该任务官方词条文件本身不存在（迷你挑战/赛事/佣兵支线共 12 个），
         或正文全是空壳。此时**不显示**该分区，
         绝不能给玩家一个「1 2 3 4」的空架子。 */
      if (t.hasStepText === false && t.nSteps) {
        return '<div class="tk-none">游戏内这个任务没有官方分步文本' +
          '（仅有 ' + t.nSteps + ' 个内部触发点）</div>';
      }
      return '';
    }
    var items = steps.map(function (s, i) {
      var txt = s.text ? esc(s.text).replace(/\n/g, '<br>') : '';
      return '<li class="tk-step">' +
        '<span class="tk-step-no">' + (i + 1) + '</span>' +
        '<span class="tk-step-tx">' + txt + '</span></li>';
    });
    /* 标注清洗口径，别让玩家以为是游戏内原文的完整列表 */
    return '<ol class="tk-steps">' + items.join('') + '</ol>' +
      (t.nSteps > steps.length
        ? '<div class="tk-note">已合并 ' + (t.nSteps - steps.length) +
          ' 条空壳/重复的内部触发点，只保留有说明的步骤</div>'
        : '');
  }

  /* 攻略段（社区整理，明确标注来源） */
  function guideHtml(t) {
    var g = t.guide || {};
    var out = '';
    if (g.start) out += kv('如何接取', esc(g.start));
    if (g.note) out += kv('注意事项', esc(g.note).replace(/\n/g, '<br>'));
    if (g.reward && g.reward.length) {
      out += kv('任务奖励', g.reward.map(function (r) { return esc(r); }).join('、'));
    }
    if (!out) return '';
    return section('攻略要点<span class="tk-src">社区整理</span>', out);
  }

  /* ---------- 官方分步 → 「任务原文」折叠区 ----------
   * ------------------------------------------------------------
   * 折叠规则（老大定的）：
   *   有攻略要点时 → 官方原文降级为折叠区，攻略是主体
   *   没有攻略时   → 不能把唯一可用的内容藏起来，直接平铺显示
   * 理由：攻略是玩家真正要看的，官方分步是补充；但攻略缺失时
   * 官方分步就是唯一信息源，藏起来等于这个卡片什么也没有。
   *
   * ★★ 修2026-10-06：stepsHtml() 自己会 return section('官方分步'...)，
   *   这里直接把它当 body 塞进外层 section，等于**同一段文字渲染两遍**
   *   （截图里能看到「官方步骤」和「官方分步」两个分区内容一样）。
   *   正确做法：stepsHtml 出裸列表，分区标题一律由本函数决定。
   */
  function stepsSectionHtml(t) {
    if (!t.stepsUI || !t.stepsUI.length) {
      if (t.hasStepText === false) {
        return section('官方步骤', '<div class="tk-empty">游戏内没有这个任务的文字说明</div>');
      }
      return '';
    }
    var body = stepsListHtml(t);

    var hasGuide = t.guide && (
      (t.guide.start && t.guide.start.length) ||
      (t.guide.note && t.guide.note.length) ||
      (t.guide.reward && t.guide.reward.length));

    if (!hasGuide) {
      /* 没有攻略 → 平铺，官方原文是唯一可用内容 */
      return section('官方步骤<span class="tk-src">游戏内原文</span>', body);
    }
    /* 有攻略 → 折叠。用 details/summary，零 JS 依赖、可键盘操作 */
    return '<div class="tk-sec tk-fold">' +
      '<details class="tk-details">' +
      '<summary class="tk-sec-t">任务原文<span class="tk-src">游戏内 · ' +
      t.stepsUI.length + ' 步</span></summary>' +
      '<div class="tk-sec-b">' + body + '</div>' +
      '</details></div>';
  }

  /* 同坐标重叠：地图上会叠成一个点，必须列清（对应「卡片里一定要清楚」） */
  function overlapHtml(t) {
    if (!t.overlap || !t.overlap.length) return '';
    var items = t.overlap.map(function (n) {
      return '<li><a href="#" class="tk-link" data-tk-goto="' + esc(n) + '">' + esc(n) + '</a></li>';
    });
    return section('同位置还有', '<ul class="tk-list">' + items.join('') + '</ul>');
  }

  /* 解锁的后续任务 */
  function unlockHtml(t) {
    if (!t.unlockList || !t.unlockList.length) return '';
    var D = global.TaskData;
    var chain = D && D.chainOf ? D.chainOf(t.key) : null;
    var inChain = {};
    if (chain) chain.list.forEach(function (x) { inChain[x.key] = 1; });
    /* 同链后继 → 进度格里已经能看到，不重复列 */
    var items = t.unlockList.filter(function (r) {
      if (r.key && inChain[r.key]) return false;
      return true;
    }).map(function (r) {
      if (r.linkable && r.reqName) {
        return '<li><a href="#" class="tk-link" data-tk-goto="' + esc(r.reqName) + '"' +
          (global.TaskDone && global.TaskDone.isDone(r.key)
            ? ' data-tk-done="1" title="（已完成）"' : '') +
          '>' + esc(r.reqName) + '</a></li>';
      }
      /* 指向不在库内的目标（小游戏、赛事等已剔除的条目）：
         说清「不在任务板块里」，别让玩家点了没反应以为坏了 */
      return '<li class="tk-flag">' + esc(r.reqName || r.key || '') +
        '<span class="tk-none2">（不在任务板块）</span></li>';
    });
    if (!items.length) return '';
    return section('完成后解锁', '<ul class="tk-list">' + items.join('') + '</ul>');
  }

  /* ---------- M6：任务链 / 系列 ---------- */
  /* 链条区（严格前后：做完 A 才解锁 B）
   * 显示成可点击的进度格：已完成 / 当前 / 未做
   * ★ 每一格的完成态**必须查 TaskDone.isDone(key)**，
   *   不能用「序号 < 当前序号」位置推断——
   *   那样做的话玩家点了「标记完成」，当前环永远不会变绿，
   *   链条区就成了摆设（这是第一版的 bug，真浏览器验收抓到的）。
   * ★ 窄卡片放不下6 格以上的横排，所以超过 5 环就压缩成「前后各一环 + 省略号」。
   */
  function chainHtml(t) {
    var D = global.TaskData;
    if (!D || !D.relationsOf) return '';
    var rel = D.relationsOf(t.key);
    if (!rel) return '';

    var out = '';
    var TD = global.TaskDone;

    /* 单格的class：done 查真实状态；cur 只表示「你正在看这一环」 */
    function cellCls(x, i) {
      var cls = 'tk-ch-c';
      if (TD && TD.isDone(x.key)) cls += ' done';
      if (i === ch.index) cls += ' cur';
      return cls;
    }

    /* --- 链条 --- */
    if (rel.chain) {
      var ch = rel.chain;
      function cell(i) {
        var x = ch.list[i];
        return '<button type="button" class="' + cellCls(x, i) + '" data-tk-goto="' +
          esc(x.name) + '" title="' + esc(x.name) + '">' + (i + 1) + '</button>';
      }
      var cells;
      if (ch.total <= 5) {
        cells = ch.list.map(function (x, i) {
          return cell(i);
        }).join('<span class="tk-ch-ar">›</span>');
      } else {
        cells = [];
        if (ch.index > 1) cells.push(cell(0), '<span class="tk-ch-ar">…</span>');
        if (ch.index > 0) cells.push(cell(ch.index - 1), '<span class="tk-ch-ar">›</span>');
        cells.push(cell(ch.index));
        if (ch.index < ch.total - 1) {
          cells.push('<span class="tk-ch-ar">›</span>', cell(ch.index + 1));
        }
        if (ch.index < ch.total - 2) cells.push('<span class="tk-ch-ar">…</span>', cell(ch.total - 1));
        cells = cells.join('');
      }
      /* 完成了几环（真实状态，不是位置推断） */
      var doneN = ch.list.filter(function (x) { return TD && TD.isDone(x.key); }).length;
      out += '<div class="tk-chain">' +
        '<div class="tk-chain-h">任务链<span class="tk-src">第 ' + (ch.index + 1) + ' / ' +
        ch.total + ' 环 · 已完成 ' + doneN + '</span></div>' +
        '<div class="tk-chain-c">' + cells + '</div>' +
        '<div class="tk-chain-n">' + esc(ch.list[ch.index].name) + '</div>' +
        '</div>';
    }

    /* --- 系列（同一主题的一批任务，顺序不重要）---
     * M6.3 改成可折叠列表：原先只给一个「本任务」按钮 + 一句
     * 「名字相近可搜 XX」，玩家想看同系列其它任务必须关卡片、去搜索框
     * 打字、再从结果里认哪个是自己要的——三步跳。
     * 现在折叠展开直接列全部，点一下就切过去。
     *
     * 为什么用 <details> 而不是自造折叠：
     *   「任务原文」折叠区已经用它了，同一套样式与键盘行为（可 Tab 可回车），
     *   不引入第二套交互模型。老大原话也是「少而精」。
     *
     * 默认折叠：同系列最长15 条（PhotoSpot），全展开会把卡片撑到出屏。
     * 头部仍然显示「共 N 个 · 已完成 M」——这是判断要不要展开的关键信息，
     * 不能藏进折叠区里。 */
    if (rel.series) {
      var se = rel.series;
      var doneN = se.list.filter(function (x) { return TD && TD.isDone(x.key); }).length;
      var rows = se.list.map(function (x) {
        var cls = 'tk-se-row';
        if (x.key === t.key) cls += ' self';
        if (TD && TD.isDone(x.key)) cls += ' done';
        return '<button type="button" class="' + cls + '" data-tk-goto="' + esc(x.name) + '">' +
          '<span class="tk-se-n">' + esc(x.name) + '</span>' +
          '<span class="tk-se-m">' +
            (x.key === t.key ? '当前' : (TD && TD.isDone(x.key) ? '已完成' : (x.locCn || x.catCn || ''))) +
          '</span></button>';
      }).join('');
      out += '<div class="tk-chain tk-series">' +
        '<details class="tk-details">' +
        '<summary><span class="tk-chain-h">同系列' +
        '<span class="tk-src">共 ' + se.total + ' 个 · 已完成 ' + doneN + '</span></span></summary>' +
        '<div class="tk-se-list">' + rows + '</div>' +
        '</details></div>';
    }

    return out;
  }

  function section(title, body) {
    return '<div class="tk-sec"><div class="tk-sec-t">' + title + '</div>' +
      '<div class="tk-sec-b">' + body + '</div></div>';
  }

  /* ---------- M6.1：本任务可获得的防具 ----------
   * 为什么单独一区而不是塞进「任务奖励」：
   *   guide.reward 是攻略作者的自由文本（"50卢比、炸弹花*5、铠甲鲷鱼*3"），
   *   防具有官方名、图标、防御值、套装归属，是结构化数据，
   *   混在文字里会被当成普通奖励一样扫过去，白做。
   *
   * 只显示能确认的：来源 A 只取 conf=high，来源 B 必须对撞上真实条目。
   * 低置信度的地名巧合（"卓拉铠甲" 撞 "卓拉领地的希多"）宁可不显示。
   */
  function armorHtml(t) {
    var D = global.TaskData;
    if (!D || !D.armorsOf) return '';
    var a = D.armorsOf(t.key);
    if (!a || !a.groups.length) return '';

    var body = a.groups.map(function (g) {
      /* M6.5 想让图标点开「防具卡片」，M6.6 改成：**跳到地图上那件防具的标点**。
       防具信息已经并进 exploreCard 了（点地图图标即见），
       再单独做一张防具卡片就是重复。 */
      var icons = g.items.map(function (x) {
        return x.icon
          ? '<img class="tk-ar-ic" src="' + esc(x.icon) + '" alt="' + esc(x.name) +
            '" title="' + esc(x.name + (x.def != null ? ' · 防御 ' + x.def : '')) +
            '" data-go-armor="' + esc(x.key) + '">'
          : '<span class="tk-ar-ic tk-ar-nopic" title="' + esc(x.name) + '">' +
            esc(x.name.slice(0, 1)) + '</span>';
      }).join('');
      /* 多件套装才说明部位；单件直接说是什么 */
      var what = g.slots.length > 1 ? g.slots.join(' / ') : (g.items[0].name);
      var how = g.items.map(function (x) { return x.how }).filter(Boolean)[0];
      /* 套装名也做成链接：点套装名能跳到该套第一件，省得一件件点。
         ★ 外面仍保留 .tk-ar-n 那个 div —— M6.1 的验收脚本按
           .tk-ar-n 取套装名，改成 button 会让它取不到（实测踩过）。
           所以只在 div 里塞一个可点的「›」按钮，不动原有层级。 */
      var setLink = g.items.length > 1
        ? '<button type="button" class="tk-ar-setgo" data-go-armor="' +
          esc(g.items[0].key) + '" title="查看这套防具的' + (g.slots.length || 0) +
          ' 件">›</button>'
        : '';
      return '<div class="tk-ar-g">' +
        '<div class="tk-ar-icw">' + icons + '</div>' +
        '<div class="tk-ar-tx">' +
        '<div class="tk-ar-n">' + esc(g.set) + setLink + '</div>' +
        '<div class="tk-ar-s">' + esc(what) + (how ? ' · ' + esc(how) : '') + '</div>' +
        '</div></div>';
    }).join('');

    return '<div class="tk-ar">' +
      '<div class="tk-ar-h">本任务可获得<span class="tk-src">防具 ' + a.total + ' 件</span></div>' +
      body + '</div>';
  }

  /* ---------- 完成态 ----------
   * ------------------------------------------------------------
   * 数据来源与优先级见 js/task/task-done.js：
   *   src='save'   来自 progress.sav 的真实进度（权威，不可取消）
   *   src='manual' 用户手动标记，存在 localStorage
   * 阶段名（如「Ready」「Step2」）只在存档态下有值，来自 ROM 的阶段枚举。
   */
  function doneState(t) {
    if (window.TaskDone && t.key) return window.TaskDone.status(t.key);
    return { done: false, src: '', stage: '', idx: -1, total: 0 };
  }

  /* 右上角完成勾（参考神庙的完成标记：勾 + 标题不加粗降透明度） */
  function doneBadgeHtml(t) {
    var st = doneState(t);
    if (!st.done) return '';
    var tip = st.src === 'save'
      ? '已完成（来自存档）'
      : '已完成（手动标记）';
    return '<span class="tk-done-tick" title="' + tip + '">✓</span>';
  }

  /* 底部「标记完成」按钮 */
  function doneBtnHtml(t) {
    var st = doneState(t);
    /* ⚠️ 必须同时判 src 和 done：
       TaskDone.status() 对**任何出现在存档里**的任务都返回 src='save'
       （含未完成的，那是「读到存档数据了」而不是「存档说它完成了」）。
       只判 src 会让全部 285 个任务都显示成「已完成 ✓」且不可点。 */
    if (st.done && st.src === 'save') {
      /* 存档里已完成：显示为不可取消的完成态 */
      return '<button type="button" class="btn done is-done" id="tkDone" disabled ' +
        'title="' + (st.stage ? '游戏内进度：' + esc(st.stage) : '存档记录已完成') +
        '">已完成 ✓</button>';
    }
    return '<button type="button" class="btn done' + (st.done ? ' is-done' : '') +
      '" id="tkDone">' + (st.done ? '取消完成' : '标记完成') + '</button>';
  }
  function kv(k, v) {
    return '<div class="tk-kv"><span class="tk-k">' + k + '</span><span class="tk-v">' + v + '</span></div>';
  }

  /* ---------- 组装 ---------- */
  function buildHtml(t) {
    var h = '';

    /* 顶部：分类标签 + 任务名。
       ★ 整块 tk-grip（把手）覆盖头部和标题行 —— 这是拖动的显式入口，
         光标变 grab，视觉上有六点抓手图案。
         点关闭按钮（.tk-close 在里面）不启动拖动，见 makeDraggable 的closest 排除。 */
    h += '<div class="tk-grip">';
    /* ★ 按 group 判（2026-10-07 迷你挑战单列）。
     * 原来按 t.cat（ROM 四档）判，迷你挑战会落到 'oth'（灰），
     * 卡片上显示成「其他」，跟真正的「其他」任务混为一谈。 */
    /* ★ 按官方四档 group 判（2026-10-07 分类改造，与地图点配色一致）。
     * 原来有第五档 'oth' 灰色，随 FindSunaNui2 删除后已无成员。 */
    h += '<span class="tk-chip tk-chip-' + (t.group === '主剧情挑战' ? 'main' : t.group === '情节挑战' ? 'imp' : t.group === '神庙挑战' ? 'sub' : 'mini') + '">' +
      esc(t.group) + '</span>';
    if (!t.hasName) {
      h += '<span class="tk-chip tk-noname" title="游戏内这个任务没有官方标题，用内部编号显示">暂无官方名</span>';
    }
    h += '<button type="button" class="tk-close" id="tkClose" title="关闭">×</button>';
    h += '</div>';
    /* 标题行右侧：完成勾 + 复制（复制挪到右上角，按钮小图标不抢正文注意力） */
    h += '<div class="tk-title-row">';
    h += '<h3 class="tk-name">' + esc(t.name) + '</h3>';
    h += '<div class="tk-title-acts">';
    h += doneBadgeHtml(t);
    h += '<button type="button" class="tk-icon-btn" id="tkCopy" title="复制任务名">复制</button>';
    h += '</div>';
    h += '</div>';

    /* 关键信息行：类型 / 步骤数 / 坐标 */
    h += '<div class="tk-meta">';
    if (t.oldCat) h += '<div class="tk-mrow"><span class="tk-mk">原分类</span><span class="tk-mv">' + esc(t.oldCat) + '</span></div>';
    /* 任务性质（迷你挑战/情节挑战/神庙探索…）—— M5 新增，比 ROM 的四分类更贴近玩家认知 */
    if (t.kindCn) h += '<div class="tk-mrow"><span class="tk-mk">类型</span><span class="tk-mv">' + esc(t.kindCn) + '</span></div>';
    if (t.npcCn) h += '<div class="tk-mrow"><span class="tk-mk">相关 NPC</span><span class="tk-mv">' + esc(t.npcCn) + '</span></div>';
    /* 步数用 nStepsUI（清洗后玩家真正看到的），不是 nSteps（ROM 触发点数）。
       两者不一致时注明原始值，避免「说13 步却是 5 条」的对不上。 */
    if (t.nStepsUI) {
      h += '<div class="tk-mrow"><span class="tk-mk">步骤</span><span class="tk-mv">' +
        t.nStepsUI + ' 步' +
        (t.nSteps && t.nSteps !== t.nStepsUI
          ? '<span class="tk-mv-sub">（游戏内 ' + t.nSteps + ' 个触发点）</span>'
          : '') +
        '</span></div>';
    } else if (t.nSteps) {
      h += '<div class="tk-mrow"><span class="tk-mk">步骤</span><span class="tk-mv">' +
        t.nSteps + ' 个触发点<span class="tk-mv-sub">（无官方说明）</span></span></div>';
    }
    if (t.gx != null && t.gz != null) {
      var co = 'X ' + Math.round(t.gx) + ' · Z ' + Math.round(t.gz);
      /* gy 缺失就明说「高度未知」，不猜 */
      co += t.hasHeight && t.gy != null ? ' · 高 ' + Math.round(t.gy) : ' · 高度未知';
      h += '<div class="tk-mrow"><span class="tk-mk">坐标</span><span class="tk-mv">' + esc(co) + '</span></div>';
    }
    /* 完成进度：阶段名 + 「第 n/total 步」，让存档进度可见 */
    var dst = doneState(t);
    if (dst.src === 'save' && dst.stage) {
      var pg = dst.total > 1
        ? esc(dst.stage) + '<span class="tk-mv-sub">（第 ' + (dst.idx + 1) + '/' + dst.total + ' 步）</span>'
        : esc(dst.stage);
      h += '<div class="tk-mrow"><span class="tk-mk">进度</span><span class="tk-mv' +
        (dst.done ? ' tk-mv-done' : '') + '">' + pg + '</span></div>';
    }
    h += '</div>';

    /* ---------- M6：任务链 / 系列（放在 meta 之后、分区之前）----------
     * 为什么放这个位置：这是卡片里唯一的「结构性信息」。
     *   「这是系列第 3/6 环」必须**先看到**，玩家才知道
     *   下面那些前置/解锁列表不是一堆无关任务名。
     * 数据来源 task-data.js 的 chainOf / seriesOf（离线推导，不是 ROM 字段）。
     */
    h += chainHtml(t);

    /* 各分区。
       顺序刻意调整为「攻略在前、任务原文在后」：
       攻略是玩家真正要看的正文，官方分步退为补充。 */
    h += overlapHtml(t);
    h += reqsHtml(t);
    h += guideHtml(t);
    h += stepsSectionHtml(t);
    h += unlockHtml(t);
    /* 防具区紧跟「完成后解锁」：两者都是「做完能得到什么」，逻辑相邻。
       放在最后是因为它比前置/攻略次要，不该把正文挤下去。 */
    h += armorHtml(t);

    /* ---------- 底部操作：导航 / 追踪 / 标记完成 ----------
       无坐标时导航按钮置灰而不是隐藏：
       隐藏会让玩家以为卡片缺功能；置灰 + 说明原因才讲得通
       「这个任务本来就没有固定地点」不是 bug。 */
    var noNav = (t.gx == null || t.gz == null || !t.onMap);
    h += '<div class="tk-actions">';
    h += '<button type="button" class="btn act' + (noNav ? ' is-off' : '') + '" id="tkNav"' +
      (noNav ? ' disabled' : '') +
      (noNav && t.noPlaceReason ? ' title="' + esc(t.noPlaceReason) + '"' : '') +
      '>导航</button>';
    /* 追踪按钮文案跟随实际状态：追踪中显示「取消追踪」 */
    var tracking = global.TaskFlow && global.TaskFlow.isTracking(t.key);
    h += '<button type="button" class="btn act' + (tracking ? ' is-on' : '') +
      '" id="tkTrack">' + (tracking ? '取消追踪' : '追踪') + '</button>';
    h += doneBtnHtml(t);
    h += '</div>';

    /* M4 流程线：L1 才是多点任务（可连线），L2/L3 直接说明为什么画不出。
       档位术语（L1/L2/L3）是内部约定，不给玩家看。 */
    var flow = '';
    if (t.tier === 'L1') {
      flow = '<button type="button" class="btn ghost tk-flow-btn" id="tkFlow">' +
        '显示流程</button>' +
        '<span class="tk-flow-hint" id="tkFlowHint">' +
        '共 ' + t.flowPts.length + ' 个地点' +
        (t.flowPts.length > 1 ? '，可连成流程线' : '') + '</span>';
    } else if (t.tier === 'L2') {
      flow = '<span class="tk-flow-hint">这个任务只有 1 个地点，无需连线</span>';
    } else if (t.noPlaceReason) {
      /* 已知无地点：把原因说出来，玩家才不会反复找「导航怎么用不了」 */
      flow = '<span class="tk-flow-hint">' + esc(t.noPlaceReason) + '</span>';
    } else {
      flow = '<span class="tk-flow-hint">这个任务没有可定位的地点</span>';
    }
    h += '<div class="tk-flow-row">' + flow + '</div>';

    return h;
  }

  /* ---------- 拖动 ----------
   * ------------------------------------------------------------
   * 为什么要做：卡片是 fixed 定位、从点击位置弹出，
   * 点完地图上的任务点后卡片常常正好压在那个点（甚至压住整片区域），
   * 想看被挡的地图位置就只能先关卡片。
   *
   * 可拖区域 = 顶部标题区 + 卡片内所有非交互空白。
   * 不可拖：按钮 / 链接 / 分步正文（那是选文本的地方）+ 滚动条。
   *
   * 用 pointer events + setPointerCapture，不用 mousedown/touchstart：
   *   ① 鼠标/触摸/手写笔一套代码；
   *   ② capture 之后即使指针移出卡片，move/up 仍然派发到卡片，
   *      不会因为「指针跑到 Leaflet 上」被地图抢走（实测这是必须的）。
   *
   * ★ 拖动不会误关卡片：全局「点别处关闭」监听的是 click 事件，
   *   而拖动不产生 click（浏览器只在按下抬起未移动时才发 click）。
   *   即便只是点了一下空白，card.contains(el) 也会拦下关闭。
   */
  var DRAG_THRESHOLD = 3;   /* 小于这个位移仍算点击，不触发拖动 */

  function makeDraggable(card) {
    if (card.__tkDrag) return;
    card.__tkDrag = true;

    var st = null;   /* 拖动会话：{pid, ox, oy, x0, y0, moved} */

    function start(e) {
      /* 左键 / 触摸 / 手写笔；右键和中间键不管 */
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var el = e.target;
      /* 交互元素不启动拖动，否则点按钮会变成拖按钮 */
      if (el.closest && el.closest('button, a, input, select, textarea')) return;
      /* ★ 防具图标（data-go-armor）也必须排除，否则点了没反应。
         根因：end() 里的 card.releasePointerCapture(pointerId)
         会**重定向后续 click 的 target** —— 原本落在<img> 上的 click
         被改派到捕获元素（#taskCard 自己），于是img 上的 click handler
         永远不触发。表现是「elementFromPoint 明明命中 IMG，
         真实鼠标点却毫无反应」（实测：ic.click() 有效、真实点击无效）。 */
      if (el.closest && el.closest('[data-go-armor]')) return;
      /* 竖向滚动条区域（约12px 宽）不启动拖动，
         否则在长卡片上想滚动条却变成了拖卡片 */
      if (card.scrollHeight > card.clientHeight + 2) {
        var r = card.getBoundingClientRect();
        if (e.clientX > r.right - 14) return;
      }
      st = { pid: e.pointerId, ox: 0, oy: 0, x0: e.clientX, y0: e.clientY, moved: false };
      var r = card.getBoundingClientRect();
      st.ox = r.left; st.oy = r.top;
      /* ★ 两个动作缺一不可，CSS 单独上不够（实测仍选中 8 字）：
         ① e.preventDefault() —— 浏览器在 pointerdown 的**默认动作**里
            建立文本选区，光写 user-select:none 只是 CSS 提示，
            默认动作照样跑（headless Chrome 实测禁不掉）。
            这里 preventDefault 才是真正掐断选区的那一刀。
         ② 加 tk-press 类 —— 拖动全程保持 CSS 禁选，防止后续动作再拉。
         若最终没移动（判定为点击），end() 会清掉类，
         此时 preventDefault 的唯一副作用就是「不能选中把手文字」，
         正文文字不受影响（它们不在 pointerdown 的落点上）。 */
      card.classList.add('tk-press');
      if (e.preventDefault) e.preventDefault();
      /* 先 capture 再等move：保证指针移出卡片仍能收到事件 */
      if (card.setPointerCapture) {
        try { card.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      }
    }

    function move(e) {
      if (!st || e.pointerId !== st.pid) return;
      var dx = e.clientX - st.x0, dy = e.clientY - st.y0;
      if (!st.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        st.moved = true;
        card.classList.add('tk-dragging');   /* 抓握光标 + 禁止选中文本 */
      }
      /* 视口内夹取：卡片宽高用实际渲染值，不写死 350/420 */
      var r = card.getBoundingClientRect();
      var x = st.ox + dx, y = st.oy + dy;
      var maxX = Math.max(0, global.innerWidth - r.width);
      var maxY = Math.max(0, global.innerHeight - r.height);
      card.style.left = Math.min(Math.max(0, x), maxX) + 'px';
      card.style.top = Math.min(Math.max(0, y), maxY) + 'px';
    }

    function end(e) {
      if (!st || e.pointerId !== st.pid) return;
      if (card.releasePointerCapture) {
        try { card.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      }
      card.classList.remove('tk-dragging');
      card.classList.remove('tk-press');
      /* 拖动过程中浏览器可能已建了选区，松手后清掉，
         否则文本上永久留一块蓝色高亮。 */
      var sel = global.getSelection && global.getSelection();
      if (sel && st.moved && sel.removeAllRanges) sel.removeAllRanges();
      st = null;
    }

    card.addEventListener('pointerdown', start);
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  /* ---------- 按钮区：统一阻止冒泡 ---------- */
  /* 卡片内任何交互都不能冒泡到 document 的「点别处关闭」监听器，
     否则点一下按钮卡片就消失了。 */
  function stopAll(e) { e.preventDefault(); e.stopPropagation(); }

  /* ---------- 打开 / 关闭 ---------- */
  function open(t, evt) {
    if (!t) return;
    cur = t;
    var card = $('taskCard');
    var body = $('taskCardBody');
    if (!card || !body) return;

    body.innerHTML = buildHtml(t);
    card.classList.remove('hidden');

    /* 定位规则：
       - 从卡片内部跳转过来（点在#taskCard 里）→ 保持原位不动，
         否则用点击坐标会让卡片每次跳转都乱跑；
       - 从地图点进来 → 鼠标位置附近弹出。
       均做视口内夹取，避免卡片跑到屏幕外找不见。

       ★ 偏移量从 +16 改成 +24 并优先往「远离点击点」的方向甩：
         原本卡片总是落在点击点右下，正好压住刚点的那张任务点图标，
         想看被挡的地图位置必须先关卡片。现在卡片尽量甩到点的另一侧，
         刚点的点始终露在外面（配合拖动，玩家可以自己挪）。 */
    var W = 350, H = 420;
    var x, y;
    var fromCard = !!(evt && evt.target &&
      typeof evt.target.nodeType === 'number' && card.contains(evt.target));
    if (fromCard) {
      x = parseInt(card.style.left, 10) || 80;
      y = parseInt(card.style.top, 10) || 80;
    } else {
      var p = (evt && (evt.originalEvent || evt)) || null;
      if (p) {
        /* 点在屏幕左半边→ 卡片甩到右侧，反之甩到左侧：
           这样卡片永远不会压在刚点的那一点上。 */
        x = p.clientX < global.innerWidth / 2 ? p.clientX + 24 : p.clientX - W - 24;
        y = p.clientY + 24;
      } else {
        x = 80; y = 80;
      }
    }
    card.style.left = Math.min(Math.max(14, x), Math.max(14, global.innerWidth - W - 14)) + 'px';
    card.style.top = Math.min(Math.max(14, y), Math.max(14, global.innerHeight - H)) + 'px';

    makeDraggable(card);
    bind(t);
  }

  /* 就地重绘当前卡片：只换 body 内容并重新绑事件，**不动卡片的位置**。
   （完成态切换、追踪态切换后用，避免调open() 把卡片甩到别处）
   注意：别写 render(t) —— 没有这个函数（曾踩过：点了没反应 + 控制台
   PAGEERROR: render is not defined，白白排查一轮）。 */
  function redraw() {
    var t = cur;
    if (!t) return;
    var body = $('taskCardBody');
    var card = $('taskCard');
    if (!body || !card) return;
    body.innerHTML = buildHtml(t);
    /* 滚回顶部：内容高度变了还停在原来的滚动位置会显得错乱 */
    body.scrollTop = 0;
    bind(t);
  }

  function close() {
    var card = $('taskCard');
    if (card) card.classList.add('hidden');
    cur = null;
  }

  function bind(t) {
    var card = $('taskCard');

    var x = $('tkClose');
    if (x) x.addEventListener('click', function (e) { e.stopPropagation(); close(); });

    /* 导航：交给 app.js 的实时导航/自动导航 */
    var nav = $('tkNav');
    if (nav) nav.addEventListener('click', function (e) {
      stopAll(e);
      var A = global.TOTK_APP;
      if (A && A.liveNav && t.gx != null && t.gz != null) {
        A.liveNav({
          name: t.name, x: t.gz, y: t.gx, layer: t.layer,
          type: t.group
        });
      } else {
        toast('导航功能需要本地定位服务');
      }
    });

    /* 流程线：交给 task-flow.js（独立模块，出问题也不影响卡片其他功能） */
    var fl = $('tkFlow');
    if (fl) fl.addEventListener('click', function (e) {
      stopAll(e);
      if (global.TaskFlow) global.TaskFlow.toggle();
      else toast('流程线模块未加载');
    });

    /* 追踪：流程线的持久化开关（关卡片后线仍留在地图上） */
    var tr = $('tkTrack');
    if (tr) tr.addEventListener('click', function (e) {
      stopAll(e);
      if (!global.TaskFlow) { toast('流程线模块未加载'); return; }
      global.TaskFlow.toggleTrack();
      /* 只改文案，不整卡重绘 —— 重绘会让用户滚动位置丢失 */
      var on = global.TaskFlow.isTracking(t.key);
      tr.textContent = on ? '取消追踪' : '追踪';
      tr.classList.toggle('is-on', !!on);
    });

    /* 复制任务名，便于搜攻略 */
    var cp = $('tkCopy');
    if (cp) cp.addEventListener('click', function (e) {
      stopAll(e);
      copy(t.name);
      toast('已复制：' + t.name);
    });

    /* 标记完成 / 取消完成。
     * 存档态的任务不允许取消（那是游戏真实进度，强行改会和下次加载存档打架），
     * 所以这个按钮在存档态下是 disabled 的。 */
    var dn = $('tkDone');
    if (dn) dn.addEventListener('click', function (e) {
      stopAll(e);
      if (!window.TaskDone) { toast('完成状态模块未加载'); return; }
      if (!t.key) {
        toast('这个任务没有存档标识，只能临时标记');
        return;
      }
      var st = window.TaskDone.toggle(t.key);
      if (st.done) {
        toast(st.src === 'save' ? '已完成（来自存档）' : '已标记完成：' + t.name);
      } else {
        toast('已取消完成：' + t.name);
      }
      /* 重画卡片：完成勾、按钮文案、以及 meta 里新增的进度行都要变 */
      redraw();
    });

    /* 卡片内跳转：任务链 / 同位置任务 */
    Array.prototype.forEach.call(card.querySelectorAll('[data-tk-goto]'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();          /* 必须：否则冒泡到全局监听器把卡片关了 */
        var name = a.getAttribute('data-tk-goto');
        var target = D.byName(name);
        if (!target) { toast('没找到任务：' + name); return; }
        open(target, e);
      });
    });

    /* M6.5：防具图标 / 套装名 → 跳到地图上那件防具的标点。
       ★ 防具信息已并入 exploreCard（点地图图标即见），所以这里不再另开卡片，
         统一走「找到标点 → 打开它的探索卡片」这条路。
       必须 stopPropagation ——否则冒泡到全局监听器会把任务卡片关掉。 */
    Array.prototype.forEach.call(card.querySelectorAll('[data-go-armor]'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var key = a.getAttribute('data-go-armor');
        var A = global.TOTK_APP;
        if (A && A.gotoArmor) { A.gotoArmor(key); return; }
        toast('防具跳转功能未加载');
      });
    });
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  }

  /* ---------- 键盘 / 全局 ---------- */
  /* ★ 这里必须调 `TaskCard.close`（对外暴露的那个），**不能调闭包内的 close()**。
     task-flow.js 为了「关卡片即收线」包装了 global.TaskCard.close；
     若这里调闭包内的 close()，包装就被绕过 —— 表现为
     按 Esc 关卡片后地图上留一条流程线（实测踩过）。
     同理下面 document click 里的 close() 也一样。 */
  function closePublic() {
    var C = global.TaskCard;
    if (C && typeof C.close === 'function') C.close();
    else close();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePublic();
  });
  document.addEventListener('click', function (e) {
    /* ★ 必须延后一拍判断：Leaflet 的 marker click 与这次 DOM click 是同一轮派发，
       open() 是同步执行的 —— 若在事件仍在冒泡时直接 close()，
       卡片会在弹出的同一瞬间被自己关掉（实测点任务点卡片永远打不开）。
       用 setTimeout(0) 等这一轮派发彻底结束。 */
    setTimeout(function () {
      var card = $('taskCard');
      if (!card || card.classList.contains('hidden')) return;
      var el = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
      if (!el) return;
      if (card.contains(el)) return;          /* 卡片内点击不关 */
      /* 点任务点不关 —— 这里不能只判 cur.key：
         攻略孤儿条目（key=null，全库 1 条）会漏判，
         点了它自己的点反而把刚开的卡片关了。改成按元素类名判。 */
      if (el.closest && el.closest('.tk-dot-wrap')) return;
      closePublic();
    }, 0);
  });

  global.TaskCard = {
    open: open,
    close: close,
    current: function () { return cur; },
    /* 导出 buildHtml 供验收脚本全量渲染检查（undefined/NaN 泄漏）。
       正常业务不调它，但留着能随时在浏览器里验证渲染结果。 */
    buildHtml: buildHtml
  };

  /* ---------- 订阅完成态变化 ----------
   * ★ 这个订阅不能省（第一版就漏了）：
   *   玩家开着卡片时导入存档 / 另一个标签页标记完成，
   *   卡片的完成勾、按钮文案、进度行、**M6 链条格的完成态**
   *   全都不会变——看着像「功能没生效」。
   *   按钮自己那条路径已经调 redraw()，这里补的是
   *   「不是由这个卡片的按钮触发的」那些路径。
   * 存档导入时 TaskDone 会连续 notify 十几次，
   * 所以这里也做防抖，别把浏览器卡住。 */
  if (global.TaskDone && typeof global.TaskDone.onChange === 'function') {
    var redrawTimer = null;
    global.TaskDone.onChange(function () {
      if (!cur) return;
      if (redrawTimer) clearTimeout(redrawTimer);
      redrawTimer = setTimeout(function () {
        redrawTimer = null;
        if (cur) redraw();
      }, 150);
    });
  }

  /* ---------- 卡片样式 ---------- */
  /* ★ 自足函数：CSS 以参数形式传进去，不依赖任何外层 var 的赋值顺序。
     （原先写成 `var CSS = [...]` + 后面 injectCSS() 调用，因为 var 只提升声明
      不提升赋值，会把 undefined 写进 <style> —— 卡片 DOM 正常但完全不可见。） */
  function injectCSS(cssText) {
    if ($('task-card-css')) return;
    var st = document.createElement('style');
    st.id = 'task-card-css';
    st.textContent = cssText;
    document.head.appendChild(st);
  }

  injectCSS([
    '#taskCard {',
    '  position:fixed; left:80px; top:80px; z-index:1400; width:350px; max-height:78vh;',
    '  overflow-y:auto; pointer-events:auto;',
    '  background:rgba(28,30,36,.97); border:1px solid rgba(255,255,255,.1);',
    '  border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,.55);',
    '  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);',
    '  padding:14px 16px 16px; user-select:text;',
    /* 拖动反馈：抓握光标提示可拖；拖动中禁用选中文本，
       否则鼠标一动就拉出一片蓝色选区。
       注意：这些行必须是完整字符串（含收尾单引号），
       插在数组中间的 JS 注释虽然合法，但极易把相邻字符串的引号吃掉。 */
    '  cursor:default;',
    /* 按下即禁选：必须早于 move 判定生效，见 makeDraggable/start 注释 */
    /* ★ 必须写 * 后代选择器：user-select 虽然可继承，
       但子元素（.tk-chip 等）若自带 user-select:text 会覆盖掉父级的 none，
       结果还是能拉出选区（实测拖动中选中 8 字）。 */
    '.tk-press, .tk-press * { user-select:none !important; -webkit-user-select:none !important; }',
    '.tk-dragging { cursor:grabbing; }',
    '.tk-dragging * { cursor:grabbing !important; }',
    '  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.14) transparent; }',
    '#taskCard.hidden { display:none; }',
    '#taskCard::-webkit-scrollbar { width:3px; }',
    '#taskCard::-webkit-scrollbar-thumb { background:rgba(255,255,255,.12); border-radius:3px; }',

    '/* 顶部：tk-grip 是显式拖动把手（六点抓手图案 + grab 光标） */',
    '.tk-grip {',
    '  display:flex; align-items:center; gap:6px; margin-bottom:8px;',
    '  cursor:grab; padding:2px 0; margin-left:-2px; margin-right:-2px;',
    '  border-bottom:1px solid rgba(255,255,255,.06); padding-bottom:6px;',
    '  touch-action:none; /* ★ 必须：否则触摸设备上浏览器会接管手势，卡片拖不动 */',
    '}',
    '.tk-grip:active { cursor:grabbing; }',
    '.tk-grip::before {',
    '  content:""; flex:0 0 auto; width:11px; height:9px; opacity:.4;',
    '  background-image:radial-gradient(currentColor 1px, transparent 1.1px);',
    '  background-size:3.5px 3.5px; color:rgba(255,255,255,.9);',
    '}',
    '.tk-chip {',
    '  font-size:11px; padding:2px 7px; border-radius:4px;',
    '  background:rgba(255,255,255,.08); color:rgba(255,255,255,.7);',
    '  white-space:nowrap; }',
    '.tk-chip-main { background:rgba(234,194,126,.16); color:#eac27e; }',
    '.tk-chip-imp  { background:rgba(126,200,169,.16); color:#7ec8a9; }',
    '.tk-chip-sub  { background:rgba(111,179,224,.16); color:#6fb3e0; }',
    '.tk-chip-mini { background:rgba(184,160,232,.16); color:#c4b0f0; }',  /* 迷你挑战：紫 */
    '.tk-noname { background:rgba(255,180,90,.13); color:#d9a05e; }',
    '.tk-close {',
    '  margin-left:auto; width:22px; height:22px; line-height:1;',
    '  border:none; background:transparent; color:rgba(255,255,255,.45);',
    '  font-size:19px; cursor:pointer; border-radius:4px; flex:0 0 auto; }',
    '.tk-close:hover { background:rgba(255,255,255,.1); color:#fff; }',

    '.tk-name {',
    '  font-size:17px; font-weight:600; line-height:1.35;',
    '  color:#f0f1f3; margin-bottom:10px; }',

    '/* 关键信息 */',
    '.tk-meta { margin-bottom:4px; }',
    '.tk-mrow { display:flex; gap:8px; font-size:12.5px; line-height:1.7; }',
    '.tk-mk { color:rgba(255,255,255,.42); flex:0 0 52px; }',
    '.tk-mv { color:rgba(255,255,255,.85); flex:1; }',
    '.tk-mv-sub { color:rgba(255,255,255,.4); font-size:11.5px; }',

    '/* 分区 */',
    '.tk-sec { margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }',
    '.tk-sec-t {',
    '  font-size:11.5px; color:rgba(255,255,255,.42);',
    '  margin-bottom:6px; display:flex; align-items:center; gap:6px; }',
    '.tk-src {',
    '  font-size:10px; color:rgba(255,255,255,.28);',
    '  border:1px solid rgba(255,255,255,.12); border-radius:3px; padding:0 4px; }',
    '.tk-sec-b { font-size:13px; line-height:1.65; color:rgba(255,255,255,.8); }',

    '.tk-kv { display:flex; gap:8px; margin-bottom:5px; }',
    '.tk-k { color:rgba(255,255,255,.42); flex:0 0 56px; }',
    '.tk-v { flex:1; }',

    '.tk-list { list-style:none; }',
    '.tk-list li { margin-bottom:3px; padding-left:10px; position:relative; }',
    '.tk-list li::before {',
    '  content:"·"; position:absolute; left:2px; color:rgba(255,255,255,.35); }',
    '.tk-flag { color:rgba(255,255,255,.5); }',
    /* 自指降级来的条件（台账P1）：斜体 + 更淡，视觉上就与其他条件不同，
       提示玩家「这不是另一条任务，是个我们还没收录的条件」。 */
    '.tk-flag-self { color:rgba(255,255,255,.34); font-style:italic; }',

    '.tk-link { color:#eac27e; text-decoration:none; border-bottom:1px solid rgba(234,194,126,.3); }',
    '.tk-link:hover { border-bottom-color:#eac27e; }',
    '/* 已完成的前置/后继：划掉并压暗，和「未做的前置」一眼能分开 */',
    '.tk-link[data-tk-done] { color:rgba(255,255,255,.42); border-bottom-color:rgba(255,255,255,.16); text-decoration:line-through; }',
    '.tk-none2 { color:rgba(255,255,255,.32); font-size:11px; }',

    /* --- M6 任务链 / 系列 ---
       位置在 meta 之后、正文之前：这是卡片里唯一的结构性信息，
       玩家得先知道「这是第几环」，才看得懂下面的前置列表。 */
    '.tk-chain {',
    '  margin:10px 0 2px; padding:9px 10px;',
    '  background:rgba(255,255,255,.045);',
    '  border:1px solid rgba(255,255,255,.08);',
    '  border-radius:7px; }',
    '.tk-chain-h {',
    '  display:flex; align-items:baseline; gap:6px;',
    '  font-size:11px; letter-spacing:.4em; color:rgba(255,255,255,.45);',
    '  text-shadow:none; margin-bottom:7px; }',
    '.tk-chain-h .tk-src { margin-left:auto; letter-spacing:0; }',
    '.tk-chain-c { display:flex; align-items:center; flex-wrap:wrap; gap:3px; }',
    '.tk-chain-n {',
    '  margin-top:6px; font-size:12px; color:rgba(255,255,255,.78);',
    '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.tk-ch-ar { color:rgba(255,255,255,.28); font-size:11px; margin:0 1px; }',
    /* 三态：已完成(实心绿) / 当前(金，带光环) / 未做(空心) */
    '.tk-ch-c {',
    '  min-width:22px; height:22px; padding:0 5px;',
    '  border-radius:6px; cursor:pointer;',
    '  font-size:11px; font-weight:700; line-height:20px;',
    '  font-variant-numeric:tabular-nums;',
    '  color:rgba(255,255,255,.62);',
    '  background:rgba(255,255,255,.05);',
    '  border:1px solid rgba(255,255,255,.16);',
    '  text-shadow:none;',
    '  transition:transform .12s, background .12s; }',
    '.tk-ch-c:hover { transform:scale(1.14); background:rgba(255,255,255,.14); color:#fff; }',
    '.tk-ch-c.done {',
    '  color:#0e2a1a; background:#7ec8a9; border-color:#8ad9bb;',
    '  text-shadow:none; }',
    '.tk-ch-c.cur {',
    '  color:#241c08; background:#eac27e; border-color:#f5d79c;',
    '  box-shadow:0 0 0 2px rgba(234,194,126,.25); text-shadow:none; }',
    /* 既是当前环、又已完成 → 金底保留（当前优先），右上角补一个绿点区分。
       不这么做的后果：玩家标完成当前环后，格子从金变绿，
       「我现在看的是哪一环」这个信息就丢了。 */
    '.tk-ch-c.done.cur { position:relative; }',
    '.tk-ch-c.done.cur::after {',
    '  content:""; position:absolute; right:2px; top:2px;',
    '  width:5px; height:5px; border-radius:50%;',
    '  background:#1f9d5c; box-shadow:0 0 2px rgba(0,0,0,.6); }',
    /* 系列条比链条轻一档，别跟链条抢注意力 */
    '.tk-series { background:rgba(255,255,255,.03); border-style:dashed; padding:0; }',
    '.tk-series .tk-ch-c { background:rgba(234,194,126,.12); border-color:rgba(234,194,126,.3); color:rgba(234,194,126,.8); }',

    /* --- M6.3 系列折叠列表 ---
       summary 复用「任务原文」折叠区的三角与交互（.tk-details 样式已在上方定义），
       这里只补系列自己的排版。
       头部做成 flex：左边「同系列」，右边「共 N 个 · 已完成 M」贴边对齐。 */
    '.tk-series .tk-details > summary {',
    '  padding:9px 10px; cursor:pointer; list-style:none;',
    '  position:relative; padding-right:22px; user-select:none; }',
    '.tk-series .tk-details > summary::-webkit-details-marker { display:none; }',
    /* 箭头：与「任务原文」折叠区同一套语言（▸ 展开 ▾），
       但不能复用 .tk-fold 的选择器——系列区没有那个父类，
       照抄会导致箭头根本不渲染。 */
    '.tk-series .tk-details > summary::after {',
    '  content:"▸"; position:absolute; right:4px; top:50%; margin-top:-6px;',
    '  font-size:11px; color:rgba(255,255,255,.42); transition:transform .15s; }',
    '.tk-series .tk-details > summary:hover { background:rgba(255,255,255,.03); }',
    '.tk-series .tk-details > summary:hover::after { color:rgba(255,255,255,.75); }',
    '.tk-series .tk-details > summary .tk-chain-h { margin-bottom:0; width:100%; }',
    '.tk-series .tk-details[open] > summary { border-bottom:1px solid rgba(255,255,255,.07); }',
    '.tk-series .tk-details[open] > summary::after { transform:rotate(90deg); }',
    /* 列表默认限高：PhotoSpot 系列 15 条全展开会把卡片撑到出屏，
       超过 8 条内部滚动。头部数字已经够判断，滚不滚的无所谓。 */
    '.tk-se-list { max-height:212px; overflow-y:auto; padding:4px 6px 6px; }',
    '.tk-se-row {',
    '  display:flex; align-items:center; gap:8px; width:100%;',
    '  padding:5px 7px; border-radius:5px; cursor:pointer;',
    '  font-size:12px; text-align:left;',
    '  color:rgba(255,255,255,.72); background:transparent;',
    '  border:0; text-shadow:none; transition:background .12s; }',
    '.tk-se-row:hover { background:rgba(255,255,255,.07); color:#fff; }',
    '.tk-se-n { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.tk-se-m {',
    '  flex:none; font-size:10px; letter-spacing:.3em;',
    '  color:rgba(255,255,255,.3); }',
    /* 已完成：划掉压暗，和「任务原文」里的链接同一套语言 */
    '.tk-se-row.done .tk-se-n { color:rgba(255,255,255,.4); text-decoration:line-through; }',
    '.tk-se-row.done .tk-se-m { color:rgba(126,200,169,.6); }',
    /* 当前这条：金底，和任务链「你正在看这一环」同一个信号 */
    '.tk-se-row.self { background:rgba(234,194,126,.14); color:#f5d79c; }',
    '.tk-se-row.self:hover { background:rgba(234,194,126,.2); }',
    '.tk-se-row.self .tk-se-m { color:#eac27e; }',
    '.tk-se-row.self.done .tk-se-n { color:rgba(245,215,156,.55); }',

    /* --- M6.1 本任务可获得的防具 ---
       复用链条区的容器语言（同色系圆角盒），但底色更淡一档：
       掉落是补充信息，不该跟「这是第几环」抢眼。
       图标用 30px 方片并排——套装 3 件一眼看全，比文字列一堆强。 */
    '.tk-ar {',
    '  margin:8px 0 2px; padding:9px 10px;',
    '  background:rgba(255,255,255,.035);',
    '  border:1px solid rgba(255,255,255,.07);',
    '  border-radius:7px; }',
    '.tk-ar-h {',
    '  display:flex; align-items:baseline; gap:6px;',
    '  font-size:11px; letter-spacing:.4em; color:rgba(255,255,255,.45);',
    '  text-shadow:none; margin-bottom:7px; }',
    '.tk-ar-h .tk-src { margin-left:auto; letter-spacing:0; }',
    '.tk-ar-g { display:flex; align-items:center; gap:9px; padding:3px 0; }',
    '.tk-ar-g + .tk-ar-g { border-top:1px solid rgba(255,255,255,.055); }',
    '.tk-ar-icw { display:flex; flex:0 0 auto; gap:2px; }',
    '.tk-ar-ic {',
    '  width:30px; height:30px; border-radius:5px; object-fit:contain;',
    '  background:rgba(0,0,0,.25); border:1px solid rgba(255,255,255,.09); }',
    /* M6.5：图标变成「打开防具卡片」的入口，得给出可点的暗示 */
    '.tk-ar-ic[data-go-armor] { cursor:pointer; transition:transform .12s, box-shadow .12s; }',
    '.tk-ar-ic[data-go-armor]:hover {',
    '  transform:scale(1.1); box-shadow:0 0 0 1px rgba(234,194,126,.5); }',
    /* 套装跳转按钮：套���名右侧的小箭头。
       外面仍是 .tk-ar-n div —— M6.1 的验收按 .tk-ar-n 取套装名，
       把整个 div 换成 button 会让老脚本取不到（实测踩过）。 */
    '.tk-ar-setgo {',
    '  display:inline-block; margin-left:5px; padding:0 3px;',
    '  font-size:12px; line-height:1; cursor:pointer;',
    '  color:rgba(255,255,255,.3); background:none;',
    '  border:0; text-shadow:none; vertical-align:middle; }',
    '.tk-ar-setgo:hover { color:#eac27e; }',
    /* 图标缺失时的占位：取名字首字，别留一个破图 */
    '.tk-ar-nopic {',
    '  display:flex; align-items:center; justify-content:center;',
    '  font-size:12px; color:rgba(255,255,255,.4); }',
    '.tk-ar-tx { flex:1; min-width:0; }',
    '.tk-ar-n {',
    '  font-size:12.5px; color:rgba(255,255,255,.85);',
    '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.tk-ar-s {',
    '  font-size:11px; line-height:1.5; color:rgba(255,255,255,.4);',
    '  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',

    '/* 官方分步 */',
    '.tk-steps { list-style:none; counter-reset:none; }',
    '.tk-step { display:flex; gap:8px; margin-bottom:6px; }',
    '.tk-step-no {',
    '  flex:0 0 17px; height:17px; line-height:17px; text-align:center;',
    '  font-size:10.5px; border-radius:50%;',
    '  background:rgba(234,194,126,.18); color:#eac27e;',
    '  font-variant-numeric:tabular-nums; margin-top:2px; }',
    '.tk-step-tx { flex:1; }',
    '.tk-note {',
    '  font-size:11.5px; color:rgba(255,255,255,.38);',
    '  margin-top:6px; padding-left:25px; line-height:1.55; }',
    '.tk-none {',
    '  font-size:12.5px; color:rgba(255,255,255,.45);',
    '  background:rgba(255,255,255,.04); border-radius:6px;',
    '  padding:7px 9px; line-height:1.6; }',

    '/* 底部操作 */',
    '.tk-actions { display:flex; gap:8px; margin-top:14px; }',
    /* 触控最小可点高度 40px（Apple/Google 的 44px 基线在窄屏放不下，
       40px 是移动端公认的合格下限）。实测 34px 在手机上会误触。
       用 min-height 而不是 height：文案变两行时不至于把字挤出去。 */
    '.tk-actions .btn { flex:1; min-height:40px; }',

    '/* --- 标题行：左标题 + 右操作 --- */',
    '.tk-title-row {',
    '  display:flex; align-items:flex-start; gap:8px; margin-bottom:10px; }',
    '.tk-title-row .tk-name { flex:1; margin-bottom:0; min-width:0; }',
    '.tk-title-acts {',
    '  display:flex; align-items:center; gap:6px; flex:0 0 auto; }',
    '/* 右上角复制：小按钮，不抢正文注意力 */',
    '.tk-icon-btn {',
    '  border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.05);',
    '  color:rgba(255,255,255,.62); font-size:11px; line-height:1;',
    '  padding:5px 8px; border-radius:5px; cursor:pointer; }',
    '.tk-icon-btn:hover { background:rgba(255,255,255,.1); color:#fff; }',
    '/* 追踪开启态：按钮高亮，让「线还在地图上」这件事有视觉出口 */',
    '.tk-actions .btn.act.is-on {',
    '  background:rgba(234,194,126,.16); border-color:rgba(234,194,126,.45);',
    '  color:#eac27e; }',
    /* 不可用态：置灰 + not-allowed 光标。
       不用 display:none —— 藏掉按钮会让人以为卡片缺功能，
       置灰（配title 说明原因）才讲得通「这任务没地点」。 */
    '.tk-actions .btn.act.is-off {',
    '  opacity:.36; cursor:not-allowed; }',
    '.tk-actions .btn.act.is-off:hover {',
    '  background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.14);',
    '  color:rgba(255,255,255,.8); transform:none; }',

    '/* --- 完成态 --- */',
    '/* 右上角勾：参考神庙完成标记，绿色实心 + 白勾，不降标题透明度 */',
    '.tk-done-tick {',
    '  display:inline-flex; align-items:center; justify-content:center;',
    '  width:19px; height:19px; border-radius:50%; flex:0 0 auto;',
    '  background:#3f9c52; color:#fff; font-size:12px; font-weight:700;',
    '  line-height:1; }',
    '.tk-mv-done { color:#7fd18f; }',
    '.btn.done.is-done {',
    '  background:rgba(63,156,82,.16); border-color:rgba(63,156,82,.42);',
    '  color:#8fd79c; cursor:default; }',
    '.btn.done.is-done:disabled { opacity:1; }',

    '/* --- 「任务原文」折叠区（有攻略时才出现）--- */',
    '.tk-fold .tk-details { border:0; }',
    '.tk-fold .tk-details > summary {',
    '  cursor:pointer; list-style:none; position:relative;',
    '  padding-right:20px; user-select:none; }',
    '.tk-fold .tk-details > summary::-webkit-details-marker { display:none; }',
    '/* 自制小箭头：默认 ▸，展开 ▾ */',
    '.tk-fold .tk-details > summary::after {',
    '  content:"▸"; position:absolute; right:2px; top:0;',
    '  font-size:11px; color:rgba(255,255,255,.42); transition:transform .15s; }',
    '.tk-fold .tk-details[open] > summary::after { transform:rotate(90deg); }',
    '.tk-fold .tk-details > summary:hover::after { color:rgba(255,255,255,.75); }',

    '/* 流程线占位（M4 启用） */',
    '.tk-flow-row {',
    '  display:flex; align-items:center; gap:8px; margin-top:10px;',
    '  padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }',
    '.tk-flow-hint { font-size:12px; color:rgba(255,255,255,.55); flex:1; line-height:1.55; }',
    '.tk-flow-btn { flex:0 0 auto; }',
  ].join('\n'));
})(window);