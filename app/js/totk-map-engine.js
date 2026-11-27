/**
 * TOTKmap 纯 Canvas 地图引擎（移植自 BOTWmap BotwMap 架构）
 * 单 <canvas> 同步绘制：瓦片（含低阶缓存瓦片降级铺底，0 黑屏）+ 区域多边形 + 标点 + 材料聚合 + 矢量线
 * 彻底消除 Leaflet 双 DOM 线程差导致的缩放偏移、拉伸与闪烁。
 */
(function (root) {
  'use strict';

  var MIN_X = -6000, MAX_X = 6000, WORLD_W = 12000;
  var MIN_Z = -5000, MAX_Z = 5000, WORLD_H = 10000;

  var ImageCache = {};
  function getCachedImage(url, onLoad) {
    if (!url) return null;
    var entry = ImageCache[url];
    if (entry) {
      return (entry.complete && entry.naturalWidth > 0) ? entry : null;
    }
    var img = new Image();
    img.onload = function () { if (onLoad) onLoad(); };
    img.onerror = function () { img._failed = true; };
    img.src = url;
    ImageCache[url] = img;
    return null;
  }

  /* ---------------- 悬停 Tooltip（共用 #matCanvasTooltip） ---------------- */
  var TooltipEl = null;
  function getTooltipEl() {
    if (!TooltipEl) {
      var el = document.getElementById('matCanvasTooltip');
      if (!el) {
        el = document.createElement('div');
        el.id = 'matCanvasTooltip';
        el.className = 'totk-mat-tooltip';
        el.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;background:rgba(10,14,20,0.92);color:#fff;font-size:12px;font-weight:600;padding:4px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.5);white-space:nowrap;display:none;transform:translate(-50%,-100%);margin-top:-8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
        document.body.appendChild(el);
      }
      TooltipEl = el;
    }
    return TooltipEl;
  }
  function showTooltipText(text, clientX, clientY) {
    var el = getTooltipEl();
    if (!el || !text) return;
    el.textContent = text;
    el.style.left = (clientX || 0) + 'px';
    el.style.top = (clientY || 0) + 'px';
    el.style.display = 'block';
  }
  function hideTooltip() {
    if (TooltipEl) TooltipEl.style.display = 'none';
  }

  /* ---------------- 基础几何类型（兼容 L.Point / L.LatLng / L.LatLngBounds） ---------------- */
  function Point(x, y) {
    this.x = x || 0;
    this.y = y || 0;
  }
  Point.prototype.add = function (p) { return new Point(this.x + p.x, this.y + p.y); };
  Point.prototype.subtract = function (p) { return new Point(this.x - p.x, this.y - p.y); };
  Point.prototype.multiplyBy = function (k) { return new Point(this.x * k, this.y * k); };
  Point.prototype.divideBy = function (k) { return new Point(this.x / k, this.y / k); };
  Point.prototype._add = function (p) { this.x += p.x; this.y += p.y; return this; };
  Point.prototype._subtract = function (p) { this.x -= p.x; this.y -= p.y; return this; };
  Point.prototype._divideBy = function (k) { this.x /= k; this.y /= k; return this; };
  Point.prototype._round = function () { this.x = Math.round(this.x); this.y = Math.round(this.y); return this; };
  Point.prototype.distanceTo = function (p) {
    var dx = this.x - p.x, dy = this.y - p.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  function LatLng(lat, lng) {
    if (Array.isArray(lat)) { this.lat = Number(lat[0]) || 0; this.lng = Number(lat[1]) || 0; }
    else if (lat && typeof lat === 'object') { this.lat = Number(lat.lat) || 0; this.lng = Number(lat.lng) || 0; }
    else { this.lat = Number(lat) || 0; this.lng = Number(lng) || 0; }
  }
  function toLatLng(a, b) {
    if (a instanceof LatLng) return a;
    if (Array.isArray(a)) return new LatLng(a[0], a[1]);
    if (a && typeof a === 'object' && a.lat !== undefined) return new LatLng(a.lat, a.lng);
    return new LatLng(a, b);
  }

  function LatLngBounds(sw, ne) {
    var p1 = toLatLng(sw), p2 = toLatLng(ne || sw);
    this._sw = new LatLng(Math.min(p1.lat, p2.lat), Math.min(p1.lng, p2.lng));
    this._ne = new LatLng(Math.max(p1.lat, p2.lat), Math.max(p1.lng, p2.lng));
  }
  LatLngBounds.prototype.getWest = function () { return this._sw.lng; };
  LatLngBounds.prototype.getSouth = function () { return this._sw.lat; };
  LatLngBounds.prototype.getEast = function () { return this._ne.lng; };
  LatLngBounds.prototype.getNorth = function () { return this._ne.lat; };
  LatLngBounds.prototype.getCenter = function () {
    return new LatLng((this._sw.lat + this._ne.lat) / 2, (this._sw.lng + this._ne.lng) / 2);
  };
  LatLngBounds.prototype.contains = function (ll) {
    var p = toLatLng(ll);
    return p.lat >= this._sw.lat && p.lat <= this._ne.lat && p.lng >= this._sw.lng && p.lng <= this._ne.lng;
  };
  LatLngBounds.prototype.pad = function (ratio) {
    var dh = (this._ne.lat - this._sw.lat) * ratio;
    var dw = (this._ne.lng - this._sw.lng) * ratio;
    return new LatLngBounds([this._sw.lat - dh, this._sw.lng - dw], [this._ne.lat + dh, this._ne.lng + dw]);
  };

  /* ---------------- 轻量事件发射器 ---------------- */
  function Emitter() { this._ev = {}; }
  Emitter.prototype.on = function (types, fn) {
    var list = String(types).split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t) continue;
      if (!this._ev[t]) this._ev[t] = [];
      this._ev[t].push(fn);
    }
    return this;
  };
  Emitter.prototype.once = function (types, fn) {
    var self = this;
    function wrapper(data) {
      self.off(types, wrapper);
      fn.call(this, data);
    }
    return this.on(types, wrapper);
  };
  Emitter.prototype.off = function (types, fn) {
    if (!types) { this._ev = {}; return this; }
    var list = String(types).split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!this._ev[t]) continue;
      if (!fn) { delete this._ev[t]; continue; }
      this._ev[t] = this._ev[t].filter(function (f) { return f !== fn; });
    }
    return this;
  };
  Emitter.prototype.fire = function (type, data) {
    var arr = this._ev[type];
    if (!arr || !arr.length) return this;
    var copy = arr.slice();
    for (var i = 0; i < copy.length; i++) {
      try { copy[i].call(this, data || {}); } catch (err) { console.error('[TotkMap]', type, err); }
    }
    return this;
  };

  /* ---------------- 图层容器与矢量/DOM 覆盖物 ---------------- */
  function LayerGroup() {
    this._layers = [];
    this._map = null;
  }
  LayerGroup.prototype.addTo = function (map) {
    this._map = map;
    map._addGroup(this);
    for (var i = 0; i < this._layers.length; i++) this._layers[i]._onAdd(map);
    map._schedDraw();
    return this;
  };
  LayerGroup.prototype.remove = function () {
    if (!this._map) return this;
    for (var i = 0; i < this._layers.length; i++) this._layers[i]._onRemove(this._map);
    this._map._removeGroup(this);
    this._map._schedDraw();
    this._map = null;
    return this;
  };
  LayerGroup.prototype.addLayer = function (l) {
    if (!l) return this;
    this._layers.push(l);
    if (this._map) { l._onAdd(this._map); this._map._schedDraw(); }
    return this;
  };
  LayerGroup.prototype.removeLayer = function (l) {
    var idx = this._layers.indexOf(l);
    if (idx >= 0) {
      this._layers.splice(idx, 1);
      if (this._map) { l._onRemove(this._map); this._map._schedDraw(); }
    }
    return this;
  };
  LayerGroup.prototype.clearLayers = function () {
    for (var i = 0; i < this._layers.length; i++) {
      if (this._map) this._layers[i]._onRemove(this._map);
    }
    this._layers = [];
    if (this._map) this._map._schedDraw();
    return this;
  };
  LayerGroup.prototype.eachLayer = function (fn) {
    for (var i = 0; i < this._layers.length; i++) fn(this._layers[i]);
    return this;
  };

  function calcPointsBbox(pts) {
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return [minLat, maxLat, minLng, maxLng];
  }

  function Polyline(latlngs, opts) {
    Emitter.call(this);
    this._latlngs = (latlngs || []).map(toLatLng);
    this._bbox = calcPointsBbox(this._latlngs);
    this.options = opts || {};
    this._map = null;
  }
  Polyline.prototype = Object.create(Emitter.prototype);
  Polyline.prototype._onAdd = function (map) { this._map = map; map._vectors.push(this); };
  Polyline.prototype._onRemove = function (map) {
    this._map = null;
    var i = map._vectors.indexOf(this);
    if (i >= 0) map._vectors.splice(i, 1);
  };
  Polyline.prototype.addTo = function (map) {
    if (map instanceof LayerGroup) map.addLayer(this);
    else { this._onAdd(map); map._schedDraw(); }
    return this;
  };
  Polyline.prototype.remove = function () {
    if (this._map) { var m = this._map; this._onRemove(m); m._schedDraw(); }
    return this;
  };
  Polyline.prototype.setLatLngs = function (ll) {
    this._latlngs = (ll || []).map(toLatLng);
    this._bbox = calcPointsBbox(this._latlngs);
    if (this._map) this._map._schedDraw();
    return this;
  };
  Polyline.prototype.setStyle = function (st) {
    Object.assign(this.options, st || {});
    if (this._map) this._map._schedDraw();
    return this;
  };
  Polyline.prototype.bindTooltip = function () { return this; };
  Polyline.prototype.openTooltip = function () { return this; };
  Polyline.prototype.closeTooltip = function () { return this; };

  function Polygon(latlngs, opts) {
    Emitter.call(this);
    var rings = (latlngs && Array.isArray(latlngs[0]) && (Array.isArray(latlngs[0][0]) || (latlngs[0][0] && latlngs[0][0].lat !== undefined)))
      ? latlngs : [latlngs || []];
    this._rings = rings.map(function (r) { return (r || []).map(toLatLng); });
    this._bbox = calcPointsBbox(this._rings[0] || []);
    for (var ri = 1; ri < this._rings.length; ri++) {
      var b = calcPointsBbox(this._rings[ri]);
      if (b[0] < this._bbox[0]) this._bbox[0] = b[0];
      if (b[1] > this._bbox[1]) this._bbox[1] = b[1];
      if (b[2] < this._bbox[2]) this._bbox[2] = b[2];
      if (b[3] > this._bbox[3]) this._bbox[3] = b[3];
    }
    this.options = opts || {};
    this._isPolygon = true;
    this._map = null;
  }
  Polygon.prototype = Object.create(Polyline.prototype);

  function CircleMarker(latlng, opts) {
    Emitter.call(this);
    this._latlng = toLatLng(latlng);
    this.options = opts || {};
    this._isCircle = true;
    this._map = null;
  }
  CircleMarker.prototype = Object.create(Emitter.prototype);
  CircleMarker.prototype._onAdd = function (map) { this._map = map; map._vectors.push(this); };
  CircleMarker.prototype._onRemove = function (map) {
    this._map = null;
    var i = map._vectors.indexOf(this);
    if (i >= 0) map._vectors.splice(i, 1);
  };
  CircleMarker.prototype.addTo = function (map) {
    if (map instanceof LayerGroup) map.addLayer(this);
    else { this._onAdd(map); map._schedDraw(); }
    return this;
  };
  CircleMarker.prototype.remove = function () {
    if (this._map) { var m = this._map; this._onRemove(m); m._schedDraw(); }
    return this;
  };
  CircleMarker.prototype.setLatLng = function (ll) {
    this._latlng = toLatLng(ll);
    if (this._map) this._map._schedDraw();
    return this;
  };
  CircleMarker.prototype.bindTooltip = function () { return this; };
  CircleMarker.prototype.openTooltip = function () { return this; };
  CircleMarker.prototype.closeTooltip = function () { return this; };

  /* DOM Marker（供任务/实时定位/龙图标/声之记忆等少数动态元素使用，同帧同步定位） */
  function DomMarker(latlng, opts) {
    Emitter.call(this);
    this._latlng = toLatLng(latlng);
    this.options = opts || {};
    this._map = null;
    this._el = null;
    this._tip = null;
    this._tipEl = null;
  }
  DomMarker.prototype = Object.create(Emitter.prototype);
  DomMarker.prototype._ensureEl = function () {
    if (this._el) return this._el;
    var el = document.createElement('div');
    el.className = 'totk-dom-marker';
    el.style.cssText = 'position:absolute;left:0;top:0;pointer-events:auto;will-change:transform;';
    if (this.options.interactive === false) el.style.pointerEvents = 'none';
    this._el = el;
    this._applyIcon();
    var self = this;
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var pt = self._map ? self._map.mouseEventToContainerPoint(e) : null;
      self.fire('click', { originalEvent: e, latlng: self._latlng, layerPoint: pt, containerPoint: pt });
    });
    el.addEventListener('mouseenter', function () {
      if (self._tip && self._map) {
        var r = el.getBoundingClientRect();
        showTooltipText(self._tip, r.left + r.width / 2, r.top);
      }
    });
    el.addEventListener('mouseleave', function () { hideTooltip(); });
    return el;
  };
  DomMarker.prototype._applyIcon = function () {
    if (!this._el) return;
    var ic = this.options.icon;
    var el = this._el;
    el.innerHTML = '';
    if (!ic) return;
    var sz = ic.iconSize || [24, 24];
    var anc = ic.iconAnchor || [sz[0] / 2, sz[1] / 2];
    el.style.width = sz[0] + 'px';
    el.style.height = sz[1] + 'px';
    el.style.marginLeft = (-anc[0]) + 'px';
    el.style.marginTop = (-anc[1]) + 'px';
    el.style.zIndex = String(300 + (this.options.zIndexOffset || 0));
    /* 内层承载图标 className（避免 .korok-camp-pin 的 transition:transform 与外层 translate3d 定位冲突导致缩放偏移） */
    var inner = document.createElement('div');
    inner.style.cssText = 'width:100%;height:100%;';
    if (ic.className) inner.className = ic.className;
    if (ic.html != null) {
      inner.innerHTML = ic.html;
    } else if (ic.iconUrl) {
      var img = document.createElement('img');
      img.src = ic.iconUrl;
      img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
      img.alt = '';
      inner.appendChild(img);
    }
    el.appendChild(inner);
  };
  DomMarker.prototype._onAdd = function (map) {
    this._map = map;
    var el = this._ensureEl();
    map._domPane.appendChild(el);
    map._domMarkers.push(this);
    map._posDomMarker(this);
  };
  DomMarker.prototype._onRemove = function (map) {
    this._map = null;
    if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    var i = map._domMarkers.indexOf(this);
    if (i >= 0) map._domMarkers.splice(i, 1);
  };
  DomMarker.prototype.addTo = function (map) {
    if (map instanceof LayerGroup) map.addLayer(this);
    else { this._onAdd(map); }
    return this;
  };
  DomMarker.prototype.remove = function () {
    if (this._map) this._onRemove(this._map);
    return this;
  };
  DomMarker.prototype.setLatLng = function (ll) {
    this._latlng = toLatLng(ll);
    if (this._map) this._map._posDomMarker(this);
    return this;
  };
  DomMarker.prototype.getLatLng = function () { return this._latlng; };
  DomMarker.prototype.setIcon = function (ic) {
    this.options.icon = ic;
    this._applyIcon();
    if (this._map) this._map._posDomMarker(this);
    return this;
  };
  DomMarker.prototype.getElement = function () { return this._el; };
  DomMarker.prototype.setZIndexOffset = function (z) {
    this.options.zIndexOffset = z;
    if (this._el) this._el.style.zIndex = String(300 + (z || 0));
    return this;
  };
  DomMarker.prototype.bindTooltip = function (txt) { this._tip = txt; return this; };
  DomMarker.prototype.openTooltip = function () {
    if (this._tip && this._el) {
      var r = this._el.getBoundingClientRect();
      showTooltipText(this._tip, r.left + r.width / 2, r.top);
    }
    return this;
  };
  DomMarker.prototype.closeTooltip = function () { hideTooltip(); return this; };

  /* ---------------- 核心纯 Canvas 地图引擎 TotkCanvasMap ---------------- */
  function TotkCanvasMap(containerId, opts) {
    Emitter.call(this);
    opts = opts || {};
    this._container = (typeof containerId === 'string') ? document.getElementById(containerId) : containerId;
    this.options = opts;
    this._minZoom = opts.minZoom != null ? opts.minZoom : 3;
    this._maxZoom = opts.maxZoom != null ? opts.maxZoom : 7;
    this._layerKey = 'ground';
    this._tileCache = new Map();
    this._tilePending = new Set();

    this._zoom = opts.zoom != null ? opts.zoom : 5;
    var c = toLatLng(opts.center || [-140.8, -298.54]);
    this._center = c;
    this.view = { x: 0, y: 0, scale: Math.pow(2, this._zoom - 6) };

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;touch-action:none;';
    this._ctx = this._canvas.getContext('2d');

    this._domPane = document.createElement('div');
    this._domPane.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:400;';

    if (getComputedStyle(this._container).position === 'static') {
      this._container.style.position = 'relative';
    }
    this._container.style.overflow = 'hidden';
    this._container.innerHTML = '';
    this._container.appendChild(this._canvas);
    this._container.appendChild(this._domPane);

    this._groups = [];
    this._vectors = [];
    this._domMarkers = [];
    this._exploreLayers = [];
    this._matLayers = [];
    this._liveOverlay = null;
    this._rafDraw = 0;
    this._flyRaf = 0;
    this._isDragging = false;
    this._w = 0;
    this._h = 0;
    this._dpr = (root.TOTK_ADV && root.TOTK_ADV.getEffectiveDpr) ? root.TOTK_ADV.getEffectiveDpr() : (window.devicePixelRatio || 1);
    this._staticCache = {
      canvas: document.createElement('canvas'),
      ctx: null,
      dirty: true,
      vx: 0,
      vy: 0,
      scale: 0,
      w: 0,
      h: 0,
      pad: 128,
      dpr: 1
    };
    this._staticCache.ctx = this._staticCache.canvas.getContext('2d');

    this._resize();
    this._syncViewFromCenterZoom();
    this._bindInteractions();
    this._prewarmZ3();
    this._schedDraw();
  }
  TotkCanvasMap.prototype = Object.create(Emitter.prototype);

  TotkCanvasMap.prototype._invalidateStatic = function () {
    if (this._staticCache) this._staticCache.dirty = true;
  };

  TotkCanvasMap.prototype.setLiveOverlay = function (fn) {
    this._liveOverlay = (typeof fn === 'function') ? fn : null;
    this.draw({ dynamicOnly: true });
    return this;
  };

  TotkCanvasMap.prototype.setTileLayerKey = function (key) {
    if (this._layerKey === key) return;
    this._layerKey = key;
    this._invalidateStatic();
    this._prewarmZ3();
    this._schedDraw();
  };

  TotkCanvasMap.prototype._prewarmZ3 = function () {
    var lk = this._layerKey;
    var self = this;
    for (var ty = 0; ty <= 4; ty++) {
      for (var tx = 0; tx <= 5; tx++) {
        this._loadTile(lk, 3, tx, ty, self);
      }
    }
  };

  TotkCanvasMap.prototype._resize = function () {
    var rect = this._container.getBoundingClientRect();
    this._w = Math.max(1, Math.round(rect.width || this._container.clientWidth || window.innerWidth));
    this._h = Math.max(1, Math.round(rect.height || this._container.clientHeight || window.innerHeight));
    this._dpr = (root.TOTK_ADV && root.TOTK_ADV.getEffectiveDpr) ? root.TOTK_ADV.getEffectiveDpr() : (window.devicePixelRatio || 1);
    this._canvas.width = Math.round(this._w * this._dpr);
    this._canvas.height = Math.round(this._h * this._dpr);
    this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this._invalidateStatic();
  };

  TotkCanvasMap.prototype._syncViewFromCenterZoom = function () {
    this.view.scale = Math.pow(2, this._zoom - 6);
    this.view.x = this._w / 2 - this._center.lng * this.view.scale;
    this.view.y = this._h / 2 - this._center.lat * this.view.scale;
  };

  TotkCanvasMap.prototype._syncCenterFromView = function () {
    var gx = (this._w / 2 - this.view.x) / this.view.scale;
    var gz = (this._h / 2 - this.view.y) / this.view.scale;
    // 软边界限制（避免拖出宇宙）
    if (this.options.maxBounds) {
      var b = this.options.maxBounds;
      gx = Math.max(b.getWest(), Math.min(b.getEast(), gx));
      gz = Math.max(b.getSouth(), Math.min(b.getNorth(), gz));
      this.view.x = this._w / 2 - gx * this.view.scale;
      this.view.y = this._h / 2 - gz * this.view.scale;
    }
    this._center = new LatLng(gz, gx);
  };

  /* 公共坐标 API */
  TotkCanvasMap.prototype.getContainer = function () { return this._container; };
  TotkCanvasMap.prototype.getSize = function () { return new Point(this._w, this._h); };
  TotkCanvasMap.prototype.getZoom = function () { return this._zoom; };
  TotkCanvasMap.prototype.getCenter = function () { return this._center; };
  TotkCanvasMap.prototype.getBounds = function () {
    var x0 = (0 - this.view.x) / this.view.scale;
    var y0 = (0 - this.view.y) / this.view.scale;
    var x1 = (this._w - this.view.x) / this.view.scale;
    var y1 = (this._h - this.view.y) / this.view.scale;
    return new LatLngBounds([y0, x0], [y1, x1]);
  };
  TotkCanvasMap.prototype.latLngToContainerPoint = function (ll) {
    var p = toLatLng(ll);
    return new Point(this.view.x + p.lng * this.view.scale, this.view.y + p.lat * this.view.scale);
  };
  TotkCanvasMap.prototype.latLngToLayerPoint = function (ll) { return this.latLngToContainerPoint(ll); };
  TotkCanvasMap.prototype.layerPointToContainerPoint = function (pt) {
    return Array.isArray(pt) ? new Point(pt[0], pt[1]) : new Point(pt.x, pt.y);
  };
  TotkCanvasMap.prototype.containerPointToLatLng = function (pt) {
    var p = Array.isArray(pt) ? { x: pt[0], y: pt[1] } : pt;
    return new LatLng((p.y - this.view.y) / this.view.scale, (p.x - this.view.x) / this.view.scale);
  };
  TotkCanvasMap.prototype.mouseEventToContainerPoint = function (e) {
    var r = this._container.getBoundingClientRect();
    return new Point(e.clientX - r.left, e.clientY - r.top);
  };
  TotkCanvasMap.prototype.mouseEventToLayerPoint = function (e) { return this.mouseEventToContainerPoint(e); };
  TotkCanvasMap.prototype.mouseEventToLatLng = function (e) { return this.containerPointToLatLng(this.mouseEventToContainerPoint(e)); };

  TotkCanvasMap.prototype.setView = function (center, zoom) {
    if (this._flyRaf) { cancelAnimationFrame(this._flyRaf); this._flyRaf = 0; }
    this._center = toLatLng(center);
    if (zoom != null) this._zoom = Math.max(this._minZoom, Math.min(this._maxZoom, zoom));
    this._syncViewFromCenterZoom();
    this._syncCenterFromView();
    this._draw();
    this.fire('move'); this.fire('zoom'); this.fire('moveend'); this.fire('zoomend');
    return this;
  };

  TotkCanvasMap.prototype.flyTo = function (center, zoom, opts) {
    opts = opts || {};
    var tgtCenter = toLatLng(center);
    var tgtZoom = zoom != null ? Math.max(this._minZoom, Math.min(this._maxZoom, zoom)) : this._zoom;
    var dur = (opts.duration != null ? opts.duration : 0.5) * 1000;
    if (opts.animate === false || dur <= 0) return this.setView(tgtCenter, tgtZoom);
    if (this._flyRaf) cancelAnimationFrame(this._flyRaf);
    var sLat = this._center.lat, sLng = this._center.lng, sZoom = this._zoom;
    var t0 = performance.now();
    var self = this;
    function step(now) {
      var t = Math.min(1, (now - t0) / dur);
      var p = 1 - Math.pow(1 - t, 3);
      self._center = new LatLng(sLat + (tgtCenter.lat - sLat) * p, sLng + (tgtCenter.lng - sLng) * p);
      self._zoom = sZoom + (tgtZoom - sZoom) * p;
      self._syncViewFromCenterZoom();
      self._draw();
      self.fire('move');
      if (t < 1) {
        self._flyRaf = requestAnimationFrame(step);
      } else {
        self._flyRaf = 0;
        self.fire('moveend');
        self.fire('zoomend');
      }
    }
    this._flyRaf = requestAnimationFrame(step);
    return this;
  };

  TotkCanvasMap.prototype.panTo = function (center, opts) {
    return this.flyTo(center, this._zoom, opts);
  };

  TotkCanvasMap.prototype.fitBounds = function (bounds, opts) {
    var b = bounds instanceof LatLngBounds ? bounds : new LatLngBounds(bounds[0], bounds[1]);
    var bw = Math.max(1, b.getEast() - b.getWest());
    var bh = Math.max(1, b.getNorth() - b.getSouth());
    var scale = Math.min(this._w / bw, this._h / bh) * 0.92;
    var z = Math.max(this._minZoom, Math.min(this._maxZoom, Math.log2(scale) + 6));
    return this.flyTo(b.getCenter(), z, opts);
  };

  TotkCanvasMap.prototype.zoomIn = function (dz) {
    var z = Math.min(this._maxZoom, Math.round((this._zoom + (dz || 0.5)) * 2) / 2);
    return this.flyTo(this._center, z, { duration: 0.2 });
  };
  TotkCanvasMap.prototype.zoomOut = function (dz) {
    var z = Math.max(this._minZoom, Math.round((this._zoom - (dz || 0.5)) * 2) / 2);
    return this.flyTo(this._center, z, { duration: 0.2 });
  };
  TotkCanvasMap.prototype.invalidateSize = function () {
    this._resize();
    this._syncViewFromCenterZoom();
    this._schedDraw();
    return this;
  };

  /* BOTWmap 同款零偏移定点缩放（以屏幕点 sx, sy 为锚点） */
  TotkCanvasMap.prototype.zoomAt = function (sx, sy, factor) {
    if (this._flyRaf) { cancelAnimationFrame(this._flyRaf); this._flyRaf = 0; }
    var minScale = Math.pow(2, this._minZoom - 6);
    var maxScale = Math.pow(2, this._maxZoom - 6);
    var ns = Math.min(Math.max(this.view.scale * factor, minScale), maxScale);
    var k = ns / this.view.scale;
    this.view.x = sx - (sx - this.view.x) * k;
    this.view.y = sy - (sy - this.view.y) * k;
    this.view.scale = ns;
    this._zoom = Math.log2(ns) + 6;
    this._syncCenterFromView();
    this._schedDraw();
    this.fire('zoom');
    this.fire('zoomend');
    this.fire('moveend');
  };

  TotkCanvasMap.prototype._addGroup = function (g) { if (this._groups.indexOf(g) < 0) this._groups.push(g); };
  TotkCanvasMap.prototype._removeGroup = function (g) { var i = this._groups.indexOf(g); if (i >= 0) this._groups.splice(i, 1); };
  TotkCanvasMap.prototype.hasLayer = function (l) {
    if (!l) return false;
    return this._groups.indexOf(l) >= 0 || this._domMarkers.indexOf(l) >= 0 || this._vectors.indexOf(l) >= 0;
  };
  TotkCanvasMap.prototype.addLayer = function (l) {
    if (l && l.addTo) l.addTo(this);
    return this;
  };
  TotkCanvasMap.prototype.removeLayer = function (l) {
    if (l && l.remove) l.remove();
    return this;
  };
  TotkCanvasMap.prototype._posDomMarker = function (dm) {
    if (!dm._el) return;
    var pt = this.latLngToContainerPoint(dm._latlng);
    dm._el.style.transform = 'translate3d(' + pt.x.toFixed(2) + 'px,' + pt.y.toFixed(2) + 'px,0)';
  };

  TotkCanvasMap.prototype._schedDraw = function () {
    this._invalidateStatic();
    if (this._rafDraw) return;
    var self = this;
    this._rafDraw = requestAnimationFrame(function () {
      self._rafDraw = 0;
      self._draw();
    });
  };

  TotkCanvasMap.prototype.draw = function (opts) {
    if (opts && opts.dynamicOnly) {
      this._draw({ dynamicOnly: true });
    } else {
      this._invalidateStatic();
      this._draw();
    }
    return this;
  };

  /* ---------------- 瓦片渲染（含低阶缓存瓦片降级铺底，彻底 0 黑屏） ---------------- */
  TotkCanvasMap.prototype._loadTile = function (lk, z, tx, ty, mapInst) {
    var key = lk + ':' + z + '_' + tx + '_' + ty;
    if (this._tileCache.has(key) || this._tilePending.has(key)) return;
    this._tilePending.add(key);
    var ext = (z <= 4) ? 'webp' : 'png';
    var img = new Image();
    var self = mapInst || this;
    img.onload = function () {
      self._tilePending.delete(key);
      self._tileCache.set(key, img);
      self._schedDraw();
    };
    img.onerror = function () {
      self._tilePending.delete(key);
    };
    img.src = 'tiles_obj/' + lk + '/' + z + '/' + tx + '_' + ty + '.' + ext;
  };

  TotkCanvasMap.prototype._findCachedFallback = function (lk, z, tx, ty) {
    for (var d = 1; d <= 3; d++) {
      var lz = z - d;
      if (lz < 3) break;
      var c = Math.pow(2, d);
      var a = Math.floor(tx / c), b = Math.floor(ty / c);
      var img = this._tileCache.get(lk + ':' + lz + '_' + a + '_' + b);
      if (img && img.complete && img.naturalWidth > 0) return { img: img, lz: lz, a: a, b: b, d: d };
    }
    return null;
  };

  TotkCanvasMap.prototype._drawTiles = function (ctx) {
    var w = this._w, h = this._h, view = this.view, lk = this._layerKey;
    var z = Math.min(6, Math.max(3, Math.round(this._zoom)));
    var tw = 256 * Math.pow(2, 6 - z); // 单张瓦片覆盖的游戏世界边长(米)
    var maxTx = Math.ceil(WORLD_W / tw) - 1;
    var maxTy = Math.ceil(WORLD_H / tw) - 1;

    var gx0 = (0 - view.x) / view.scale;
    var gz0 = (0 - view.y) / view.scale;
    var gx1 = (w - view.x) / view.scale;
    var gz1 = (h - view.y) / view.scale;

    var tx0 = Math.max(0, Math.floor((gx0 - MIN_X) / tw));
    var ty0 = Math.max(0, Math.floor((gz0 - MIN_Z) / tw));
    var tx1 = Math.min(maxTx, Math.floor((gx1 - MIN_X) / tw));
    var ty1 = Math.min(maxTy, Math.floor((gz1 - MIN_Z) / tw));

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    var drawnFb = new Set();
    var reqCount = 0;

    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var key = lk + ':' + z + '_' + tx + '_' + ty;
        var img = this._tileCache.get(key);
        if (img && img.complete && img.naturalWidth > 0) {
          var lx = MIN_X + tx * tw;
          var ly = MIN_Z + ty * tw;
          var sw = tw * view.scale;
          ctx.drawImage(img, view.x + lx * view.scale, view.y + ly * view.scale, sw + 0.6, sw + 0.6);
        } else {
          var fb = this._findCachedFallback(lk, z, tx, ty);
          if (fb) {
            var fk = fb.lz + '_' + fb.a + '_' + fb.b;
            if (!drawnFb.has(fk)) {
              drawnFb.add(fk);
              var fbTw = tw * Math.pow(2, fb.d);
              var flx = MIN_X + fb.a * fbTw;
              var fly = MIN_Z + fb.b * fbTw;
              var fsw = fbTw * view.scale;
              ctx.drawImage(fb.img, view.x + flx * view.scale, view.y + fly * view.scale, fsw + 0.6, fsw + 0.6);
            }
          }
          if (reqCount < 48 && !this._tilePending.has(key)) {
            reqCount++;
            this._loadTile(lk, z, tx, ty, this);
          }
        }
      }
    }
  };

  /* ---------------- 矢量线 / 多边形 / 圆点同帧绘制 ---------------- */
  TotkCanvasMap.prototype._drawVectors = function (ctx) {
    var view = this.view;
    var gx0 = (0 - view.x) / view.scale, gx1 = (this._w - view.x) / view.scale;
    var gz0 = (0 - view.y) / view.scale, gz1 = (this._h - view.y) / view.scale;
    for (var i = 0; i < this._vectors.length; i++) {
      var v = this._vectors[i];
      if (v._bbox && (v._bbox[1] < gz0 || v._bbox[0] > gz1 || v._bbox[3] < gx0 || v._bbox[2] > gx1)) continue;
      var o = v.options || {};
      if (v._isCircle) {
        var cx = view.x + v._latlng.lng * view.scale;
        var cy = view.y + v._latlng.lat * view.scale;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, o.radius || 5, 0, Math.PI * 2);
        if (o.fill !== false) {
          ctx.fillStyle = o.fillColor || o.color || '#3388ff';
          ctx.globalAlpha = o.fillOpacity != null ? o.fillOpacity : 0.5;
          ctx.fill();
        }
        if (o.stroke !== false && (o.weight || 1) > 0) {
          ctx.strokeStyle = o.color || '#ffffff';
          ctx.lineWidth = o.weight || 1.5;
          ctx.globalAlpha = o.opacity != null ? o.opacity : 1;
          ctx.stroke();
        }
        ctx.restore();
      } else if (v._isPolygon) {
        ctx.save();
        ctx.beginPath();
        for (var r = 0; r < v._rings.length; r++) {
          var ring = v._rings[r];
          for (var j = 0; j < ring.length; j++) {
            var px = view.x + ring[j].lng * view.scale;
            var py = view.y + ring[j].lat * view.scale;
            if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
        }
        if (o.fill !== false && o.fillColor) {
          ctx.fillStyle = o.fillColor;
          ctx.globalAlpha = o.fillOpacity != null ? o.fillOpacity : 0.12;
          ctx.fill('evenodd');
        }
        if (o.weight !== 0) {
          if (o.dashArray) ctx.setLineDash(String(o.dashArray).split(',').map(Number));
          ctx.strokeStyle = o.color || '#ffffff';
          ctx.lineWidth = o.weight || 1.5;
          ctx.globalAlpha = o.opacity != null ? o.opacity : 0.9;
          ctx.stroke();
        }
        ctx.restore();
      } else if (v._latlngs && v._latlngs.length >= 2) {
        ctx.save();
        ctx.beginPath();
        for (var k = 0; k < v._latlngs.length; k++) {
          var lx = view.x + v._latlngs[k].lng * view.scale;
          var ly = view.y + v._latlngs[k].lat * view.scale;
          if (k === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
        }
        if (o.dashArray) ctx.setLineDash(String(o.dashArray).split(',').map(Number));
        ctx.strokeStyle = o.color || '#ffd166';
        ctx.lineWidth = o.weight || 2.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = o.opacity != null ? o.opacity : 0.9;
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  TotkCanvasMap.prototype.setAreaLabels = function (list) {
    this._areaLabels = Array.isArray(list) ? list : [];
    this._schedDraw();
    return this;
  };
  TotkCanvasMap.prototype._drawAreaLabels = function (ctx, iconBoxes) {
    this._areaBoxes = [];
    var list = this._areaLabels;
    if (!list || !list.length) return;
    var view = this.view, w = this._w, h = this._h;
    var z = Math.min(7, Math.round(this._zoom));
    var pad = 120;
    var cands = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.vis && a.vis.indexOf(z) < 0) continue;
      var ax = view.x + a.y * view.scale;
      var ay = view.y + a.x * view.scale;
      if (ax < -pad || ax > w + pad || ay < -pad || ay > h + pad) continue;
      cands.push({ a: a, x: ax, y: ay });
    }
    if (!cands.length) return;
    cands.sort(function (u, v) { return (u.a.prio || 5) - (v.a.prio || 5); });
    ctx.save();
    var disp = (root.TOTK_ADV && root.TOTK_ADV.s && root.TOTK_ADV.s.display) || {};
    var areaScale = disp.areaSizeScale || 1.0;
    var areaAlphaBase = (disp.areaAlpha != null ? disp.areaAlpha : 100) / 100;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#3f3010';
    ctx.fillStyle = disp.areaColor || '#bfae68';
    ctx.lineJoin = 'round';
    var boxes = this._areaBoxes;
    var icons = iconBoxes || [];
    var offsets = [[0, 0], [0, -24], [0, 24], [-28, 0], [28, 0]];
    function overlapsAny(bx1, by1, bx2, by2, arr) {
      for (var n = 0; n < arr.length; n++) {
        var b = arr[n];
        if (bx1 < b[2] && bx2 > b[0] && by1 < b[3] && by2 > b[1]) return true;
      }
      return false;
    }
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j], a = c.a;
      var fs = Math.round(Math.max(10, a.size * (0.5 + z * 0.13) * areaScale));
      ctx.font = '600 ' + fs + 'px "PingFang SC","Microsoft YaHei","SimSun",sans-serif';
      var tw = ctx.measureText(a.name).width;
      var hw = tw / 2 + 4, hh = fs / 2 + 2;
      var chosen = null, hitIconFallback = false;
      for (var oi = 0; oi < offsets.length; oi++) {
        var ox = c.x + offsets[oi][0], oy = c.y + offsets[oi][1];
        var bx1 = ox - hw, by1 = oy - hh, bx2 = ox + hw, by2 = oy + hh;
        if (overlapsAny(bx1, by1, bx2, by2, boxes)) continue;
        if (!overlapsAny(bx1, by1, bx2, by2, icons)) {
          chosen = [ox, oy, bx1, by1, bx2, by2];
          break;
        }
      }
      if (!chosen) {
        var fx1 = c.x - hw, fy1 = c.y - hh, fx2 = c.x + hw, fy2 = c.y + hh;
        if (overlapsAny(fx1, fy1, fx2, fy2, boxes)) continue;
        chosen = [c.x, c.y, fx1, fy1, fx2, fy2];
        hitIconFallback = true;
      }
      boxes.push([chosen[2], chosen[3], chosen[4], chosen[5]]);
      ctx.globalAlpha = (hitIconFallback ? 0.58 : 1.0) * areaAlphaBase;
      ctx.lineWidth = 3;
      ctx.strokeText(a.name, chosen[0], chosen[1]);
      ctx.fillText(a.name, chosen[0], chosen[1]);
    }
    ctx.restore();
  };

  /* ---------------- 离屏静态层重建（动静分离缓存核心） ---------------- */
  TotkCanvasMap.prototype._rebuildStaticCache = function () {
    var sc = this._staticCache;
    var isMob = !!(root.TOTK_ADV && root.TOTK_ADV.isMobileDevice && root.TOTK_ADV.isMobileDevice());
    var pad = isMob ? 64 : 128;
    var cw = this._w + pad * 2;
    var ch = this._h + pad * 2;
    var dpr = this._dpr || 1;
    var pxW = Math.max(1, Math.round(cw * dpr));
    var pxH = Math.max(1, Math.round(ch * dpr));
    if (sc.canvas.width !== pxW || sc.canvas.height !== pxH) {
      sc.canvas.width = pxW;
      sc.canvas.height = pxH;
    }
    var sctx = sc.ctx;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, cw, ch);

    var origVx = this.view.x, origVy = this.view.y, origW = this._w, origH = this._h;
    sc.vx = origVx;
    sc.vy = origVy;
    sc.scale = this.view.scale;
    sc.w = cw;
    sc.h = ch;
    sc.pad = pad;
    sc.dpr = dpr;
    sc.dirty = false;

    this.view.x = origVx + pad;
    this.view.y = origVy + pad;
    this._w = cw;
    this._h = ch;
    try {
      this._drawTiles(sctx);
      this._drawVectors(sctx);
      var allIconBoxes = [];
      for (var i = 0; i < this._exploreLayers.length; i++) {
        var layer = this._exploreLayers[i];
        if (layer._renderIcons) {
          layer._renderIcons(sctx);
          if (layer._iconBoxes) {
            for (var ib = 0; ib < layer._iconBoxes.length; ib++) allIconBoxes.push(layer._iconBoxes[ib]);
          }
        } else {
          layer._renderOn(sctx);
        }
      }
      var view = this.view, dpad = 48, w = this._w, h = this._h;
      var dms = this._domMarkers || [];
      for (var di = 0; di < dms.length; di++) {
        var dm = dms[di];
        if (!dm || !dm._latlng || !dm._el || dm._el.style.display === 'none') continue;
        var dx = view.x + dm._latlng.lng * view.scale;
        var dy = view.y + dm._latlng.lat * view.scale;
        if (dx < -dpad * 2 || dx > w + dpad * 2 || dy < -dpad * 2 || dy > h + dpad * 2) continue;
        var icSz = (dm.options && dm.options.icon && dm.options.icon.options && dm.options.icon.options.iconSize) || [26, 26];
        var dw = (icSz[0] || 26) / 2 + 2, dh = (icSz[1] || 26) / 2 + 2;
        allIconBoxes.push([dx - dw, dy - dh, dx + dw, dy + dh]);
      }
      this._drawAreaLabels(sctx, allIconBoxes);
      for (var i2 = 0; i2 < this._exploreLayers.length; i2++) {
        if (this._exploreLayers[i2]._renderLabels) this._exploreLayers[i2]._renderLabels(sctx);
      }
      for (var j = 0; j < this._matLayers.length; j++) this._matLayers[j]._renderOn(sctx);
    } finally {
      this.view.x = origVx;
      this.view.y = origVy;
      this._w = origW;
      this._h = origH;
    }
  };

  /* ---------------- 主渲染帧（动静分离：1 次 drawImage 静态缓存 + 动态覆盖层） ---------------- */
  TotkCanvasMap.prototype._draw = function (opts) {
    var sc = this._staticCache;
    var view = this.view;
    var needStatic = sc.dirty ||
      sc.scale !== view.scale ||
      sc.dpr !== this._dpr ||
      Math.abs(view.x - sc.vx) > sc.pad ||
      Math.abs(view.y - sc.vy) > sc.pad;
    if (needStatic) {
      this._rebuildStaticCache();
    }
    var ctx = this._ctx;
    ctx.clearRect(0, 0, this._w, this._h);
    var ox = view.x - sc.vx - sc.pad;
    var oy = view.y - sc.vy - sc.pad;
    ctx.drawImage(sc.canvas, ox, oy, sc.w, sc.h);
    if (this._liveOverlay) {
      try { this._liveOverlay(ctx, this); } catch (e) { console.error('[TotkMap] liveOverlay', e); }
    }
    for (var k = 0; k < this._domMarkers.length; k++) this._posDomMarker(this._domMarkers[k]);
  };

  /* 将屏幕点转换到静态缓存坐标系（确保离屏缓存平移期内点击/悬停像素级精准） */
  TotkCanvasMap.prototype._screenToStaticPt = function (pt) {
    var sc = this._staticCache;
    if (!sc || sc.dirty) return pt;
    var ox = this.view.x - sc.vx - sc.pad;
    var oy = this.view.y - sc.vy - sc.pad;
    return new Point(pt.x - ox, pt.y - oy);
  };

  /* ---------------- 鼠标与触控交互 ---------------- */
  TotkCanvasMap.prototype._bindInteractions = function () {
    var self = this, cv = this._canvas;
    var drag = null, pinch = null, moved = false;

    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 32;
      else if (e.deltaMode === 2) dy *= 120;
      var pt = self.mouseEventToContainerPoint(e);
      var factor = Math.pow(2, -dy * 0.0022);
      self.zoomAt(pt.x, pt.y, factor);
      hideTooltip();
    }, { passive: false });

    cv.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (self._flyRaf) { cancelAnimationFrame(self._flyRaf); self._flyRaf = 0; }
      drag = { sx: e.clientX, sy: e.clientY, vx: self.view.x, vy: self.view.y };
      moved = false;
      self._isDragging = false;
      cv.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', function (e) {
      if (drag) {
        var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
          moved = true;
          self._isDragging = true;
          self.fire('dragstart');
        }
        self.view.x = drag.vx + dx;
        self.view.y = drag.vy + dy;
        self._syncCenterFromView();
        self._draw({ dynamicOnly: true });
        self.fire('move');
        hideTooltip();
        return;
      }
      var r = cv.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      var pt = new Point(e.clientX - r.left, e.clientY - r.top);
      self._handleHover(pt, e);
    });

    window.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      self._isDragging = false;
      cv.style.cursor = '';
      if (moved) self.fire('moveend');
    });

    cv.addEventListener('mouseleave', function () { hideTooltip(); });

    cv.addEventListener('click', function (e) {
      if (moved) { moved = false; return; }
      var pt = self.mouseEventToContainerPoint(e);
      var spt = self._screenToStaticPt(pt);
      var ll = self.containerPointToLatLng(pt);
      var ev = { originalEvent: e, containerPoint: pt, layerPoint: pt, latlng: ll };
      for (var i = self._exploreLayers.length - 1; i >= 0; i--) {
        if (self._exploreLayers[i]._handleClick(spt, ev)) return;
      }
      for (var j = self._matLayers.length - 1; j >= 0; j--) {
        if (self._matLayers[j]._handleClick(spt, ev)) return;
      }
      self.fire('click', ev);
    });

    /* 手机端触控平移 + 双指捏合缩放 */
    cv.addEventListener('touchstart', function (e) {
      if (self._flyRaf) { cancelAnimationFrame(self._flyRaf); self._flyRaf = 0; }
      if (e.touches.length === 1) {
        var t = e.touches[0];
        drag = { sx: t.clientX, sy: t.clientY, vx: self.view.x, vy: self.view.y };
        pinch = null;
        moved = false;
        self._isDragging = false;
      } else if (e.touches.length === 2) {
        drag = null;
        var t0 = e.touches[0], t1 = e.touches[1];
        var r = cv.getBoundingClientRect();
        var dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        var mx = (t0.clientX + t1.clientX) / 2 - r.left;
        var my = (t0.clientY + t1.clientY) / 2 - r.top;
        pinch = { dist: dist, mx: mx, my: my };
      }
    }, { passive: true });

    cv.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1 && drag) {
        e.preventDefault();
        var t = e.touches[0];
        var dx = t.clientX - drag.sx, dy = t.clientY - drag.sy;
        if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          moved = true;
          self._isDragging = true;
          self.fire('dragstart');
        }
        self.view.x = drag.vx + dx;
        self.view.y = drag.vy + dy;
        self._syncCenterFromView();
        self._draw();
      } else if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        var t0 = e.touches[0], t1 = e.touches[1];
        var r = cv.getBoundingClientRect();
        var dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        var mx = (t0.clientX + t1.clientX) / 2 - r.left;
        var my = (t0.clientY + t1.clientY) / 2 - r.top;
        if (pinch.dist > 0 && dist > 0) {
          self.zoomAt(mx, my, dist / pinch.dist);
        }
        pinch.dist = dist;
        pinch.mx = mx;
        pinch.my = my;
      }
    }, { passive: false });

    cv.addEventListener('touchend', function (e) {
      if (e.touches.length === 0) {
        if (drag && moved) self.fire('moveend');
        drag = null;
        self._isDragging = false;
        pinch = null;
      }
    });

    window.addEventListener('resize', function () {
      self._resize();
      self._syncViewFromCenterZoom();
      self._schedDraw();
    });
  };

  TotkCanvasMap.prototype._handleHover = function (pt, e) {
    var spt = this._screenToStaticPt(pt);
    for (var i = this._exploreLayers.length - 1; i >= 0; i--) {
      if (this._exploreLayers[i]._handleHover(spt, e)) return;
    }
    for (var j = this._matLayers.length - 1; j >= 0; j--) {
      if (this._matLayers[j]._handleHover(spt, e)) return;
    }
    this._canvas.style.cursor = '';
    hideTooltip();
  };

  /* ---------------- 探索标点层 TotkCanvasLayer（挂入主画布同帧绘制） ---------------- */
  function TotkCanvasLayer(mapOrOpts, maybeOpts) {
    Emitter.call(this);
    var opts = {};
    var directMap = null;
    if (mapOrOpts && mapOrOpts._canvas) { directMap = mapOrOpts; opts = maybeOpts || {}; }
    else if (mapOrOpts) opts = mapOrOpts;
    this.options = Object.assign({
      padding: 0.2, markerSize: 24, hitRadius: 16,
      showNames: false, labelMinZoom: 5,
      getMarkerSize: null, getIconUrl: null, isDone: null, getLabel: null
    }, opts);
    this._data = [];
    this._visibleMarkers = [];
    this._map = null;
    if (directMap) this.addTo(directMap);
  }
  TotkCanvasLayer.prototype = Object.create(Emitter.prototype);
  TotkCanvasLayer.prototype.addTo = function (map) {
    this._map = map;
    if (map._exploreLayers.indexOf(this) < 0) map._exploreLayers.push(this);
    map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype.setData = function (data) {
    this._data = Array.isArray(data) ? data : [];
    var opt = this.options;
    var CELL = 512, cols = Math.ceil(WORLD_W / CELL);
    var grid = {};
    var items = [];
    for (var i = 0; i < this._data.length; i++) {
      var m = this._data[i];
      if (!m) continue;
      var isChestCoord = !!(m.drop || m.drop_zh || m.type === 'chest' || (m.id && String(m.id).indexOf('c_') === 0) || m.y === undefined);
      var lat = isChestCoord ? m.z : m.x;
      var lng = isChestCoord ? m.x : m.y;
      if (lat == null || lng == null) continue;
      var iconUrl = typeof opt.getIconUrl === 'function' ? opt.getIconUrl(m) : (m.iconUrl || null);
      var item = {
        m: m,
        lat: lat,
        lng: lng,
        iconUrl: iconUrl,
        isChest: isChestCoord,
        isKorok: !!(root.TOTK_KOROK_INFO && root.TOTK_KOROK_INFO[m.id])
      };
      var idx = items.length;
      items.push(item);
      var cx = Math.floor((lng - MIN_X) / CELL);
      var cy = Math.floor((lat - MIN_Z) / CELL);
      var gk = cy * cols + cx;
      if (!grid[gk]) grid[gk] = [];
      grid[gk].push(idx);
    }
    this._items = items;
    this._grid = grid;
    this._gridCols = cols;
    this._gridCell = CELL;
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype.setShowNames = function (show) {
    this.options.showNames = !!show;
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype.setShowTaskNames = function (show) {
    this.options.showTaskNames = !!show;
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype.redraw = function () {
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype.clear = function () {
    this._data = [];
    this._items = [];
    this._grid = null;
    this._visibleMarkers = [];
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkCanvasLayer.prototype._renderIcons = function (ctx) {
    var map = this._map, view = map.view, w = map._w, h = map._h;
    var zoom = map._zoom, opt = this.options;
    var items = this._items || [];
    if (!items.length) {
      this._visibleMarkers = [];
      this._iconBoxes = [];
      this._pendingLabels = [];
      return;
    }
    var pad = 48;
    var vis = [], labelList = [], iconBoxes = [];
    var onImg = function () { map._schedDraw(); };

    /* 512m 空间网格裁剪，只遍历视口内网格单元 */
    var gx0 = (-pad - view.x) / view.scale, gx1 = (w + pad - view.x) / view.scale;
    var gz0 = (-pad - view.y) / view.scale, gz1 = (h + pad - view.y) / view.scale;
    var CELL = this._gridCell || 512, cols = this._gridCols || 24;
    var c0x = Math.floor((gx0 - MIN_X) / CELL), c1x = Math.floor((gx1 - MIN_X) / CELL);
    var c0y = Math.floor((gz0 - MIN_Z) / CELL), c1y = Math.floor((gz1 - MIN_Z) / CELL);
    var grid = this._grid;

    var curAlpha = 1.0;
    ctx.globalAlpha = 1.0;

    for (var cy = c0y; cy <= c1y; cy++) {
      for (var cx = c0x; cx <= c1x; cx++) {
        var bucket = grid[cy * cols + cx];
        if (!bucket) continue;
        for (var bi = 0; bi < bucket.length; bi++) {
          var it = items[bucket[bi]];
          var m = it.m;
          var x = view.x + it.lng * view.scale;
          var y = view.y + it.lat * view.scale;
          if (x < -pad || x > w + pad || y < -pad || y > h + pad) continue;

          var isDone = typeof opt.isDone === 'function' ? opt.isDone(m) : !!m.done;
          var size = typeof opt.getMarkerSize === 'function' ? opt.getMarkerSize(m, zoom) : (opt.markerSize || 24);
          if (!size || size <= 0) size = 24;

          var img = it.iconUrl ? getCachedImage(it.iconUrl, onImg) : null;
          var targetAlpha = isDone ? 0.45 : 1.0;
          if (curAlpha !== targetAlpha) { ctx.globalAlpha = targetAlpha; curAlpha = targetAlpha; }

          if (img) {
            ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
          } else {
            ctx.beginPath();
            ctx.arc(x, y, Math.max(4, size * 0.35), 0, Math.PI * 2);
            ctx.fillStyle = m.color || '#3498db';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
          if (isDone) {
            if (curAlpha !== 1.0) { ctx.globalAlpha = 1.0; curAlpha = 1.0; }
            ctx.strokeStyle = '#7dffa0';
            ctx.lineWidth = Math.max(1.5, size * 0.16);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(x - size * 0.22, y);
            ctx.lineTo(x - size * 0.05, y + size * 0.18);
            ctx.lineTo(x + size * 0.24, y - size * 0.18);
            ctx.stroke();
          }

          vis.push({ marker: m, x: x, y: y, size: size });
          var vh = size / 2 + 1;
          iconBoxes.push([x - vh, y - vh, x + vh, y + vh]);
          var dispCfg = (root.TOTK_ADV && root.TOTK_ADV.s && root.TOTK_ADV.s.display) || {};
          var minLabelZ = dispCfg.labelMinZoom != null ? dispCfg.labelMinZoom : (opt.labelMinZoom || 6);
          if (opt.showNames && zoom >= minLabelZ) {
            labelList.push({ m: m, x: x, y: y, size: size, isDone: isDone });
          }
        }
      }
    }
    if (curAlpha !== 1.0) ctx.globalAlpha = 1.0;
    this._visibleMarkers = vis;
    this._iconBoxes = iconBoxes;
    this._pendingLabels = labelList;
  };
  TotkCanvasLayer.prototype._renderLabels = function (ctx) {
    var map = this._map, view = map.view, w = map._w, h = map._h;
    var zoom = map._zoom, opt = this.options, pad = 48;
    var labelList = (this._pendingLabels || []).slice();
    var placedBoxes = (this._iconBoxes || []).slice();
    /* 避让区域地名文字包围盒（地名已在 Pass 2 避让图标绘制，标点文字避让地名） */
    var aboxes = map._areaBoxes || [];
    for (var ai = 0; ai < aboxes.length; ai++) {
      placedBoxes.push(aboxes[ai]);
    }
    /* 避让视口内可见的 DomMarker（任务图标等），并在最大缩放时收集未完成任务名 */
    var dms = map._domMarkers || [];
    for (var di = 0; di < dms.length; di++) {
      var dm = dms[di];
      if (!dm || !dm._latlng || !dm._el || dm._el.style.display === 'none') continue;
      var dx = view.x + dm._latlng.lng * view.scale;
      var dy = view.y + dm._latlng.lat * view.scale;
      if (dx < -pad * 2 || dx > w + pad * 2 || dy < -pad * 2 || dy > h + pad * 2) continue;
      var icSz = (dm.options && dm.options.icon && dm.options.icon.options && dm.options.icon.options.iconSize) || [26, 26];
      var dw = (icSz[0] || 26) / 2 + 2;
      var dh = (icSz[1] || 26) / 2 + 2;
      placedBoxes.push([dx - dw, dy - dh, dx + dw, dy + dh]);
      if (opt.showTaskNames && zoom >= 7 && dm._taskObj && !dm._taskDone && dm._taskLabel) {
        labelList.push({ isTask: true, m: dm._taskObj, x: dx, y: dy, size: Math.max(icSz[0] || 26, icSz[1] || 26), isDone: false, label: dm._taskLabel });
      }
    }

    if (labelList.length) {
      var PRIORITY_CATS = { 62: 1, 66: 1, 67: 2, 63: 2, 109: 2, 97: 2, 70: 3, 116: 3, 82: 3, 69: 3 };
      labelList.sort(function (a, b) {
        var pa = a.isTask ? 5 : (PRIORITY_CATS[a.m.cat] || 9);
        var pb = b.isTask ? 5 : (PRIORITY_CATS[b.m.cat] || 9);
        if (pa !== pb) return pa - pb;
        if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
        return (a.y - b.y) || (a.x - b.x);
      });
      var dispCfg2 = (root.TOTK_ADV && root.TOTK_ADV.s && root.TOTK_ADV.s.display) || {};
      var fsDelta = dispCfg2.labelSizeDelta || 0;
      var singleLineOnly = dispCfg2.labelLines === 1;
      var fs = Math.min(Math.max(8, Math.round(zoom * 2) + fsDelta), 18);
      var fs2 = Math.max(8, fs - 1);
      var font1 = '600 ' + fs + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      var font2 = '600 ' + fs2 + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.save();
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8, 12, 10, 0.85)';
      for (var j = 0; j < labelList.length; j++) {
        var it = labelList[j];
        var lbl = it.isTask ? it.label : (typeof opt.getLabel === 'function' ? opt.getLabel(it.m) : (it.m.name || it.m.drop_zh || ''));
        if (!lbl) continue;
        var lines = String(lbl).split('\n');
        var line1 = lines[0] || '';
        var line2 = singleLineOnly ? '' : (lines[1] || '');
        ctx.font = font1;
        var w1 = ctx.measureText(line1).width;
        var w2 = 0;
        if (line2) {
          ctx.font = font2;
          w2 = ctx.measureText(line2).width;
        }
        var bw = Math.max(w1, w2) + 8;
        var bh = line2 ? (fs + fs2 + 5) : (fs + 3);
        var halfIcon = it.size / 2;
        /* 四方向尝试：下 → 上 → 右 → 左 */
        var cands = [
          { tx: it.x, ty: it.y + halfIcon + 3, align: 'center', bx1: it.x - bw / 2, by1: it.y + halfIcon + 2 },
          { tx: it.x, ty: it.y - halfIcon - 3 - bh, align: 'center', bx1: it.x - bw / 2, by1: it.y - halfIcon - 4 - bh },
          { tx: it.x + halfIcon + 5, ty: it.y - bh / 2, align: 'left', bx1: it.x + halfIcon + 2, by1: it.y - bh / 2 - 1 },
          { tx: it.x - halfIcon - 5, ty: it.y - bh / 2, align: 'right', bx1: it.x - halfIcon - 2 - bw, by1: it.y - bh / 2 - 1 }
        ];
        var chosen = null;
        for (var ci = 0; ci < cands.length; ci++) {
          var cd = cands[ci];
          var cx1 = cd.bx1, cy1 = cd.by1, cx2 = cx1 + bw, cy2 = cy1 + bh;
          var overlap = false;
          for (var pbIdx = 0; pbIdx < placedBoxes.length; pbIdx++) {
            var b = placedBoxes[pbIdx];
            if (cx1 < b[2] && cx2 > b[0] && cy1 < b[3] && cy2 > b[1]) {
              overlap = true;
              break;
            }
          }
          if (!overlap) {
            chosen = cd;
            placedBoxes.push([cx1, cy1, cx2, cy2]);
            break;
          }
        }
        if (!chosen) continue;
        ctx.textAlign = chosen.align;
        ctx.font = font1;
        ctx.strokeText(line1, chosen.tx, chosen.ty);
        ctx.fillStyle = it.isTask ? '#ffe59e' : (it.isDone ? 'rgba(180, 205, 185, 0.85)' : '#ffffff');
        ctx.fillText(line1, chosen.tx, chosen.ty);
        if (line2) {
          var ly2 = chosen.ty + fs + 2;
          ctx.font = font2;
          ctx.strokeText(line2, chosen.tx, ly2);
          ctx.fillStyle = it.isDone ? 'rgba(160, 195, 170, 0.75)' : 'rgba(215, 238, 222, 0.92)';
          ctx.fillText(line2, chosen.tx, ly2);
        }
      }
      ctx.restore();
    }
  };
  TotkCanvasLayer.prototype._renderOn = function (ctx) {
    this._renderIcons(ctx);
    this._renderLabels(ctx);
  };
  TotkCanvasLayer.prototype._pickCandidates = function (px, py) {
    var out = [], defR = this.options.hitRadius || 16;
    for (var i = this._visibleMarkers.length - 1; i >= 0; i--) {
      var item = this._visibleMarkers[i];
      var r = Math.max(defR, item.size * 0.65);
      var dx = px - item.x, dy = py - item.y;
      var dSq = dx * dx + dy * dy;
      if (dSq <= r * r) out.push({ marker: item.marker, dSq: dSq });
    }
    out.sort(function (a, b) { return a.dSq - b.dSq; });
    return out;
  };
  TotkCanvasLayer.prototype._handleHover = function (pt, e) {
    var cands = this._pickCandidates(pt.x, pt.y);
    if (!cands.length) return false;
    var m = cands[0].marker;
    this._map._canvas.style.cursor = 'pointer';
    var lbl = typeof this.options.getLabel === 'function' ? this.options.getLabel(m) : (m.name || m.drop_zh || '');
    if (lbl) showTooltipText(lbl, e.clientX, e.clientY);
    return true;
  };
  TotkCanvasLayer.prototype._handleClick = function (pt, ev) {
    var cands = this._pickCandidates(pt.x, pt.y);
    if (!cands.length) return false;
    if (cands.length > 1) this.fire('multiclick', cands, ev);
    else this.fire('click', cands[0].marker, ev);
    return true;
  };

  /* ---------------- 材料聚合层 TotkMatCanvasLayer ---------------- */
  function TotkMatCanvasLayer(mapOrOpts, maybeOpts) {
    Emitter.call(this);
    var opts = {};
    var directMap = null;
    if (mapOrOpts && mapOrOpts._canvas) { directMap = mapOrOpts; opts = maybeOpts || {}; }
    else if (mapOrOpts) opts = mapOrOpts;
    this.options = Object.assign({
      hitRadius: 18, FX: 180 / 6000, FZ: 85 / 5000
    }, opts);
    this._visibleItems = [];
    this._map = null;
    if (directMap) this.addTo(directMap);
  }
  TotkMatCanvasLayer.prototype = Object.create(Emitter.prototype);
  TotkMatCanvasLayer.prototype.addTo = function (map) {
    this._map = map;
    if (map._matLayers.indexOf(this) < 0) map._matLayers.push(this);
    map._schedDraw();
    return this;
  };
  TotkMatCanvasLayer.prototype.redraw = function () {
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkMatCanvasLayer.prototype.clear = function () {
    this._visibleItems = [];
    if (this._map) this._map._schedDraw();
    return this;
  };
  TotkMatCanvasLayer.prototype._renderOn = function (ctx) {
    var opt = this.options, map = this._map, view = map.view, w = map._w, h = map._h;
    if (typeof opt.isActive === 'function' && !opt.isActive()) { this._visibleItems = []; return; }
    var selected = typeof opt.getSelected === 'function' ? opt.getSelected() : {};
    var curLayer = typeof opt.getLayer === 'function' ? opt.getLayer() : 0;
    var currentZoom = Math.round(map._zoom);
    var mapBounds = map.getBounds();
    var FX = opt.FX || (180 / 6000), FZ = opt.FZ || (85 / 5000);
    var padX = 800 * FX, padZ = 800 * FZ;
    var fakeBbox = [
      mapBounds.getWest() * FX - padX, mapBounds.getSouth() * FZ - padZ,
      mapBounds.getEast() * FX + padX, mapBounds.getNorth() * FZ + padZ
    ];
    var vis = [], pad = 48;

    for (var midStr in selected) {
      if (!selected[midStr]) continue;
      var mid = Number(midStr);
      var m = typeof opt.getMatConfig === 'function' ? opt.getMatConfig(mid) : null;
      if (!m) continue;
      var idxr = typeof opt.getClusterer === 'function' ? opt.getClusterer(mid, curLayer) : null;
      if (!idxr) continue;
      var clusters = idxr.getClusters(fakeBbox, currentZoom);

      for (var ci = 0; ci < clusters.length; ci++) {
        var c = clusters[ci];
        var coords = c.geometry.coordinates;
        var gx = coords[0] / FX, gz = coords[1] / FZ;
        var x = view.x + gx * view.scale, y = view.y + gz * view.scale;
        if (x < -pad || x > w + pad || y < -pad || y > h + pad) continue;

        var props = c.properties;
        if (props.cluster) {
          if (typeof opt.isExpanded === 'function' && opt.isExpanded(mid, c.id)) {
            var leaves = idxr.getLeaves(c.id, Infinity) || [];
            for (var li = 0; li < leaves.length; li++) {
              var lf = leaves[li], lc = lf.geometry.coordinates;
              var lgx = lc[0] / FX, lgz = lc[1] / FZ;
              var lx = view.x + lgx * view.scale, ly = view.y + lgz * view.scale;
              if (lx < -pad || lx > w + pad || ly < -pad || ly > h + pad) continue;
              var lsize = typeof opt.getIconSize === 'function' ? opt.getIconSize(currentZoom) : 26;
              var done = (typeof opt.isDone === 'function' && opt.isDone(mid, lf.id)) ||
                         (typeof opt.isCollected === 'function' && opt.isCollected(mid, lf.id));
              this._drawLeaf(ctx, m, lx, ly, lsize, done);
              vis.push({ type: 'leaf', mid: mid, m: m, idx: lf.id, latlng: [lgz, lgx], x: lx, y: ly, size: lsize });
            }
          } else {
            var cnt = props.point_count || 2;
            var cSize = typeof opt.getIconSize === 'function' ? opt.getIconSize(currentZoom) : 28;
            this._drawCluster(ctx, m, x, y, cSize, cnt);
            vis.push({ type: 'cluster', mid: mid, m: m, clusterId: c.id, count: cnt, latlng: [gz, gx], x: x, y: y, size: cSize });
          }
        } else {
          var baseSize = typeof opt.getIconSize === 'function' ? opt.getIconSize(currentZoom) : 26;
          var done2 = (typeof opt.isDone === 'function' && opt.isDone(mid, c.id)) ||
                      (typeof opt.isCollected === 'function' && opt.isCollected(mid, c.id));
          this._drawLeaf(ctx, m, x, y, baseSize, done2);
          vis.push({ type: 'leaf', mid: mid, m: m, idx: c.id, latlng: [gz, gx], x: x, y: y, size: baseSize });
        }
      }
    }
    this._visibleItems = vis;
  };
  TotkMatCanvasLayer.prototype._roundRect = function (ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  TotkMatCanvasLayer.prototype._drawBadge = function (ctx, sx, sy, n) {
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
  };
  TotkMatCanvasLayer.prototype._drawCluster = function (ctx, m, x, y, size, count) {
    var self = this;
    ctx.save();
    var matKey = m.entry || m.actor;
    var url = matKey ? ('assets/materials/' + matKey + '.png') : null;
    var img = url ? getCachedImage(url, function () { if (self._map) self._map._schedDraw(); }) : null;
    if (img) {
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    } else {
      ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#2c3e50'; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    this._drawBadge(ctx, x, y - size / 2 - 2, count);
    ctx.restore();
  };
  TotkMatCanvasLayer.prototype._drawLeaf = function (ctx, m, x, y, size, isDone) {
    var self = this;
    ctx.save();
    ctx.globalAlpha = isDone ? 0.38 : 1.0;
    var matKey = m.entry || m.actor;
    var url = matKey ? ('assets/materials/' + matKey + '.png') : null;
    var img = url ? getCachedImage(url, function () { if (self._map) self._map._schedDraw(); }) : null;
    if (img) ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    else {
      ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#16a085'; ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (isDone) {
      ctx.globalAlpha = 1.0; ctx.strokeStyle = '#7dffa0';
      ctx.lineWidth = Math.max(1.5, size * 0.16); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x - size * 0.22, y); ctx.lineTo(x - size * 0.05, y + size * 0.18);
      ctx.lineTo(x + size * 0.26, y - size * 0.16); ctx.stroke();
    }
    ctx.restore();
  };
  TotkMatCanvasLayer.prototype._pickItem = function (px, py) {
    var best = null, minD = Infinity, defR = this.options.hitRadius || 18;
    for (var i = this._visibleItems.length - 1; i >= 0; i--) {
      var it = this._visibleItems[i];
      var r = Math.max(defR, (it.size || 24) * 0.65);
      var dSq = (px - it.x) * (px - it.x) + (py - it.y) * (py - it.y);
      if (dSq <= r * r && dSq < minD) { minD = dSq; best = it; }
    }
    return best;
  };
  TotkMatCanvasLayer.prototype._handleHover = function (pt, e) {
    var hit = this._pickItem(pt.x, pt.y);
    if (!hit) return false;
    this._map._canvas.style.cursor = 'pointer';
    var rawCn = hit.m.cn || hit.m.name || hit.m.title || '';
    var matName = (root.I18N && typeof root.I18N.nameOf === 'function') ? (root.I18N.nameOf(rawCn) || rawCn) : rawCn;
    if (matName) {
      var text = hit.type === 'cluster'
        ? (matName + ' × ' + hit.count)
        : (((this.options.isDone && this.options.isDone(hit.mid, hit.idx)) || (this.options.isCollected && this.options.isCollected(hit.mid, hit.idx))) ? '✓ ' : '') + matName;
      showTooltipText(text, e.clientX, e.clientY);
    }
    return true;
  };
  TotkMatCanvasLayer.prototype._handleClick = function (pt, ev) {
    var hit = this._pickItem(pt.x, pt.y);
    if (!hit) return false;
    if (hit.type === 'cluster') this.fire('clusterClick', hit, ev);
    else this.fire('leafClick', hit, ev);
    return true;
  };

  /* ---------------- 暴露引擎与轻量 L 兼容层（免改 6 个外挂图层） ---------------- */
  root.TotkCanvasLayer = TotkCanvasLayer;
  root.TotkMatCanvasLayer = TotkMatCanvasLayer;
  root.TotkCanvasMap = TotkCanvasMap;

  root.L = {
    CRS: { Simple: {} },
    Util: { extend: function (d) { return Object.assign.apply(Object, arguments); } },
    Transformation: function () {},
    point: function (x, y) { return new Point(x, y); },
    latLng: function (a, b) { return toLatLng(a, b); },
    latLngBounds: function (sw, ne) { return new LatLngBounds(sw, ne); },
    map: function (id, opts) { return new TotkCanvasMap(id, opts); },
    layerGroup: function () { return new LayerGroup(); },
    polyline: function (ll, opts) { return new Polyline(ll, opts); },
    polygon: function (ll, opts) { return new Polygon(ll, opts); },
    circleMarker: function (ll, opts) { return new CircleMarker(ll, opts); },
    marker: function (ll, opts) { return new DomMarker(ll, opts); },
    divIcon: function (opts) { return Object.assign({ _isDiv: true }, opts); },
    icon: function (opts) { return Object.assign({}, opts); }
  };
})(typeof window !== 'undefined' ? window : this);
