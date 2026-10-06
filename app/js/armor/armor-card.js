/* ============================================================
 * 防具卡片（V2.1 M6.5）
 * ------------------------------------------------------------
 * 参考材料卡片（#detail）的结构与交互，做成独立的一套
 * ——不共用 #detail 的模板，原因：
 *   #detail 同时服务材料与探索标点，它的 meta 行固定是「区域/坐标/位置」，
 *   而防具卡要多出「部位/套装 / 防御·买价·售价 / 强化链 / 获取说明 /
 *   同套部件 / 关联任务」六块，塞进去会把材料卡也搞坏。
 *   照 task-card.js 与 exploreCard 的先例：独立卡片，互不干扰。
 *
 * 命名：叫「防具」不叫「装备」—— 防具是唯一不会损坏的装备。
 * ============================================================ */
(function (global) {
  'use strict';

  var D = global.ArmorData;
  if (!D) { console.warn('[防具] ArmorData 未加载，卡片不初始化'); return; }

  var CARD_ID = 'armorCard';
  var cur = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
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

  /* ---------- 各区块 ---------- */

  /* 强化链：能升的显示每一级的防御与材料，不可强化的一句话说明 */
  function upgradeHtml(r) {
    var u = r.upgrade;
    if (!u.upgradeable) {
      return '<div class="ac-sec"><div class="ac-sec-t">强化</div>' +
        '<div class="ac-sec-b"><div class="ac-none">这件防具不可强化</div></div></div>';
    }
    /* 每一级一行：防御 + 星星 + 材料。L1 是当前状态，后面是升级要付的。 */
    var rows = u.steps.map(function (s, i) {
      var mats = (s.mats || []).map(function (m) { return m.zh + '×' + m.n; });
      var star = s.stars != null ? '海拉鲁星星 ×' + s.stars : '（星星数未收录）';
      return '<div class="ac-up' + (i === 0 ? ' cur' : '') + '">' +
        '<span class="ac-up-lv">' + (i === 0 ? '当前' : 'Lv' + s.lv) + '</span>' +
        '<span class="ac-up-d">防御 ' + (s.def != null ? s.def : '—') + '</span>' +
        '<span class="ac-up-s">' + esc(star) + '</span>' +
        '<span class="ac-up-m">' + esc(mats.join('、') || '无') + '</span>' +
        '</div>';
    }).join('');
    return '<div class="ac-sec"><div class="ac-sec-t">强化<span class="ac-src">共 ' +
      u.maxLevel + ' 级</span></div>' +
      '<div class="ac-sec-b"><div class="ac-ups">' + rows + '</div></div></div>';
  }

  /* 获取说明：攻略原文。有多个获取点就都列出来（同名多点的场景）。 */
  function howHtml(r) {
    var out = '';
    if (r.how) {
      out += '<div class="ac-row"><span class="ac-l">获取方式</span>' +
        '<span class="ac-v">' + esc(r.how) + '</span></div>';
    }
    /* 商店防具没有逐件标点，用「附近商店」的说法而不是留空 */
    if (r.how === '商店购买' && !r.howText) {
      out += '<div class="ac-row"><span class="ac-l">获取说明</span>' +
        '<span class="ac-v ac-dim">在附近村庄/商店购买（地图上搜「防具店」）</span></div>';
    }
    (r.points || []).forEach(function (p, i) {
      if (!p.how) return;
      out += '<div class="ac-row"><span class="ac-l">' +
        (r.points.length > 1 ? '获取点 ' + (i + 1) : '获取说明') + '</span>' +
        '<span class="ac-v ac-para">' + esc(p.how.replace(/\n+/g, ' ')) + '</span></div>';
    });
    if (r.req) {
      out += '<div class="ac-row"><span class="ac-l">前置</span>' +
        '<span class="ac-v">' + esc(r.req) + '</span></div>';
    }
    if (r.note) {
      out += '<div class="ac-row"><span class="ac-l">备注</span>' +
        '<span class="ac-v ac-dim">' + esc(r.note) + '</span></div>';
    }
    if (!out) return '';
    return '<div class="ac-sec"><div class="ac-sec-t">怎么拿到</div>' +
      '<div class="ac-sec-b">' + out + '</div></div>';
  }

  /* 套装链接：同套兄弟。老大要求「分开展示 + 加套装链接快速找部件」，
     这里就是那个链接——点一下直接切到那件的卡片。 */
  function setHtml(r) {
    if (!r.siblings.length) return '';
    var rows = r.siblings.map(function (s) {
      return '<button type="button" class="ac-set-i" data-go-armor="' + esc(s.key) + '">' +
        (s.icon ? '<img src="' + esc(s.icon) + '" alt="">' : '') +
        '<span>' + esc(s.name) + '</span>' +
        '<span class="ac-set-s">' + esc(s.slot) + '</span>' +
        '</button>';
    }).join('');
    return '<div class="ac-sec"><div class="ac-sec-t">套装 · ' + esc(r.set) +
      '<span class="ac-src">同套 ' + (r.siblings.length + 1) + ' 件</span></div>' +
      '<div class="ac-sec-b"><div class="ac-sets">' + rows + '</div></div></div>';
  }

  /* 关联任务：点一下跳任务卡片（任务↔防具双向联动的这一半） */
  function tasksHtml(r) {
    if (!r.tasks.length) return '';
    var rows = r.tasks.map(function (t) {
      return '<li><button type="button" class="ac-task" data-go-task="' + esc(t.key) + '">' +
        esc(t.name) + '</button></li>';
    }).join('');
    return '<div class="ac-sec"><div class="ac-sec-t">关联任务</div>' +
      '<div class="ac-sec-b"><ul class="ac-tasks">' + rows + '</ul></div></div>';
  }

  /* ---------- 主渲染 ---------- */
  function open(r, evt) {
    cur = r;
    var box = $(CARD_ID);
    if (!box) return;
    /* ★ 填 #armorCardBody，不是 #armorCard。
       #armorCard 是带 .detail-card 的外壳（负责背景/边框/圆角），
       直接写 outer 会把外壳整个替换掉 → 卡片变透明，地图透出来。 */
    var body = $('armorCardBody') || box;

    /* 无坐标就置灰导航，跟任务卡片一个道理：藏掉会让人以为缺功能 */
    var canNav = !!(r.posValid && r.gx != null && r.gz != null);
    var coord = canNav
      ? 'X ' + Math.round(r.gx) + ' · Z ' + Math.round(r.gz)
      : '无坐标';

    var h = '';
    /* 头部 */
    h += '<div class="ac-head">';
    h += '<span class="chip">' + esc(r.slot) + '</span>';
    h += '<button class="ac-close" id="acClose" type="button">×</button>';
    h += '</div>';
    /* 名字 + 图标 */
    h += '<div class="ac-name-row">';
    h += '<img class="ac-ic" id="acImg" src="' + esc(r.icon || '') + '" alt="' + esc(r.name) + '">';
    h += '<div class="ac-nm">';
    h += '<h3 class="ac-name">' + esc(r.name) + '</h3>';
    h += '<div class="ac-sub">' + esc(r.set || '未分组') +
      ' · ' + esc(r.layerCn || '') + '</div>';
    h += '</div></div>';

    /* 数值 + 位置 */
    h += '<div class="ac-rows">';
    h += '<div class="ac-row"><span class="ac-l">防御</span><span class="ac-v">' +
      (r.def != null ? r.def : '—') + '</span></div>';
    if (r.buy != null) {
      h += '<div class="ac-row"><span class="ac-l">售价 / 回收</span><span class="ac-v">' +
        r.buy + ' / ' + (r.sell != null ? r.sell : '—') + '</span></div>';
    }
    h += '<div class="ac-row"><span class="ac-l">地区</span><span class="ac-v">' +
      esc(r.region || '未知') + '</span></div>';
    h += '<div class="ac-row"><span class="ac-l">坐标</span><span class="ac-v">' + coord + '</span></div>';
    h += '</div>';

    /* 官方说明 */
    if (r.desc) {
      h += '<div class="ac-sec"><div class="ac-sec-t">官方说明</div>' +
        '<div class="ac-sec-b"><div class="ac-para">' + esc(r.desc) + '</div></div></div>';
    }
    h += howHtml(r);
    h += upgradeHtml(r);
    h += setHtml(r);
    h += tasksHtml(r);

    /* 图鉴跳转：老大说以后做，现在只留位不实现 */
    h += '<div class="ac-comp-slot" data-site="' + esc(r.sitePath || '') + '"></div>';

    /* 底部操作 */
    h += '<div class="card-actions">';
    h += '<button id="acNav" type="button" class="btn act' + (canNav ? '' : ' is-off') + '"' +
      (canNav ? '' : ' disabled') + '>导航</button>';
    h += '</div>';

    body.innerHTML = h;
    box.classList.remove('hidden');

    /* 定位到点击处（跟材料卡片一致；双击网格时 evt 为 null，退回右下角） */
    position(box, evt);

    bind(r, canNav);
  }

  function position(box, evt) {
    var w = box.offsetWidth, hh = box.offsetHeight;
    var x = evt && evt.clientX ? evt.clientX - w / 2 : window.innerWidth - w - 24;
    var y = evt && evt.clientY ? evt.clientY - 60 : window.innerHeight - hh - 24;
    /* 夹进视口，避免飘到屏幕外点不到 */
    x = Math.max(12, Math.min(x, window.innerWidth - w - 12));
    y = Math.max(12, Math.min(y, window.innerHeight - hh - 12));
    box.style.left = x + 'px';
    box.style.top = y + 'px';
  }

  function bind(r, canNav) {
    var box = $(CARD_ID);

    var x = $('acClose');
    if (x) x.addEventListener('click', function (e) { e.stopPropagation(); close(); });

    /* 导航：接 app.js 的实时导航，与任务卡片/材料卡片同一套 */
    var nav = $('acNav');
    if (nav && canNav) {
      nav.addEventListener('click', function (e) {
        e.stopPropagation();
        var A = global.TOTK_APP;
        if (A && A.liveNav) {
          A.liveNav({
            name: r.name, x: r.gz, y: r.gx, layer: r.layer, type: '防具'
          });
        } else {
          toast('导航功能需要本地定位服务');
        }
      });
    }

    /* 套装链接：切到同套另一件的卡片 */
    Array.prototype.forEach.call(box.querySelectorAll('[data-go-armor]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var t = D.byKey(b.getAttribute('data-go-armor'));
        if (t) open(t, null);
      });
    });

    /* 关联任务：跳任务卡片（需要先把地图图层切到该任务所在层） */
    Array.prototype.forEach.call(box.querySelectorAll('[data-go-task]'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var tk = b.getAttribute('data-go-task');
        var TD = global.TaskData;
        var A = global.TOTK_APP;
        var t = TD && TD.byKey(tk);
        if (!t) { toast('找不到该任务'); return; }
        /* 任务卡片只会显示当前图层的任务，跨层要先切图层 */
        if (A && A.setLayer && t.layer != null && t.layer !== undefined) {
          try { A.setLayer(t.layer); } catch (err) { /* 切不了就照常打开 */ }
        }
        global.TaskCard.open(t, e);
      });
    });

    /* 图标点开看原图：跟材料卡片同一套预览层。
       ★ 同时是「图鉴跳转」的预留位——老大说以后点击图片跳 totk-site，
         现在仍走原图预览，行为不变、只是多留一个出口。 */
    var ic = $('acImg');
    if (ic) ic.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!this.src) return;
      var pv = $('imgPreviewImg'), pvw = $('imgPreview');
      if (pv && pvw) {
        pv.src = this.src;
        pvw.classList.remove('hidden');
      }
    });
  }

  function close() {
    var box = $(CARD_ID);
    if (box) box.classList.add('hidden');
    cur = null;
  }

  /* ---------- 对外 ---------- */
  global.ArmorCard = {
    open: function (r, evt) {
      if (!r || !r.key) return;
      open(r, evt);
    },
    openByKey: function (k, evt) {
      var r = D.byKey(k);
      if (r) open(r, evt);
    },
    close: close,
    current: function () { return cur; }
  };
})(window);