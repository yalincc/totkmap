/* ============================================================================
 * TOTKmap · 独立网页端实时语音导航模块 (app/voice/voice-nav.js)
 * ----------------------------------------------------------------------------
 * 设计目标：
 *   1. 100% 独立可插拔模块：自带状态机、音频池、Web Audio 普尔亚雷达音合成、独立配置与 UI 挂载；
 *      宿主（网页地图 TOTKmap）即使不加载或彻底关闭本模块也 0 报错、0 开销。
 *   2. 罗盘 8 方位绝对方向：与游戏右下角小地图圆盘北向严格一致（正北/东北/正东/东南/正南/西南/正西/西北）。
 *   3. 三维空间感知：支持 3D 距离阶梯（500m / 300m / 100m / 自定义到达距离）、垂直高低差、跨层提醒与同层补报、偏航提醒。
 *   4. 中英文离线角色语音包 + 双兜底：
 *      - zelda : 塞尔达公主风（温柔空灵少女音，离线 MP3；英文界面自动切 en/ 英式离线女声包）
 *      - yujie : 御姐领航员（成熟干练御姐音，离线 MP3；英文界面自动切 en/ 英式离线女声包）
 *      - chime : 仅普尔亚平板雷达感应音（纯 Web Audio 合成，0 音频文件请求）
 *      - tts   : 浏览器原生语音合成（支持直接播报具体神庙/地标名称，自适应中英文）
 * ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceNav = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORAGE_KEY = 'totkmap.voice.cfg.v1';
  var BASE_PATH = 'voice/';
  var ONLINE_BASE = 'https://totk.yalin.site/voice/';

  /* 默认独立配置 */
  var DEFAULT_CFG = {
    enabled: true,         // 语音导航总开关
    pack: 'zelda',         // 'zelda' | 'yujie' | 'chime' | 'tts'
    volume: 85,            // 音量 0 ~ 100
    dirDist: true,         // 播报罗盘 8 方位与距离
    altLayer: true,        // 播报高低差与跨层提醒
    offCourse: true,       // 偏航提醒（背离目标持续跑动）
    chime: true,           // 普尔亚平板雷达感应音
    arriveM: 35,           // 自定义：到达播报距离阈值（15 ~ 80m，默认 35m）
    altDiffM: 25,          // 自定义：高低差播报阈值（10 ~ 60m，默认 ±25m）
    freqMode: 'standard'   // 自定义：中途播报密度 'compact'(仅100m) | 'standard'(300m+100m) | 'dense'(500m+300m+100m)
  };

  var cfg = loadCfg();

  /* 32 个标准词条文本（供系统 TTS 模式、中英双语回退及调试日志使用） */
  var CLIP_TEXT = {
    welcome:       { zh: '语音导航已就绪。', en: 'Voice navigation ready.' },
    start_nav:     { zh: '开始导航。', en: 'Starting navigation.' },
    start_auto:    { zh: '开启自动收集。', en: 'Auto collection started.' },
    next_target:   { zh: '完成！下一个目标，', en: 'Completed! Next target,' },
    switch_near:   { zh: '发现更近目标，', en: 'Closer target found,' },
    dir_n:         { zh: '正北方向，', en: 'North,' },
    dir_ne:        { zh: '东北方向，', en: 'Northeast,' },
    dir_e:         { zh: '正东方向，', en: 'East,' },
    dir_se:        { zh: '东南方向，', en: 'Southeast,' },
    dir_s:         { zh: '正南方向，', en: 'South,' },
    dir_sw:        { zh: '西南方向，', en: 'Southwest,' },
    dir_w:         { zh: '正西方向，', en: 'West,' },
    dir_nw:        { zh: '西北方向，', en: 'Northwest,' },
    dist_far:      { zh: '距离较远，建议先传送。', en: 'Far away, consider fast travel.' },
    dist_800:      { zh: '约八百米。', en: 'about 800 meters.' },
    dist_500:      { zh: '约五百米。', en: 'about 500 meters.' },
    dist_400:      { zh: '约四百米。', en: 'about 400 meters.' },
    dist_300:      { zh: '三百米。', en: '300 meters.' },
    dist_200:      { zh: '两百米。', en: '200 meters.' },
    dist_150:      { zh: '一百五十米。', en: '150 meters.' },
    dist_100:      { zh: '一百米。', en: '100 meters.' },
    dist_50:       { zh: '五十米。', en: '50 meters.' },
    arrived:       { zh: '已到达目标附近。', en: 'Arrived near target.' },
    all_done:      { zh: '太棒了，本层目标已全部完成！', en: 'Awesome! All targets on this layer are completed!' },
    alt_up:        { zh: '目标在上方。', en: 'Target is above you.' },
    alt_down:      { zh: '目标在下方。', en: 'Target is below you.' },
    layer_sky:     { zh: '注意，目标在天空层。', en: 'Note: target is on the Sky layer.' },
    layer_surface: { zh: '注意，目标在地上层。', en: 'Note: target is on the Surface layer.' },
    layer_depths:  { zh: '注意，目标在地下层。', en: 'Note: target is in the Depths.' },
    off_course:    { zh: '方向偏离，目标在', en: 'Off course, target is' },
    korok_near:    { zh: '附近有克洛格的气息哦。', en: 'A Korok is hiding nearby.' },
    korok_start:   { zh: '前往克洛格起点，', en: 'Heading to Korok start,' },
    korok_to_camp: { zh: '已到达起点，请护送前往朋友营地，', en: "Arrived at start, escort to friend's camp," },
    korok_to_goal: { zh: '已到达起点，前往挑战终点，', en: 'Arrived at start, heading to goal,' },
    shrine_near:   { zh: '感应到神庙反应。', en: 'Shrine sensor triggered nearby.' }
  };

  /* 内部状态机（针对当前导航目标） */
  var state = {
    targetKey: '',          // 当前目标唯一标识 'x,y,layer,name'
    announcedStart: false,  // 是否已播报起步
    passed500: false,       // 是否已触发 500m 节点（密集模式）
    passed300: false,       // 是否已触发 300m 节点
    passed100: false,       // 是否已触发 100m 节点
    passedArrive: false,    // 是否已触发到达节点
    wasCrossLayer: false,   // 上一拍是否处于跨层状态（切回同层时自动补报方向距离）
    lastDist: null,         // 上一拍三维距离
    lastPx: null,           // 上一拍玩家 X
    lastPy: null,           // 上一拍玩家 Y
    offCourseSince: 0,      // 连续偏航起始时间戳
    lastOffCourseSpeak: 0,  // 上次播报偏航时间戳
    lastRadarPing: 0,       // 上次雷达感应音时间戳
    lastSpokenClips: [],    // 最近一次播报的词条列表（便于测试与状态检查）
    lastPlaybackMode: '',   // 最近一次播报模式: 'mp3' | 'tts' | 'chime'
    lastPlaybackPack: ''    // 最近一次实际使用的语音包目录: 'zelda' | 'yujie' | 'en' | ''
  };

  var OFF_COURSE_WAIT = 6000;     // 持续反向移动 6 秒触发偏航
  var OFF_COURSE_COOLDOWN = 22000;// 偏航提醒冷却 22 秒
  var MILESTONE_RESET_HYST = 80;  // 传送/远离超过里程碑 +80m 时重置对应里程碑
  var externalPaused = false;     // 外部模块临时静音避让标志（不改动用户 cfg.enabled）
  var audioUnlocked = false;      // 浏览器首次手势解锁标志
  var autoplayWarned = false;     // 自动播放被拦截提示防重复标志

  function getArriveM() {
    var v = parseInt(cfg.arriveM, 10);
    return (isNaN(v) || v < 10) ? 35 : Math.min(80, Math.max(15, v));
  }

  function getAltDiffM() {
    var v = parseInt(cfg.altDiffM, 10);
    return (isNaN(v) || v < 5) ? 25 : Math.min(60, Math.max(10, v));
  }

  /* 单一全局 Audio 实例 + 播放代次锁（彻底杜绝多实例串扰与 AbortError 重音） */
  var sharedAudio = null;
  var playQueue = [];       // 待播放 clipId 队列
  var currentAudio = null;  // 当前正在播放的 HTMLAudioElement
  var playGen = 0;          // 每次 stopPlayback 递增，作废所有旧异步回调
  var queueTimer = null;
  var audioCtx = null;      // Web Audio API 上下文（用于合成普尔亚平板雷达音效）

  /* ---------------- 配置存取 ---------------- */
  function loadCfg() {
    var res = {};
    for (var k in DEFAULT_CFG) res[k] = DEFAULT_CFG[k];
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        for (var pk in DEFAULT_CFG) {
          if (parsed[pk] !== undefined) res[pk] = parsed[pk];
        }
      }
    } catch (e) {}
    return res;
  }

  function saveCfg() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch (e) {}
    syncUI();
  }

  function isEn() {
    return !!(typeof window !== 'undefined' && window.I18N && window.I18N.getLang && window.I18N.getLang() === 'en');
  }

  function tr(key, zh, en) {
    if (typeof window !== 'undefined' && window.I18N && window.I18N.t) {
      var v = window.I18N.t(key);
      if (v && v !== key) return v;
    }
    return isEn() ? en : zh;
  }

  /* ---------------- 罗盘 8 方位与空间几何计算 ----------------
   * 坐标口径（与 live.js 完全一致）：
   *   player.x (mx) = 游戏 Z_objmap（北负南正） -> 北向增量 dN = player.x - target.x
   *   player.y (my) = 游戏 X_objmap（东正西负） -> 东向增量 dE = target.y - player.y
   *   0° = 正北，90° = 正东，180° = 正南，270° = 正西
   */
  function calcBearingDeg(px, py, tx, ty) {
    var dN = px - tx;
    var dE = ty - py;
    var rad = Math.atan2(dE, dN);
    return (rad * 180 / Math.PI + 360) % 360;
  }

  function bearingToDirClip(deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg >= 337.5 || deg < 22.5)  return 'dir_n';
    if (deg >= 22.5  && deg < 67.5)  return 'dir_ne';
    if (deg >= 67.5  && deg < 112.5) return 'dir_e';
    if (deg >= 112.5 && deg < 157.5) return 'dir_se';
    if (deg >= 157.5 && deg < 202.5) return 'dir_s';
    if (deg >= 202.5 && deg < 247.5) return 'dir_sw';
    if (deg >= 247.5 && deg < 292.5) return 'dir_w';
    return 'dir_nw';
  }

  function calcCompass8(px, py, tx, ty) {
    return bearingToDirClip(calcBearingDeg(px, py, tx, ty));
  }

  function calcDist3D(player, target) {
    if (!player || !target || player.x == null || target.x == null) return null;
    var dx = target.x - player.x;
    var dy = target.y - player.y;
    var pz = player.z != null ? Number(player.z) : 0;
    var tz = target.z != null ? Number(target.z) : pz;
    var dz = (target.z != null && player.z != null) ? (tz - pz) : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function pickDistClip(d) {
    if (d == null || !isFinite(d)) return null;
    if (d <= getArriveM()) return 'arrived';
    if (d <= 75)  return 'dist_50';
    if (d <= 125) return 'dist_100';
    if (d <= 175) return 'dist_150';
    if (d <= 250) return 'dist_200';
    if (d <= 350) return 'dist_300';
    if (d <= 450) return 'dist_400';
    if (d <= 650) return 'dist_500';
    if (d <= 1000) return 'dist_800';
    return 'dist_far';
  }

  function pickAltClip(player, target) {
    if (!cfg.altLayer) return null;
    if (!player || !target || player.z == null || target.z == null) return null;
    var dz = Number(target.z) - Number(player.z);
    if (!isFinite(dz)) return null;
    var th = getAltDiffM();
    if (dz >= th)  return 'alt_up';
    if (dz <= -th) return 'alt_down';
    return null;
  }

  function pickCrossLayerClip(player, target) {
    if (!cfg.altLayer) return null;
    if (!player || !target || !target.layer || !player.layer) return null;
    if (Number(target.layer) === Number(player.layer)) return null;
    var tl = Number(target.layer);
    if (tl === 20) return 'layer_sky';
    if (tl === 19) return 'layer_depths';
    return 'layer_surface';
  }

  /* ---------------- Web Audio 普尔亚平板雷达感应音（0 字节纯合成） ---------------- */
  function ensureAudioCtx() {
    if (!audioCtx && typeof window !== 'undefined') {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try { audioCtx = new AC(); } catch (e) {}
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (e) {}
    }
    return audioCtx;
  }

  function playChime(kind) {
    if (!cfg.enabled || externalPaused || !cfg.chime) return;
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    var now = ctx.currentTime;
    var vol = Math.max(0.05, Math.min(1, (cfg.volume || 80) / 100)) * 0.28;

    function tone(freq, startOffset, dur, gainMul) {
      try {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + startOffset);
        var g = vol * (gainMul || 1);
        gain.gain.setValueAtTime(0.0001, now + startOffset);
        gain.gain.linearRampToValueAtTime(g, now + startOffset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + startOffset);
        osc.stop(now + startOffset + dur + 0.02);
      } catch (e) {}
    }

    if (kind === 'ping') {
      // 普尔亚平板神庙感应器双连音 (E6 -> A6)
      tone(1318.5, 0.00, 0.14, 0.7);
      tone(1760.0, 0.11, 0.24, 1.0);
    } else if (kind === 'arrive') {
      // 到达目标三连清脆泛音 (E6 -> G#6 -> B6)
      tone(1318.5, 0.00, 0.14, 0.8);
      tone(1661.2, 0.11, 0.16, 0.9);
      tone(1975.5, 0.22, 0.35, 1.1);
    } else if (kind === 'done') {
      // 完成目标上扬双音 (A5 -> E6)
      tone(880.0,  0.00, 0.12, 0.8);
      tone(1318.5, 0.10, 0.28, 1.0);
    }
  }

  /* ---------------- 音频切片队列播放器（单实例 + 代次锁） ---------------- */
  function stopPlayback() {
    playGen++;
    playQueue = [];
    if (queueTimer) {
      clearTimeout(queueTimer);
      queueTimer = null;
    }
    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
      } catch (e) {}
      currentAudio = null;
    }
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  function getClipUrl(pack, clipId, useOnline) {
    var base = useOnline
      ? ((typeof window !== 'undefined' && window.TOTK_VOICE_ONLINE_BASE) || ONLINE_BASE)
      : BASE_PATH;
    return base + pack + '/' + clipId + '.webm';
  }

  function getSharedAudio() {
    if (!sharedAudio && typeof Audio !== 'undefined') {
      sharedAudio = new Audio();
      sharedAudio.preload = 'auto';
    }
    return sharedAudio;
  }

  function speakViaSystemTTS(clips, customTargetName) {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    var lang = isEn() ? 'en' : 'zh';
    var parts = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (CLIP_TEXT[c]) {
        parts.push(CLIP_TEXT[c][lang] || CLIP_TEXT[c].zh);
      }
    }
    if (customTargetName && (clips[0] === 'start_nav' || clips[0] === 'start_auto' || clips[0] === 'next_target' || clips[0] === 'switch_near')) {
      parts.splice(1, 0, customTargetName + '，');
    }
    var text = parts.join('');
    if (!text) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = isEn() ? 'en-US' : 'zh-CN';
      u.volume = Math.max(0.1, Math.min(1, (cfg.volume || 80) / 100));
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  function speakClips(clips, opts) {
    opts = opts || {};
    if (!cfg.enabled || externalPaused) return;
    if (!clips || !clips.length) return;

    state.lastSpokenClips = clips.slice();

    // 仅感应音模式：只响雷达音，不播人声
    if (cfg.pack === 'chime') {
      state.lastPlaybackMode = 'chime';
      state.lastPlaybackPack = '';
      if (opts.chime) playChime(opts.chime);
      return;
    }

    // 抢占旧语音队列
    if (opts.interrupt !== false) {
      stopPlayback();
    }

    if (opts.chime) {
      playChime(opts.chime);
    }

    // 系统原生 TTS 模式（可读出具体神庙/地标名称，自适应中英文）
    if (cfg.pack === 'tts') {
      state.lastPlaybackMode = 'tts';
      state.lastPlaybackPack = '';
      speakViaSystemTTS(clips, opts.targetName);
      return;
    }

    // 离线 MP3 模式：英文界面自动切内置 en/ 英式离线女声包，中文界面按 zelda / yujie 播放
    state.lastPlaybackMode = 'mp3';
    var pack = isEn() ? 'en' : ((cfg.pack === 'yujie') ? 'yujie' : 'zelda');
    state.lastPlaybackPack = pack;
    for (var i = 0; i < clips.length; i++) {
      playQueue.push({ pack: pack, clipId: clips[i] });
    }
    pumpQueue();
  }

  function pumpQueue() {
    if (!cfg.enabled || externalPaused || currentAudio || !playQueue.length) return;
    var item = playQueue.shift();
    var myGen = playGen;

    function playOne(useOnline) {
      if (myGen !== playGen) return;
      var audio = getSharedAudio();
      if (!audio) {
        speakViaSystemTTS([item.clipId]);
        queueTimer = setTimeout(pumpQueue, 100);
        return;
      }
      currentAudio = audio;
      audio.volume = Math.max(0.05, Math.min(1, (cfg.volume || 80) / 100));

      var advanced = false;
      function next() {
        if (advanced || myGen !== playGen) return;
        advanced = true;
        audio.onended = null;
        audio.onerror = null;
        if (currentAudio === audio) currentAudio = null;
        queueTimer = setTimeout(pumpQueue, 25);
      }
      function onErr() {
        if (advanced || myGen !== playGen) return;
        advanced = true;
        audio.onended = null;
        audio.onerror = null;
        if (currentAudio === audio) currentAudio = null;
        // 三级回退：本地 .webm -> 线上导航站 .webm -> 系统 TTS
        if (!useOnline) {
          playOne(true);
          return;
        }
        speakViaSystemTTS([item.clipId]);
        queueTimer = setTimeout(pumpQueue, 100);
      }

      audio.onended = next;
      audio.onerror = onErr;
      try {
        audio.src = getClipUrl(item.pack, item.clipId, useOnline);
        audio.currentTime = 0;
        var pr = audio.play();
        if (pr && typeof pr.catch === 'function') {
          pr.catch(function (err) {
            if (myGen !== playGen) return;
            // 抢占切播引发的 AbortError 绝不能误进 onErr() 触发重音/TTS
            if (err && err.name === 'AbortError') return;
            if (err && err.name === 'NotAllowedError') {
              advanced = true;
              audio.onended = null;
              audio.onerror = null;
              if (currentAudio === audio) currentAudio = null;
              playQueue = [];
              if (!autoplayWarned && typeof window !== 'undefined' && window.TOTK_APP && typeof window.TOTK_APP.toast === 'function') {
                autoplayWarned = true;
                window.TOTK_APP.toast(tr('voice.autoplayHint', '浏览器限制自动语音，请点击地图任意处解锁', 'Browser blocked auto audio — click anywhere on the map to unlock'));
              }
              return;
            }
            onErr();
          });
        }
      } catch (e) {
        onErr();
      }
    }
    playOne(false);
  }

  /* ---------------- 核心导航语音组装逻辑 ---------------- */
  function buildTargetAnnounceClips(prefixClip, player, target, d) {
    var clips = [];
    if (prefixClip) clips.push(prefixClip);

    var crossClip = pickCrossLayerClip(player, target);
    if (crossClip) {
      clips.push(crossClip);
      return clips;
    }

    var arrM = getArriveM();
    if (cfg.dirDist && player && target && player.x != null && target.x != null) {
      if (d != null && d <= arrM) {
        clips.push('arrived');
      } else {
        var dirClip = calcCompass8(player.x, player.y, target.x, target.y);
        clips.push(dirClip);
        var distClip = pickDistClip(d);
        if (distClip) clips.push(distClip);
      }
    }

    var altClip = pickAltClip(player, target);
    if (altClip) {
      clips.push(altClip);
    }
    return clips;
  }

  function resetTargetState(tKey, d, isCrossLayer) {
    var arrM = getArriveM();
    state.targetKey = tKey || '';
    state.announcedStart = true;
    state.passed500 = (d != null && d <= 500);
    state.passed300 = (d != null && d <= 300);
    state.passed100 = (d != null && d <= 100);
    state.passedArrive = (d != null && d <= arrM);
    state.wasCrossLayer = !!isCrossLayer;
    state.lastDist = d;
    state.offCourseSince = 0;
  }

  /* 宿主每拍或事件触发时调用：
   * VoiceNav.feed({
   *   player: { x, y, z, layer, located },
   *   target: { id, name, x, y, z, layer, type },
   *   event: 'start_nav' | 'start_auto' | 'next_target' | 'switch_near' | 'all_done' | 'clear' | null
   * })
   */
  function feed(payload) {
    if (!payload) return;
    var ev = payload.event || null;
    var player = payload.player || null;
    var target = payload.target || null;

    if (ev === 'clear') {
      state.targetKey = '';
      state.wasCrossLayer = false;
      stopPlayback();
      return;
    }

    if (ev === 'all_done') {
      state.targetKey = '';
      state.wasCrossLayer = false;
      if (cfg.enabled) {
        speakClips(['all_done'], { chime: 'done', interrupt: true });
      }
      return;
    }

    if (!target || target.x == null || target.y == null) {
      state.targetKey = '';
      state.wasCrossLayer = false;
      return;
    }

    var tKey = Math.round(target.x) + ',' + Math.round(target.y) + ',' + (target.layer || '') + ',' + (target.id || target.name || '');
    var hasPlayer = !!(player && player.located !== false && player.x != null && player.y != null);
    var d = hasPlayer ? calcDist3D(player, target) : null;
    var isCrossLayer = !!(hasPlayer && target.layer && player.layer && Number(target.layer) !== Number(player.layer));

    // 1. 显式导航事件（手动点导航 / 开启自动收集 / 完成续导 / 切最近点 / 克洛格起点与二段接力）
    if (ev === 'start_nav' || ev === 'start_auto' || ev === 'next_target' || ev === 'switch_near' ||
        ev === 'korok_start' || ev === 'korok_to_camp' || ev === 'korok_to_goal') {
      resetTargetState(tKey, d, isCrossLayer);
      if (hasPlayer) {
        var clips = buildTargetAnnounceClips(ev, player, target, d);
        var chimeType = (ev === 'next_target' || ev === 'korok_to_camp' || ev === 'korok_to_goal') ? 'done' : 'ping';
        speakClips(clips, { chime: chimeType, interrupt: true, targetName: target.name });
      } else {
        speakClips([ev], { chime: 'ping', interrupt: true, targetName: target.name });
      }
      if (hasPlayer) {
        state.lastPx = player.x;
        state.lastPy = player.y;
      }
      return;
    }

    if (!hasPlayer) return;

    // 2. 目标发生隐式切换（例如服务端 /pos 同步过来的新目标）
    if (tKey !== state.targetKey) {
      resetTargetState(tKey, d, isCrossLayer);
      var autoClips = buildTargetAnnounceClips('start_nav', player, target, d);
      speakClips(autoClips, { chime: 'ping', interrupt: true, targetName: target.name });
      state.lastPx = player.x;
      state.lastPy = player.y;
      return;
    }

    // 若跨层，记录跨层状态，不做同层距离里程碑与偏航计算
    if (isCrossLayer) {
      state.wasCrossLayer = true;
      state.lastPx = player.x;
      state.lastPy = player.y;
      state.lastDist = d;
      return;
    }

    // 2.5 从跨层切回目标所在同层时，自动补报一次当前方向、距离与高低差
    if (state.wasCrossLayer) {
      resetTargetState(tKey, d, false);
      var backClips = buildTargetAnnounceClips(null, player, target, d);
      if (backClips.length) {
        speakClips(backClips, { chime: 'ping', interrupt: true, targetName: target.name });
      }
      state.lastPx = player.x;
      state.lastPy = player.y;
      return;
    }

    if (d == null) return;
    var arrM = getArriveM();

    // 2.8 传送或大幅远离超过里程碑 +80m 迟滞时，自动重置对应里程碑，确保重飞回来能再次提醒
    if (state.passedArrive && d > arrM + MILESTONE_RESET_HYST) state.passedArrive = false;
    if (state.passed100 && d > 100 + MILESTONE_RESET_HYST) state.passed100 = false;
    if (state.passed300 && d > 300 + MILESTONE_RESET_HYST) state.passed300 = false;
    if (state.passed500 && d > 500 + MILESTONE_RESET_HYST) state.passed500 = false;

    // 3. 距离阶梯里程碑检测（支持自定义到达距离 arrM 与中途播报频率 compact / standard / dense）
    if (d <= arrM && !state.passedArrive) {
      state.passedArrive = true;
      state.passed100 = true;
      state.passed300 = true;
      state.passed500 = true;
      var arrClips = ['arrived'];
      var tType = String(target.type || target.name || '');
      if (tType.indexOf('克洛格') >= 0 || tType.toLowerCase().indexOf('korok') >= 0) {
        arrClips.push('korok_near');
      } else if (tType.indexOf('神庙') >= 0 || tType.toLowerCase().indexOf('shrine') >= 0) {
        arrClips.push('shrine_near');
      }
      var arrAlt = pickAltClip(player, target);
      if (arrAlt) arrClips.push(arrAlt);
      speakClips(arrClips, { chime: 'arrive', interrupt: true });
    } else if (d <= 100 && !state.passed100) {
      state.passed100 = true;
      state.passed300 = true;
      state.passed500 = true;
      var c100 = [];
      if (cfg.dirDist) {
        c100.push(calcCompass8(player.x, player.y, target.x, target.y));
        c100.push('dist_100');
      }
      var alt100 = pickAltClip(player, target);
      if (alt100) c100.push(alt100);
      if (c100.length) {
        speakClips(c100, { chime: 'ping', interrupt: false });
      } else {
        playChime('ping');
      }
    } else if (d <= 300 && !state.passed300 && cfg.freqMode !== 'compact') {
      state.passed300 = true;
      state.passed500 = true;
      if (cfg.dirDist) {
        var c300 = [calcCompass8(player.x, player.y, target.x, target.y), 'dist_300'];
        speakClips(c300, { chime: null, interrupt: false });
      }
    } else if (d <= 500 && !state.passed500 && cfg.freqMode === 'dense') {
      state.passed500 = true;
      if (cfg.dirDist) {
        var c500 = [calcCompass8(player.x, player.y, target.x, target.y), 'dist_500'];
        speakClips(c500, { chime: null, interrupt: false });
      }
    }

    // 4. 偏航检测（距离 > 60m，且连续 6 秒朝背离目标 > 120° 方向移动）
    var now = Date.now();
    if (cfg.offCourse && d > 60 && state.lastPx != null && state.lastPy != null) {
      var moveN = state.lastPx - player.x;
      var moveE = player.y - state.lastPy;
      var moveStep = Math.sqrt(moveN * moveN + moveE * moveE);
      if (moveStep >= 1.2 && moveStep <= 150) {
        var moveHeading = (Math.atan2(moveE, moveN) * 180 / Math.PI + 360) % 360;
        var targetBearing = calcBearingDeg(player.x, player.y, target.x, target.y);
        var angleDiff = Math.abs(((moveHeading - targetBearing) % 360 + 540) % 360 - 180);
        if (angleDiff > 120) {
          if (!state.offCourseSince) {
            state.offCourseSince = now;
          } else if (now - state.offCourseSince >= OFF_COURSE_WAIT && now - state.lastOffCourseSpeak >= OFF_COURSE_COOLDOWN) {
            state.lastOffCourseSpeak = now;
            state.offCourseSince = now;
            var rightDir = bearingToDirClip(targetBearing);
            speakClips(['off_course', rightDir], { chime: 'ping', interrupt: false });
          }
        } else if (angleDiff < 85) {
          state.offCourseSince = 0;
        }
      }
    }

    state.lastPx = player.x;
    state.lastPy = player.y;
    state.lastDist = d;
  }

  /* 试听功能 */
  function testPlay() {
    ensureAudioCtx();
    if (!cfg.enabled) {
      cfg.enabled = true;
      saveCfg();
    }
    var demoClips = ['welcome', 'dir_ne', 'dist_100', 'alt_up'];
    speakClips(demoClips, { chime: 'ping', interrupt: true });
  }

  /* ---------------- 独立 UI 挂载与双向同步（零侵入宿主 DOM） ---------------- */
  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('totk-voice-nav-css')) return;
    var st = document.createElement('style');
    st.id = 'totk-voice-nav-css';
    st.textContent =
      '.vn-np-bar{display:flex;align-items:center;gap:6px;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.12);font-size:12px;color:#e8e6e0;}' +
      '.vn-np-select{flex:1;min-width:0;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);color:#eac27e;border-radius:5px;padding:2px 4px;font-size:11.5px;outline:none;cursor:pointer;}' +
      '.vn-np-select option{background:#181b20;color:#e8ecf1;}' +
      '.vn-np-test{background:rgba(234,194,126,.16);border:1px solid rgba(234,194,126,.45);color:#eac27e;border-radius:5px;padding:2px 7px;font-size:11px;cursor:pointer;white-space:nowrap;transition:all .15s;}' +
      '.vn-np-test:hover{background:rgba(234,194,126,.3);color:#fff;}' +
      '.vn-set-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px;}' +
      '.vn-vol-wrap{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#8a93a0;}' +
      '.vn-vol-slider{flex:1;accent-color:#eac27e;cursor:pointer;height:4px;}' +
      '.vn-vol-val{width:34px;text-align:right;font-family:monospace;color:#eac27e;font-size:11.5px;}' +
      '.vn-adv-row{display:flex;align-items:center;gap:6px;margin-top:7px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.08);font-size:11.5px;color:#8a93a0;flex-wrap:wrap;}' +
      '.vn-adv-row.vn-adv-freq-row{border-top:none;margin-top:5px;padding-top:0;justify-content:space-between;}' +
      '.vn-adv-group{display:inline-flex;align-items:center;gap:4px;}' +
      '.vn-adv-num{width:42px!important;height:22px!important;padding:1px 4px!important;font-size:11.5px!important;text-align:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:5px;color:#eac27e;-moz-appearance:textfield;appearance:textfield;}' +
      '.vn-adv-num::-webkit-outer-spin-button,.vn-adv-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}' +
      '.vn-adv-sel{flex:1;max-width:168px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:5px;color:#eac27e;font-size:11px;padding:2px 6px;outline:none;cursor:pointer;}' +
      '.vn-adv-sel option{background:#181b20;color:#e8ecf1;}' +
      '#vnSetPackBtns{display:flex;gap:6px;flex-wrap:nowrap;}' +
      '#vnSetPackBtns .set-opt{padding:3px 10px;font-size:11.5px;text-align:center;white-space:nowrap;flex:0 0 auto;}';
    document.head.appendChild(st);
  }

  function mountNavPanelUI() {
    if (typeof document === 'undefined') return;
    var npBody = document.getElementById('npBody');
    if (!npBody || document.getElementById('vnNavBar')) return;
    var npActions = npBody.querySelector('.np-actions');

    var bar = document.createElement('div');
    bar.id = 'vnNavBar';
    bar.className = 'vn-np-bar';
    bar.innerHTML =
      '<label class="np-chk" id="vnNpChkWrap" title="开启或关闭实时语音导航">' +
        '<input type="checkbox" id="vnNpEnable"> ' +
        '<span id="vnNpLabel">🔊 语音</span>' +
      '</label>' +
      '<select id="vnNpPack" class="vn-np-select" title="选择导航语音角色音色">' +
        '<option value="zelda">塞尔达风</option>' +
        '<option value="yujie">御姐领航员</option>' +
        '<option value="chime">仅感应音</option>' +
        '<option value="tts">系统语音</option>' +
      '</select>' +
      '<button type="button" id="vnNpTest" class="vn-np-test" title="试听当前语音">▶ 试听</button>';

    if (npActions) {
      npBody.insertBefore(bar, npActions);
    } else {
      npBody.appendChild(bar);
    }

    var chk = document.getElementById('vnNpEnable');
    var sel = document.getElementById('vnNpPack');
    var btn = document.getElementById('vnNpTest');

    chk.addEventListener('change', function () {
      ensureAudioCtx();
      setEnabled(this.checked, true);
    });
    sel.addEventListener('change', function () {
      ensureAudioCtx();
      cfg.pack = this.value;
      saveCfg();
      if (cfg.enabled) testPlay();
    });
    btn.addEventListener('click', function () {
      testPlay();
    });
  }

  function mountSettingsModalUI() {
    if (typeof document === 'undefined') return;
    var modal = document.getElementById('settingsModal');
    if (!modal || document.getElementById('vnSettingsSec')) return;
    var trailBtns = document.getElementById('setTrailBtns');
    var anchorSec = trailBtns ? trailBtns.parentNode : null;

    var sec = document.createElement('div');
    sec.id = 'vnSettingsSec';
    sec.className = 'set-sec';
    sec.innerHTML =
      '<div class="set-sec-head">' +
        '<span id="vnSetTitle">语音导航</span>' +
        '<label class="set-switch" title="开启或关闭语音导航"><input type="checkbox" id="vnSetToggle"><i></i></label>' +
      '</div>' +
      '<div class="set-sec-desc" id="vnSetHint">罗盘 8 方位语音指路（塞尔达 / 御姐离线语音）</div>' +
      '<div id="vnSetDetailWrap">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:nowrap">' +
          '<span id="vnPackLbl" style="color:#8a93a0;font-size:11.5px;white-space:nowrap;flex-shrink:0">音色选择</span>' +
          '<div class="set-opts" id="vnSetPackBtns" style="margin-top:0;gap:5px;flex-wrap:nowrap">' +
            '<button type="button" class="set-opt" data-pack="zelda" id="vnBtnZelda" style="white-space:nowrap;padding:3px 8px;font-size:11.5px;flex:0 0 auto">塞尔达</button>' +
            '<button type="button" class="set-opt" data-pack="yujie" id="vnBtnYujie" style="white-space:nowrap;padding:3px 8px;font-size:11.5px;flex:0 0 auto">御姐音</button>' +
            '<button type="button" class="set-opt" data-pack="tts" id="vnBtnTts" style="white-space:nowrap;padding:3px 8px;font-size:11.5px;flex:0 0 auto">系统</button>' +
          '</div>' +
        '</div>' +
        '<div class="set-sub-types" style="margin-top:7px">' +
          '<div class="vn-vol-wrap">' +
            '<span id="vnVolLabel">音量</span>' +
            '<input type="range" id="vnVolRange" class="vn-vol-slider" min="10" max="100" step="5" value="85">' +
            '<span id="vnVolText" class="vn-vol-val">85%</span>' +
            '<button type="button" id="vnSetTestBtn" class="vn-np-test">▶ 试听</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;justify-content:flex-start;gap:8px;margin-top:8px">' +
            '<span id="vnFreqLbl" style="color:#8a93a0;font-size:11.5px;white-space:nowrap">播报频次</span>' +
            '<select id="vnFreqMode" class="vn-adv-sel" style="flex:0 0 auto" title="精简：100m 提醒，25m 到达，±30m 高低差&#10;标准：300m / 100m 提醒，35m 到达，±25m 高低差&#10;详细：500m / 300m / 100m 提醒，50m 到达，±20m 高低差">' +
              '<option value="compact">精简（100m）</option>' +
              '<option value="standard">标准（300/100m）</option>' +
              '<option value="dense">详细（500/300/100m）</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
      '</div>';

    var voiceTabPane = document.getElementById('setTabVoice');
    if (voiceTabPane) {
      voiceTabPane.insertBefore(sec, voiceTabPane.firstChild);
    } else if (anchorSec && anchorSec.nextSibling) {
      modal.insertBefore(sec, anchorSec.nextSibling);
    } else {
      modal.appendChild(sec);
    }

    var toggleInp = document.getElementById('vnSetToggle');
    if (toggleInp) {
      toggleInp.addEventListener('change', function () {
        ensureAudioCtx();
        setEnabled(this.checked, true);
      });
    }

    var packBtns = sec.querySelectorAll('#vnSetPackBtns .set-opt');
    for (var i = 0; i < packBtns.length; i++) {
      packBtns[i].addEventListener('click', function () {
        ensureAudioCtx();
        var p = this.getAttribute('data-pack');
        cfg.enabled = true;
        cfg.pack = p;
        saveCfg();
        testPlay();
      });
    }

    var volRange = document.getElementById('vnVolRange');
    if (volRange) {
      volRange.addEventListener('input', function () {
        cfg.volume = parseInt(this.value, 10) || 80;
        var vt = document.getElementById('vnVolText');
        if (vt) vt.textContent = cfg.volume + '%';
        if (currentAudio) currentAudio.volume = Math.max(0.05, Math.min(1, cfg.volume / 100));
        saveCfg();
      });
    }

    var testBtn = document.getElementById('vnSetTestBtn');
    if (testBtn) {
      testBtn.addEventListener('click', function () { testPlay(); });
    }

    var pills = sec.querySelectorAll('#vnSetPills .set-pill');
    for (var j = 0; j < pills.length; j++) {
      pills[j].addEventListener('click', function () {
        ensureAudioCtx();
        var k = this.getAttribute('data-k');
        if (k && cfg[k] !== undefined) {
          cfg[k] = !cfg[k];
          saveCfg();
          // 激活选项时立刻示范播放对应语音/音效，让玩家秒懂作用
          if (cfg[k] && cfg.enabled) {
            if (k === 'dirDist') speakClips(['dir_ne', 'dist_300'], { interrupt: true });
            else if (k === 'altLayer') speakClips(['alt_up'], { interrupt: true });
            else if (k === 'offCourse') speakClips(['off_course', 'dir_n'], { interrupt: true });
            else if (k === 'chime') playChime('ping');
          }
        }
      });
    }

    var FREQ_PRESETS = {
      compact:  { arriveM: 25, altDiffM: 30 },
      standard: { arriveM: 35, altDiffM: 25 },
      dense:    { arriveM: 50, altDiffM: 20 }
    };
    var selFreq = document.getElementById('vnFreqMode');
    if (selFreq) {
      selFreq.addEventListener('change', function () {
        var fm = this.value || 'standard';
        var preset = FREQ_PRESETS[fm] || FREQ_PRESETS.standard;
        cfg.freqMode = fm;
        cfg.arriveM = preset.arriveM;
        cfg.altDiffM = preset.altDiffM;
        saveCfg();
      });
    }
  }

  function syncUI() {
    if (typeof document === 'undefined') return;
    var en = isEn();

    // 1. 同步 #navPanel 导航面板控件
    var npWrap = document.getElementById('vnNpChkWrap');
    var npChk = document.getElementById('vnNpEnable');
    var npSel = document.getElementById('vnNpPack');
    var npLbl = document.getElementById('vnNpLabel');
    var npTest = document.getElementById('vnNpTest');
    if (npWrap) npWrap.setAttribute('title', tr('voice.enableTip', '开启或关闭实时语音导航', 'Toggle live voice navigation'));
    if (npChk) npChk.checked = !!cfg.enabled;
    if (npSel) {
      npSel.setAttribute('title', tr('voice.packTip', '选择导航语音角色音色', 'Select voice navigation character pack'));
      npSel.value = cfg.pack || 'zelda';
      npSel.disabled = !cfg.enabled;
      npSel.style.opacity = cfg.enabled ? '1' : '0.45';
      var opts = npSel.options;
      if (opts && opts.length >= 4) {
        opts[0].text = tr('voice.pack.zelda', '塞尔达风', 'Princess (Zelda)');
        opts[1].text = tr('voice.pack.yujie', '御姐领航员', 'Navigator (Mature)');
        opts[2].text = tr('voice.pack.chime', '仅感应音', 'Sensor Chime');
        opts[3].text = tr('voice.pack.tts', '系统语音', 'System TTS');
      }
    }
    if (npLbl) npLbl.textContent = tr('voice.navLabel', '🔊 语音', '🔊 Voice');
    if (npTest) {
      npTest.textContent = tr('voice.testBtn', '▶ 试听', '▶ Test');
      npTest.setAttribute('title', tr('voice.testTip', '试听当前语音', 'Test current voice pack'));
    }

    // 2. 同步 #settingsModal 设置弹窗控件
    var setTitle = document.getElementById('vnSetTitle');
    var setHint = document.getElementById('vnSetHint');
    var setToggle = document.getElementById('vnSetToggle');
    if (setTitle) setTitle.textContent = tr('voice.setTitle', '语音导航', 'Voice Navigation');
    if (setHint) setHint.textContent = tr('voice.setHint', '罗盘 8 方位语音指路（塞尔达 / 御姐离线语音）', '8-Compass voice guidance (Zelda / Mature packs)');
    if (setToggle) setToggle.checked = !!cfg.enabled;

    var btnZelda = document.getElementById('vnBtnZelda');
    var btnYujie = document.getElementById('vnBtnYujie');
    var btnTts = document.getElementById('vnBtnTts');
    if (btnZelda) btnZelda.textContent = tr('voice.pack.zeldaShort', '塞尔达', 'Zelda');
    if (btnYujie) btnYujie.textContent = tr('voice.pack.yujieShort', '御姐音', 'Mature');
    if (btnTts) btnTts.textContent = tr('voice.pack.ttsShort', '系统', 'TTS');

    var packBtns = document.querySelectorAll('#vnSetPackBtns .set-opt');
    var activePack = (cfg.pack === 'yujie' || cfg.pack === 'tts') ? cfg.pack : 'zelda';
    for (var i = 0; i < packBtns.length; i++) {
      var b = packBtns[i];
      var match = b.getAttribute('data-pack') === activePack;
      b.classList.toggle('active', match);
      b.classList.toggle('on', match);
    }

    var detailWrap = document.getElementById('vnSetDetailWrap');
    if (detailWrap) {
      detailWrap.style.opacity = cfg.enabled ? '1' : '0.42';
      detailWrap.style.pointerEvents = cfg.enabled ? '' : 'none';
    }

    var volLbl = document.getElementById('vnVolLabel');
    var volRange = document.getElementById('vnVolRange');
    var volText = document.getElementById('vnVolText');
    var setTestBtn = document.getElementById('vnSetTestBtn');
    if (volLbl) volLbl.textContent = tr('voice.volume', '音量', 'Vol');
    if (volRange) volRange.value = String(cfg.volume || 85);
    if (volText) volText.textContent = (cfg.volume || 85) + '%';
    if (setTestBtn) setTestBtn.textContent = tr('voice.testBtn', '▶ 试听', '▶ Test');

    var pillDir = document.getElementById('vnPillDir');
    var pillAlt = document.getElementById('vnPillAlt');
    var pillOff = document.getElementById('vnPillOff');
    var pillChime = document.getElementById('vnPillChime');
    if (pillDir) {
      pillDir.textContent = tr('voice.pill.dirDist', '方向与距离', 'Direction & Dist');
      pillDir.classList.toggle('on', !!cfg.dirDist);
    }
    if (pillAlt) {
      pillAlt.textContent = tr('voice.pill.altLayer', '高低差/跨层', 'Altitude & Layer');
      pillAlt.classList.toggle('on', !!cfg.altLayer);
    }
    if (pillOff) {
      pillOff.textContent = tr('voice.pill.offCourse', '偏航提醒', 'Off-Course Alert');
      pillOff.classList.toggle('on', !!cfg.offCourse);
    }
    if (pillChime) {
      pillChime.textContent = tr('voice.pill.chime', '普尔亚雷达音', 'Purah Sensor Chime');
      pillChime.classList.toggle('on', !!cfg.chime);
    }

    var packLbl = document.getElementById('vnPackLbl');
    if (packLbl) packLbl.textContent = tr('voice.packLbl', '音色选择', 'Voice');
    var freqLbl = document.getElementById('vnFreqLbl');
    if (freqLbl) freqLbl.textContent = tr('voice.adv.freq', '播报频次', 'Frequency');
    var selFreq = document.getElementById('vnFreqMode');
    if (selFreq) {
      selFreq.value = cfg.freqMode || 'standard';
      selFreq.title = en
        ? 'Compact: 100m alert, 25m arrive, ±30m alt\nStandard: 300/100m alert, 35m arrive, ±25m alt\nDetailed: 500/300/100m alert, 50m arrive, ±20m alt'
        : '精简：100m 提醒，25m 到达，±30m 高低差\n标准：300m / 100m 提醒，35m 到达，±25m 高低差\n详细：500m / 300m / 100m 提醒，50m 到达，±20m 高低差';
      var fOpts = selFreq.options;
      if (fOpts && fOpts.length >= 3) {
        fOpts[0].text = tr('voice.freq.compact', '精简（100m）', 'Compact (100m)');
        fOpts[1].text = tr('voice.freq.standard', '标准（300/100m）', 'Standard (300/100m)');
        fOpts[2].text = tr('voice.freq.dense', '详细（500/300/100m）', 'Detailed (500/300/100m)');
      }
    }
  }

  function packDisplayName(pack) {
    if (pack === 'yujie') return tr('voice.pack.yujie', '御姐领航员', 'Navigator (Mature)');
    if (pack === 'chime') return tr('voice.pack.chime', '仅感应音', 'Sensor Chime');
    if (pack === 'tts') return tr('voice.pack.tts', '系统语音', 'System TTS');
    return tr('voice.pack.zelda', '塞尔达风', 'Princess (Zelda)');
  }

  function setEnabled(flag, showToast) {
    cfg.enabled = !!flag;
    if (!cfg.enabled) {
      stopPlayback();
    }
    saveCfg();
    if (showToast && typeof window !== 'undefined' && window.TOTK_APP && typeof window.TOTK_APP.toast === 'function') {
      window.TOTK_APP.toast(cfg.enabled
        ? (isEn() ? ('Voice navigation enabled (' + packDisplayName(cfg.pack) + ')') : ('已开启语音导航（' + packDisplayName(cfg.pack) + '）'))
        : tr('voice.toastOff', '已关闭语音导航', 'Voice navigation disabled'));
    }
  }

  function setPaused(flag) {
    externalPaused = !!flag;
    if (externalPaused) stopPlayback();
  }

  function isPaused() {
    return externalPaused;
  }

  function isSpeaking() {
    if (currentAudio && !currentAudio.paused) return true;
    if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) return true;
    return false;
  }

  function bindAutoplayUnlock() {
    if (audioUnlocked || typeof document === 'undefined') return;
    function unlock() {
      audioUnlocked = true;
      autoplayWarned = false;
      ensureAudioCtx();
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    }
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  function setConfig(patch) {
    if (!patch || typeof patch !== 'object') return cfg;
    for (var k in DEFAULT_CFG) {
      if (patch[k] !== undefined) cfg[k] = patch[k];
    }
    if (!cfg.enabled) stopPlayback();
    saveCfg();
    return getConfig();
  }

  function getConfig() {
    var copy = {};
    for (var k in cfg) copy[k] = cfg[k];
    return copy;
  }

  function resetConfig() {
    for (var k in DEFAULT_CFG) cfg[k] = DEFAULT_CFG[k];
    saveCfg();
    return getConfig();
  }

  function init(opts) {
    opts = opts || {};
    if (opts.basePath) BASE_PATH = opts.basePath;
    if (opts.storageKey) {
      STORAGE_KEY = opts.storageKey;
      cfg = loadCfg();
    }
    if (typeof document !== 'undefined') {
      injectStyles();
      mountNavPanelUI();
      mountSettingsModalUI();
      syncUI();
      bindAutoplayUnlock();

      // 监听语言切换与设置重置按钮，保持零侵入自动同步
      if (typeof window !== 'undefined' && window.I18N && typeof window.I18N.onChange === 'function') {
        window.I18N.onChange(function () { syncUI(); });
      }
      var langBtns = document.getElementById('setLangBtns');
      if (langBtns) {
        langBtns.addEventListener('click', function () {
          setTimeout(syncUI, 50);
        });
      }
      var setReset = document.getElementById('setReset');
      if (setReset) {
        setReset.addEventListener('click', function () {
          resetConfig();
        });
      }
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
    feed: feed,
    setEnabled: setEnabled,
    setPaused: setPaused,
    isPaused: isPaused,
    isSpeaking: isSpeaking,
    setConfig: setConfig,
    getConfig: getConfig,
    resetConfig: resetConfig,
    testPlay: testPlay,
    stop: stopPlayback,
    playChime: playChime,
    calcCompass8: calcCompass8,
    calcBearingDeg: calcBearingDeg,
    pickDistClip: pickDistClip,
    refreshUI: syncUI,
    _state: function () { return state; }
  };
});
