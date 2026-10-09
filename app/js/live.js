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

  /* V2.4.1 手机防息屏（双层 + 手势续命）：
   * ① Screen Wake Lock —— secure context（localhost / https 隧道）标准 API；Android Chrome /
   *    iOS 16.4+ Safari 生效，**无需用户手势**，页面加载即请求，回前台自动续（visibilitychange 可用）；
   * ② 静音视频保亮降级 —— 局域网 http（非 secure context）时 wakeLock 不可用 → 播放 keep_awake.mp4。
   *    ★ V2.4.1 修正：视频改 1px 可见（index.html），并借用户手势续播 —— Chrome Android 会挂起
   *      display:none 的隐藏视频（V2.4.0 版约 5 分钟息屏的可疑主因），且部分浏览器要求手势内 play。
   * 手势事件里再 enable 一次 = NoSleep.js 同款「必须在用户手势中激活」策略的兜底。 */
  (function wakeLockKeeper() {
    var vid = document.getElementById('keepAwake');
    var sentinel = null;
    function keepOn() {
      try {
        if ('wakeLock' in navigator && navigator.wakeLock) {
          navigator.wakeLock.request('screen').then(function (s) {
            sentinel = s;
            s.addEventListener('release', function () { sentinel = null; });
          }).catch(function () {});
        } else if (vid) {
          var p = vid.play();
          if (p && p.catch) p.catch(function () {});
        }
      } catch (e) {}
    }
    function pauseVid() { if (vid) { try { vid.pause(); } catch (e) {} } }
    /* 手势续命：每次 touch/click 都续播视频（防被浏览器掐）；sentinel 被释放时手势内补 request */
    function onGesture() {
      if (vid) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
      if (sentinel == null && 'wakeLock' in navigator) keepOn();
    }
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('touchstart', onGesture, { passive: true, capture: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') keepOn(); else pauseVid();
    });
    keepOn();
  })();

  /* V2.4.0 手机镜像：/botw/ 镜像页（手机/iPad 同 WiFi 访问，host=PC 局域网 IP，或 V2.4.1 https 隧道）
   * → 同源 location.origin；其余（PC 本机打开、在线站导航跳转 https://totk.yalin.site/?follow=1）→
   * 保持旧版写死 http://127.0.0.1:8766 跨域连本机 xnavi。
   * ★ 2026-10-09 真机实测回退：不能用「非本机即同源」判定 —— 导航跳转打开的是在线站，
   *   同源判定会把 API 指到在线站自身（无 /pos）→ 定位失效（红点错/不跟随）。
   *   回归最初逻辑：只有 /botw/ 镜像页走同源，其余一律 127.0.0.1:8766。
   * ★ V2.4.1：放开 protocol 限制（去掉了 === 'http:'）—— /botw/ 前缀只有 xnavi 静态托管会挂
   *   （在线站部署在根路径，不会命中），https 隧道（cloudflared）同样由 xnavi 托管 /botw/，
   *   必须同源，否则隧道页定位连到 127.0.0.1 失效。 */
  var LIVE_API = (location.pathname.indexOf('/botw/') === 0)
    ? location.origin : 'http://127.0.0.1:8766';
  var LS_FOLLOW = 'totkmap.live.follow.v1';
  var LS_AUTOLAYER = 'totkmap.live.autolayer.v1';
  var LS_ARRIVE = 'totkmap.live.arrive.v1';
  var LS_HOLD = 'totkmap.live.hold.v1';
  var ARRIVE_DEF = 30;                 // 到达阈值：游戏单位 ≈ m（可调）
  var HOLD_DEF = 2;                    // 到达停留自动标记：秒（0-10，0=到达即标，面板可调）
  var LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' };

  var map = null, T = null;
  var pos = { online: false, mx: null, my: null, gx: 0, gy: 0, gz: 0,
              layer: 18, verified: false, source: '-' };
  var target = null;                  // {x,y,name,type,layer} 服务端目标
  var follow = false, autoLayer = true, arriveM = ARRIVE_DEF, holdSec = HOLD_DEF, paused = false;
  var lastProgGen = null, lastProgFetch = 0;   // 存档进度代次（服务端 /pos.progressGen）
  var mirrorShown = false, lastLanUrl = '';      // V2.4.0 手机镜像面板状态 / 服务端 lanUrl
  var arrivedShown = false;
  var layerLock = null;                        // 手动层级锁定：null=自动，18/19/20=锁定该层（传送后恢复自动）
  var lastMX = null, lastMY = null;            // 上一采样位置（传送检测）
  var lastLayer = null;                        // 上一采样层（传送检测：层变化 = 传送/深穴，解除手动锁定）
  var autoLayerWarned = false;                 // 自动切层关闭提示（只提示一次）
  var teleportTS = 0;                           // 最近一次传送解锁时间戳（抑制紧随的切层 toast）

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
    if (target.layer && target.layer !== renderLayer()) return;
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
    var rl = renderLayer();
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
          LAYER_NAME[rl] + (layerLock != null ? ' 🔒' : '') + ' · 高 ' + Math.round(pos.gz)
        : (pos.online ? '位置 --（等待玩家位置）' : '位置 --（未连接定位服务）');
      if (posEl.textContent !== s) posEl.textContent = s;
    }
    var tEl = $('npTargetRow');
    if (tEl) {
      var ts = '目标：未设置';
      if (target && target.name) {
        var d = distToTarget();
        var cross = (target.layer && target.layer !== rl);
        ts = '目标：' + target.name + (target.type ? '（' + target.type + '）' : '');
        if (cross) ts += ' · 在' + LAYER_NAME[target.layer] + '层，点击左侧层按钮切换';
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

  /* ---------------- 轮询 ----------------
   * ★ 定位服务（live-python / xnavi）没启动时，浏览器会在控制台里
   *   每 600ms 刷一条红色的 GET /pos  ERR_CONNECTION_REFUSED，
   *   刷一整天，人看着以为页面坏了。
   *
   *   这里**只改探测方式与节奏，不改对接逻辑**：
   *     - 拿到过服务之前用 fetch 的 no-cors 模式探测。
   *       no-cors 的网络错误 Chrome 不打控制台（opaque 响应，status=0），
   *       但 resolve/reject 语义与普通 fetch 一致，reachable 判定完全相同。
   *     - 连不上时退避到 5s 一次，不再高频刷。
   *     - 一旦成功过（sawOnline），恢复 600ms 并走原来的普通 fetch，
   *       这样 /pos 的字段解析、进度代次、传送检测等逻辑一行都没动。
   *
   *   反过来用「HEAD 请求探测 + GET 正常取」也行，但那样多发一次请求；
   *   no-cors 一次搞定，且失败不落控制台。
   */
  var sawOnline = false;       // 本次会话是否成功连上过服务
  var offlineSince = 0;        // 首次离线时刻
  var probeFail = 0;           // 连续失败次数（用于退避）
  var POLL_MS = 600;           // 在线时的轮询间隔（原值）
  var OFFLINE_MAX_MS = 5000;   // 离线时的退避间隔

  async function fetchPos() {
    /* 已连上过 → 走普通 fetch（拿完整 JSON，字段齐全）。
       ★ 这条路径必须保持原样，否则定位/进度/传送检测会失效。 */
    if (sawOnline) {
      var r = await fetch(LIVE_API + '/pos?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    }
    /* 从未连上过 → no-cors 静默探测，避免控制台刷红 */
    var r2 = await fetch(LIVE_API + '/pos?t=' + Date.now(), {
      cache: 'no-store', mode: 'no-cors'
    });
    if (!r2 || r2.type !== 'opaque' && !r2.ok) throw new Error('probe failed');
    /* opaque 响应读不出 body —— 这时按「可能已上线」处理，
       下一轮切回普通 fetch 就能拿到真数据。 */
    return { __opaque: true };
  }

  async function poll() {
    var p = null;
    var reachable = true;
    try {
      var got = await fetchPos();
      if (got && got.__opaque) {
        /* 探测通了但拿不到内容 → 先标记在线并立刻用普通 fetch 取一次 */
        reachable = true;
        try {
          var real = await fetch(LIVE_API + '/pos?t=' + Date.now(), { cache: 'no-store' });
          if (real.ok) p = await real.json();
          else { p = null; reachable = false; }
        } catch (e2) { p = null; reachable = false; }
      } else {
        p = got;
      }
    } catch (e) { p = null; reachable = false; }

    if (reachable) {
      if (!sawOnline) { sawOnline = true; offlineSince = 0; }
      probeFail = 0;
    } else {
      /* 服务不可达：退避，别再高频刷 */
      probeFail++;
      /* sawOnline 不复位 —— xnavi 关掉后重新打开要能自动接回去，
         所以不做「一旦离线就永久降级」的判断。 */
    }

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

      /* 传送检测：相邻采样位移 > 1000 游戏单位，或层变化（天空↔地上↔地底）= 传送/深穴/重启，
         解除层级锁定（重启后 layerLock 残留而位移<1000 时，层变化是更可靠的信号） */
      if (layerLock != null && lastMX != null) {
        var dd = Math.sqrt((pos.mx - lastMX) * (pos.mx - lastMX) + (pos.my - lastMY) * (pos.my - lastMY));
        var lc = (lastLayer != null && pos.layer !== lastLayer);
        if (dd > 1000 || (lc && layerLock !== pos.layer)) {
          layerLock = null;
          teleportTS = Date.now();
          toast('检测到传送/层变化，已恢复自动层级切换');
          updateLockUI();
        }
      }
      lastMX = pos.mx; lastMY = pos.my;
      lastLayer = pos.layer;

      var key = Math.round(p.mx) + ',' + Math.round(p.my);
      if (key !== lastPosKey) {
        lastPosKey = key;
        trail.push([p.mx, p.my]);
        if (trail.length > 600) trail.shift();
        if (follow && !paused) followCenter();
      }
      if (!autoLayer && !autoLayerWarned) {
        autoLayerWarned = true;
        toast('提示：自动切层已关闭，不会跟随玩家切换层级');
      }
      autoSwitchLayer();
    } else {
      offlineStreak++;
      lastPosKey = null;
    }
    /* V2.4.0 手机镜像：服务端 lanUrl 变化 → 更新面板；
       ★ 2026-10-09：面板开着时，服务不可达 / 未定位 → 降级提示「未检测到本地定位服务」
       （原逻辑只在 URL 变化时更新，xnavi 关闭后面板仍挂旧链接，用户无感知） */
    if (mirrorShown) {
      var lanOk = !!(p && p.ok && typeof p.lanUrl === 'string' && p.lanUrl);
      if (lanOk) {
        if (p.lanUrl !== lastLanUrl) { lastLanUrl = p.lanUrl; renderMirror(p.lanUrl, false); }
      } else if (lastLanUrl !== '') {
        lastLanUrl = '';
        renderMirror('', true);
      }
    }
    /* 存档进度代次：游戏内保存 → 存档 mtime 变化 → progressGen 变化 → 自动重新拉取进度
       （BOTWmap 同机制：服务自动定位存档，网页无需上传；服务可达即检测，不依赖定位成功） */
    if (p && typeof p.progressGen === 'string' && p.progressGen && p.progressGen !== lastProgGen) {
      lastProgGen = p.progressGen;
      var _n = Date.now();
      if (_n - lastProgFetch > 3000 && window.TOTK_APP && window.TOTK_APP.syncProgressFromServer) {
        lastProgFetch = _n;
        window.TOTK_APP.syncProgressFromServer();
      }
    }
    tickArrival();
    redraw();
    setStatus();
  }

  /* ---------------- 手动层级锁定（V1.8.1）：自动切层 + 手动接管，传送后恢复 ---------------- */
  function renderLayer() {
    return (layerLock != null) ? layerLock : pos.layer;
  }
  function updateLockUI() {
    var sw = document.getElementById('layerSwitch');
    if (!sw) return;
    Array.prototype.forEach.call(sw.querySelectorAll('button'), function (b) {
      b.classList.toggle('locked', Number(b.getAttribute('data-layer')) === layerLock);
    });
  }
  function setLayerLock(id) {
    if (layerLock === id) {
      layerLock = null;
      toast('已解除层级锁定，恢复自动切换');
    } else {
      layerLock = id;
      toast('已锁定' + (LAYER_NAME[id] || id) + '层（传送后恢复自动）');
    }
    lastDrawKey = '';
    redraw();
    setStatus();
    updateLockUI();
  }

  /* 跟随玩家 Z 自动切层（天空/地上/地底），不跨层 */
  function autoSwitchLayer() {
    if (paused || !autoLayer || !pos.online || !pos.located) return;
    if (layerLock != null) return;   // 手动锁定期间不自动切层
    if (pos.layer && pos.layer !== T.state.layer) {
      T.switchLayer(pos.layer, true);
      if (Date.now() - teleportTS > 2000) {
        toast('已自动切换到' + (LAYER_NAME[pos.layer] || pos.layer) + '层');
      }
      /* 切层会重置地图视野：传送+切层时 followCenter 在切层前已执行（旧层视野），
         这里切层成功后立即再跟随一次，画面才落到新层红点位置 */
      if (follow && !paused) followCenter();
    }
  }

  /* 到达提示：距离 ≤ 阈值 判定「已到达」（仅为提示值，不参与算法） */
  function tickArrival() {
    if (paused || !pos.online || !pos.located || !target) { arrivedShown = false; return; }
    if (target.layer && target.layer !== renderLayer()) { arrivedShown = false; return; }
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

  /* ---------------- 视图跟随（V1.8.3：范围跟随，防持续动画晕眩/卡顿） ---------------- */
  /* 单次定位：居中玩家，保持缩放 */
  function centerOnPlayer() {
    if (pos.mx == null) return;
    map.flyTo([pos.mx, pos.my], Math.max(map.getZoom(), 6), { duration: 0.6 }); // V2.4.0: 800%
  }
  /* 跟随（V2.4.0 方案2+3，2026-10-09 老大拍板）：
   *   死区 30% → 10%（红点偏离视口中心 10% 即拉回，原 30% 太迟钝）；
   *   panTo 300ms 平滑动画 = 软跟随（避免 BOTW 式每拍硬居中跳变）。 */
  function followCenter() {
    if (pos.mx == null) return;
    var cp = map.latLngToContainerPoint([pos.mx, pos.my]);
    var cc = map.latLngToContainerPoint(map.getCenter());
    var lim = Math.min(map.getSize().x, map.getSize().y) * 0.1;
    if (Math.abs(cp.x - cc.x) > lim || Math.abs(cp.y - cc.y) > lim) {
      map.panTo([pos.mx, pos.my], { animate: true, duration: 0.3 });
    }
  }
  function setLocateBtns() {
    if ($('npLocate')) $('npLocate').classList.toggle('active', follow);
    if ($('zoomLocate')) $('zoomLocate').classList.toggle('active', follow);
  }
  function toggleFollow() {
    if (pos.mx == null) { toast('尚未获取玩家位置'); return false; }
    follow = !follow;
    lsSet(LS_FOLLOW, follow ? '1' : '0');
    if ($('npFollow')) $('npFollow').checked = follow;
    if (follow) centerOnPlayer();
    setLocateBtns();
    toast(follow ? '已开启：视图跟随玩家（超范围时跟随）' : '已关闭视图跟随');
    return follow;
  }
  /* 拖动地图 = 手动看别处 → 自动关闭跟随 */
  function bindFollowDrag() {
    if (!map) return;
    map.on('dragstart', function () {
      if (!follow) return;
      follow = false;
      lsSet(LS_FOLLOW, '0');
      if ($('npFollow')) $('npFollow').checked = false;
      setLocateBtns();
    });
  }
  /* 导航结束广播：材料/探索队列同步停止（防队列状态残留，防重入：队列 stop 先置 running=false） */
  function notifyQueueEnd() {
    if (window.MAT_AUTO && window.MAT_AUTO.onNavEnd) window.MAT_AUTO.onNavEnd();
    if (window.EXPLORE_AUTO && window.EXPLORE_AUTO.onNavEnd) window.EXPLORE_AUTO.onNavEnd();
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
    notifyQueueEnd();
  }

  /* ---------------- 手机镜像面板（V2.4.0，BOTW V1.5.0 同款） ---------------- */
  function toggleMirror() {
    var b = $('btnMirror');
    var el = $('mirrorPanel');
    if (!b || !el) return;
    if (mirrorShown) { hideMirror(); return; }
    mirrorShown = true;
    el.classList.remove('hidden');
    b.classList.add('on');
    if (!lastLanUrl) toast('未检测到本地定位服务，请先启动 TOTKnavi');
  }
  function hideMirror() {
    mirrorShown = false;
    var el = $('mirrorPanel');
    var b = $('btnMirror');
    if (el) el.classList.add('hidden');
    if (b) b.classList.remove('on');
  }
  function renderMirror(url, offline) {
    var el = $('mirrorPanel');
    if (!el) return;
    var input = $('mirrorUrl');
    var img = $('mirrorQr');
    var hint = $('mirrorHint');
    if (!input || !img) return;
    if (!url || offline) {
      input.value = '';
      img.removeAttribute('src');
      img.style.display = 'none';
      if (hint) hint.textContent = '未检测到本地定位服务，请先启动 TOTKnavi';
      return;
    }
    input.value = url;
    img.style.display = '';
    img.onerror = function () { img.style.display = 'none'; };
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=6&data=' + encodeURIComponent(url);
    if (hint) hint.textContent = '手机打开后：红点跟随 / 点图标导航 / 收集进度与电脑一致';
  }
  function copyMirrorUrl() {
    var input = $('mirrorUrl');
    if (!input || !input.value) { toast('暂无可复制的链接'); return; }
    input.focus();
    input.select();
    input.setSelectionRange(0, 99999);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    toast(ok ? '链接已复制 · 手机需与电脑在同一 WiFi' : '复制失败，请长按选择复制');
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

    /* V2.4.0 手机镜像面板按钮 */
    var bMir = $('btnMirror');
    if (bMir) bMir.addEventListener('click', toggleMirror);
    var bClose = $('mirrorClose');
    if (bClose) bClose.addEventListener('click', hideMirror);
    var bCopy = $('mirrorCopy');
    if (bCopy) bCopy.addEventListener('click', copyMirrorUrl);

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
    var iHold = $('npHold');
    if (iHold) {
      iHold.value = holdSec;
      iHold.addEventListener('change', function () {
        var v = parseInt(this.value, 10);
        if (isNaN(v) || v < 0) v = HOLD_DEF;
        if (v > 10) v = 10;
        this.value = v; holdSec = v;
        lsSet(LS_HOLD, String(v));
        toast('停留自动标记已设为 ' + v + ' 秒（0=到达即标记）');
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
        setLocateBtns();
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
    if (bLoc) bLoc.addEventListener('click', toggleFollow);
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
    /* V1.9.2 URL 上下文（xnavi 导航程序打开地图时带参，见《BOTWmap导航配合接口协议 v1》）：
     *   ?follow=1 → 导航启动，强制开启视图跟随并持久化（用户手动设置让位于导航启动意图）
     *   无 follow 参数 → 完全尊重本地持久化设置（手动打开行为不变） */
    try {
      var _sp = new URLSearchParams(location.search);
      if (_sp.get('follow') === '1') {
        follow = true;
        lsSet(LS_FOLLOW, '1');
        /* V2.4.0：导航程序跳转地图 → 直接放大到 800%（z6）并跟随（原 400% 太小）。
           ★ 用 setView(animate:false) 而非 setZoom：setZoom 走缩放动画，会被 poll 的
           panTo 打断导致 zoom 卡死在中途值（实测日志 after z=3 / 5.5），必须瞬时生效 */
        /* V2.4.0：导航程序跳转地图 → 直接放大到 800%（z6）并跟随（原 400% 太小）。
           ★ 必须延后到 app.js 初始化 zoom 动画结束后再放大（2026-10-09 实测定位）：
             app.js 初始化 setView(CENTER,3) 走 Leaflet 缩放动画，动画进行中
             _animatingZoom=true → 此时任何 setZoom/setView 都被 _tryAnimatedZoom 的
             "已在动画"分支吞掉 → zoom 卡 3（400%），这就是此前手动点 2 次才 800% 的根因。
           ★ 放大用 setView(animate:false) 而非 setZoom：setZoom 的缩放动画同样会被
             poll 的 panTo 打断卡死在中途值。
           ★ 同时直接 panTo 玩家居中（avoid poll 首拍被吞导致的 center 不动）。 */
        setTimeout(function () {
          try {
            if (map._animatingZoom) { map._stop(); map._animatingZoom = false; map._tempFireZoomEvent = false; }
          } catch (e) {}
          if (map && map.setView) map.setView(map.getCenter(), 6, { animate: false });
          if (map && map.panTo && pos.mx != null && pos.my != null) {
            map.panTo([pos.mx, pos.my], { animate: false });
          }
        }, 400);
      }
    } catch (e) {}
    try { autoLayer = lsGet(LS_AUTOLAYER, '1') !== '0'; } catch (e) {}
    var a = parseInt(lsGet(LS_ARRIVE, String(ARRIVE_DEF)), 10);
    arriveM = (isNaN(a) || a < 1) ? ARRIVE_DEF : Math.min(a, 500);
    var h = parseInt(lsGet(LS_HOLD, String(HOLD_DEF)), 10);
    holdSec = (isNaN(h) || h < 0) ? HOLD_DEF : Math.min(h, 10);

    buildPanel();
    setLocateBtns();
    bindFollowDrag();
    /* 自调度轮询（取代 setInterval）：离线时自动退避到 5s，
   ★ 这样 xnavi 没启动也不会一直高频打 8766 端口。
   用 setInterval 的话离线期间永远是 600ms，节流无从谈起。
   poll 内部即使抛错也不能断链，所以 catch 后仍继续排下一次。 */
    function scheduleNext() {
      var delay = probeFail > 0 ? OFFLINE_MAX_MS : POLL_MS;
      /* 有连续失败时再往后推一点，避免刚关 xnavi 时的抖动 */
      if (probeFail > 3) delay = Math.min(OFFLINE_MAX_MS * 2, 10000);
      setTimeout(function () {
        var pr;
        try { pr = poll(); } catch (e) { pr = Promise.resolve(); }
        Promise.resolve(pr).catch(function () { /* 单次失败不影响后续 */ })
          .then(scheduleNext);
      }, delay);
    }
    scheduleNext();
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
      endNav: endNav,
      /* V1.8.0 M3: 探索队列需要的位置/到达状态 */
      pos: function () { return { online: pos.online, located: pos.located, mx: pos.mx, my: pos.my, layer: pos.layer, verified: pos.verified }; },
      arrived: function () { return arrivedShown; },
      arriveM: function () { return arriveM; },
      holdSec: function () { return holdSec; },
      paused: function () { return paused; },
      toggleFollow: toggleFollow,
      setLocateBtns: setLocateBtns,
      /* V1.8.1: 手动层级锁定 */
      setLayerLock: setLayerLock,
      lockLayer: function () { return layerLock; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
