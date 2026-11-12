/* ============ TOTKMAP · 存档修改器 页面逻辑 ============
 *
 * 职责边界：
 *   save-writer.js  负责「字节怎么改」（定位、写入、校验），一行 UI 逻辑都没有
 *   本文件          只负责「怎么问用户要参数、怎么把结果交给用户」
 *
 * 三条铁律（改这个文件前先读）：
 *   1. 任何写入都必须先出预览，用户确认后才下载 —— 不给「一键盲改」
 *   2. 下载改档之前，强制先下载一份原档备份（不给跳过选项）
 *   3. 只调 SaveWriter 的公开 API，不在这里直接碰 DataView / 偏移
 */
(function () {
  'use strict';

  var NAVI = 'http://127.0.0.1:8766';

  var state = {
    sw: null,          // SaveWriter 会话
    file: null,        // 原档 ArrayBuffer
    source: '',        // 'navi' | 'file'
    pouch: {},         // 各类背包读出来的结果
    eqCat: 'weapons',
    /* ★ 装备改动必须存在这里，不能只留在 DOM 里。
     *   装备区按武器/弓/盾分三个 tab，切一次 tab 就整块重绘，
     *   DOM 里的输入随之销毁 —— 之前就是因此「只有最后停留的那个分类生效」，
     *   用户改了武器和弓、最后停在盾，结果只有盾被导出。 */
    eqEdits: {},       // 'weapons|3' → { life?, eff?, effVal?, inf? }
    mgSel: {},         // 材料分类勾选 { food:true, zonai:true, ... }
    pending: null,     // 待下载的结果
    dlBufs: null,      // 已算好的两份字节（备份 / 改档），供「再下一次」复用
    dlDone: false,     // 下载已完成（此时底部按钮变成"关闭"）
    origin: { rupee: 0, hearts: 0, stamina: 0, energy: 0 },  // 存档原值（HUD 对比用）
    pos: null,          // 当前存档点
    bp: null,           // 存档里的蓝图槽（readBlueprints 结果）
    bpImport: null      // 待写入的蓝图 { i, data, camPos, camAt }
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nameOf(actor) {
    var n = window.EQUIP_NAMES && window.EQUIP_NAMES[actor];
    return n || null;
  }
  /* 提示分两个落点：
   *   未加载 → 投放区下方（loadMsg）
   *   已加载 → 编辑区顶部（liveMsg）
   * 以前一律写进 loadMsg，导致「改不了」「连不上 navi」这类提示落在已隐藏的首页区，
   * 用户点了按钮毫无反应 —— 这是真实的可用性缺陷，不是样式问题。 */
  function showMsg(html, cls) {
    if (!html) {
      $('loadMsg').innerHTML = '';
      var old = $('liveMsg');
      if (old) old.innerHTML = '';
      return;
    }
    var el = '<div class="tip ' + (cls || '') + '">' + html + '</div>';
    if (state.sw) {
      var live = $('liveMsg');
      if (!live) {
        $('editStage').insertAdjacentHTML('afterbegin', '<div id="liveMsg"></div>');
        live = $('liveMsg');
      }
      live.innerHTML = el;
      live.scrollIntoView({ block: 'nearest' });
    } else {
      $('loadMsg').innerHTML = el;
    }
  }
  function fmt(n) {
    return typeof n === 'number' ? (Math.abs(n - Math.round(n)) < 1e-6 ? String(Math.round(n)) : n.toFixed(2)) : n;
  }
  function thou(n) {
    return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
  }

  /* 分段选择器：读 / 写 / 高亮都由 data-value 驱动，不让按钮和状态各存一份 */
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
    /* 换了一份存档 → 上一份的改动全部作废，否则会把旧档的改动带进新档 */
    state.eqEdits = {};
    state.mgSel = {};

    $('loadingStage').hidden = true;
    $('editStage').hidden = false;

    /* 顶栏信息 */
    $('topMeta').hidden = false;
    $('chipVer').textContent = sw.version;
    $('chipSize').textContent = sw.size.toLocaleString() + ' 字节';
    $('verDot').classList.toggle('bad', !sw.isKnownVersion);
    $('verDot').title = sw.isKnownVersion ? '存档版本已识别' : '版本未识别（仍可改，按运行时定位）';

    /* 读出各背包。zonai = 左纳乌装置，它是独立容器（不在材料里），
       所以 999 要单独算一类，见 save-writer 的 POUCH 注释 */
    ['materials', 'arrows', 'zonai', 'weapons', 'bows', 'shields'].forEach(function (cat) {
      state.pouch[cat] = sw.readPouch(cat, true);
    });

    /* 记住原值 —— HUD 要拿它做"改前 → 改后"对比 */
    var sc = sw.readScalars().values;
    state.origin = {
      rupee: sc.rupee || 0,
      hearts: (sc.maxLife || 0) / 4,
      stamina: sc.stamina || 0,
      energy: sc.energy || 0
    };

    /* 精力 / 电池：当前值提示到小字上，不占主界面 */
    if (sc.stamina !== undefined) {
      $('hintStamina').textContent = '当前 ' + (sc.stamina / 1000) + ' 圈 · 1 圈 = 1000';
    }
    if (sc.energy !== undefined) {
      $('hintEnergy').textContent = '当前 ' + (sc.energy / 1000) + ' 格 · 满 16 格';
    }

    renderMatGrid();
    renderEquip();

    /* 蓝图：换了一份存档 → 上一份待导入的蓝图一律作废 */
    state.bp = sw.readBlueprints();
    state.bpImport = null;
    $('bpPending').hidden = true;
    $('bpShareBox').hidden = true;
    renderBlueprints();

    /* 坐标 */
    var p = sw.readPos();
    state.pos = p;
    $('curPos').textContent = p
      ? '(' + fmt(p.x) + ', ' + fmt(p.y) + ', ' + fmt(p.z) + ')'
      : '读取失败';
    $('btnFillPos').disabled = !p;

    $('btnApply').disabled = false;
    $('btnReset').disabled = false;
    updateFoot();
  }

  /* 材料分类格子：按类统计「你有几种」，点哪类就改哪类。
   * 数量来自存档实读，不是写死的 —— 每个人背包里的种类不一样。
   * 分类规则只有一份（save-writer 的 MAT_GROUPS），这里不另抄一套。 */
  function renderMatGrid() {
    var m = state.pouch.materials, a = state.pouch.arrows, z = state.pouch.zonai;
    var box = $('mgGrid');

    var counts = {};
    if (m && m.ok) {
      m.items.forEach(function (it) {
        var g = window.SaveWriter.classifyMaterial(it.name);
        counts[g] = (counts[g] || 0) + 1;
      });
    }

    /* 前几格照 MAT_GROUPS 的顺序，最后一格固定是左纳乌（它是独立容器，不在材料里） */
    var cells = window.SaveWriter.MAT_GROUPS.map(function (g) {
      return { key: g.key, label: g.label, n: counts[g.key] || 0 };
    });
    if (z && z.ok) cells.push({ key: 'zonai', label: '左纳乌', n: z.items.length });

    box.innerHTML = cells.map(function (c) {
      var on = !!state.mgSel[c.key];
      return '<button type="button" class="mg' + (on ? ' on' : '') + '"' +
        ' data-g="' + c.key + '"' + (c.n === 0 ? ' disabled' : '') +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="mg-n">' + (c.n || '—') + '</span>' +
        '<span class="mg-l">' + c.label + '</span>' +
        '</button>';
    }).join('') + ((z && !z.ok)
      ? '<div class="mg-warn">左纳乌装置读不出来：' + esc(z.error) + '</div>' : '');

    $('arrHint').textContent = a && a.ok
      ? a.items.length + ' 种箭矢'
      : (a ? a.error : '—');

    syncMgAll();
  }

  /* 「全选 / 全不选」的文字跟着当前状态走，不用用户猜点了会发生什么 */
  function syncMgAll() {
    var btns = $('mgGrid').querySelectorAll('.mg:not([disabled])');
    var allOn = btns.length > 0;
    Array.prototype.forEach.call(btns, function (b) {
      if (!state.mgSel[b.dataset.g]) allOn = false;
    });
    $('mgAll').textContent = allOn ? '全不选' : '全选';
    $('mgAll').classList.toggle('on', allOn);
  }

  /* ---------- 装备列表 ---------- */
  function renderEquip() {
    /* 三个 tab 都带上数量，用户不用逐个点开才知道哪栏有东西 */
    ['weapons', 'bows', 'shields'].forEach(function (cat) {
      var r = state.pouch[cat];
      var el = document.querySelector('.eq-tab .cnt[data-cnt="' + cat + '"]');
      if (el) el.textContent = (r && r.ok) ? r.items.length : '—';
    });

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

    /* 只列出「这一类别能用」的附加属性，不把长柄/弓的专属属性混进盾的下拉 */
    var allowed = EFFECT_BY_CAT[state.eqCat] || EFFECT_ALL;
    var opts = allowed.map(function (e) {
      return '<option value="' + e + '">' + effLabel(e) + '</option>';
    }).join('');

    box.innerHTML = r.items.map(function (it) {
      var cn = nameOf(it.name);
      var title = cn ? esc(cn) : esc(it.name);
      var sub = cn ? esc(it.name) : '';
      return '' +
        '<div class="eq-item" data-i="' + it.i + '" data-cat="' + state.eqCat + '"' +
             ' data-eff="' + esc(it.eff || '') + '" data-val="' + (it.effVal !== undefined ? it.effVal : '') + '">' +
          '<div class="eq-name">' + title + (sub ? '<small>' + sub + '</small>' : '') + '</div>' +
          '<input type="number" class="eq-life" min="1" max="99999" ' +
            'placeholder="耐久 ' + (it.life !== undefined ? it.life : '?') + '" aria-label="耐久">' +
          '<select class="eq-eff" aria-label="附加属性">' +
            '<option value="">附加：不改</option>' + opts +
          '</select>' +
          '<span class="eq-valwrap">' +
            '<input type="number" class="eq-val" disabled aria-label="附加数值">' +
            '<button type="button" class="eq-inf" title="设为无限耐久（永不损坏）" aria-label="无限耐久">∞</button>' +
          '</span>' +
        '</div>';
    }).join('');

    /* 附加属性 → 附加数值 的联动。
     * 关键：同一格在三种属性下含义不同（攻击力 / 防御力 / 额外耐久），
     * 不需要数值的属性（连射、投掷距离…）必须禁用输入框，否则会写出无意义的数字。
     * 无限耐久的值是 2100000000，10 位数塞不进 92px 的框（会被裁成 21000000，用户读到错值），
     * 所以点 ∞ 之后不再显示数字，改用占位文字「∞ 永不损坏」，真值挂在 dataset 上。 */
    var SW = window.SaveWriter;
    Array.prototype.forEach.call(box.querySelectorAll('.eq-item'), function (el) {
      var i = +el.dataset.i;
      var it = r.items.filter(function (x) { return x.i === i; })[0];
      if (!it) return;

      var key = state.eqCat + '|' + i;      /* 跨 tab 的稳定标识，别用 DOM 位置 */
      var sel = el.querySelector('.eq-eff');
      var val = el.querySelector('.eq-val');
      var inf = el.querySelector('.eq-inf');
      var wrap = el.querySelector('.eq-valwrap');
      var lifeIn = el.querySelector('.eq-life');
      var origEff = it.eff || 'None';
      var origVal = it.effVal;

      sel.title = '当前附加：' + effLabel(origEff) + '（数值 ' + (origVal !== undefined ? origVal : '?') + '）';

      function promptOf(e) {
        if (!e) return '—';
        if (!SW.needsValue(e)) return '不需数值';
        return SW.valueLabel(e) || '—';
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

        /* 选回原本就是「无限耐久」的装备 → 直接进 ∞ 状态 */
        if (isDur && e === origEff && origVal === SW.INF_DURABILITY) { setInf(true); return; }

        setInf(false);
        if (!need) { val.value = ''; return; }
        if (fill) {
          /* 选回原本就有的属性 → 用存档原值（别降级成默认值）；换成别的属性 → 默认 10 */
          var keep = (e === origEff && typeof origVal === 'number' && origVal > 0);
          val.value = keep ? origVal : 10;
        }
      }

      /* 把这一行的输入收进 state —— 重建 DOM 不丢、切 tab 不丢、导出时从这里取 */
      function persist() {
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
        if (rec) state.eqEdits[key] = rec;
        else delete state.eqEdits[key];
        updateFoot();
      }

      lifeIn.addEventListener('input', persist);
      val.addEventListener('input', persist);
      sel.addEventListener('change', function () { sync(true); persist(); });
      inf.addEventListener('click', function () {
        if (el.dataset.inf === '1') { setInf(false); val.value = 10; }
        else { setInf(true); }
        persist();
      });

      sync(false);

      /* ★ 切回这个 tab 时把之前填的还原。
         没有这段，切一次 tab 改动就没了 —— 这正是「武器和弓改了不生效」的原因。 */
      var saved = state.eqEdits[key];
      if (saved) {
        if (typeof saved.life === 'number') lifeIn.value = saved.life;
        if (saved.eff) {
          sel.value = saved.eff;
          sync(true);
          if (saved.inf) setInf(true);
          else if (typeof saved.effVal === 'number') val.value = saved.effVal;
        }
      }
    });
  }

  var EFFECT_LABELS = {
    'None': '无',
    'AttackUp': '攻击力提升',
    'AttackUpPlus': '攻击力大提升',
    'DurabilityUp': '耐久提升',
    'DurabilityUpPlus': '耐久大提升',
    'FinishBlow': '终结一击强化',
    'LongThrow': '投掷距离提升',
    'RapidFire': '连射',
    'ThreeWayZoom': '三连射',
    'FiveWay': '五连射',
    'GuardUp': '防御力提升',
    'GuardUpPlus': '防御力大提升'
  };
  function effLabel(e) { return EFFECT_LABELS[e] || e || '—'; }

  /* 武器 / 弓 / 盾 各能用哪些附加属性 —— 给人看不属于该类别的选项等于埋雷 */
  var EFFECT_ALL = ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'FinishBlow', 'LongThrow'];
  var EFFECT_BY_CAT = {
    weapons: ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'FinishBlow', 'LongThrow'],
    bows: ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus', 'RapidFire', 'ThreeWayZoom', 'FiveWay'],
    shields: ['None', 'DurabilityUp', 'DurabilityUpPlus', 'GuardUp', 'GuardUpPlus']
  };

  /* ---------- 蓝图分享 / 导入 ----------
   * 字节读写全在 save-writer.js，这里只做「选槽 → 导出/生成分享码 → 读回 → 交给预览」。
   * 导入不会立刻改档：先记进 state.bpImport，由底部「预览并下载」统一走强制备份流程。 */
  function bpLabel(s) {
    return '#' + String(s.i + 1).padStart(2, '0') + ' · ' + (s.used ? '有蓝图' : '空槽') +
           (s.index < 0 ? '（未启用）' : '');
  }

  function renderBlueprints() {
    var src = $('bpSlot'), dst = $('bpTarget'), cnt = $('bpCount');
    var b = state.bp;
    if (!b || !b.ok) {
      cnt.textContent = b ? b.error : '读取失败';
      src.innerHTML = ''; dst.innerHTML = '';
      $('bpExport').disabled = true; $('bpShare').disabled = true;
      return;
    }
    var used = 0, firstUsed = -1, firstEmpty = -1;
    b.slots.forEach(function (s) {
      if (s.used) { used++; if (firstUsed < 0) firstUsed = s.i; }
      else if (firstEmpty < 0) firstEmpty = s.i;
    });
    cnt.textContent = b.count + ' 个槽 · ' + used + ' 个有蓝图';
    var opts = b.slots.map(function (s) {
      return '<option value="' + s.i + '">' + esc(bpLabel(s)) + '</option>';
    }).join('');
    src.innerHTML = opts; dst.innerHTML = opts;
    if (firstUsed >= 0) src.value = String(firstUsed);
    dst.value = String(firstEmpty >= 0 ? firstEmpty : b.slots[b.slots.length - 1].i);
    $('bpExport').disabled = firstUsed < 0;
    $('bpShare').disabled = firstUsed < 0;
  }

  function bpSlot() {
    if (!state.bp || !state.bp.ok) return null;
    return state.bp.slots[+$('bpSlot').value] || null;
  }

  function bpExport() {
    var s = bpSlot();
    if (!s || !s.used) { showMsg('这个槽里没有蓝图，换一个再导出。', 'warn'); return; }
    try {
      var cai = window.Blueprint.toCai(s);
      window.Blueprint.download(cai, 'blueprint_' + String(s.i + 1).padStart(2, '0') + '.cai');
      showMsg('<b>已导出 .cai。</b>可以直接发给别人，或上传到 HyruleWorks。', 'ok');
    } catch (e) { showMsg('<b>导出失败：</b>' + esc(e.message), 'warn'); }
  }

  function bpShare() {
    var s = bpSlot();
    if (!s || !s.used) { showMsg('这个槽里没有蓝图，换一个再分享。', 'warn'); return; }
    try {
      var code = window.Blueprint.encodeShare(window.Blueprint.toCai(s));
      var svg = window.Blueprint.qrSvg(code);
      $('bpShareText').value = code;
      $('bpQr').innerHTML = svg || '';
      $('bpQrHint').textContent = svg
        ? '用任意扫码工具扫出来就是这串文本，复制粘贴到本页即可导入。'
        : '这张蓝图太长，二维码放不下，请改用分享码文本或 .cai 文件。';
      $('bpShareBox').hidden = false;
    } catch (e) { showMsg('<b>生成分享码失败：</b>' + esc(e.message), 'warn'); }
  }

  function bpPendingHtml(i, from) {
    var tgt = state.bp.slots[i];
    return '<b>已读取一张蓝图</b>' + (from ? '（来源：' + esc(from) + '）' : '') + ' → 将' +
      (tgt.used ? '<b>覆盖</b>' : '写入') + ' <b>' + esc(bpLabel(tgt)) + '</b>' +
      (tgt.used ? '（该槽原有蓝图会被替换，可先导出留底）' : '') +
      '。点底部「预览并下载」生成改好的存档。';
  }

  function bpSetImport(caiBytes, from) {
    if (!state.bp || !state.bp.ok) { showMsg('先加载存档，再导入蓝图。', 'warn'); return; }
    try {
      var parsed = window.Blueprint.parseCai(caiBytes);
      var i = +$('bpTarget').value;
      state.bpImport = { i: i, data: parsed.data, camPos: parsed.camPos, camAt: parsed.camAt };
      var el = $('bpPending');
      el.hidden = false;
      el.innerHTML = bpPendingHtml(i, from);
      updateFoot();
    } catch (e) { showMsg('<b>导入失败：</b>' + esc(e.message), 'warn'); }
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

    /* 材料 / 左纳乌：按勾选的类别交（左纳乌是独立容器，单独一个开关） */
    var gs = Object.keys(state.mgSel).filter(function (k) { return state.mgSel[k]; });
    var matGs = gs.filter(function (k) { return k !== 'zonai'; });
    if (matGs.length) p.matGroups = matGs;
    if (state.mgSel.zonai) p.zonai999 = true;
    if ($('swArr').checked) p.arrows999 = true;

    /* 坐标：三个都填才生效 —— 只改一半等于把人塞进地底 */
    var xs = $('inPosX').value.trim(), ys = $('inPosY').value.trim(), zs = $('inPosZ').value.trim();
    if (xs !== '' && ys !== '' && zs !== '') {
      var x = parseFloat(xs), y = parseFloat(ys), z = parseFloat(zs);
      if (isFinite(x) && isFinite(y) && isFinite(z)) p.pos = { x: x, y: y, z: z };
    }

    /* 装备：从 state 取，不读 DOM —— DOM 只显示当前 tab，不能当数据源 */
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
      if (one.life !== undefined || one.eff !== undefined) items.push(one);
    });
    if (items.length) p.items = items;

    /* 蓝图导入与其它改动一起进预览，共用强制备份 / 下载流程 */
    if (state.bpImport) p.blueprint = state.bpImport;

    return p;
  }

  /* ---------- 预览 ---------- */
  function openPreview() {
    var plan = collectPlan();

    /* 「什么都没填」和「填了但值跟存档一样」是两件事，提示必须分开说。
       以前两种情况都报"你还没改任何东西"，用户明明填了数却被告知没改，只会以为按钮坏了。 */
    if (!Object.keys(plan).length) {
      showMsg('还没选要改什么 —— 上面的卡片里挑一项填上，再点这里。', '');
      return;
    }

    var res;
    try {
      res = state.sw.apply(plan);
    } catch (e) {
      showMsg('<b>生成失败：</b>' + esc(e.message), 'warn');
      return;
    }
    if (!res.ok) {
      showMsg('<b>改不了：</b>' + esc(res.error), 'warn');
      return;
    }
    if (!res.changed) {
      showMsg('你填的值和存档里现在的一样，没有需要写的字节。改一个不一样的值再试。', '');
      return;
    }

    state.pending = res;

    var body = $('previewBody');
    /* 同类合并显示：材料 90 条数量改动没必要列 90 行 */
    var groups = {};
    res.edits.forEach(function (e) {
      var key = e.label.replace(/#\d+/, '').replace(/ \d+$/, '');
      if (!groups[key]) groups[key] = { n: 0, label: key, samples: [] };
      groups[key].n++;
      if (groups[key].samples.length < 3) groups[key].samples.push(e);
    });

    /* 一条改动怎么念：枚举字段（附加属性）翻成中文；无限耐久念成 ∞ —— 2100000000 给人看没意义 */
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

    var vr = res.verify();
    html += '<div class="tip ok">共改动 <b class="num">' + res.changed + '</b> 处、' +
      '<b class="num">' + vr.bytes + '</b> 个字节，分布 <b class="num">' + vr.segments.length +
      '</b> 段，文件长度不变。没有新增或删除任何物品。</div>';

    body.innerHTML = html;
    $('previewMask').classList.remove('hidden');
    $('btnCancelPreview').focus();
  }

  /* ---------- 下载 ----------
   *
   * ★ 这里踩过坑，改之前先读：
   *   原来点一次就 setTimeout 连下两个文件，然后立刻把弹层关掉、把成功提示写到页面顶部。
   *   问题出在两处：
   *     1) 浏览器（Chrome/Edge）把「一次点击内连续两次下载」判定为自动多文件下载，
   *        第二次会被直接拦掉，只留一个地址栏小图标 —— 用户完全看不出来，就是"点了没反应"。
   *     2) 提示落在页面顶部，而用户视线在底部弹层上，点完页面毫无变化，同样像没反应。
   *   现在的做法：
   *     · 点下去先在弹层里给出可见状态（按钮禁用 + 「正在下载」），绝不让人盯着没动静的界面
   *     · 两个文件仍按顺序自动下（体验不变），但完成后面板留在弹层里，
   *       每个文件各带一个「再下一次」按钮 —— 每次都是独立点击，绕过一切多文件拦截
   *     · 不再对结果打包票（沙箱预览里可能静默失败），文案只说"已交给浏览器"，让用户自己核对
   */
  function fileTag() {
    var d = new Date();
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
  }

  /* 单次下载：返回空串代表没抛错（不代表一定落盘），抛错就带回原因 */
  function fire(item) {
    try {
      window.SaveWriter.download(item.buf, item.name);
      return '';
    } catch (e) {
      return (e && e.message) || '浏览器拒绝了这次下载';
    }
  }

  function doDownload() {
    var res = state.pending;
    if (!res) return;

    var tag = fileTag();
    /* 两份字节先备好：后面的「再下一次」按钮直接复用，不再重算 */
    state.dlBufs = {
      backup: {
        buf: state.file.slice(0),
        name: 'progress_backup_' + tag + '.sav',
        label: '原档备份 · 先收好'
      },
      edited: {
        buf: res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength),
        name: 'progress.sav',
        label: '改好的存档 · 用来覆盖'
      }
    };

    var btn = $('btnDownload');
    btn.disabled = true;
    btn.textContent = '正在下载…';

    var body = $('previewBody');
    body.insertAdjacentHTML('afterbegin', '<div class="dl-busy" id="dlBusy">正在把两个文件交给浏览器…</div>');

    /* 铁律 2：先备份，再给改好的档。间隔 320ms —— 浏览器连续两次下载容易吞掉后一个 */
    var errB = fire(state.dlBufs.backup);
    setTimeout(function () {
      var errE = fire(state.dlBufs.edited);
      renderDone(errB, errE);
    }, 320);
  }

  function renderDone(errB, errE) {
    var anyErr = !!(errB || errE);
    var n = state.pending ? state.pending.changed : 0;

    var html = '' +
      '<div class="dl-note ' + (anyErr ? 'warn' : 'ok') + '">' +
        '<b>改动 ' + n + ' 处已写进 progress.sav</b>' +
        '<br>' + (anyErr
          ? '浏览器挡下了其中一次下载（常见于一次点击触发多个文件）。点下面各自的「再下一次」，一次一个就不会被挡。'
          : '浏览器已开始下载。如果两个文件里只见到一个，点下面缺的那个「再下一次」补上。') +
      '</div>';

    [['backup', state.dlBufs.backup, errB], ['edited', state.dlBufs.edited, errE]].forEach(function (p) {
      html += '<div class="dl-row" data-k="' + p[0] + '">' +
        '<span class="dl-txt"><b>' + esc(p[1].name) + '</b><small>' + esc(p[1].label) +
          (p[2] ? '<em class="bad">' + esc(p[2]) + '</em>' : '') + '</small></span>' +
        '<button type="button" class="dl-again">再下一次</button>' +
      '</div>';
    });

    html += '<div class="tip">覆盖前务必<b>完全退出游戏和模拟器</b>，否则下次退出游戏会把旧档写回去。' +
      '文件名必须是 <b>progress.sav</b>，目录：<span class="pth">save › 0000000000000007 › 0 › slot_00</span></div>';

    var body = $('previewBody');
    body.innerHTML = html;

    /* 每个文件独立一次点击 = 独立用户手势，绕开多文件拦截 */
    Array.prototype.forEach.call(body.querySelectorAll('.dl-again'), function (b) {
      b.addEventListener('click', function () {
        var k = b.parentNode.dataset.k;
        var e = fire(state.dlBufs[k]);
        b.textContent = e ? '失败，重试' : '已下载';
        b.classList.toggle('bad', !!e);
        setTimeout(function () { b.textContent = '再下一次'; b.classList.remove('bad'); }, 1600);
      });
    });

    state.dlDone = true;
    var btn = $('btnDownload');
    btn.disabled = false;
    btn.textContent = '好，去覆盖存档';

    /* 面板已经从"确认要不要改"变成"文件在这儿"，标题和次要按钮跟着换 ——
       留着"再想想"会让人以为还能撤回，其实字节早就算好并导出过了。 */
    $('dlgTitle').textContent = '已导出，去覆盖存档';
    $('btnCancelPreview').hidden = true;

    /* 页面顶部也留一条，关掉弹层后还能对上号 */
    showMsg('<b>改动已导出。</b>先把 <b>' + esc(state.dlBufs.backup.name) + '</b> 收好，' +
      '再用 <b>progress.sav</b> 覆盖存档目录里的同名文件。', 'ok');
  }

  function closePreview() {
    $('previewMask').classList.add('hidden');
    state.dlDone = false;
    state.dlBufs = null;
    state.pending = null;
    var btn = $('btnDownload');
    btn.disabled = false;
    btn.textContent = '下载改好的存档';
    $('dlgTitle').textContent = '确认要改这些';
    $('btnCancelPreview').hidden = false;
  }

  /* ---------- 状态面板 + 底栏 ---------- */
  function paintStat(id, valHtml, wasHtml, dirty) {
    var el = $(id);
    el.querySelector('.stat-val').innerHTML = valHtml;
    el.querySelector('.stat-was').innerHTML = wasHtml || '';
    el.classList.toggle('dirty', !!dirty);
  }

  function updateFoot() {
    if (!state.sw) { $('footStatus').textContent = '还没有加载存档'; return; }

    var plan = collectPlan();
    var o = state.origin;

    /* 卢比 */
    var rUp = typeof plan.rupee === 'number';
    paintStat('statRupee',
      thou(rUp ? plan.rupee : o.rupee),
      rUp ? '<s>' + thou(o.rupee) + '</s>' : '',
      rUp && plan.rupee !== o.rupee);

    /* 生命 */
    var hUp = typeof plan.hearts === 'number';
    paintStat('statHearts',
      fmt(hUp ? plan.hearts : o.hearts) + '<small>心</small>',
      hUp ? '<s>' + fmt(o.hearts) + '</s>' : '',
      hUp && plan.hearts !== o.hearts);

    /* 精力 */
    var sUp = typeof plan.stamina === 'number';
    var sVal = sUp ? plan.stamina : o.stamina;
    paintStat('statStamina',
      fmt(sVal / 1000) + '<small>圈</small>',
      sUp ? '<s>' + fmt(o.stamina / 1000) + '</s>' : '',
      sUp && plan.stamina !== o.stamina);

    /* 电池 */
    var eUp = typeof plan.energy === 'number';
    var eVal = eUp ? plan.energy : o.energy;
    paintStat('statEnergy',
      fmt(eVal / 1000) + '<small>格</small>',
      eUp ? '<s>' + fmt(o.energy / 1000) + '</s>' : '',
      eUp && plan.energy !== o.energy);

    /* 底栏计数 */
    var n = 0;
    if (rUp) n++;
    if (hUp) n++;
    if (sUp) n++;
    if (eUp) n++;
    if (plan.matGroups) n += plan.matGroups.length;
    if (plan.zonai999) n++;
    if (plan.arrows999) n++;
    if (plan.pos) n++;
    if (plan.items) n += plan.items.length;
    if (plan.blueprint) n++;

    var src = state.source === 'navi' ? 'navi 直连' : '本地文件';
    $('footStatus').innerHTML = n
      ? '已选 <b>' + n + '</b> 项待修改<span class="sep">·</span>' + esc(src) + '<span class="sep">·</span>版本 ' + esc(state.sw.version)
      : '版本 ' + esc(state.sw.version) + '<span class="sep">·</span>' + esc(src) + '<span class="sep">·</span>还没选要改什么';
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btnBack').addEventListener('click', function () {
      location.href = '../index.html';
    });

    /* 选文件 */
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

    /* 拖拽 */
    var dz = $('dropZone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { loadFromArrayBuffer(fr.result, 'file'); };
      fr.readAsArrayBuffer(f);
    });

    /* 从 navi 拉 */
    $('btnFromNavi').addEventListener('click', function () {
      /* 离线包是 file:// 打开的，这个协议下浏览器禁止页面访问任何 http 服务（含本机 8766） */
      if (location.protocol === 'file:') {
        showMsg('<b>离线包方式打不开自动读取。</b>你现在是直接双击 html 打开的（file://），浏览器在这种方式下不允许页面连本机服务。' +
          '<br>请用左边「选择存档文件」，效果完全一样。', 'warn');
        return;
      }
      var btn = $('btnFromNavi');
      btn.disabled = true;
      showMsg('正在向 totknavi 要最新存档…（请确认定位服务已启动）');
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;

      fetch(NAVI + '/save?t=' + Date.now(), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (ab) {
          if (timer) clearTimeout(timer);
          btn.disabled = false;
          showMsg('');
          loadFromArrayBuffer(ab, 'navi');
        })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          btn.disabled = false;
          showMsg('<b>连不上 totknavi。</b>可能是定位服务没启动，或者页面走的是 https 被浏览器拦了本地请求。' +
            '<br>直接选文件也一样能改，功能完全一致。', 'warn');
        });
    });

    /* 装备切换 */
    Array.prototype.forEach.call(document.querySelectorAll('.eq-tab'), function (t) {
      t.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('.eq-tab'), function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        state.eqCat = t.dataset.cat;
        renderEquip();
        updateFoot();
      });
    });

    /* 快捷档位：卢比 / 生命 */
    Array.prototype.forEach.call(document.querySelectorAll('.qbtn'), function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.hearts) $('inHearts').value = b.dataset.hearts;
        if (b.dataset.rupee) $('inRupee').value = b.dataset.rupee;
        /* 同一组里同时只高亮一个 */
        var sibs = b.parentNode.querySelectorAll('.qbtn');
        Array.prototype.forEach.call(sibs, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        updateFoot();
      });
    });

    /* 分段选择器：精力 / 电池 */
    ['segStamina', 'segEnergy'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        setSeg(id, b.dataset.v === '' ? null : +b.dataset.v);
        updateFoot();
      });
    });

    /* 填入当前坐标 —— 想微调位置时有基准点，不用手动抄三个数 */
    $('btnFillPos').addEventListener('click', function () {
      if (!state.pos) return;
      $('inPosX').value = Math.round(state.pos.x * 100) / 100;
      $('inPosY').value = Math.round(state.pos.y * 100) / 100;
      $('inPosZ').value = Math.round(state.pos.z * 100) / 100;
      updateFoot();
    });

    /* 任何改动都刷新状态面板与底栏计数 */
    ['inRupee', 'inHearts', 'inPosX', 'inPosY', 'inPosZ'].forEach(function (id) {
      $(id).addEventListener('input', updateFoot);
    });
    $('swArr').addEventListener('change', updateFoot);

    /* 材料分类格子：点一下切换一类。全选/全不选按当前状态反转 */
    $('mgGrid').addEventListener('click', function (e) {
      var b = e.target.closest('.mg');
      if (!b || b.disabled) return;
      var g = b.dataset.g;
      if (state.mgSel[g]) delete state.mgSel[g];
      else state.mgSel[g] = true;
      b.classList.toggle('on', !!state.mgSel[g]);
      b.setAttribute('aria-pressed', state.mgSel[g] ? 'true' : 'false');
      syncMgAll();
      updateFoot();
    });
    $('mgAll').addEventListener('click', function () {
      var btns = $('mgGrid').querySelectorAll('.mg:not([disabled])');
      var allOn = btns.length > 0;
      Array.prototype.forEach.call(btns, function (b) { if (!state.mgSel[b.dataset.g]) allOn = false; });
      Array.prototype.forEach.call(btns, function (b) {
        var g = b.dataset.g;
        if (allOn) { delete state.mgSel[g]; b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
        else { state.mgSel[g] = true; b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); }
      });
      syncMgAll();
      updateFoot();
    });

    /* 重置 */
    $('btnReset').addEventListener('click', function () {
      ['inRupee', 'inHearts', 'inPosX', 'inPosY', 'inPosZ'].forEach(function (id) { $(id).value = ''; });
      setSeg('segStamina', null);
      setSeg('segEnergy', null);
      $('swArr').checked = false;
      Array.prototype.forEach.call(document.querySelectorAll('.qbtn'), function (x) { x.classList.remove('on'); });
      /* 装备改动和材料勾选都存在 state 里，重置必须连 state 一起清，否则重绘后又被回填回来 */
      state.eqEdits = {};
      state.mgSel = {};
      state.bpImport = null;
      $('bpPending').hidden = true;
      $('bpShareBox').hidden = true;
      $('bpCode').value = '';
      renderMatGrid();
      renderEquip();
      updateFoot();
      showMsg('已重置所有输入，存档本身一个字节都没动。', '');
    });

    /* 蓝图分享 / 导入 */
    $('bpExport').addEventListener('click', bpExport);
    $('bpShare').addEventListener('click', bpShare);
    $('bpCopy').addEventListener('click', function () {
      var t = $('bpShareText');
      t.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(t.value).then(function () {
          showMsg('分享码已复制。', 'ok');
        }, function () { showMsg('复制失败，请手动全选文本框里的分享码。', 'warn'); });
        return;
      }
      showMsg(ok ? '分享码已复制。' : '复制失败，请手动全选文本框里的分享码。', ok ? 'ok' : 'warn');
    });
    $('bpFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var name = f.name;
      var r = new FileReader();
      r.onload = function () { bpSetImport(new Uint8Array(r.result), name); };
      r.onerror = function () { showMsg('文件读不出来，换一个 .cai 试试。', 'warn'); };
      r.readAsArrayBuffer(f);
      this.value = '';
    });
    $('bpCodeLoad').addEventListener('click', function () {
      try {
        var cai = window.Blueprint.decodeShare($('bpCode').value);
        bpSetImport(cai, '分享码');
      } catch (e) { showMsg('<b>分享码读不了：</b>' + esc(e.message), 'warn'); }
    });
    $('bpTarget').addEventListener('change', function () {
      if (!state.bpImport) return;
      state.bpImport.i = +this.value;
      $('bpPending').innerHTML = bpPendingHtml(state.bpImport.i);
    });

    /* 预览 / 下载 */
    $('btnApply').addEventListener('click', openPreview);
    $('btnClosePreview').addEventListener('click', closePreview);
    $('btnCancelPreview').addEventListener('click', closePreview);
    /* 同一个按钮两个阶段：还没下载 → 开始下载；已经下载完 → 关弹层。
       这样用户不用在两个按钮之间找"到底该点哪个"。 */
    $('btnDownload').addEventListener('click', function () {
      if (state.dlDone) closePreview();
      else doDownload();
    });

    /* 无障碍：Esc 关弹层 */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('previewMask').classList.contains('hidden')) closePreview();
    });

    renderBlueprintPresets();
  }

  /* ---------- 精选蓝图工坊渲染 ---------- */
  function renderBlueprintPresets() {
    var grid = $('bpPresetGrid');
    if (!grid) return;
    var list = window.TOTK_BLUEPRINTS_PRESET || [];
    if (!list.length) {
      grid.innerHTML = '<div style="opacity:.6;font-size:12px">暂无预设蓝图</div>';
      return;
    }
    var html = '';
    list.forEach(function (p, idx) {
      html += '<div class="bp-pcard" data-idx="' + idx + '" style="background:#141920;border:1px solid #313b48;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span style="font-weight:600;font-size:13px;color:#e8edf4">' + esc(p.name) + '</span>' +
          '<span style="font-size:11px;background:#1e293b;color:#38bdf8;padding:2px 6px;border-radius:4px">' + esc(p.tag || '') + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:#94a3b8">' + esc(p.desc) + '</div>' +
        '<div style="font-size:11px;color:#fbbf24;margin-top:2px">💎 消耗矿石：' + p.costOre + ' 块</div>' +
        '<div style="font-size:11px;color:#64748b;line-height:1.4"><b>零件：</b>' + esc((p.parts || []).join('、')) + '</div>' +
        '<div style="display:flex;gap:6px;margin-top:auto;padding-top:6px">' +
          '<button type="button" class="btn primary bp-load-btn" data-idx="' + idx + '" style="flex:1;padding:5px 8px;font-size:11px">📥 填入存档</button>' +
          '<button type="button" class="btn bp-copy-btn" data-idx="' + idx + '" style="padding:5px 8px;font-size:11px">📋 复制码</button>' +
        '</div>' +
      '</div>';
    });
    grid.innerHTML = html;

    Array.prototype.forEach.call(grid.querySelectorAll('.bp-load-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var idx = +this.dataset.idx;
        var p = list[idx];
        if (!p) return;
        if (!state.bp || !state.bp.ok) {
          showMsg('请先在页面顶部【从游戏拉取】或【选择 progress.sav】加载存档，再填入蓝图。', 'warn');
          return;
        }
        try {
          var cai = window.Blueprint.decodeShare(p.shareCode);
          bpSetImport(cai, p.name);
          showMsg('已成功装载【' + p.name + '】至目标槽位，请在底部【预览并下载】写回存档。', 'ok');
        } catch (e) {
          showMsg('预设载入失败：' + e.message, 'warn');
        }
      });
    });

    Array.prototype.forEach.call(grid.querySelectorAll('.bp-copy-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var idx = +this.dataset.idx;
        var p = list[idx];
        if (!p) return;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(p.shareCode).then(function () {
            showMsg('【' + p.name + '】分享码已复制到剪贴板！', 'ok');
          }, function () {
            showMsg('复制失败，请手动在分享框复制。', 'warn');
          });
        }
      });
    });
  }

  if (!window.SaveWriter) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="padding:20px;color:#e0715f">核心库 save-writer.js 没加载成功，检查 ../js/save-writer.js 是否存在。</div>');
    return;
  }

  bind();
  updateFoot();
})();
