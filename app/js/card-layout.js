/* ============================================================
 * TOTKmap · 卡片智能避让内核（CardLayout）
 * ------------------------------------------------------------
 * 解决问题：标点卡片弹窗盖住地图标点、玩家定位箭头、或超出屏幕边缘
 * 原理：同时以「目标标点像素坐标 (tx, ty)」与「玩家箭头像素坐标 (px, py)」
 *       为双保护锚点，多方位探测避让；并提供 overlaps() 碰撞检测接口，
 *       仅在玩家移动/地图平移导致重叠时按需让位（带迟滞防抖，不乱晃）。
 * ============================================================ */
(function () {
  'use strict';

  var PAD = 50;          /* 标点保护半径（放置时） */
  var PAD_PLAYER = 56;   /* 玩家箭头保护半径（放置时） */
  var TRIG_TARGET = 42;  /* 标点碰撞触发半径（检测时，小于放置半径形成防抖死区） */
  var TRIG_PLAYER = 46;  /* 玩家箭头碰撞触发半径（检测时，小于放置半径形成防抖死区） */
  var EDGE = 10;         /* 视口四周最小间距 */

  function guardLeft() {
    var p = document.getElementById('panel');
    if (!p) return EDGE;
    if (p.classList.contains('collapsed')) return EDGE;
    return (p.offsetWidth || 352) + 12;
  }

  function hitsPoint(rect, x, y, r) {
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) return false;
    return !(rect.right <= x - r || rect.left >= x + r ||
             rect.bottom <= y - r || rect.top >= y + r);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(val, max));
  }

  /* 检测当前卡片是否与目标标点或玩家箭头发生重叠 */
  function overlaps(card, tx, ty, px, py) {
    if (!card || card.classList.contains('hidden')) return false;
    var vw = window.innerWidth, vh = window.innerHeight;
    if (vw <= 720 && vh > 450) return false;
    var r = card.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return false;
    if (hitsPoint(r, tx, ty, TRIG_TARGET)) return true;
    if (hitsPoint(r, px, py, TRIG_PLAYER)) return true;
    return false;
  }

  function positionCard(card, anchorX, anchorY, playerX, playerY) {
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

    var tx = (typeof anchorX === 'number' && !isNaN(anchorX)) ? anchorX : (vw * 0.5);
    var ty = (typeof anchorY === 'number' && !isNaN(anchorY)) ? anchorY : (vh * 0.5);
    var hasP = (typeof playerX === 'number' && !isNaN(playerX) && typeof playerY === 'number' && !isNaN(playerY));

    // 候选位：围绕目标点 8 方位 + 若存在玩家坐标则补充双点联合包络外侧 4 方位
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

    if (hasP) {
      var boxL = Math.min(tx - PAD, playerX - PAD_PLAYER);
      var boxR = Math.max(tx + PAD, playerX + PAD_PLAYER);
      var boxT = Math.min(ty - PAD, playerY - PAD_PLAYER);
      var boxB = Math.max(ty + PAD, playerY + PAD_PLAYER);
      var midY = (ty + playerY) / 2;
      var midX = (tx + playerX) / 2;
      cands.push(
        [boxR, midY - ch / 2],
        [boxL - cw, midY - ch / 2],
        [midX - cw / 2, boxB],
        [midX - cw / 2, boxT - ch]
      );
    }

    var best = null;
    var bestNoPlayer = null;
    for (var i = 0; i < cands.length; i++) {
      var lx = clamp(cands[i][0], minX, maxX);
      var ly = clamp(cands[i][1], minY, maxY);
      var r = { left: lx, top: ly, right: lx + cw, bottom: ly + ch };

      var hitT = hitsPoint(r, tx, ty, PAD);
      var hitP = hasP && hitsPoint(r, playerX, playerY, PAD_PLAYER);
      if (!hitT && !hitP) {
        best = { x: lx, y: ly };
        break;
      }
      if (!hitP && !bestNoPlayer) {
        bestNoPlayer = { x: lx, y: ly };
      }
    }

    if (!best) best = bestNoPlayer;

    // 极端小视口兜底：远离玩家箭头与标点的较宽敞一侧
    if (!best) {
      var refX = hasP ? (tx + playerX) / 2 : tx;
      var fallbackX = (refX > (vw + minX) / 2) ? minX : maxX;
      var fallbackY = clamp(ty - ch / 2, minY, maxY);
      best = { x: fallbackX, y: fallbackY };
    }

    card.style.left = Math.round(best.x) + 'px';
    card.style.top = Math.round(best.y) + 'px';
    card.style.bottom = 'auto';
    card.style.right = 'auto';
  }

  window.CardLayout = {
    positionCard: positionCard,
    overlaps: overlaps
  };
})();
