/**
 * TOTKmap 工业级 Canvas 高性能标点渲染图层
 * 基于 Leaflet 官方 L.Canvas 核心派生，继承原生 zoomanim 硬件加速 3D Transform
 * 彻底实现：万级标点 60fps 极速渲染 + 缩放动画 100% 贴合底图 0 漂移
 */
(function (root, factory) {
  'use strict';
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TotkCanvasLayer = factory();
  }
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var ImageCache = {};

  function getMarkerLatLng(m) {
    if (!m) return null;
    if (Array.isArray(m)) {
      return (m.length >= 2 && !isNaN(m[0]) && !isNaN(m[1])) ? [Number(m[0]), Number(m[1])] : null;
    }
    // 1. 常规标点（有 x 和 y）：x 为 lat，y 为 lng（z 为高度）
    if (m.x !== undefined && m.y !== undefined && m.x !== null && m.y !== null) {
      var lat = Number(m.x);
      var lng = Number(m.y);
      if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
    }
    // 2. 原生 lat / lng
    if (m.lat !== undefined && m.lng !== undefined && m.lat !== null && m.lng !== null) {
      var lat = Number(m.lat);
      var lng = Number(m.lng);
      if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
    }
    // 3. 大世界宝箱（无 y，有 z (lat) 和 x (lng)）
    if (m.z !== undefined && m.x !== undefined && m.z !== null && m.x !== null) {
      var bLat = Number(m.z);
      var bLng = Number(m.x);
      if (!isNaN(bLat) && !isNaN(bLng)) return [bLat, bLng];
    }
    // 4. 3D 坐标 pos_3d: [x, y, z] -> [z, x]
    if (m.pos_3d && Array.isArray(m.pos_3d) && m.pos_3d.length >= 3) {
      var pLat = Number(m.pos_3d[2]);
      var pLng = Number(m.pos_3d[0]);
      if (!isNaN(pLat) && !isNaN(pLng)) return [pLat, pLng];
    }
    return null;
  }

  function resolveIconUrl(m, options) {
    if (options && typeof options.getIconUrl === 'function') {
      var custom = options.getIconUrl(m);
      if (custom) return custom;
    }
    if (m.iconUrl) return m.iconUrl;
    if (m.icon) {
      if (m.icon.indexOf('/') !== -1 || m.icon.indexOf('data:') === 0 || m.icon.indexOf('http') === 0) return m.icon;
      return 'assets/icons/' + m.icon;
    }
    if (m.drop || m.drop_zh || m.type === 'chest' || (m.id && String(m.id).indexOf('c_') === 0)) {
      return 'assets/icons/origin_3845393_77466.png';
    }
    return null;
  }

  function checkIsDone(m, options) {
    if (options && typeof options.isDone === 'function') {
      return !!options.isDone(m);
    }
    var doneId = m.korokStartId || m.id;
    return !!(m.isDone || m.done || (m.state && m.state.done));
  }

  function getLeaflet() {
    if (typeof window !== 'undefined' && window.L) return window.L;
    if (typeof global !== 'undefined' && global.L) return global.L;
    return null;
  }

  var L = getLeaflet();
  var Base = (L && L.Canvas) ? L.Canvas : function () {};

  var protoMethods = {
    options: {
      padding: 0.2,        // 视口外扩展 20%
      pane: 'overlayPane',
      hitRadius: 14,
      showNames: false,
      labelMinZoom: 5,
      getMarkerSize: null,
      getIconUrl: null,
      isDone: null,
      getLabel: null
    },

    initialize: function (mapOrOptions, maybeOptions) {
      var options = {};
      var directMap = null;
      if (mapOrOptions && (mapOrOptions.getContainer || mapOrOptions._container)) {
        directMap = mapOrOptions;
        options = maybeOptions || {};
      } else if (mapOrOptions && typeof mapOrOptions === 'object') {
        options = mapOrOptions;
      }

      var curL = getLeaflet();
      if (Base.prototype && Base.prototype.initialize) {
        Base.prototype.initialize.call(this, options);
      }
      if (curL && curL.Util && curL.Util.setOptions) {
        curL.Util.setOptions(this, options);
      } else {
        this.options = Object.assign({}, protoMethods.options, options);
      }

      this._data = [];
      this._visibleMarkers = [];
      this._hoveredMarker = null;
      this._customEvents = {};

      if (directMap) {
        this.addTo(directMap);
      }
    },

    addTo: function (map) {
      if (Base.prototype && Base.prototype.addTo) {
        Base.prototype.addTo.call(this, map);
      } else {
        this._map = map;
        this.onAdd(map);
      }
      return this;
    },

    onAdd: function (map) {
      this._map = map;
      if (Base.prototype && Base.prototype.onAdd) {
        Base.prototype.onAdd.call(this, map);
      }
      this._bindEvents();
      this.redraw();
      return this;
    },

    onRemove: function (map) {
      this._unbindEvents();
      if (Base.prototype && Base.prototype.onRemove) {
        Base.prototype.onRemove.call(this, map);
      }
      return this;
    },

    setData: function (data) {
      this._data = Array.isArray(data) ? data : [];
      this.redraw();
      return this;
    },

    getData: function () {
      return this._data;
    },

    setShowNames: function (show) {
      this.options.showNames = !!show;
      this.redraw();
      return this;
    },

    redraw: function () {
      if (this._map) {
        this._updatePaths();
      }
      return this;
    },

    clear: function () {
      this._data = [];
      this._visibleMarkers = [];
      this.redraw();
      return this;
    },

    on: function (event, fn) {
      if (!this._customEvents[event]) this._customEvents[event] = [];
      this._customEvents[event].push(fn);
      return this;
    },

    off: function (event, fn) {
      if (!event) { this._customEvents = {}; return this; }
      if (!fn) { delete this._customEvents[event]; return this; }
      var list = this._customEvents[event];
      if (list) {
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i] === fn) list.splice(i, 1);
        }
      }
      return this;
    },

    fire: function (event, data, origEvent) {
      var list = this._customEvents[event];
      if (!list || !list.length) return this;
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].call(this, data, origEvent);
        } catch (err) {
          console.error('[TotkCanvasLayer] Error in ' + event + ' handler:', err);
        }
      }
      return this;
    },

    _getImage: function (url) {
      if (!url) return null;
      if (ImageCache[url]) {
        return (ImageCache[url].complete && ImageCache[url].naturalWidth > 0) ? ImageCache[url] : null;
      }
      var self = this;
      var img = new Image();
      img.onload = function () {
        self.redraw();
      };
      img.onerror = function () {
        img._failed = true;
      };
      img.src = url;
      ImageCache[url] = img;
      return null;
    },

    // 核心绘制管线：由 Leaflet _update 驱动，坐标系完全是 layerPoint，缩放动画完全由 _updateTransform 硬件锁定
    _updatePaths: function () {
      if (!this._map || !this._ctx) return;

      var ctx = this._ctx;
      var map = this._map;
      var bounds = this._bounds; // 这是 L.Bounds (layerPoint)
      var currentZoom = map.getZoom();

      // 关键：每次重绘前彻底擦除画布内容，保证点击清空图层瞬间 0ms 秒清（无需缩放触发）
      if (bounds) {
        var minPt = bounds.min;
        var bSz = bounds.getSize();
        ctx.clearRect(minPt.x - bSz.x, minPt.y - bSz.y, bSz.x * 3, bSz.y * 3);
      } else if (this._container) {
        ctx.clearRect(-10000, -10000, 20000, 20000);
      }

      var data = this._data;
      var len = data.length;
      var visibleMarkers = [];
      var labelList = [];
      var hitRadiusDefault = this.options.hitRadius || 14;

      for (var i = 0; i < len; i++) {
        var m = data[i];
        if (!m) continue;

        var latlng = getMarkerLatLng(m);
        if (!latlng) continue;

        // 经纬度换算为 LayerPoint
        var lp = map.latLngToLayerPoint(latlng);
        var x = lp.x;
        var y = lp.y;

        // 视口边界缓冲裁剪
        if (bounds) {
          var pad = this.options.padding || 0.2;
          var bSize = bounds.getSize();
          if (x < bounds.min.x - bSize.x * pad || x > bounds.max.x + bSize.x * pad ||
              y < bounds.min.y - bSize.y * pad || y > bounds.max.y + bSize.y * pad) {
            continue;
          }
        }

        var isDone = checkIsDone(m, this.options);

        var size = this.options.markerSize || 24;
        if (typeof this.options.getMarkerSize === 'function') {
          size = this.options.getMarkerSize(m, currentZoom);
        } else if (m.size) {
          size = m.size;
        }
        if (!size || isNaN(size) || size <= 0) size = 24;

        ctx.save();

        // 完成状态置灰半透明（BOTWmap 规范：0.45）
        if (isDone) {
          ctx.globalAlpha = 0.45;
        } else {
          ctx.globalAlpha = 1.0;
        }

        var iconUrl = resolveIconUrl(m, this.options);
        var img = iconUrl ? this._getImage(iconUrl) : null;

        if (img) {
          ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
        } else {
          // 优雅兜底小圆点
          ctx.beginPath();
          ctx.arc(x, y, Math.max(4, size * 0.35), 0, Math.PI * 2);
          ctx.fillStyle = m.color || '#3498db';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // 经典绿色矢量对勾（100% 移植 BOTWmap 源码算法）
        if (isDone) {
          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = '#7dffa0';
          ctx.lineWidth = Math.max(1.5, size * 0.16);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          ctx.moveTo(x - size * 0.22, y);
          ctx.lineTo(x - size * 0.05, y + size * 0.18);
          ctx.lineTo(x + size * 0.26, y - size * 0.16);
          ctx.stroke();
        }

        ctx.restore();

        visibleMarkers.push({
          marker: m,
          x: x,
          y: y,
          size: size,
          radius: (m.hitRadius || m.radius || hitRadiusDefault)
        });

        // 标签收集（BOTW 规则：全图不显示标签，仅 zoom >= 5 重要地点显示，宝箱绝不显示，呀哈哈近景显示）
        if (this.options.showNames && currentZoom >= (this.options.labelMinZoom || 5)) {
          var isChest = !!(m.drop || m.drop_zh || m.type === 'chest' || (m.id && String(m.id).indexOf('c_') === 0));
          var isKorok = (m.cat === 130 || m.cat === 160 || (m.name && m.name.indexOf('克洛格') >= 0));
          if (!isChest) {
            if (!isKorok || currentZoom >= 6) {
              labelList.push({ m: m, x: x, y: y, size: size, isDone: isDone });
            }
          }
        }
      }

      // 顶层统一绘制文字标签
      if (labelList.length > 0) {
        for (var j = 0; j < labelList.length; j++) {
          var it = labelList[j];
          var lbl = (typeof this.options.getLabel === 'function') ? this.options.getLabel(it.m) : (it.m.name || it.m.full || it.m.drop_zh || it.m.drop);
          if (!lbl) continue;
          ctx.save();
          var fs = Math.min(Math.max(10, Math.round(currentZoom * 2)), 13);
          ctx.font = '600 ' + fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          var ly = it.y + it.size / 2 + 3;
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(8, 12, 10, 0.85)';
          ctx.strokeText(lbl, it.x, ly);
          ctx.fillStyle = it.isDone ? 'rgba(180, 205, 185, 0.85)' : '#ffffff';
          ctx.fillText(lbl, it.x, ly);
          ctx.restore();
        }
      }

      this._visibleMarkers = visibleMarkers;
    },

    _pickMarker: function (lx, ly) {
      var list = this._visibleMarkers;
      if (!list || !list.length) return null;
      var best = null;
      var minDistanceSq = Infinity;
      for (var i = list.length - 1; i >= 0; i--) {
        var it = list[i];
        var r = it.radius || 14;
        var dx = lx - it.x;
        var dy = ly - it.y;
        var dSq = dx * dx + dy * dy;
        if (dSq <= r * r) {
          if (dSq < minDistanceSq) {
            minDistanceSq = dSq;
            best = it;
          }
        }
      }
      return best;
    },

    /* 2026-10-27 新增：命中半径内的全部候选（距离升序）。
     * 背景：密集区 / 同一坐标叠着好几个标点时，_pickMarker 只肯返回最近的那一个，
     *   压在下层的任务、神庙、克洛格永远点不到 —— 上层据此弹「候选列表」让玩家自己挑。
     * limit 是保险：一屏几十个重叠时列表也不能无限长。 */
    _pickCandidates: function (lx, ly, limit) {
      var list = this._visibleMarkers;
      var out = [];
      if (!list || !list.length) return out;
      limit = limit || 12;
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var r = it.radius || 14;
        var dx = lx - it.x;
        var dy = ly - it.y;
        var dSq = dx * dx + dy * dy;
        if (dSq <= r * r) out.push({ item: it, d: dSq });
      }
      if (out.length > 1) out.sort(function (a, b) { return a.d - b.d; });
      var res = [];
      for (var j = 0; j < out.length && j < limit; j++) res.push(out[j].item);
      return res;
    },

    _bindEvents: function () {
      if (!this._map) return;
      var self = this;
      var map = this._map;

      this._mouseMoveHandler = function (e) {
        if (!self._visibleMarkers.length) {
          if (self._hoveredMarker) {
            self._hoveredMarker = null;
            map.getContainer().style.cursor = '';
          }
          return;
        }
        var lp = e.layerPoint;
        if (!lp) return;
        var hit = self._pickMarker(lp.x, lp.y);
        if (hit) {
          self._hoveredMarker = hit.marker;
          map.getContainer().style.cursor = 'pointer';
        } else if (self._hoveredMarker) {
          self._hoveredMarker = null;
          map.getContainer().style.cursor = '';
        }
      };

      this._clickHandler = function (e) {
        if (!self._visibleMarkers.length) return;
        var lp = e.layerPoint;
        if (!lp) return;
        /* 2026-10-27：先收候选。单个 = 原来的直达卡片；多个 = 抛给上层弹候选列表，
           由玩家自己挑（密集区不再"永远只点中最上面那个"）。 */
        var cands = self._pickCandidates(lp.x, lp.y);
        if (!cands.length) return;
        e._markerClicked = true;
        if (e.originalEvent) e.originalEvent._markerClicked = true;
        if (cands.length > 1) {
          self.fire('multiclick', cands, e);
          return;
        }
        self.fire('click', cands[0].marker, e);
      };

      map.on('mousemove', this._mouseMoveHandler);
      map.on('click', this._clickHandler);
    },

    _unbindEvents: function () {
      if (!this._map) return;
      var map = this._map;
      if (this._mouseMoveHandler) map.off('mousemove', this._mouseMoveHandler);
      if (this._clickHandler) map.off('click', this._clickHandler);
      map.getContainer().style.cursor = '';
    }
  };

  /* ==========================================================================
     TOTK 材料专属 Canvas 高性能渲染图层（TotkMatCanvasLayer）
     基于 Leaflet L.Canvas 核心派生，接管 44 种材料与万级点位聚合渲染，彻底消灭 DOM 节点
     ========================================================================== */
  var matProtoMethods = {
    options: {
      padding: 0.2,
      pane: 'overlayPane',
      hitRadius: 18,
      getMatConfig: null,
      getClusterer: null,
      isCollected: null,
      isDone: null,
      isExpanded: null,
      getSelected: null,
      getLayer: null,
      isActive: null,
      getIconSize: null,
      FX: 180 / 6000,
      FZ: 85 / 5000
    },

    initialize: function (mapOrOptions, maybeOptions) {
      var options = {};
      var directMap = null;
      if (mapOrOptions && (mapOrOptions.getContainer || mapOrOptions._container)) {
        directMap = mapOrOptions;
        options = maybeOptions || {};
      } else if (mapOrOptions && typeof mapOrOptions === 'object') {
        options = mapOrOptions;
      }

      var curL = getLeaflet();
      if (Base.prototype && Base.prototype.initialize) {
        Base.prototype.initialize.call(this, options);
      }
      if (curL && curL.Util && curL.Util.setOptions) {
        curL.Util.setOptions(this, options);
      } else {
        this.options = Object.assign({}, matProtoMethods.options, options);
      }

      this._visibleItems = [];
      this._hoveredItem = null;
      this._customEvents = {};

      if (directMap) {
        this.addTo(directMap);
      }
    },

    addTo: function (map) {
      if (Base.prototype && Base.prototype.addTo) {
        Base.prototype.addTo.call(this, map);
      } else {
        this._map = map;
        this.onAdd(map);
      }
      return this;
    },

    onAdd: function (map) {
      this._map = map;
      if (Base.prototype && Base.prototype.onAdd) {
        Base.prototype.onAdd.call(this, map);
      }
      this._bindEvents();
      this.redraw();
      return this;
    },

    onRemove: function (map) {
      this._unbindEvents();
      if (Base.prototype && Base.prototype.onRemove) {
        Base.prototype.onRemove.call(this, map);
      }
      return this;
    },

    redraw: function () {
      if (this._map) {
        this._updatePaths();
      }
      return this;
    },

    clear: function () {
      this._visibleItems = [];
      if (this._ctx && this._bounds) {
        var minPt = this._bounds.min;
        var bSz = this._bounds.getSize();
        this._ctx.clearRect(minPt.x - bSz.x, minPt.y - bSz.y, bSz.x * 3, bSz.y * 3);
      } else if (this._ctx && this._container) {
        this._ctx.clearRect(-10000, -10000, 20000, 20000);
      }
      return this;
    },

    on: function (event, fn) {
      if (!this._customEvents[event]) this._customEvents[event] = [];
      this._customEvents[event].push(fn);
      return this;
    },

    off: function (event, fn) {
      if (!event) { this._customEvents = {}; return this; }
      if (!fn) { delete this._customEvents[event]; return this; }
      var list = this._customEvents[event];
      if (list) {
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i] === fn) list.splice(i, 1);
        }
      }
      return this;
    },

    fire: function (event, data, origEvent) {
      var list = this._customEvents[event];
      if (!list || !list.length) return this;
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].call(this, data, origEvent);
        } catch (err) {
          console.error('[TotkMatCanvasLayer] Error in ' + event + ' handler:', err);
        }
      }
      return this;
    },

    _getImage: function (url) {
      if (!url) return null;
      if (ImageCache[url]) {
        return (ImageCache[url].complete && ImageCache[url].naturalWidth > 0) ? ImageCache[url] : null;
      }
      var self = this;
      var img = new Image();
      img.onload = function () {
        self.redraw();
      };
      img.onerror = function () {
        img._failed = true;
      };
      img.src = url;
      ImageCache[url] = img;
      return null;
    },

    _roundRect: function (ctx, x, y, w, h, r) {
      if (w < 2 * r) r = w / 2;
      if (h < 2 * r) r = h / 2;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    _drawBadge: function (ctx, sx, sy, n) {
      var t = String(n);
      ctx.font = '700 10px sans-serif';
      var tw = ctx.measureText(t).width;
      var bw = Math.max(16, tw + 8), bh = 13;
      var x = sx - bw / 2, y = sy - bh / 2;
      ctx.fillStyle = 'rgba(10, 14, 10, 0.88)';
      this._roundRect(ctx, x, y, bw, bh, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, sx, y + bh / 2 + 0.5);
    },

    _drawCluster: function (ctx, m, x, y, size, count) {
      ctx.save();
      var iconUrl = 'assets/materials/' + m.entry + '.png';
      var img = this._getImage(iconUrl);
      if (img) {
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#2c3e50';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      this._drawBadge(ctx, x, y - size / 2 - 2, count);
      ctx.restore();
    },

    _drawLeaf: function (ctx, m, x, y, size, isDone) {
      ctx.save();
      if (isDone) {
        ctx.globalAlpha = 0.38;
      }
      var iconUrl = 'assets/materials/' + m.entry + '.png';
      var img = this._getImage(iconUrl);
      if (img) {
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#16a085';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isDone) {
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = '#7dffa0';
        ctx.lineWidth = Math.max(1.5, size * 0.16);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x - size * 0.22, y);
        ctx.lineTo(x - size * 0.05, y + size * 0.18);
        ctx.lineTo(x + size * 0.26, y - size * 0.16);
        ctx.stroke();
      }
      ctx.restore();
    },

    _updatePaths: function () {
      if (!this._map || !this._ctx) return;
      var ctx = this._ctx;
      var map = this._map;
      var bounds = this._bounds;

      if (bounds) {
        var minPt = bounds.min;
        var bSz = bounds.getSize();
        ctx.clearRect(minPt.x - bSz.x, minPt.y - bSz.y, bSz.x * 3, bSz.y * 3);
      } else if (this._container) {
        ctx.clearRect(-10000, -10000, 20000, 20000);
      }

      var opt = this.options;
      if (typeof opt.isActive === 'function' && !opt.isActive()) {
        this._visibleItems = [];
        return;
      }

      var selected = (typeof opt.getSelected === 'function') ? opt.getSelected() : {};
      var curLayer = (typeof opt.getLayer === 'function') ? opt.getLayer() : 0;
      var currentZoom = Math.round(map.getZoom());
      var mapBounds = map.getBounds();
      var FX = opt.FX || (180 / 6000);
      var FZ = opt.FZ || (85 / 5000);

      var padX = 800 * FX, padZ = 800 * FZ;
      var fakeBbox = [
        mapBounds.getWest() * FX - padX, mapBounds.getSouth() * FZ - padZ,
        mapBounds.getEast() * FX + padX, mapBounds.getNorth() * FZ + padZ
      ];

      var visibleItems = [];

      for (var midStr in selected) {
        if (!selected[midStr]) continue;
        var mid = Number(midStr);
        var m = (typeof opt.getMatConfig === 'function') ? opt.getMatConfig(mid) : null;
        if (!m) continue;

        var r = currentZoom >= 7 ? 8 : (currentZoom <= 3 ? 96 : currentZoom < 5 ? 192 : currentZoom === 5 ? 256 : 128);
        var idxr = (typeof opt.getClusterer === 'function') ? opt.getClusterer(mid, curLayer, r) : null;
        if (!idxr) continue;

        var clusters = idxr.getClusters(fakeBbox, currentZoom);
        var len = clusters.length;

        for (var ci = 0; ci < len; ci++) {
          var c = clusters[ci];
          var coords = c.geometry.coordinates;
          var gx = coords[0] / FX, gz = coords[1] / FZ;
          var latlng = [gz, gx];
          var lp = map.latLngToLayerPoint(latlng);
          var x = lp.x, y = lp.y;

          if (bounds) {
            var pad = opt.padding || 0.2;
            var bSize = bounds.getSize();
            if (x < bounds.min.x - bSize.x * pad || x > bounds.max.x + bSize.x * pad ||
                y < bounds.min.y - bSize.y * pad || y > bounds.max.y + bSize.y * pad) {
              continue;
            }
          }

          var props = c.properties;
          if (props.cluster) {
            var isExp = (currentZoom >= 7 && typeof opt.isExpanded === 'function' && opt.isExpanded(mid, c.id));
            if (isExp) {
              var leaves = idxr.getLeaves(c.id, Infinity) || [];
              for (var li = 0; li < leaves.length; li++) {
                var lf = leaves[li];
                var lcoords = lf.geometry.coordinates;
                var lgx = lcoords[0] / FX, lgz = lcoords[1] / FZ;
                var lll = [lgz, lgx];
                var llp = map.latLngToLayerPoint(lll);
                var lx = llp.x, ly = llp.y;
                var lsize = (typeof opt.getIconSize === 'function') ? opt.getIconSize(currentZoom) : 26;
                var leafIdx = lf.id;
                var done = (typeof opt.isDone === 'function' && opt.isDone(mid, leafIdx)) ||
                           (typeof opt.isCollected === 'function' && opt.isCollected(mid, leafIdx));

                this._drawLeaf(ctx, m, lx, ly, lsize, done);
                visibleItems.push({
                  type: 'leaf',
                  mid: mid,
                  m: m,
                  idx: leafIdx,
                  latlng: lll,
                  x: lx,
                  y: ly,
                  size: lsize,
                  radius: lsize / 2 + 4
                });
              }
              continue;
            }

            var baseSize = (typeof opt.getIconSize === 'function') ? opt.getIconSize(currentZoom) : 26;
            var clusterSize = baseSize + (props.point_count >= 100 ? 12 : props.point_count >= 20 ? 6 : 0);
            this._drawCluster(ctx, m, x, y, clusterSize, props.point_count);
            visibleItems.push({
              type: 'cluster',
              mid: mid,
              cid: c.id,
              m: m,
              count: props.point_count,
              latlng: latlng,
              x: x,
              y: y,
              size: clusterSize,
              radius: clusterSize / 2 + 4
            });
          } else {
            var leafSize = (typeof opt.getIconSize === 'function') ? opt.getIconSize(currentZoom) : 26;
            var leafIdx = (props.id !== undefined) ? props.id : (c.id !== undefined ? c.id : 0);
            var done = (typeof opt.isDone === 'function' && opt.isDone(mid, leafIdx)) ||
                       (typeof opt.isCollected === 'function' && opt.isCollected(mid, leafIdx));

            this._drawLeaf(ctx, m, x, y, leafSize, done);
            visibleItems.push({
              type: 'leaf',
              mid: mid,
              m: m,
              idx: leafIdx,
              latlng: latlng,
              x: x,
              y: y,
              size: leafSize,
              radius: leafSize / 2 + 4
            });
          }
        }
      }

      this._visibleItems = visibleItems;
    },

    _pickItem: function (lx, ly) {
      var list = this._visibleItems;
      if (!list || !list.length) return null;
      var best = null;
      var minDistanceSq = Infinity;
      for (var i = list.length - 1; i >= 0; i--) {
        var it = list[i];
        var r = it.radius || 18;
        var dx = lx - it.x;
        var dy = ly - it.y;
        var dSq = dx * dx + dy * dy;
        if (dSq <= r * r && dSq < minDistanceSq) {
          minDistanceSq = dSq;
          best = it;
        }
      }
      return best;
    },

    _bindEvents: function () {
      if (!this._map) return;
      var self = this;
      var map = this._map;

      this._mouseMoveHandler = function (e) {
        if (!self._visibleItems || !self._visibleItems.length) {
          if (self._hoveredItem) {
            self._hoveredItem = null;
            map.getContainer().style.cursor = '';
          }
          return;
        }
        var lp = e.layerPoint;
        if (!lp) return;
        var hit = self._pickItem(lp.x, lp.y);
        if (hit) {
          self._hoveredItem = hit;
          map.getContainer().style.cursor = 'pointer';
        } else if (self._hoveredItem) {
          self._hoveredItem = null;
          map.getContainer().style.cursor = '';
        }
      };

      this._clickHandler = function (e) {
        if (!self._visibleItems || !self._visibleItems.length) return;
        var lp = e.layerPoint;
        if (!lp) return;
        var hit = self._pickItem(lp.x, lp.y);
        if (hit) {
          e._markerClicked = true;
          if (e.originalEvent) e.originalEvent._markerClicked = true;
          if (hit.type === 'cluster') {
            self.fire('clusterClick', hit, e);
          } else {
            self.fire('leafClick', hit, e);
          }
        }
      };

      map.on('mousemove', this._mouseMoveHandler);
      map.on('click', this._clickHandler);
    },

    _unbindEvents: function () {
      if (!this._map) return;
      var map = this._map;
      if (this._mouseMoveHandler) map.off('mousemove', this._mouseMoveHandler);
      if (this._clickHandler) map.off('click', this._clickHandler);
      map.getContainer().style.cursor = '';
    }
  };

  var TotkCanvasLayer;
  var TotkMatCanvasLayer;
  if (Base && Base.extend) {
    TotkCanvasLayer = Base.extend(protoMethods);
    TotkMatCanvasLayer = Base.extend(matProtoMethods);
  } else {
    TotkCanvasLayer = function (mapOrOptions, maybeOptions) {
      this.initialize(mapOrOptions, maybeOptions);
    };
    TotkCanvasLayer.prototype = Object.create(protoMethods);
    TotkCanvasLayer.prototype.constructor = TotkCanvasLayer;

    TotkMatCanvasLayer = function (mapOrOptions, maybeOptions) {
      this.initialize(mapOrOptions, maybeOptions);
    };
    TotkMatCanvasLayer.prototype = Object.create(matProtoMethods);
    TotkMatCanvasLayer.prototype.constructor = TotkMatCanvasLayer;
  }

  TotkCanvasLayer.ImageCache = ImageCache;
  TotkCanvasLayer.MatLayer = TotkMatCanvasLayer;
  TotkCanvasLayer.TotkMatCanvasLayer = TotkMatCanvasLayer;

  if (typeof root !== 'undefined') {
    root.TotkCanvasLayer = TotkCanvasLayer;
    root.TotkMatCanvasLayer = TotkMatCanvasLayer;
  }

  return TotkCanvasLayer;
});
