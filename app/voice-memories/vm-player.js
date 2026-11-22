/* ============================================================================
 * TOTKmap · 声之记忆（Voice Memories · 240 条）独立可插拔模块（极简版）
 * ----------------------------------------------------------------------------
 * 设计原则（完全对齐 app/voice/ 独立模块化范式）：
 *   1. 无大列表抽屉、无右上角悬浮块：底栏「🎙 声之记忆」一键开/关当前层标点，
 *      点击标点直接弹出极简三角色单语剧情卡（中文只显中文，英文只显英文）。
 *   2. 存档安全隔离：已听进度独立存入 localStorage('totkmap.vm.done.v1')，
 *      绝不被 progress.sav 覆盖清空；设置页「语音」Tab 内提供开关与导出。
 *   3. 实机跑图 20m 自动共鸣：通过 live.js 软钩子 feedPos() 触发，
 *      内置手机首次触摸音频解锁（Autoplay Unlock），跑图放桌上也能自动出声。
 *   4. 三级音频回退：本地 voice-memories/audio/ → 线上导航站 CDN → 系统 TTS 兜底，
 *      手机局域网映射无需在离线包里塞大音频也能直接流式听全套角色配音。
 *   5. 与 VoiceNav 无缝互斥：播放剧情时自动暂停导航播报，播完恢复。
 * ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceMemories = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LS_DONE = 'totkmap.vm.done.v1';
  var LS_CFG = 'totkmap.vm.cfg.v1';
  var DEFAULT_ONLINE_AUDIO_BASE = 'https://totk.yalin.site/voice-memories/audio/';
  var TRIGGER_COOLDOWN_MS = 18000;

  var DEFAULT_CFG = {
    layerVisible: false,      // 地图上是否显示声之记忆标点
    autoTrigger: true,        // 实机跑图接近时自动共鸣播报
    triggerDist: 35,          // 触发半径：15(近/仿官方) | 35(中/推荐) | 60(远/路过即响)
    hideDonePins: false,      // 隐藏已听标点
    audioBase: ''             // 可选自定义音频前缀（留空则自动本地 -> 线上站回退）
  };

  var ROLE_META = {
    rauru: {
      zh: '劳鲁', en: 'Rauru', layer: 20, layerZh: '天空', layerEn: 'Sky',
      icon: '🌀', pitch: 0.86, rate: 0.96
    },
    zelda: {
      zh: '塞尔达公主', en: 'Princess Zelda', layer: 18, layerZh: '地上', layerEn: 'Surface',
      icon: '✦', pitch: 1.16, rate: 0.98
    },
    kohga: {
      zh: '可盖大人', en: 'Master Kohga', layer: 19, layerZh: '地下', layerEn: 'Depths',
      icon: '🎭', pitch: 1.02, rate: 1.08
    }
  };

  var DATA = [];
  var BY_ID = {};
  var doneMap = loadJson(LS_DONE, {});
  var cfg = mergeCfg(loadJson(LS_CFG, {}));

  var ui = {
    bottomBtn: null,
    card: null,
    settingsSec: null
  };

  var mapLayer = null;
  var lastRenderedLayer = null;
  var currentItem = null;
  var currentAudio = null;
  var isPlayingNow = false;
  var playGen = 0;
  var audioCtx = null;
  var autoplayUnlocked = false;
  var triggeredAt = {};

  /* ---------------- 工具函数 ---------------- */
  function isEn() {
    return typeof window !== 'undefined' && window.I18N && typeof window.I18N.getLang === 'function'
      ? window.I18N.getLang() === 'en'
      : false;
  }

  function tr(zh, en) {
    return isEn() ? en : zh;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function mergeCfg(saved) {
    var out = {};
    for (var k in DEFAULT_CFG) out[k] = DEFAULT_CFG[k];
    if (saved && typeof saved === 'object') {
      for (var k2 in DEFAULT_CFG) {
        if (saved[k2] !== undefined) out[k2] = saved[k2];
      }
    }
    return out;
  }

  function toast(msg) {
    if (typeof window !== 'undefined' && window.TOTK_APP && typeof window.TOTK_APP.toast === 'function') {
      window.TOTK_APP.toast(msg);
    }
  }

  function getDoneCount() {
    var n = 0;
    for (var i = 0; i < DATA.length; i++) {
      if (doneMap[DATA[i].id]) n++;
    }
    return n;
  }

  function normBase(b) {
    b = String(b || '').trim();
    if (b && b.charAt(b.length - 1) !== '/') b += '/';
    return b;
  }

  /* 三级音频回退链：自定义/本地 (.webm -> .mp3) -> 线上导航站 (.webm) -> 系统 TTS */
  function getAudioUrls(item) {
    var urls = [];
    var customBase = normBase(cfg.audioBase || (typeof window !== 'undefined' && window.TOTK_VM_AUDIO_BASE) || '');
    if (customBase) {
      urls.push(customBase + item.id + '.webm');
      urls.push(customBase + item.id + '.mp3');
    } else {
      urls.push('voice-memories/audio/' + item.id + '.webm');
      urls.push('voice-memories/audio/' + item.id + '.mp3');
      // 局域网手机映射/精简离线包自动回退线上导航站音频
      var onlineBase = normBase((typeof window !== 'undefined' && window.TOTK_VM_ONLINE_BASE) || DEFAULT_ONLINE_AUDIO_BASE);
      if (onlineBase && typeof location !== 'undefined' && location.href.indexOf(onlineBase) < 0) {
        urls.push(onlineBase + item.id + '.webm');
      }
    }
    return urls;
  }

  /* ---------------- 手机端首次触摸解锁自动播放 ---------------- */
  function bindAutoplayUnlock() {
    if (typeof document === 'undefined' || autoplayUnlocked) return;
    function unlock() {
      if (autoplayUnlocked) return;
      autoplayUnlocked = true;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          if (!audioCtx) audioCtx = new AC();
          if (audioCtx.state === 'suspended') audioCtx.resume();
        }
      } catch (e) {}
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('touchstart', unlock, true);
      document.removeEventListener('click', unlock, true);
    }
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('touchstart', unlock, true);
    document.addEventListener('click', unlock, true);
  }

  /* ---------------- Web Audio 共鸣提示音（0 字节纯合成） ---------------- */
  function playResonanceChime() {
    if (typeof window === 'undefined') return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var notes = [523.25, 659.25, 783.99, 1046.5];
      for (var i = 0; i < notes.length; i++) {
        var osc = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(notes[i], now + i * 0.08);
        gain.gain.setValueAtTime(0.0001, now + i * 0.08);
        gain.gain.linearRampToValueAtTime(0.14, now + i * 0.08 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.08 + 0.45);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now + i * 0.08);
        osc.stop(now + i * 0.08 + 0.48);
      }
    } catch (e) {}
  }

  /* ---------------- 与 VoiceNav 互斥控制 ---------------- */
  function setVoiceNavPaused(flag) {
    if (typeof window !== 'undefined' && window.VoiceNav) {
      if (flag && typeof window.VoiceNav.stop === 'function') {
        try { window.VoiceNav.stop(); } catch (e) {}
      }
      if (typeof window.VoiceNav.setPaused === 'function') {
        try { window.VoiceNav.setPaused(!!flag); } catch (e) {}
      }
    }
  }

  /* ---------------- 三级音频播放（本地 / 线上 / TTS 兜底） ---------------- */
  function stopPlayback() {
    playGen++;
    isPlayingNow = false;
    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch (e) {}
      currentAudio = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    setVoiceNavPaused(false);
    updateCardPlayState(tr('点击播放', 'Ready'));
  }

  function speakFallbackTTS(item) {
    if (typeof window === 'undefined' || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
      isPlayingNow = false;
      setVoiceNavPaused(false);
      updateCardPlayState(tr('音频不可用', 'Audio unavailable'));
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var useZh = !isEn() && !!item.transcript_zh;
    var text = useZh ? item.transcript_zh : (item.transcript_en || item.title_en);
    var u = new SpeechSynthesisUtterance(text);
    var role = ROLE_META[item.narrator] || ROLE_META.zelda;
    u.lang = useZh ? 'zh-CN' : 'en-US';
    u.pitch = role.pitch;
    u.rate = role.rate;
    u.onstart = function () {
      isPlayingNow = true;
      updateCardPlayState(tr('系统语音朗读中', 'TTS reading'));
    };
    u.onend = function () {
      isPlayingNow = false;
      setVoiceNavPaused(false);
      updateCardPlayState(tr('播放完毕', 'Finished'));
    };
    u.onerror = function () {
      isPlayingNow = false;
      setVoiceNavPaused(false);
      updateCardPlayState(tr('已停止', 'Stopped'));
    };
    isPlayingNow = true;
    setVoiceNavPaused(true);
    updateCardPlayState(tr('系统语音朗读中…', 'TTS reading…'));
    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      isPlayingNow = false;
      setVoiceNavPaused(false);
    }
  }

  function playItem(item) {
    if (!item) return;
    stopPlayback();
    currentItem = item;
    isPlayingNow = true;
    setVoiceNavPaused(true);
    updateCardPlayState(tr('正在加载语音…', 'Loading audio…'));

    var urls = getAudioUrls(item);
    var myGen = playGen;
    function tryPlayIdx(idx) {
      if (myGen !== playGen) return;
      if (idx >= urls.length) {
        speakFallbackTTS(item);
        return;
      }
      var url = urls[idx];
      var isOnline = url.indexOf('http') === 0;
      try {
        var audio = new Audio(url);
        currentAudio = audio;
        audio.onplaying = function () {
          if (myGen !== playGen) return;
          updateCardPlayState(isOnline ? tr('在线角色语音播放中', 'Playing online audio') : tr('角色语音播放中', 'Playing audio'));
        };
        audio.onended = function () {
          if (myGen !== playGen || currentAudio !== audio) return;
          currentAudio = null;
          isPlayingNow = false;
          setVoiceNavPaused(false);
          updateCardPlayState(tr('播放完毕', 'Finished'));
        };
        audio.onerror = function () {
          if (myGen !== playGen || currentAudio !== audio) return;
          currentAudio = null;
          tryPlayIdx(idx + 1);
        };
        var p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(function (err) {
            if (myGen !== playGen || currentAudio !== audio) return;
            if (err && err.name === 'AbortError') return;
            currentAudio = null;
            tryPlayIdx(idx + 1);
          });
        }
      } catch (e) {
        tryPlayIdx(idx + 1);
      }
    }
    tryPlayIdx(0);
  }

  function togglePlayCurrent() {
    if (!currentItem) return;
    if (isPlayingNow) {
      stopPlayback();
    } else {
      playItem(currentItem);
    }
  }

  /* ---------------- 独立地图图层 ---------------- */
  function getMap() {
    return (typeof window !== 'undefined' && window.TOTK && window.TOTK.map) ? window.TOTK.map : null;
  }

  function getCurrentLayer() {
    return (typeof window !== 'undefined' && window.TOTK && window.TOTK.state) ? window.TOTK.state.layer : 18;
  }

  function renderMapLayer() {
    var map = getMap();
    if (!map || typeof L === 'undefined') return;
    if (!mapLayer) mapLayer = L.layerGroup();
    mapLayer.clearLayers();

    if (!cfg.autoTrigger || !cfg.layerVisible) {
      if (map.hasLayer(mapLayer)) map.removeLayer(mapLayer);
      return;
    }

    var layerId = getCurrentLayer();
    lastRenderedLayer = layerId;
    for (var i = 0; i < DATA.length; i++) {
      var it = DATA[i];
      if (it.layer !== layerId) continue;
      var isDone = !!doneMap[it.id];
      if (cfg.hideDonePins && isDone) continue;
      var role = ROLE_META[it.narrator] || ROLE_META.zelda;
      var icon = L.divIcon({
        className: 'vm-pin-wrap',
        html: '<div class="vm-map-pin ' + it.narrator + (isDone ? ' vm-pin-done' : '') + '">' + role.icon + '</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13]
      });
      var mk = L.marker([it.x, it.y], { icon: icon, zIndexOffset: 320 });
      var label = (isEn() ? it.title_en : (it.title_zh || it.title_en)) + ' (' + it.no + ')';
      mk.bindTooltip(label, { direction: 'top', offset: [0, -12] });
      (function (item) {
        mk.on('click', function (ev) {
          if (ev && ev.originalEvent) ev.originalEvent._markerClicked = true;
          openCard(item, false);
        });
      })(it);
      mk.addTo(mapLayer);
    }
    if (!map.hasLayer(mapLayer)) mapLayer.addTo(map);
  }

  function setLayerVisible(flag, showTip) {
    cfg.layerVisible = !!flag;
    saveJson(LS_CFG, cfg);
    renderMapLayer();
    syncUI();
    if (showTip) {
      toast(cfg.layerVisible
        ? tr('已显示声之记忆标点（已听 ' + getDoneCount() + '/' + DATA.length + '）', 'Voice Memories shown (' + getDoneCount() + '/' + DATA.length + ')')
        : tr('已隐藏声之记忆标点', 'Voice Memories hidden'));
    }
  }

  /* ---------------- 独立完成态管理（绝不受存档覆盖） ---------------- */
  function setDone(id, flag) {
    if (!BY_ID[id]) return false;
    if (flag) doneMap[id] = true;
    else delete doneMap[id];
    saveJson(LS_DONE, doneMap);
    syncUI();
    renderMapLayer();
    if (currentItem && currentItem.id === id) renderCardContent();
    return true;
  }

  function isDone(id) {
    return !!doneMap[id];
  }

  /* ---------------- 实机跑图 20m 自动共鸣触发器 ---------------- */
  function feedPos(pos) {
    if (!cfg.autoTrigger || !pos || !pos.located) return null;
    if (pos.x == null || pos.y == null) return null;
    var layerId = pos.layer != null ? pos.layer : getCurrentLayer();
    var now = Date.now();
    var best = null;
    var bestDist = Infinity;

    var triggerDist = Number(cfg.triggerDist) || 35;
    var triggerAlt = triggerDist <= 15 ? 20 : (triggerDist >= 60 ? 40 : 30);

    for (var i = 0; i < DATA.length; i++) {
      var it = DATA[i];
      if (it.layer !== layerId) continue;
      if (doneMap[it.id]) continue;
      if (triggeredAt[it.id] && (now - triggeredAt[it.id] < TRIGGER_COOLDOWN_MS)) continue;

      var dx = it.x - pos.x;
      var dy = it.y - pos.y;
      var dz = (pos.z != null && it.z != null) ? (it.z - pos.z) : 0;
      if (Math.abs(dz) > triggerAlt) continue;
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= triggerDist && dist < bestDist) {
        bestDist = dist;
        best = it;
      }
    }

    if (best) {
      triggeredAt[best.id] = now;
      setDone(best.id, true);
      playResonanceChime();
      openCard(best, true);
      toast(tr(
        '🎙 声之记忆解锁：' + (best.title_zh || best.title_en) + ' (' + getDoneCount() + '/' + DATA.length + ')',
        '🎙 Voice Memory Unlocked: ' + best.title_en + ' (' + getDoneCount() + '/' + DATA.length + ')'
      ));
      return best;
    }
    return null;
  }

  /* ---------------- 极简单语剧情卡片 ---------------- */
  function navigateToItem(item) {
    if (!item) return;
    var app = typeof window !== 'undefined' ? window.TOTK_APP : null;
    var name = (isEn() ? item.title_en : (item.title_zh || item.title_en)) + ' [' + item.no + ']';
    if (app && typeof app.liveNav === 'function') {
      var ok = app.liveNav({
        x: item.x, y: item.y, z: item.z,
        layer: item.layer,
        name: name,
        type: '声之记忆'
      });
      if (!ok) {
        toast(tr('启动 TOTKNavi 后可开启实时语音指路', 'Start TOTKNavi for live guidance'));
      }
    }
  }

  /* 与主站其他卡片/设置弹窗互斥：打开剧情卡时自动收起它们 */
  function hideOtherPopups() {
    if (typeof document === 'undefined') return;
    var ids = ['exploreCard', 'detail', 'taskCard', 'settingsModal'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.add('hidden');
    }
  }

  function openCard(item, autoPlay) {
    if (!item || !ui.card) return;
    hideOtherPopups();
    currentItem = item;
    renderCardContent();
    ui.card.classList.remove('vm-hidden');
    if (autoPlay) {
      playItem(item);
    } else {
      updateCardPlayState(isPlayingNow ? tr('播放中', 'Playing') : tr('点击播放', 'Ready'));
    }
  }

  function closeCard() {
    stopPlayback();
    if (ui.card) ui.card.classList.add('vm-hidden');
  }

  function updateCardPlayState(statusText) {
    if (!ui.card) return;
    var btn = ui.card.querySelector('#vmPlayBtn');
    var st = ui.card.querySelector('#vmPlayStatus');
    if (btn) btn.textContent = isPlayingNow ? tr('⏸ 暂停', '⏸ Pause') : tr('▶ 播放', '▶ Play');
    if (st && statusText != null) st.textContent = statusText;
  }

  function renderCardContent() {
    if (!ui.card || !currentItem) return;
    var it = currentItem;
    var role = ROLE_META[it.narrator] || ROLE_META.zelda;
    var done = !!doneMap[it.id];
    var en = isEn();
    ui.card.className = 'vm-theme-' + it.narrator;

    var roleLine = (en ? role.en + ' · ' + role.layerEn : role.zh + ' · ' + role.layerZh) + ' · ' + it.no;
    var titleText = en ? it.title_en : (it.title_zh || it.title_en);
    var placeText = en ? it.place_en : (it.place_zh || it.place_en);
    var coordStr = it.gx + ', ' + it.gy + ', ' + it.gz;
    // 中英文严格分开：中文模式只显中文台词，英文模式只显英文台词
    var transcript = en ? (it.transcript_en || '') : (it.transcript_zh || it.transcript_en || '');

    ui.card.innerHTML =
      '<div class="vm-c-head">' +
        '<div class="vm-c-avatar">' + role.icon + '</div>' +
        '<div class="vm-c-meta">' +
          '<div class="vm-c-role">' + esc(roleLine) + '</div>' +
          '<div class="vm-c-title">' + esc(titleText) + '</div>' +
          '<div class="vm-c-sub">📍 ' + esc(placeText) + ' &nbsp;|&nbsp; ' + esc(coordStr) + '</div>' +
        '</div>' +
        '<button type="button" class="vm-c-close" id="vmCardClose" title="' + esc(tr('关闭', 'Close')) + '">×</button>' +
      '</div>' +
      '<div class="vm-c-body">' +
        '<div class="vm-c-transcript">' + esc(transcript) + '</div>' +
      '</div>' +
      '<div class="vm-c-foot">' +
        '<button type="button" class="vm-play-btn" id="vmPlayBtn">' + (isPlayingNow ? tr('⏸ 暂停', '⏸ Pause') : tr('▶ 播放', '▶ Play')) + '</button>' +
        '<div class="vm-c-status" id="vmPlayStatus">' + esc(tr('点击播放', 'Ready')) + '</div>' +
        '<button type="button" class="vm-act-btn' + (done ? ' vm-is-done' : '') + '" id="vmMarkDoneBtn">' +
          (done ? tr('✓ 已听', '✓ Done') : tr('○ 标为已听', '○ Mark Done')) +
        '</button>' +
        '<button type="button" class="vm-act-btn" id="vmNavBtn">' + tr('🧭 导航', '🧭 Nav') + '</button>' +
      '</div>';

    ui.card.querySelector('#vmCardClose').onclick = closeCard;
    ui.card.querySelector('#vmPlayBtn').onclick = togglePlayCurrent;
    ui.card.querySelector('#vmMarkDoneBtn').onclick = function () { setDone(it.id, !doneMap[it.id]); };
    ui.card.querySelector('#vmNavBtn').onclick = function () { navigateToItem(it); };
  }

  /* ---------------- 导出记录（挂在设置页语音 Tab） ---------------- */
  function exportRecords() {
    var payload = {
      exportedAt: new Date().toISOString(),
      collected: getDoneCount(),
      total: DATA.length,
      doneIds: Object.keys(doneMap)
    };
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'totkmap-voice-memories.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast(tr('已导出声之记忆收集记录', 'Voice Memories record exported'));
    } catch (e) {}
  }

  /* ---------------- 设置面板（语音 Tab）挂载 ---------------- */
  function mountSettingsUI() {
    if (typeof document === 'undefined' || document.getElementById('vmSettingsSec')) return;
    var host = document.getElementById('setTabVoice') || document.getElementById('settingsModal');
    if (!host) return;
    var sec = document.createElement('div');
    sec.id = 'vmSettingsSec';
    sec.className = 'set-sec';
    sec.innerHTML =
      '<div class="set-divider" style="margin-top:12px;margin-bottom:10px"></div>' +
      '<div class="set-sec-head">' +
        '<span id="vmSetTitle">声之记忆</span>' +
        '<label class="set-switch" title="开启或关闭跑图自动共鸣播报"><input type="checkbox" id="vmSetAutoToggle"><i></i></label>' +
        '<button type="button" class="set-link-btn" id="vmSetExportBtn" style="margin-left:auto;font-size:11.5px">导出记录</button>' +
      '</div>' +
      '<div class="set-sec-desc" id="vmSetHint">实机跑图走近记忆点时自动弹卡并播放角色独白</div>' +
      '<div id="vmSetDetailWrap">' +
        '<div class="vm-set-row" style="margin-top:4px;justify-content:flex-start;gap:8px;flex-wrap:nowrap">' +
          '<span id="vmSetRangeLbl" style="color:#8a93a0;font-size:11.5px;white-space:nowrap">触发范围</span>' +
          '<div class="set-opts" id="vmRangeBtns" style="margin-top:0;gap:5px;flex-wrap:nowrap">' +
            '<button type="button" class="set-opt" data-dist="15" id="vmDist15" style="padding:2px 8px;font-size:11px;white-space:nowrap;flex:0 0 auto">近 15m</button>' +
            '<button type="button" class="set-opt" data-dist="35" id="vmDist35" style="padding:2px 8px;font-size:11px;white-space:nowrap;flex:0 0 auto">中 35m</button>' +
            '<button type="button" class="set-opt" data-dist="60" id="vmDist60" style="padding:2px 8px;font-size:11px;white-space:nowrap;flex:0 0 auto">远 60m</button>' +
          '</div>' +
        '</div>' +
        '<div class="vm-set-row" style="margin-top:9px;justify-content:flex-start;gap:10px;flex-wrap:nowrap">' +
          '<span id="vmSetProg" style="white-space:nowrap">已听 <span class="vm-set-cnt">0/240</span></span>' +
          '<button type="button" class="set-pill" id="vmSetHideDoneBtn" style="white-space:nowrap">隐藏已听</button>' +
          '<button type="button" class="set-link-btn" id="vmSetResetBtn" style="white-space:nowrap">重置已听</button>' +
        '</div>' +
      '</div>';
    host.appendChild(sec);
    ui.settingsSec = sec;

    sec.querySelector('#vmSetAutoToggle').addEventListener('change', function () {
      cfg.autoTrigger = !!this.checked;
      saveJson(LS_CFG, cfg);
      if (!cfg.autoTrigger) closeCard();
      renderMapLayer();
      syncUI();
    });
    var rangeBtns = sec.querySelectorAll('#vmRangeBtns .set-opt');
    for (var i = 0; i < rangeBtns.length; i++) {
      rangeBtns[i].addEventListener('click', function () {
        cfg.triggerDist = Number(this.getAttribute('data-dist')) || 35;
        saveJson(LS_CFG, cfg);
        syncUI();
      });
    }
    sec.querySelector('#vmSetHideDoneBtn').onclick = function () {
      cfg.hideDonePins = !cfg.hideDonePins;
      saveJson(LS_CFG, cfg);
      renderMapLayer();
      syncUI();
    };
    sec.querySelector('#vmSetExportBtn').onclick = exportRecords;
    sec.querySelector('#vmSetResetBtn').onclick = function () {
      doneMap = {};
      triggeredAt = {};
      saveJson(LS_DONE, doneMap);
      renderMapLayer();
      syncUI();
      toast(tr('已重置声之记忆进度', 'Voice Memories progress reset'));
    };
  }

  function syncUI() {
    var en = isEn();
    var done = getDoneCount();
    if (ui.bottomBtn) {
      var enabled = !!cfg.autoTrigger;
      ui.bottomBtn.disabled = !enabled;
      ui.bottomBtn.style.opacity = enabled ? '' : '0.42';
      ui.bottomBtn.style.cursor = enabled ? '' : 'not-allowed';
      ui.bottomBtn.classList.toggle('vm-on', enabled && !!cfg.layerVisible);
      ui.bottomBtn.textContent = en ? '🎙 Memories' : '🎙 声之记忆';
      ui.bottomBtn.title = !enabled
        ? (en ? 'Voice Memories disabled (re-enable in Settings → Voice)' : '声之记忆已关闭（可在「设置 → 语音」重新开启）')
        : (en
          ? 'Toggle Voice Memories on map (' + done + '/' + DATA.length + ')'
          : '显示/隐藏声之记忆标点（已听 ' + done + '/' + DATA.length + '）');
    }
    if (ui.settingsSec) {
      ui.settingsSec.querySelector('#vmSetTitle').textContent = en ? 'Voice Memories' : '声之记忆';
      ui.settingsSec.querySelector('#vmSetHint').textContent = en
        ? 'Auto-play character memories when walking near trigger spots'
        : '实机跑图走近记忆点时自动弹卡并播放角色独白';
      ui.settingsSec.querySelector('#vmSetAutoToggle').checked = !!cfg.autoTrigger;
      var detailWrap = ui.settingsSec.querySelector('#vmSetDetailWrap');
      if (detailWrap) {
        detailWrap.style.opacity = cfg.autoTrigger ? '1' : '0.42';
        detailWrap.style.pointerEvents = cfg.autoTrigger ? '' : 'none';
      }
      ui.settingsSec.querySelector('#vmSetRangeLbl').textContent = en ? 'Range' : '触发范围';
      ui.settingsSec.querySelector('#vmDist15').textContent = en ? '15m' : '近 15m';
      ui.settingsSec.querySelector('#vmDist35').textContent = en ? '35m' : '中 35m';
      ui.settingsSec.querySelector('#vmDist60').textContent = en ? '60m' : '远 60m';
      var curD = Number(cfg.triggerDist) || 35;
      var rbs = ui.settingsSec.querySelectorAll('#vmRangeBtns .set-opt');
      for (var i = 0; i < rbs.length; i++) {
        var on = Number(rbs[i].getAttribute('data-dist')) === curD;
        rbs[i].classList.toggle('active', on);
        rbs[i].classList.toggle('on', on);
      }
      var bHide = ui.settingsSec.querySelector('#vmSetHideDoneBtn');
      bHide.classList.toggle('on', !!cfg.hideDonePins);
      bHide.textContent = en ? 'Hide Done' : '隐藏已听';
      ui.settingsSec.querySelector('#vmSetProg').innerHTML =
        (en ? 'Collected ' : '已听 ') + '<span class="vm-set-cnt">' + done + '/' + DATA.length + '</span>';
      ui.settingsSec.querySelector('#vmSetExportBtn').textContent = en ? 'Export' : '导出记录';
      ui.settingsSec.querySelector('#vmSetResetBtn').textContent = en ? 'Reset' : '重置已听';
    }
  }

  function mountUI() {
    if (typeof document === 'undefined' || ui.card) return;

    // 1. 绑定底栏「🎙 声之记忆」按钮
    ui.bottomBtn = document.getElementById('vmBottomBtn');
    if (ui.bottomBtn) {
      ui.bottomBtn.onclick = function () {
        if (!cfg.autoTrigger) return;
        setLayerVisible(!cfg.layerVisible, true);
      };
    }

    // 2. 创建极简剧情卡容器
    var card = document.createElement('div');
    card.id = 'vmCard';
    card.className = 'vm-hidden';
    document.body.appendChild(card);
    ui.card = card;

    // 3. 挂载设置面板「语音」Tab 内声之记忆配置
    mountSettingsUI();

    // 4. 手机自动播放解锁 + 点击地图空白处自动关闭剧情卡 + 与其他卡片/设置弹窗互斥
    bindAutoplayUnlock();
    var map = getMap();
    if (map && typeof map.on === 'function') {
      map.on('click', function (e) {
        if (e && (e._markerClicked || (e.originalEvent && e.originalEvent._markerClicked))) return;
        if (ui.card && !ui.card.classList.contains('vm-hidden')) {
          closeCard();
        }
      });
    }
    if (typeof MutationObserver === 'function') {
      var watchIds = ['exploreCard', 'detail', 'taskCard', 'settingsModal'];
      var mo = new MutationObserver(function (mutations) {
        if (!ui.card || ui.card.classList.contains('vm-hidden')) return;
        for (var m = 0; m < mutations.length; m++) {
          var t = mutations[m].target;
          if (t && !t.classList.contains('hidden')) {
            closeCard();
            break;
          }
        }
      });
      for (var w = 0; w < watchIds.length; w++) {
        var el = document.getElementById(watchIds[w]);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
      }
    }

    // 5. 监听主站切层与语言切换
    var layerSw = document.getElementById('layerSwitch');
    if (layerSw) {
      layerSw.addEventListener('click', function () {
        setTimeout(function () {
          if (cfg.layerVisible && getCurrentLayer() !== lastRenderedLayer) {
            renderMapLayer();
          }
        }, 60);
      });
    }

    if (typeof window !== 'undefined' && window.I18N && typeof window.I18N.onChange === 'function') {
      window.I18N.onChange(function () {
        syncUI();
        renderMapLayer();
        if (currentItem && ui.card && !ui.card.classList.contains('vm-hidden')) renderCardContent();
      });
    }
    var langBtns = document.getElementById('setLangBtns');
    if (langBtns) {
      langBtns.addEventListener('click', function () {
        setTimeout(function () {
          syncUI();
          renderMapLayer();
          if (currentItem && ui.card && !ui.card.classList.contains('vm-hidden')) renderCardContent();
        }, 50);
      });
    }

    syncUI();
    if (cfg.layerVisible) renderMapLayer();
  }

  function init(opts) {
    opts = opts || {};
    var src = opts.data || (typeof window !== 'undefined' ? window.TOTK_VM_DATA : []) || [];
    DATA = Array.isArray(src) ? src : [];
    BY_ID = {};
    for (var i = 0; i < DATA.length; i++) {
      BY_ID[DATA[i].id] = DATA[i];
    }
    if (typeof document !== 'undefined') {
      mountUI();
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { init(); });
    } else {
      setTimeout(function () { init(); }, 0);
    }
  }

  return {
    init: init,
    feedPos: feedPos,
    openCard: function (id, autoPlay) {
      var it = typeof id === 'string' ? BY_ID[id] : id;
      if (it) openCard(it, !!autoPlay);
    },
    closeCard: closeCard,
    setLayerVisible: setLayerVisible,
    setDone: setDone,
    isDone: isDone,
    getDoneCount: getDoneCount,
    isPlaying: function () { return isPlayingNow; },
    stop: stopPlayback,
    getData: function () { return DATA; },
    getById: function (id) { return BY_ID[id] || null; },
    getConfig: function () { return mergeCfg(cfg); },
    setConfig: function (patch) {
      if (patch && typeof patch === 'object') {
        for (var k in DEFAULT_CFG) {
          if (patch[k] !== undefined) cfg[k] = patch[k];
        }
        saveJson(LS_CFG, cfg);
        syncUI();
        renderMapLayer();
      }
      return mergeCfg(cfg);
    },
    resetProgress: function () {
      doneMap = {};
      triggeredAt = {};
      saveJson(LS_DONE, doneMap);
      syncUI();
      renderMapLayer();
    }
  };
});
