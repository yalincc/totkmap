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
  function reqsHtml(t) {
    if (!t.reqs || !t.reqs.length) return '';
    var items = t.reqs.map(function (r) {
      if (r.linkable && r.reqName) {
        return '<li><a href="#" class="tk-link" data-tk-goto="' + esc(r.reqName) + '">' +
          esc(r.reqName) + '</a></li>';
      }
      /* flag 型：显示条件说明但不链接 */
      return '<li class="tk-flag">' + esc(r.reqName || r.key || '未命名条件') + '</li>';
    });
    return section('前置', '<ul class="tk-list">' + items.join('') + '</ul>');
  }

  /* 官方分步（ROM 权威）
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
   */
  function stepsHtml(t) {
    var steps = t.stepsUI || [];
    if (!steps.length) {
      /* 该任务官方词条文件本身不存在（迷你挑战/赛事/佣兵支线共 12 个），
         或正文全是空壳。此时**不显示**该分区，
         绝不能给玩家一个「1 2 3 4」的空架子。 */
      if (t.hasStepText === false && t.nSteps) {
        return section('官方分步',
          '<div class="tk-none">游戏内这个任务没有官方分步文本' +
          '（仅有 ' + t.nSteps + ' 个内部触发点）</div>');
      }
      return '';
    }
    var items = steps.map(function (s, i) {
      var txt = s.text ? esc(s.text).replace(/\n/g, '<br>') : '';
      return '<li class="tk-step">' +
        '<span class="tk-step-no">' + (i + 1) + '</span>' +
        '<span class="tk-step-tx">' + txt + '</span></li>';
    });
    /* 标注数据来源与清洗口径，别让玩家以为是游戏内原文的完整列表 */
    return section('官方分步<span class="tk-src">ROM 整理</span>',
      '<ol class="tk-steps">' + items.join('') + '</ol>' +
      (t.nSteps > steps.length
        ? '<div class="tk-note">已合并 ' + (t.nSteps - steps.length) +
          ' 条空壳/重复的内部触发点，只保留有说明的步骤</div>'
        : ''));
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
    var items = t.unlockList.map(function (r) {
      if (r.linkable && r.reqName) {
        return '<li><a href="#" class="tk-link" data-tk-goto="' + esc(r.reqName) + '">' +
          esc(r.reqName) + '</a></li>';
      }
      return '<li>' + esc(r.reqName || r.key || '') + '</li>';
    });
    return section('完成后解锁', '<ul class="tk-list">' + items.join('') + '</ul>');
  }

  function section(title, body) {
    return '<div class="tk-sec"><div class="tk-sec-t">' + title + '</div>' +
      '<div class="tk-sec-b">' + body + '</div></div>';
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
    h += '<span class="tk-chip tk-chip-' + (t.cat === 'Main' ? 'main' : t.cat === 'ImportantMini' ? 'imp' : t.cat === 'Sub' ? 'sub' : 'oth') + '">' +
      esc(t.group) + '</span>';
    if (!t.hasName) {
      h += '<span class="tk-chip tk-noname" title="游戏内这个任务没有官方标题，用内部编号显示">暂无官方名</span>';
    }
    h += '<button type="button" class="tk-close" id="tkClose" title="关闭">×</button>';
    h += '</div>';
    h += '<h3 class="tk-name">' + esc(t.name) + '</h3>';

    /* 关键信息行：类型 / 步骤数 / 坐标 */
    h += '<div class="tk-meta">';
    if (t.oldCat) h += '<div class="tk-mrow"><span class="tk-mk">原分类</span><span class="tk-mv">' + esc(t.oldCat) + '</span></div>';
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
    h += '</div>';

    /* 各分区 */
    h += overlapHtml(t);
    h += reqsHtml(t);
    h += stepsHtml(t);
    h += guideHtml(t);
    h += unlockHtml(t);

    /* 底部操作 */
    h += '<div class="tk-actions">';
    h += '<button type="button" class="btn act" id="tkNav">导航</button>';
    h += '<button type="button" class="btn act" id="tkCopy">复制</button>';
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

    /* 复制任务名，便于搜攻略 */
    var cp = $('tkCopy');
    if (cp) cp.addEventListener('click', function (e) {
      stopAll(e);
      copy(t.name);
      toast('已复制：' + t.name);
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

  global.TaskCard = { open: open, close: close, current: function () { return cur; } };

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
    '.tk-chip-oth  { background:rgba(138,143,154,.16); color:#a8adb8; }',
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

    '.tk-link { color:#eac27e; text-decoration:none; border-bottom:1px solid rgba(234,194,126,.3); }',
    '.tk-link:hover { border-bottom-color:#eac27e; }',

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
    '.tk-actions .btn { flex:1; }',

    '/* 流程线占位（M4 启用） */',
    '.tk-flow-row {',
    '  display:flex; align-items:center; gap:8px; margin-top:10px;',
    '  padding-top:10px; border-top:1px solid rgba(255,255,255,.07); }',
    '.tk-flow-hint { font-size:12px; color:rgba(255,255,255,.55); flex:1; line-height:1.55; }',
    '.tk-flow-btn { flex:0 0 auto; }',
  ].join('\n'));
})(window);