/* TOTKmap Service Worker —— V1.9.4 问题3：瓦片/静态资源持久缓存，地图打开秒开
 * 缓存策略：
 *   - 瓦片 tiles_obj/：cache-first（命中直接本地返回，miss 走网络并写入缓存）
 *   - 静态资源 assets/ data/ vendor/ css/ js/：cache-first（js/css 带 ?v= 版本参数，bump 即强刷）
 *   - index.html /：network-first（保证每次拿到最新页面）
 * 瓦片更新约定：更新瓦片后把 SW_VER 递增（如'v1.9.4-1' -> 'v1.9.4-2'），
 * 下次访问自动清理旧缓存并重新缓存新瓦片。
 *
 * ★★ V2.1 M6.5（2026-10-06）：不 bump SW_VER 会「改了代码但页面没变化」。
 *   原因链：sw.js 自身也被 cache-first 缓存（index.html 里 register('sw.js')
 *   没带 ?v=）→ 浏览器一直用第一次缓存的那份 SW → 缓存桶名不变
 *   → 新写的 js/css 虽然 URL 换了 ?v=211，但**旧缓存桶里没有这个新 URL**，
 *     cacheFirst 会去网络取新的（这个没问题）；
 *     真正卡住的是 **sw.js 本身拿不到新版**，导致 activate 时的清理逻辑不生效。
 *   所以凡是改了 js/css/data 又不 bump SW_VER，就会出现「老页面配新资源」
 *   或干脆看不到新功能。
 */
var SW_VER = 'v1.9.4-8';
var TILES_CACHE = 'totk-tiles-' + SW_VER;
var ASSETS_CACHE = 'totk-assets-' + SW_VER;
var KEEP_CACHES = [TILES_CACHE, ASSETS_CACHE];

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return KEEP_CACHES.indexOf(k) < 0; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // 仅处理本站请求

  var path = url.pathname;

  // index.html 走网络优先，保证页面/版本更新立即可见
  if (path === '/' || path === '/index.html') {
    e.respondWith(networkFirst(req));
    return;
  }
  // 瓦片独立缓存桶（更新瓦片只需 bump SW_VER）
  if (path.indexOf('/tiles_obj/') === 0) {
    e.respondWith(cacheFirst(req, TILES_CACHE));
    return;
  }
  // 其余静态资源（assets/data/vendor/css/js）统一缓存桶
  e.respondWith(cacheFirst(req, ASSETS_CACHE));
});

function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          c.put(req, copy);
        }
        return res;
      }).catch(function () {
        return c.match(req);
      });
    });
  });
}

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res && res.status === 200) {
      var copy = res.clone();
      caches.open(ASSETS_CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (h) { return h || Response.error(); });
  });
}
