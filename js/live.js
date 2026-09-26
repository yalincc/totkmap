/* ============ TOTKMAP · 实时定位 + 导航面板（V1.8.0 M2） ============
 *
 * 对接本地定位服务（live-python，端口 8766）：
 *   GET  /pos     玩家位置 + 目标（600ms 轮询）
 *   POST /target  设置 / 清除导航目标（含 layer，判断是否跨层）
 *
 * 坐标：/pos 的 mx/my = Leaflet latlng = (Z, X)；Z 北负南正（与游戏地图一致），X 东正
 * 能力：
 *   1. 玩家红点 + 移动轨迹（会话内，不保存路线）
 *   2. 目标金色引导线 + 距离（游戏单位 ≈ m）
 *   3. 跟随玩家 Z 自动切层（天空 / 地上 / 地底），不跨层
 *   4. 导航面板：状态 / 目标 / 距离 / 到达提示 / 暂停 / 结束 / 清除目标 /
 *      到达阈值（可调）/ 自动切层开关 / 视图跟随
 *   5. 服务离线时静默降级，普通地图功能不受影响
 */
(function () {
  'use strict';

  var LIVE_API = 'http://127.0.0.1:8766';
  var LS_FOLLOW = 'totkmap.live.follow.v1';
  var LS_AUTOLAYER = 'totkmap.live.autolayer.v1';
  var LS_ARRIVE = 'totkmap.live.arrive.v1';
  var ARRIVE_DEF = 30;                 // 到达阈值：游戏单位 ≈ m（可调）
  var LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' };

  var map = null, T = null;
  var pos = { online: false, mx: null, my: null, gx: 0, gy: 0, gz: 0,
              layer: 18, verified: false, source: '-' };
  var target = null;                  // {x,y,name,type,layer} 服务端目标
  var follow = false, autoLayer = true, arriveM = ARRIVE_DEF, paused = false;
  var arrivedShown = false;

  var trail = [];
  var lastPosKey = null;
  var lastDrawKey = '';
  var offlineStreak = 0;              // 连续离线轮询数（≥2 才清实时图层，防抖动）

  var playerMark = null, trailLine = null;
  var guideLine = null, targetRing = null, distLabel = null;

  /* ---------------- 面板元素 ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var panel = null;

  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v === null ? def : v; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- 地图元素 ---------------- */
  function ensurePlayerMark() {
    if (playerMark) return;
    playerMark = L.circleMarker([0, 0], {
      pane: 'markerPane', radius: 5, color: '#fff', weight: 2,
      fillColor: '#ff3b3b', fillOpacity: 0.95, interactive: false
    });
    playerMark.addTo(map);
  }
  function ensureTrail() {
    if (trailLine) return;
    trailLine = L.polyline([], { pane: 'overlayPane', color: 'rgba(255,90,90,.5)',
      weight: 2, dashArray: '5,4', interactive: false });
    trailLine.addTo(map);
  }
  function drawGuide() {
    if (guideLine) { map.removeLayer(guideLine); guideLine = null; }
    if (targetRing) { map.removeLayer(targetRing); targetRing = null; }
    if (distLabel) { map.removeLayer(distLabel); distLabel = null; }
    if (!target || !pos.online || pos.mx == null) return;
    // 不跨层：目标在其他层时只提示，不画误导线
    if (target.layer && target.layer !== pos.layer) return;
    guideLine = L.polyline([[pos.mx, pos.my], [target.x, target.y]], {
      pane: 'overlayPane', color: 'rgba(255,183,3,.92)', weight: 1.6, dashArray: '7,5', interactive: false
    });
    guideLine.addTo(map);
    targetRing = L.circleMarker([target.x, target.y], {
      pane: 'markerPane', radius: 7, color: '#ffb703', weight: 2,
      fillColor: 'rgba(255,183,3,.28)', fillOpacity: 1, interactive: false
    });
    targetRing.addTo(map);
    var d = Math.round(distToTarget());
    distLabel = L.marker([pos.mx, pos.my], {
      pane: 'markerPane', interactive: false, zIndexOffset: 2000,
      icon: L.divIcon({ className: '', html: '<div class="lv-dist">' + d + 'm</div>',
        iconSize: [70, 16], iconAnchor: [35, -8] })
    });
    distLabel.addTo(map);
  }
  function distToTarget() {
    if (!target || pos.mx == null) return null;
    return Math.sqrt((target.x - pos.mx) * (target.x - pos.mx) +
                     (target.y - pos.my) * (target.y - pos.my));
  }

  /* ---------------- 状态 / 面板 ---------------- */
  function setStatus() {
    if (!panel) return;
    var el = $('npStatus');
    if (!el) return;
    var txt, cls;
    if (!pos.online) { txt = '● 离线'; cls = 'off'; }
    else if (!pos.located) { txt = '◐ 定位中…（进入游戏后恢复）'; cls = 'warn'; }
    else if (!pos.verified) { txt = '◐ 定位中… 移动角色确认'; cls = 'warn'; }
    else { txt = '● 已定位'; cls = 'on'; }
    if (paused) { txt = '⏸ 已暂停'; cls = 'paused'; }
    if (el.textContent !== txt || el.className.indexOf(cls) < 0) {
      el.textContent = txt;
      el.className = 'np-status ' + cls;
    }
    var posEl = $('npPos');
    if (posEl) {
      var s = pos.located
        ? '位置 (' + Math.round(pos.mx) + ', ' + Math.round(pos.my) + ') · ' +
          LAYER_NAME[pos.layer] + ' · 高 ' + Math.round(pos.gz)
        : (pos.online ? '位置 --（等待玩家位置）' : '位置 --（未连接定位服务）');
      if (posEl.textContent !== s) posEl.textContent = s;
    }
    var tEl = $('npTargetRow');
    if (tEl) {
      var ts = '目标：未设置';
      if (target && target.name) {
        var d = distToTarget();
        var cross = (target.layer && target.layer !== pos.layer);
        ts = '目标：' + target.name + (target.type ? '（' + target.type + '）' : '');
        if (cross) ts += ' · 在' + LAYER_NAME[target.layer] + '层，不跨层';
        else if (d != null) ts += ' · 距离 ' + Math.round(d) + 'm';
      }
      if (tEl.textContent !== ts) tEl.textContent = ts;
    }
    var aEl = $('npArrive');
    if (aEl) aEl.classList.toggle('hidden', !arrivedShown || paused);
  }

  function toast(msg) {
    if (T && T.state) {
      // 复用 app.js 的 toast
      var t = $('toast');
      if (t) { t.innerHTML = msg; t.classList.remove('hidden'); clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2400); return; }
    }
    alert(msg);
  }
  var toastTimer = null;

  /* ---------------- 轮询 ---------------- */
  async function poll() {
    var p = null;
    var reachable = true;
    try {
      var r = await fetch(LIVE_API + '/pos?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) p = await r.json();
    } catch (e) { p = null; reachable = false; }

    pos.online = reachable;                 // 服务可达
    pos.located = !!(p && p.ok);            // 已拿到有效玩家位置
    if (pos.located) {
      offlineStreak = 0;
      pos.mx = p.mx; pos.my = p.my;
      pos.gx = p.gx; pos.gy = p.gy; pos.gz = p.gz;
      pos.layer = p.layer || 18;
      pos.verified = !!p.verified;
      pos.source = p.source || '-';
      target = (p.target && typeof p.target.x === 'number') ? p.target : null;
      arrivedShown = arrivedShown && (target != null);

      var key = Math.round(p.mx) + ',' + Math.round(p.my);
      if (key !== lastPosKey) {
        lastPosKey = key;
        trail.push([p.mx, p.my]);
        if (trail.length > 600) trail.shift();
        if (follow && !paused) centerOnPlayer();
      }
      autoSwitchLayer();
    } else {
      offlineStreak++;
      lastPosKey = null;
    }
    tickArrival();
    redraw();
    setStatus();
  }

  /* 跟随玩家 Z 自动切层（天空/地上/地底），不跨层 */
  function autoSwitchLayer() {
    if (paused || !autoLayer || !pos.online || !pos.located) return;
    if (pos.layer && pos.layer !== T.state.layer) {
      T.switchLayer(pos.layer, true);
      toast('已自动切换到' + (LAYER_NAME[pos.layer] || pos.layer) + '层');
    }
  }

  /* 到达提示：距离 ≤ 阈值 判定「已到达」（仅为提示值，不参与算法） */
  function tickArrival() {
    if (paused || !pos.online || !pos.located || !target) { arrivedShown = false; return; }
    if (target.layer && target.layer !== pos.layer) { arrivedShown = false; return; }
    var d = distToTarget();
    if (d == null) return;
    if (arrivedShown && d > arriveM * 1.5) arrivedShown = false;
    if (d <= arriveM && !arrivedShown) {
      arrivedShown = true;
      toast('已到达：' + (target.name || '目标') + '（阈值 ' + arriveM + 'm）');
    }
  }

  /* 重绘：轨迹 / 红点 / 引导线，仅在关键状态变化时执行 */
  function redraw() {
    var dk = (pos.online ? '1' : '0') + (pos.verified ? 'v' : '') +
             (pos.mx != null ? Math.round(pos.mx / 2) + ':' + Math.round(pos.my / 2) : '') +
             (target ? 't' : '') + (arrivedShown ? 'a' : '') +
             (pos.layer || '');
    if (dk === lastDrawKey) return;
    lastDrawKey = dk;

    // 离线/未定位：连续 2 次失败后清空实时图层，避免残留假点
    if (!pos.located || pos.mx == null) {
      if (offlineStreak < 2) return;
      [playerMark, trailLine, guideLine, targetRing, distLabel].forEach(function (ly) {
        if (ly) { map.removeLayer(ly); }
      });
      playerMark = trailLine = guideLine = targetRing = distLabel = null;
      trail = [];
      return;
    }

    ensureTrail();
    if (trail.length) trailLine.setLatLngs(trail);

    ensurePlayerMark();
    playerMark.setLatLng([pos.mx, pos.my]);
    var ok = pos.verified;
    playerMark.setRadius(ok ? 7 : 5);
    playerMark.setStyle({ fillOpacity: ok ? 0.95 : 0.55 });
    drawGuide();
  }

  /* ---------------- 视图跟随 ---------------- */
  function centerOnPlayer() {
    if (pos.mx == null) return;
    map.flyTo([pos.mx, pos.my], Math.max(map.getZoom(), 5), { duration: 0.6 });
  }

  /* ---------------- 导航目标 ---------------- */
  function navigate(opts) {
    if (!pos.online) { toast('实时定位服务未连接（live-python 未启动）'); return false; }
    if (!pos.located) { toast('尚未获取玩家位置（请先进入游戏可操作）'); return false; }
    var body = {
      name: opts.name || '目标', x: opts.x, y: opts.y,
      type: opts.type || '', layer: (opts.layer != null ? opts.layer : null)
    };
    fetch(LIVE_API + '/target', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function () {
      target = body;
      arrivedShown = false;
      lastDrawKey = '';
      redraw();
      setStatus();
      toast('已设置导航：' + body.name);
    }).catch(function () { toast('导航设置失败（服务未连接）'); });
    return true;
  }

  function clearNav() {
    fetch(LIVE_API + '/target', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true })
    }).catch(function () {});
    target = null; arrivedShown = false; lastDrawKey = '';
    drawGuide(); setStatus();
  }

  /* 导航按钮切换：同一目标再次点击 = 停止导航 */
  function toggleNav(opts) {
    if (!pos.online) { toast('实时定位服务未连接（live-python 未启动）'); return 'offline'; }
    if (!pos.located) { toast('尚未获取玩家位置（请先进入游戏可操作）'); return 'offline'; }
    var cur = target;
    if (cur && cur.name === (opts.name || '') && cur.x === opts.x && cur.y === opts.y) {
      clearNav();
      toast('已停止导航：' + (opts.name || '目标'));
      return 'stopped';
    }
    navigate(opts);
    return 'navigating';
  }
  function currentTarget() { return target; }

  function endNav() {
    paused = false;
    if ($('npPause')) $('npPause').textContent = '暂停';
    clearNav();
    toast('已结束导航');
  }

  function togglePause() {
    paused = !paused;
    if ($('npPause')) $('npPause').textContent = paused ? '继续' : '暂停';
    if (paused) arrivedShown = false;
    setStatus();
    toast(paused ? '已暂停自动行为（切层/到达提示）' : '已继续');
  }

  /* ---------------- 面板装配 ---------------- */
  function buildPanel() {
    panel = $('navPanel');
    if (!panel) return;

    var btn = $('navBtn');
    if (btn) btn.addEventListener('click', function () {
      var h = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !h);
      btn.classList.toggle('active', h);
    });

    var mini = $('npToggle');
    if (mini) mini.addEventListener('click', function () {
      var b = $('npBody');
      var collapsed = b.classList.toggle('collapsed');
      mini.textContent = collapsed ? '＋' : '－';
    });

    var iArr = $('npArriveInput');
    if (iArr) {
      iArr.value = arriveM;
      iArr.addEventListener('change', function () {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 1) v = ARRIVE_DEF;
        if (v > 500) v = 500;
        this.value = v; arriveM = v;
        lsSet(LS_ARRIVE, String(v));
        arrivedShown = false;
        toast('到达阈值已设为 ' + v + ' 游戏单位');
      });
    }
    var cAuto = $('npAutoLayer');
    if (cAuto) {
      cAuto.checked = autoLayer;
      cAuto.addEventListener('change', function () {
        autoLayer = this.checked;
        lsSet(LS_AUTOLAYER, autoLayer ? '1' : '0');
        toast(autoLayer ? '已开启：跟随玩家自动切层' : '已关闭自动切层');
      });
    }
    var cFol = $('npFollow');
    if (cFol) {
      cFol.checked = follow;
      cFol.addEventListener('change', function () {
        follow = this.checked;
        lsSet(LS_FOLLOW, follow ? '1' : '0');
        if (follow && pos.mx != null) centerOnPlayer();
        toast(follow ? '已开启：视图跟随玩家' : '已关闭视图跟随');
      });
    }
    var bPause = $('npPause');
    if (bPause) bPause.addEventListener('click', togglePause);
    var bEnd = $('npEnd');
    if (bEnd) bEnd.addEventListener('click', endNav);
    var bClear = $('npClear');
    if (bClear) bClear.addEventListener('click', function () { clearNav(); toast('已清除目标'); });
    var bLoc = $('npLocate');
    if (bLoc) bLoc.addEventListener('click', function () {
      if (pos.mx == null) { toast('尚未获取玩家位置'); return; }
      centerOnPlayer();
    });
    /* 面板可拖动（按住头部；收起按钮除外），拖动后转为 left/top 定位 */
    var head = panel.querySelector('.np-head');
    if (head) {
      var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      function down(e) {
        if (e.target.closest && e.target.closest('.np-min')) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        ox = panel.offsetLeft; oy = panel.offsetTop;
        if (!panel.style.top || panel.style.top === 'auto') {
          oy = window.innerHeight - panel.offsetHeight - 52;
        }
      }
      function move(e) {
        if (!dragging) return;
        var left = Math.max(0, Math.min(ox + e.clientX - sx, window.innerWidth - panel.offsetWidth));
        var top = Math.max(0, Math.min(oy + e.clientY - sy, window.innerHeight - 40));
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.bottom = 'auto';
      }
      function up() { dragging = false; }
      head.addEventListener('mousedown', down);
      head.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches[0]) down(e.touches[0]);
      }, { passive: true });
      document.addEventListener('mousemove', move);
      document.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches[0]) move(e.touches[0]);
      }, { passive: true });
      document.addEventListener('mouseup', up);
      document.addEventListener('touchend', up);
    }
    setStatus();
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    map = window.TOTK.map;
    T = window.TOTK;
    try { follow = lsGet(LS_FOLLOW, '0') !== '0'; } catch (e) {}
    try { autoLayer = lsGet(LS_AUTOLAYER, '1') !== '0'; } catch (e) {}
    var a = parseInt(lsGet(LS_ARRIVE, String(ARRIVE_DEF)), 10);
    arriveM = (isNaN(a) || a < 1) ? ARRIVE_DEF : Math.min(a, 500);

    buildPanel();
    setInterval(poll, 600);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) poll();
    });
    poll();
    window.LIVENAV = {
      online: function () { return pos.online; },
      navigate: navigate,
      toggleNav: toggleNav,
      currentTarget: currentTarget,
      clearNav: clearNav,
      centerOnPlayer: centerOnPlayer,
      endNav: endNav
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
