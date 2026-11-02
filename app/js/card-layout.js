/* ============================================================
 * TOTKmap · 卡片智能避让内核（CardLayout）
 * ------------------------------------------------------------
 * 解决问题：标点卡片弹窗盖住地图标点、玩家定位图标、或超出屏幕边缘
 * 原理：以标点在视口内的真实像素坐标为锚点，八方向探测避让，
 *       保护标点中心 PAD 半径内不被任何 DOM 卡片遮挡。
 * ============================================================ */
(function () {
  'use strict';

  var PAD = 50;        /* 标点保护半径（图标 + 光圈 + 安全余量） */
  var EDGE = 10;       /* 视口四周最小间距 */

  function guardLeft() {
    var p = document.getElementById('panel');
    if (!p) return EDGE;
    if (p.classList.contains('collapsed')) return EDGE;
    return (p.offsetWidth || 352) + 12;
  }

  function hitsTarget(rect, tx, ty) {
    return !(rect.right <= tx - PAD || rect.left >= tx + PAD ||
             rect.bottom <= ty - PAD || rect.top >= ty + PAD);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
  }

  function positionCard(card, anchorX, anchorY) {
    if (!card) return;
    var vw = window.innerWidth, vh = window.innerHeight;

    // 移动端竖屏：沿用底部浮动卡片
    if (vw <= 720 && vh > 450) {
      card.style.left = '';
      card.style.top = '';
      return;
    }

    var cw = card.offsetWidth || 300;
    var ch = card.offsetHeight || 220;

    var minX = guardLeft();
    var maxX = Math.max(minX, vw - cw - EDGE);
    var minY = EDGE;
    var maxY = Math.max(minY, vh - ch - EDGE);

    var tx = (typeof anchorX === 'number') ? anchorX : (vw * 0.5);
    var ty = (typeof anchorY === 'number') ? anchorY : (vh * 0.5);

    // 候选位（8个方位）：右 -> 左 -> 下 -> 上 -> 四个对角
    var cands = [
      [tx + PAD, ty - ch / 2],           // 右侧居中
      [tx - PAD - cw, ty - ch / 2],       // 左侧居中
      [tx - cw / 2, ty + PAD],           // 下方居中
      [tx - cw / 2, ty - PAD - ch],       // 上方居中
      [tx + PAD, ty + PAD],              // 右下
      [tx + PAD, ty - PAD - ch],          // 右上
      [tx - PAD - cw, ty + PAD],          // 左下
      [tx - PAD - cw, ty - PAD - ch]      // 左上
    ];

    var best = null;
    for (var i = 0; i < cands.length; i++) {
      var lx = clamp(cands[i][0], minX, maxX);
      var ly = clamp(cands[i][1], minY, maxY);
      var r = { left: lx, top: ly, right: lx + cw, bottom: ly + ch };

      if (!hitsTarget(r, tx, ty)) {
        best = { x: lx, y: ly };
        break;
      }
    }

    // 若视口实在太小全部相交，退回右侧或最宽敞侧并尽量靠边
    if (!best) {
      var fallbackX = (tx > (vw + minX) / 2) ? minX : maxX;
      var fallbackY = clamp(ty - ch / 2, minY, maxY);
      best = { x: fallbackX, y: fallbackY };
    }

    card.style.left = Math.round(best.x) + 'px';
    card.style.top = Math.round(best.y) + 'px';
    card.style.bottom = 'auto';
    card.style.right = 'auto';
  }

  window.CardLayout = {
    positionCard: positionCard
  };
})();
