/* ============ 王国之泪互动地图 · 高级设置与显示参数模块 ============
 * 移植自 BOTWmap v1.8.0 高级设置，整合总设置显示调试参数（标签缩放/双行/地名样式/导出 JSON）
 * 支持实时预览、撤销上一步（Undo，最多 30 步）、恢复默认（可撤销）与中英双语。
 * 全局暴露 window.TOTK_ADV 供 totk-map-engine.js / live.js / app.js 读取。
 */
'use strict';

window.TOTK_ADV = (function () {
  var STORAGE_KEY = 'totkmap.adv.v1';
  var MAX_UNDO = 30;

  var DEFAULT_ADV = {
    pcFps: 60,           // 30 | 60 | 90 | 120 | 0 (0 = 跟随显示器)
    mobileFps: 60,       // 30 | 60 | 90 | 120 | 0 (0 = 跟随屏幕)
    mobileDprCap: 2,     // 1 | 2 | 0 (0 = 原生不限制)
    fov: {
      show: true,
      angle: 76,         // 视野总夹角（度，20~160）
      radius: 82,        // 视野半径（px，30~220）
      color: '#fff8d6',
      alphaStart: 56,    // 近端不透明度（0~100%）
      alphaEnd: 0,       // 远端不透明度（0~100%）
      fadeFrom: 0        // 淡化起始比例（0~80%）
    },
    arrow: {
      shape: 'arrow',    // 'arrow' | 'triangle' | 'compass' | 'dot' | 'custom'
      customImg: '',     // DataURL（最大 128x128 PNG）
      customRot: 0,      // 0 | 90 | 180 | 270
      size: 1.0,         // 0.5 ~ 2.5
      color: '#ff3b3b',
      shadow: true,
      shadowBlur: 10,    // 0 ~ 24
      shadowColor: '#ff3232'
    },
    display: {
      labelMinZoom: 6,   // 4 | 5 | 6 | 7
      labelLines: 2,     // 2 = 双行(名+编号) | 1 = 单行
      labelSizeDelta: 0, // -2 ~ +4
      areaSizeScale: 1.0,// 0.7 ~ 1.5
      areaAlpha: 100,    // 20 ~ 100 (%)
      areaColor: '#bfae68'
    }
  };

  function isEn() {
    return !!(window.I18N && window.I18N.getLang && window.I18N.getLang() === 'en');
  }

  function L(zh, en) {
    return isEn() ? en : zh;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function clamp(v, lo, hi, fallback) {
    var n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function mergeDefaults(raw) {
    var d = clone(DEFAULT_ADV);
    if (!raw || typeof raw !== 'object') return d;
    if ([0, 30, 60, 90, 120].indexOf(Number(raw.pcFps)) >= 0) d.pcFps = Number(raw.pcFps);
    if ([0, 30, 60, 90, 120].indexOf(Number(raw.mobileFps)) >= 0) d.mobileFps = Number(raw.mobileFps);
    if ([0, 1, 2].indexOf(Number(raw.mobileDprCap)) >= 0) d.mobileDprCap = Number(raw.mobileDprCap);
    if (raw.fov && typeof raw.fov === 'object') {
      d.fov.show = raw.fov.show !== false;
      d.fov.angle = clamp(raw.fov.angle, 20, 160, d.fov.angle);
      d.fov.radius = clamp(raw.fov.radius, 30, 220, d.fov.radius);
      if (typeof raw.fov.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.fov.color)) d.fov.color = raw.fov.color;
      d.fov.alphaStart = clamp(raw.fov.alphaStart, 0, 100, d.fov.alphaStart);
      d.fov.alphaEnd = clamp(raw.fov.alphaEnd, 0, 100, d.fov.alphaEnd);
      d.fov.fadeFrom = clamp(raw.fov.fadeFrom, 0, 80, d.fov.fadeFrom);
    }
    if (raw.arrow && typeof raw.arrow === 'object') {
      if (['arrow', 'triangle', 'compass', 'dot', 'custom'].indexOf(raw.arrow.shape) >= 0) d.arrow.shape = raw.arrow.shape;
      if (typeof raw.arrow.customImg === 'string' && raw.arrow.customImg.indexOf('data:image/') === 0) {
        d.arrow.customImg = raw.arrow.customImg;
      }
      if ([0, 90, 180, 270].indexOf(Number(raw.arrow.customRot)) >= 0) d.arrow.customRot = Number(raw.arrow.customRot);
      d.arrow.size = clamp(raw.arrow.size, 0.5, 2.5, d.arrow.size);
      if (typeof raw.arrow.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.arrow.color)) d.arrow.color = raw.arrow.color;
      d.arrow.shadow = raw.arrow.shadow !== false;
      d.arrow.shadowBlur = clamp(raw.arrow.shadowBlur, 0, 24, d.arrow.shadowBlur);
      if (typeof raw.arrow.shadowColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.arrow.shadowColor)) d.arrow.shadowColor = raw.arrow.shadowColor;
      if (d.arrow.shape === 'custom' && !d.arrow.customImg) d.arrow.shape = 'arrow';
    }
    if (raw.display && typeof raw.display === 'object') {
      if ([4, 5, 6, 7].indexOf(Number(raw.display.labelMinZoom)) >= 0) d.display.labelMinZoom = Number(raw.display.labelMinZoom);
      if ([1, 2].indexOf(Number(raw.display.labelLines)) >= 0) d.display.labelLines = Number(raw.display.labelLines);
      d.display.labelSizeDelta = clamp(raw.display.labelSizeDelta, -2, 4, d.display.labelSizeDelta);
      d.display.areaSizeScale = clamp(raw.display.areaSizeScale, 0.7, 1.5, d.display.areaSizeScale);
      d.display.areaAlpha = clamp(raw.display.areaAlpha, 20, 100, d.display.areaAlpha);
      if (typeof raw.display.areaColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.display.areaColor)) d.display.areaColor = raw.display.areaColor;
    }
    return d;
  }

  var state = clone(DEFAULT_ADV);
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = mergeDefaults(JSON.parse(saved));
  } catch (e) {}

  function getMap() {
    return (window.TOTK && window.TOTK.map) || null;
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (t) {
      t.innerHTML = msg;
      t.classList.remove('hidden');
      clearTimeout(showToast._tm);
      showToast._tm = setTimeout(function () { t.classList.add('hidden'); }, 2200);
    }
  }

  var customImgEl = null;
  var customImgSrc = '';
  function getCustomImage() {
    var src = state.arrow.customImg;
    if (!src) { customImgEl = null; customImgSrc = ''; return null; }
    if (customImgEl && customImgSrc === src) return customImgEl;
    var img = new Image();
    img.onload = function () {
      renderPreview();
      var m = getMap();
      if (m && m.draw) m.draw({ dynamicOnly: true });
    };
    img.src = src;
    customImgEl = img;
    customImgSrc = src;
    return img;
  }
  getCustomImage();

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function isMobileDevice() {
    if (typeof window === 'undefined') return false;
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)) return true;
    return window.innerWidth <= 820 && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }

  function getFpsCap() {
    return isMobileDevice() ? state.mobileFps : state.pcFps;
  }

  function getEffectiveDpr() {
    var raw = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
    if (isMobileDevice() && state.mobileDprCap > 0) {
      return Math.min(raw, state.mobileDprCap);
    }
    return raw;
  }

  function hexToRgba(hex, alpha) {
    var h = (hex || '#ffffff').replace('#', '');
    var r = parseInt(h.slice(0, 2), 16) || 0;
    var g = parseInt(h.slice(2, 4), 16) || 0;
    var b = parseInt(h.slice(4, 6), 16) || 0;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /* 统一绘制「视野扇形 + 导航箭头」（live.js 地图层 & 弹窗实时预览共用，100% 一致）
   * 角度坐标系：Canvas 坐标（东=0°、南=90°、西=180°、北=-90°） */
  function drawPlayer(ctx, px, py, opts) {
    var verified = !opts || opts.verified !== false;
    var heading = opts ? opts.heading : null;
    var fovAngle = opts ? opts.fovAngle : null;
    var F = state.fov;
    var A = state.arrow;

    // 1) 视野扇形
    if (F.show && typeof fovAngle === 'number' && isFinite(fovAngle)) {
      var fovRad = F.radius;
      var halfCone = (F.angle / 2) * Math.PI / 180;
      var a0 = F.alphaStart / 100;
      var a1 = F.alphaEnd / 100;
      var f0 = Math.min(0.85, Math.max(0, F.fadeFrom / 100));
      var midStop = f0 + (1 - f0) * 0.5;
      var aMid = a0 + (a1 - a0) * 0.55;

      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(fovAngle * Math.PI / 180);
      var grad = ctx.createRadialGradient(0, 0, 2, 0, 0, fovRad);
      grad.addColorStop(0, hexToRgba(F.color, a0));
      if (f0 > 0.02) grad.addColorStop(f0, hexToRgba(F.color, a0));
      grad.addColorStop(midStop, hexToRgba(F.color, aMid));
      grad.addColorStop(1, hexToRgba(F.color, a1));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, fovRad, -halfCone, halfCone);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 2) 导航箭头 / 自定义图标
    var baseRad = (verified ? 8 : 6) * A.size;
    var baseDot = (verified ? 7 : 5) * A.size;
    ctx.save();
    if (A.shadow && A.shadowBlur > 0) {
      ctx.shadowColor = hexToRgba(A.shadowColor, 0.85);
      ctx.shadowBlur = A.shadowBlur;
    }

    var customEl = (A.shape === 'custom') ? getCustomImage() : null;
    if (A.shape === 'custom' && customEl && customEl.complete && customEl.naturalWidth > 0) {
      var sz = Math.round(24 * A.size);
      var rot = ((typeof heading === 'number' && isFinite(heading) ? heading : -90) + A.customRot) * Math.PI / 180;
      ctx.translate(px, py);
      ctx.rotate(rot);
      ctx.drawImage(customEl, -sz / 2, -sz / 2, sz, sz);
    } else if (A.shape === 'dot' || typeof heading !== 'number' || !isFinite(heading)) {
      ctx.fillStyle = A.color;
      ctx.beginPath();
      ctx.arc(px, py, baseDot, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1.5, 2 * A.size);
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(px, py, baseDot + 2.2 * A.size, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.translate(px, py);
      ctx.rotate(heading * Math.PI / 180);
      ctx.beginPath();
      if (A.shape === 'triangle') {
        ctx.moveTo(baseRad * 1.55, 0);
        ctx.lineTo(-baseRad * 0.95, baseRad * 0.92);
        ctx.lineTo(-baseRad * 0.95, -baseRad * 0.92);
      } else if (A.shape === 'compass') {
        ctx.moveTo(baseRad * 1.65, 0);
        ctx.lineTo(0, baseRad * 0.72);
        ctx.lineTo(-baseRad * 1.15, 0);
        ctx.lineTo(0, -baseRad * 0.72);
      } else {
        ctx.moveTo(baseRad * 1.5, 0);
        ctx.lineTo(-baseRad * 0.9, baseRad * 0.85);
        ctx.lineTo(-baseRad * 0.4, 0);
        ctx.lineTo(-baseRad * 0.9, -baseRad * 0.85);
      }
      ctx.closePath();
      ctx.fillStyle = A.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1.4, 1.8 * Math.min(1.4, A.size));
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.restore();
    return baseRad;
  }

  /* ---------- Undo 历史栈 ---------- */
  var undoStack = [];
  var dragSnapshot = null;

  function pushUndo(snap) {
    var s = snap || clone(state);
    var str = JSON.stringify(s);
    if (undoStack.length && JSON.stringify(undoStack[undoStack.length - 1]) === str) return;
    undoStack.push(s);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoBtn();
  }

  function applyChange(mode) {
    // mode: 'dynamic' | 'static' | 'resize'
    save();
    syncModalUI();
    renderPreview();
    var m = getMap();
    if (!m) return;
    if (mode === 'resize' && typeof m._resize === 'function') {
      m._resize();
      if (m._invalidateStatic) m._invalidateStatic();
      if (m._schedDraw) m._schedDraw();
    } else if (mode === 'static') {
      if (m._invalidateStatic) m._invalidateStatic();
      if (m._schedDraw) m._schedDraw();
    } else if (typeof m.draw === 'function') {
      m.draw({ dynamicOnly: true });
    } else if (m._schedDraw) {
      m._schedDraw();
    }
  }

  function undo() {
    if (!undoStack.length) return;
    var prevDpr = state.mobileDprCap;
    var prevDisp = JSON.stringify(state.display);
    state = mergeDefaults(undoStack.pop());
    getCustomImage();
    var mode = (prevDpr !== state.mobileDprCap) ? 'resize'
      : (prevDisp !== JSON.stringify(state.display) ? 'static' : 'dynamic');
    applyChange(mode);
    updateUndoBtn();
    showToast(L('已撤销上一步高级设置', 'Undid last advanced setting'));
  }

  function resetToDefault() {
    if (JSON.stringify(state) === JSON.stringify(DEFAULT_ADV)) return;
    var prevDpr = state.mobileDprCap;
    pushUndo();
    state = clone(DEFAULT_ADV);
    getCustomImage();
    applyChange(prevDpr !== state.mobileDprCap ? 'resize' : 'static');
    showToast(L('高级设置已恢复默认（可点击撤销还原）', 'Advanced settings reset to defaults (undoable)'));
  }

  /* ---------- 屏幕刷新率简测 ---------- */
  var measuredHz = 0;
  function measureDisplayHz(cb) {
    var frames = 0, t0 = 0;
    function step(now) {
      if (!t0) t0 = now;
      frames++;
      if (now - t0 >= 280) {
        measuredHz = Math.round((frames - 1) * 1000 / (now - t0));
        if (cb) cb(measuredHz);
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------- 弹窗 DOM 与预览 ---------- */
  var modalEl = null;
  var previewCanvas = null;
  var renderedLang = '';

  function renderPreview() {
    if (!previewCanvas) return;
    var ctx = previewCanvas.getContext('2d');
    var w = 320, h = 150;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (previewCanvas.width !== w * dpr || previewCanvas.height !== h * dpr) {
      previewCanvas.width = w * dpr;
      previewCanvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#131b14';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(230, 205, 143, 0.08)';
    ctx.lineWidth = 1;
    for (var x = 20; x < w; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (var y = 20; y < h; y += 24) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    drawPlayer(ctx, 118, 92, { verified: true, heading: -30, fovAngle: -30 });

    ctx.fillStyle = 'rgba(232,240,228,.55)';
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    var fps = getFpsCap();
    var fpsTxt = fps
      ? (fps + 'Hz')
      : (measuredHz ? L('随系统(' + measuredHz + 'Hz)', 'Auto(' + measuredHz + 'Hz)') : L('随系统', 'Auto'));
    var devTxt = isMobileDevice() ? L('手机', 'Mobile') : 'PC';
    ctx.fillText(L('预览 · ', 'Preview · ') + devTxt + ' ' + fpsTxt + ' · DPR ' + getEffectiveDpr().toFixed(1), w - 8, h - 6);
  }

  function updateUndoBtn() {
    if (!modalEl) return;
    var btn = modalEl.querySelector('#advUndo');
    if (!btn) return;
    btn.disabled = undoStack.length === 0;
    btn.textContent = undoStack.length
      ? (L('撤销', 'Undo') + ' (' + undoStack.length + ')')
      : L('撤销', 'Undo');
  }

  function setGroupActive(groupId, val) {
    if (!modalEl) return;
    var wrap = modalEl.querySelector('#' + groupId);
    if (!wrap) return;
    var matched = false;
    wrap.querySelectorAll('.st-opt[data-v]').forEach(function (b) {
      var hit = String(b.dataset.v) === String(val);
      if (hit) matched = true;
      b.classList.toggle('sel', hit);
    });
    var picker = wrap.querySelector('.st-picker');
    if (picker) picker.classList.toggle('sel', !matched);
    var upload = wrap.querySelector('.adv-upload-btn');
    if (upload) upload.classList.toggle('sel', String(val) === 'custom');
  }

  function setRange(id, val, fmt) {
    if (!modalEl) return;
    var el = modalEl.querySelector('#' + id);
    var out = modalEl.querySelector('#' + id + 'V');
    if (el) el.value = val;
    if (out) out.textContent = fmt ? fmt(val) : String(val);
  }

  function syncModalUI() {
    if (!modalEl) return;
    setGroupActive('advPcFps', state.pcFps);
    setGroupActive('advMobFps', state.mobileFps);
    setGroupActive('advMobDpr', state.mobileDprCap);

    setGroupActive('advFovShow', state.fov.show ? '1' : '0');
    setRange('advFovAngle', state.fov.angle, function (v) { return v + '°'; });
    setRange('advFovRadius', state.fov.radius, function (v) { return v + 'px'; });
    setRange('advFovAlphaStart', state.fov.alphaStart, function (v) { return v + '%'; });
    setRange('advFovAlphaEnd', state.fov.alphaEnd, function (v) { return v + '%'; });
    setRange('advFovFadeFrom', state.fov.fadeFrom, function (v) { return v + '%'; });
    var fc = modalEl.querySelector('#advFovColor');
    if (fc) fc.value = state.fov.color;
    setGroupActive('advFovColorPresets', state.fov.color.toLowerCase());

    setGroupActive('advArrowShape', state.arrow.shape);
    setGroupActive('advArrowRot', state.arrow.customRot);
    setRange('advArrowSize', state.arrow.size, function (v) { return Number(v).toFixed(1) + 'x'; });
    var ac = modalEl.querySelector('#advArrowColor');
    if (ac) ac.value = state.arrow.color;
    setGroupActive('advArrowColorPresets', state.arrow.color.toLowerCase());

    setGroupActive('advArrowShadow', state.arrow.shadow ? '1' : '0');
    setRange('advArrowShadowBlur', state.arrow.shadowBlur, function (v) { return v + 'px'; });
    var sc = modalEl.querySelector('#advArrowShadowColor');
    if (sc) sc.value = state.arrow.shadowColor;

    var customWrap = modalEl.querySelector('#advCustomImgRow');
    if (customWrap) customWrap.classList.toggle('hidden', state.arrow.shape !== 'custom' && !state.arrow.customImg);
    var clearBtn = modalEl.querySelector('#advClearCustomImg');
    if (clearBtn) clearBtn.classList.toggle('hidden', !state.arrow.customImg);

    setGroupActive('advDispLabelZoom', state.display.labelMinZoom);
    setGroupActive('advDispLabelLines', state.display.labelLines);
    setRange('advDispLabelSize', state.display.labelSizeDelta, function (v) { return (v > 0 ? '+' : '') + v + 'px'; });
    setRange('advDispAreaScale', state.display.areaSizeScale, function (v) { return Number(v).toFixed(1) + 'x'; });
    setRange('advDispAreaAlpha', state.display.areaAlpha, function (v) { return v + '%'; });
    var arc = modalEl.querySelector('#advDispAreaColor');
    if (arc) arc.value = state.display.areaColor;
    setGroupActive('advDispAreaColorPresets', state.display.areaColor.toLowerCase());

    var hzHint = modalEl.querySelector('#advHzHint');
    if (hzHint) {
      var dev = isMobileDevice() ? L('手机端', 'Mobile') : L('PC端', 'Desktop');
      hzHint.textContent = measuredHz
        ? (dev + ' · ' + L('屏幕约 ', 'Screen ~') + measuredHz + 'Hz')
        : dev;
    }
    updateUndoBtn();
  }

  function buildModalHTML() {
    var autoTxt = L('随系统', 'Auto');
    var customTxt = L('自选', 'Pick');
    return '' +
      '<div class="adv-dialog" role="dialog" aria-modal="true" aria-label="' + L('更多高级设置', 'Advanced Settings') + '">' +
        '<div class="adv-head">' +
          '<div class="adv-title-wrap">' +
            '<span class="adv-title">' + L('高级设置', 'Advanced Settings') + '</span>' +
            '<span class="adv-sub" id="advHzHint"></span>' +
          '</div>' +
          '<button type="button" id="advClose" class="detail-close" title="' + L('关闭', 'Close') + '">×</button>' +
        '</div>' +

        '<div class="adv-preview-bar">' +
          '<canvas id="advPreviewCanvas" class="adv-preview-canvas"></canvas>' +
        '</div>' +

        '<div class="adv-body">' +
          /* 1. 刷新率与画质（默认展开） */
          '<div class="adv-sec">' +
            '<button type="button" class="adv-sec-title"><span>' + L('刷新率与画质', 'Refresh Rate & Quality') + '</span><span class="adv-sec-tri">▾</span></button>' +
            '<div class="adv-sec-body">' +
              '<div class="adv-item">' +
                '<div class="adv-item-label">' + L('PC地图刷新率', 'Desktop FPS Cap') + ' <span class="adv-def">' + L('默认 60Hz', 'Default 60Hz') + '</span></div>' +
                '<div class="adv-opts" id="advPcFps">' +
                  '<button type="button" class="st-opt" data-v="30">30Hz</button>' +
                  '<button type="button" class="st-opt" data-v="60">60Hz</button>' +
                  '<button type="button" class="st-opt" data-v="90">90Hz</button>' +
                  '<button type="button" class="st-opt" data-v="120">120Hz</button>' +
                  '<button type="button" class="st-opt" data-v="0">' + autoTxt + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-item">' +
                '<div class="adv-item-label">' + L('手机地图刷新率', 'Mobile FPS Cap') + ' <span class="adv-def">' + L('默认 60Hz', 'Default 60Hz') + '</span></div>' +
                '<div class="adv-opts" id="advMobFps">' +
                  '<button type="button" class="st-opt" data-v="30">30Hz</button>' +
                  '<button type="button" class="st-opt" data-v="60">60Hz</button>' +
                  '<button type="button" class="st-opt" data-v="90">90Hz</button>' +
                  '<button type="button" class="st-opt" data-v="120">120Hz</button>' +
                  '<button type="button" class="st-opt" data-v="0">' + autoTxt + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('手机清晰度', 'Mobile DPR') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advMobDpr">' +
                  '<button type="button" class="st-opt" data-v="1">1x</button>' +
                  '<button type="button" class="st-opt" data-v="2">2x</button>' +
                  '<button type="button" class="st-opt" data-v="0">' + L('原生', 'Native') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          /* 2. 视野设置（默认折叠） */
          '<div class="adv-sec collapsed">' +
            '<button type="button" class="adv-sec-title"><span>' + L('视野设置', 'Field of View (FOV)') + '</span><span class="adv-sec-tri">▸</span></button>' +
            '<div class="adv-sec-body">' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('视野显示', 'Show FOV') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advFovShow">' +
                  '<button type="button" class="st-opt" data-v="1">' + L('显示', 'Show') + '</button>' +
                  '<button type="button" class="st-opt" data-v="0">' + L('隐藏', 'Hide') + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('视野角度', 'FOV Angle') + '</span>' +
                '<input type="range" id="advFovAngle" min="20" max="160" step="2" value="76">' +
                '<span id="advFovAngleV" class="st-sval">76°</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('视野距离', 'FOV Range') + '</span>' +
                '<input type="range" id="advFovRadius" min="30" max="220" step="2" value="82">' +
                '<span id="advFovRadiusV" class="st-sval">82px</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('近端透明', 'Near Alpha') + '</span>' +
                '<input type="range" id="advFovAlphaStart" min="0" max="100" step="1" value="56">' +
                '<span id="advFovAlphaStartV" class="st-sval">56%</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('远端透明', 'Far Alpha') + '</span>' +
                '<input type="range" id="advFovAlphaEnd" min="0" max="100" step="1" value="0">' +
                '<span id="advFovAlphaEndV" class="st-sval">0%</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('淡化起点', 'Fade Start') + '</span>' +
                '<input type="range" id="advFovFadeFrom" min="0" max="80" step="2" value="0">' +
                '<span id="advFovFadeFromV" class="st-sval">0%</span>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('视野颜色', 'FOV Color') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advFovColorPresets">' +
                  '<button type="button" class="st-opt" data-v="#fff8d6">' + L('暖白', 'Warm') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#4cd4f2">' + L('蓝', 'Blue') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#9adc5c">' + L('绿', 'Green') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#ffd166">' + L('金', 'Gold') + '</button>' +
                  '<label class="st-opt st-picker"><span>' + customTxt + '</span><input type="color" id="advFovColor" value="#fff8d6"></label>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +

          /* 3. 导航箭头（默认折叠） */
          '<div class="adv-sec collapsed">' +
            '<button type="button" class="adv-sec-title"><span>' + L('导航箭头', 'Player Arrow') + '</span><span class="adv-sec-tri">▸</span></button>' +
            '<div class="adv-sec-body">' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('图标样式', 'Shape') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advArrowShape">' +
                  '<button type="button" class="st-opt" data-v="arrow">' + L('箭头', 'Arrow') + '</button>' +
                  '<button type="button" class="st-opt" data-v="triangle">' + L('三角', 'Tri') + '</button>' +
                  '<button type="button" class="st-opt" data-v="compass">' + L('罗盘', 'Diamond') + '</button>' +
                  '<button type="button" class="st-opt" data-v="dot">' + L('圆点', 'Dot') + '</button>' +
                  '<label class="st-opt adv-upload-btn"><span>' + L('上传', 'Upload') + '</span><input type="file" id="advArrowUpload" accept="image/*" style="display:none"></label>' +
                '</div>' +
              '</div>' +
              '<div class="adv-row-inline hidden" id="advCustomImgRow">' +
                '<span class="adv-rl">' + L('图片朝向', 'Rotation') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advArrowRot">' +
                  '<button type="button" class="st-opt" data-v="0">0°</button>' +
                  '<button type="button" class="st-opt" data-v="90">90°</button>' +
                  '<button type="button" class="st-opt" data-v="180">180°</button>' +
                  '<button type="button" class="st-opt" data-v="270">270°</button>' +
                  '<button type="button" class="st-opt adv-danger-opt hidden" id="advClearCustomImg">' + L('清除', 'Clear') + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('图标大小', 'Scale') + '</span>' +
                '<input type="range" id="advArrowSize" min="0.5" max="2.5" step="0.1" value="1.0">' +
                '<span id="advArrowSizeV" class="st-sval">1.0x</span>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('图标颜色', 'Color') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advArrowColorPresets">' +
                  '<button type="button" class="st-opt" data-v="#ff3b3b">' + L('红', 'Red') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#4cd4f2">' + L('蓝', 'Blue') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#f2c94c">' + L('金', 'Gold') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#4ade80">' + L('绿', 'Green') + '</button>' +
                  '<label class="st-opt st-picker"><span>' + customTxt + '</span><input type="color" id="advArrowColor" value="#ff3b3b"></label>' +
                '</div>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('图标阴影', 'Shadow') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advArrowShadow">' +
                  '<button type="button" class="st-opt" data-v="1">' + L('开', 'On') + '</button>' +
                  '<button type="button" class="st-opt" data-v="0">' + L('关', 'Off') + '</button>' +
                  '<label class="st-opt st-picker"><span>' + L('颜色', 'Color') + '</span><input type="color" id="advArrowShadowColor" value="#ff3232"></label>' +
                '</div>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('阴影范围', 'Blur') + '</span>' +
                '<input type="range" id="advArrowShadowBlur" min="0" max="24" step="1" value="10">' +
                '<span id="advArrowShadowBlurV" class="st-sval">10px</span>' +
              '</div>' +
            '</div>' +
          '</div>' +

          /* 4. 地图与标签显示（原总设置显示调试参数，默认折叠） */
          '<div class="adv-sec collapsed">' +
            '<button type="button" class="adv-sec-title"><span>' + L('地图与标签显示', 'Map & Label Display') + '</span><span class="adv-sec-tri">▸</span></button>' +
            '<div class="adv-sec-body">' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('标签缩放', 'Label Zoom') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advDispLabelZoom">' +
                  '<button type="button" class="st-opt" data-v="4">z4</button>' +
                  '<button type="button" class="st-opt" data-v="5">z5</button>' +
                  '<button type="button" class="st-opt" data-v="6">z6</button>' +
                  '<button type="button" class="st-opt" data-v="7">z7</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('标签行数', 'Label Mode') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advDispLabelLines">' +
                  '<button type="button" class="st-opt" data-v="2">' + L('双行(含编号)', '2-Line (+No)') + '</button>' +
                  '<button type="button" class="st-opt" data-v="1">' + L('单行(仅名称)', '1-Line') + '</button>' +
                '</div>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('标签字号', 'Label Size') + '</span>' +
                '<input type="range" id="advDispLabelSize" min="-2" max="4" step="1" value="0">' +
                '<span id="advDispLabelSizeV" class="st-sval">0px</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('地名字号', 'Area Size') + '</span>' +
                '<input type="range" id="advDispAreaScale" min="0.7" max="1.5" step="0.1" value="1.0">' +
                '<span id="advDispAreaScaleV" class="st-sval">1.0x</span>' +
              '</div>' +
              '<div class="adv-slider-row">' +
                '<span class="adv-rl">' + L('地名透明', 'Area Alpha') + '</span>' +
                '<input type="range" id="advDispAreaAlpha" min="20" max="100" step="5" value="100">' +
                '<span id="advDispAreaAlphaV" class="st-sval">100%</span>' +
              '</div>' +
              '<div class="adv-row-inline">' +
                '<span class="adv-rl">' + L('地名颜色', 'Area Color') + '</span>' +
                '<div class="adv-opts adv-opts-inline" id="advDispAreaColorPresets">' +
                  '<button type="button" class="st-opt" data-v="#bfae68">' + L('金褐', 'Gold') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#ffffff">' + L('白', 'White') + '</button>' +
                  '<button type="button" class="st-opt" data-v="#7ef2c8">' + L('青绿', 'Teal') + '</button>' +
                  '<label class="st-opt st-picker"><span>' + customTxt + '</span><input type="color" id="advDispAreaColor" value="#bfae68"></label>' +
                '</div>' +
              '</div>' +
              '<div class="adv-row-inline" style="margin-top:10px">' +
                '<span class="adv-rl">' + L('参数导出', 'Export') + '</span>' +
                '<div class="adv-opts adv-opts-inline">' +
                  '<button type="button" class="st-opt" id="advExportJson">' + L('复制 JSON 配置', 'Copy JSON Config') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="adv-foot">' +
          '<div class="adv-foot-left">' +
            '<button type="button" id="advUndo" class="set-ghost" disabled>' + L('撤销', 'Undo') + '</button>' +
            '<button type="button" id="advReset" class="set-ghost">' + L('重置', 'Reset') + '</button>' +
          '</div>' +
          '<button type="button" id="advDone" class="set-ghost adv-primary">' + L('完成', 'Done') + '</button>' +
        '</div>' +
      '</div>';
  }

  function bindGroup(id, setter, mode) {
    var wrap = modalEl.querySelector('#' + id);
    if (!wrap) return;
    wrap.querySelectorAll('.st-opt[data-v]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pushUndo();
        setter(btn.dataset.v);
        applyChange(mode || 'dynamic');
      });
    });
  }

  function bindRange(id, setter, mode) {
    var el = modalEl.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('pointerdown', function () { dragSnapshot = clone(state); });
    el.addEventListener('input', function () {
      if (!dragSnapshot) dragSnapshot = clone(state);
      setter(Number(el.value));
      applyChange(mode || 'dynamic');
    });
    el.addEventListener('change', function () {
      if (dragSnapshot) {
        pushUndo(dragSnapshot);
        dragSnapshot = null;
      }
    });
  }

  function bindColor(id, setter, mode) {
    var el = modalEl.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('focus', function () { dragSnapshot = clone(state); });
    el.addEventListener('input', function () {
      if (!dragSnapshot) dragSnapshot = clone(state);
      setter(el.value);
      applyChange(mode || 'dynamic');
    });
    el.addEventListener('change', function () {
      if (dragSnapshot) {
        pushUndo(dragSnapshot);
        dragSnapshot = null;
      }
    });
  }

  function handleCustomUpload(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var maxSide = 128;
        var scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        var cw = Math.max(16, Math.round(img.naturalWidth * scale));
        var ch = Math.max(16, Math.round(img.naturalHeight * scale));
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        var dataUrl = c.toDataURL('image/png');
        pushUndo();
        state.arrow.customImg = dataUrl;
        state.arrow.shape = 'custom';
        getCustomImage();
        applyChange('dynamic');
        showToast(L('已应用自定义导航图标', 'Custom player icon applied'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function ensureModal() {
    var curL = isEn() ? 'en' : 'zh';
    if (modalEl && renderedLang === curL) return;
    renderedLang = curL;
    modalEl = document.getElementById('advModal');
    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'advModal';
      modalEl.className = 'adv-overlay hidden';
      document.body.appendChild(modalEl);
    }
    modalEl.innerHTML = buildModalHTML();
    previewCanvas = modalEl.querySelector('#advPreviewCanvas');

    var closeModal = function () { modalEl.classList.add('hidden'); };
    modalEl.querySelector('#advClose').addEventListener('click', closeModal);
    modalEl.querySelector('#advDone').addEventListener('click', closeModal);
    if (!modalEl._bgBound) {
      modalEl._bgBound = true;
      modalEl.addEventListener('click', function (e) { if (e.target === modalEl) closeModal(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modalEl && !modalEl.classList.contains('hidden')) closeModal();
      });
    }

    modalEl.querySelector('#advUndo').addEventListener('click', undo);
    modalEl.querySelector('#advReset').addEventListener('click', resetToDefault);

    modalEl.querySelectorAll('.adv-sec-title').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sec = btn.closest('.adv-sec');
        if (!sec) return;
        var collapsed = sec.classList.toggle('collapsed');
        var tri = btn.querySelector('.adv-sec-tri');
        if (tri) tri.textContent = collapsed ? '▸' : '▾';
      });
    });

    bindGroup('advPcFps', function (v) { state.pcFps = Number(v); }, 'dynamic');
    bindGroup('advMobFps', function (v) { state.mobileFps = Number(v); }, 'dynamic');
    bindGroup('advMobDpr', function (v) { state.mobileDprCap = Number(v); }, 'resize');

    bindGroup('advFovShow', function (v) { state.fov.show = (v === '1'); }, 'dynamic');
    bindRange('advFovAngle', function (v) { state.fov.angle = v; }, 'dynamic');
    bindRange('advFovRadius', function (v) { state.fov.radius = v; }, 'dynamic');
    bindRange('advFovAlphaStart', function (v) { state.fov.alphaStart = v; }, 'dynamic');
    bindRange('advFovAlphaEnd', function (v) { state.fov.alphaEnd = v; }, 'dynamic');
    bindRange('advFovFadeFrom', function (v) { state.fov.fadeFrom = v; }, 'dynamic');
    bindGroup('advFovColorPresets', function (v) { state.fov.color = v; }, 'dynamic');
    bindColor('advFovColor', function (v) { state.fov.color = v; }, 'dynamic');

    bindGroup('advArrowShape', function (v) { state.arrow.shape = v; }, 'dynamic');
    bindGroup('advArrowRot', function (v) { state.arrow.customRot = Number(v); }, 'dynamic');
    bindRange('advArrowSize', function (v) { state.arrow.size = v; }, 'dynamic');
    bindGroup('advArrowColorPresets', function (v) { state.arrow.color = v; }, 'dynamic');
    bindColor('advArrowColor', function (v) { state.arrow.color = v; }, 'dynamic');
    bindGroup('advArrowShadow', function (v) { state.arrow.shadow = (v === '1'); }, 'dynamic');
    bindRange('advArrowShadowBlur', function (v) { state.arrow.shadowBlur = v; }, 'dynamic');
    bindColor('advArrowShadowColor', function (v) { state.arrow.shadowColor = v; }, 'dynamic');

    bindGroup('advDispLabelZoom', function (v) { state.display.labelMinZoom = Number(v); }, 'static');
    bindGroup('advDispLabelLines', function (v) { state.display.labelLines = Number(v); }, 'static');
    bindRange('advDispLabelSize', function (v) { state.display.labelSizeDelta = v; }, 'static');
    bindRange('advDispAreaScale', function (v) { state.display.areaSizeScale = v; }, 'static');
    bindRange('advDispAreaAlpha', function (v) { state.display.areaAlpha = v; }, 'static');
    bindGroup('advDispAreaColorPresets', function (v) { state.display.areaColor = v; }, 'static');
    bindColor('advDispAreaColor', function (v) { state.display.areaColor = v; }, 'static');

    var expBtn = modalEl.querySelector('#advExportJson');
    if (expBtn) {
      expBtn.addEventListener('click', function () {
        var jsonStr = JSON.stringify(state, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(jsonStr).then(function () {
            showToast(L('已复制当前高级配置 JSON', 'Advanced config JSON copied'));
          }).catch(function () {
            window.prompt(L('复制配置 JSON：', 'Copy config JSON:'), jsonStr);
          });
        } else {
          window.prompt(L('复制配置 JSON：', 'Copy config JSON:'), jsonStr);
        }
      });
    }

    var up = modalEl.querySelector('#advArrowUpload');
    if (up) {
      up.addEventListener('change', function () {
        if (up.files && up.files[0]) handleCustomUpload(up.files[0]);
        up.value = '';
      });
    }
    var clr = modalEl.querySelector('#advClearCustomImg');
    if (clr) {
      clr.addEventListener('click', function () {
        pushUndo();
        state.arrow.customImg = '';
        if (state.arrow.shape === 'custom') state.arrow.shape = 'arrow';
        getCustomImage();
        applyChange('dynamic');
      });
    }
  }

  function open() {
    ensureModal();
    var sm = document.getElementById('settingsModal');
    if (sm) sm.classList.add('hidden');
    modalEl.classList.remove('hidden');
    syncModalUI();
    renderPreview();
    measureDisplayHz(function () { syncModalUI(); renderPreview(); });
  }

  function bindEntryButton() {
    var btn = document.getElementById('btnAdvSettings');
    if (btn && !btn._advBound) {
      btn._advBound = true;
      btn.addEventListener('click', open);
    }
    try {
      var sp = new URLSearchParams(location.search);
      if (sp.get('debug') === '1') {
        setTimeout(open, 350);
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEntryButton);
  } else {
    bindEntryButton();
  }

  return {
    get s() { return state; },
    D: DEFAULT_ADV,
    open: open,
    undo: undo,
    reset: resetToDefault,
    getFpsCap: getFpsCap,
    getEffectiveDpr: getEffectiveDpr,
    isMobileDevice: isMobileDevice,
    drawPlayer: drawPlayer
  };
})();
