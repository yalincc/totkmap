/* ============ TOTKMAP · 蓝图分享与导入（纯前端，零依赖） ============
 *
 * 职责：把存档里的蓝图槽封装成社区通用 .cai，以及把 .cai / 分享码还原成可写入的字节。
 * 字节怎么改由 save-writer.js 负责，本文件不碰存档、不碰偏移。
 *
 * 格式依据（2026-11-05 实测 + 社区权威定义）：
 *   marcrobledo/savegame-editors · zelda-totk.class.autobuilder.js
 *     CAI_HEADER='CmbAct' / CAI_SIZE=6688 / CAI_EDITOR_SIZE=6712 / CAI_DRAFT_SIZE=7840
 *   zelda-totk.js:49  'AutoBuilder.Draft.Content.CombinedActorInfo' // binary data (size=6688)
 *   示例 progress.sav：30 槽，每槽 4 字节长度头(0x1a20) + 6688 数据 = stride 6692
 *
 * 分享码 TKB1-<base64url(RLE(6712 字节))>-<fnv1a 8 位十六进制>
 *   · .cai 里约 88% 是零，RLE 后通常 1KB 上下，单张二维码装得下
 *   · 不引压缩库、不依赖 CompressionStream，纯同步 JS，离线可用
 *   · 二维码内容就是这串文本，任意扫码工具扫出后粘贴到网页即可导入，不需解码库
 */
(function (global) {
  'use strict';

  var HEADER = 'CmbAct';
  var CAI_SIZE = 6688;          // 蓝图数据本体
  var CAI_DRAFT_SIZE = 7840;    // 草稿变体（6688 + 1152）
  var CAI_EDITOR_SIZE = 6712;   // 数据 + 相机参数 24 字节
  var PREFIX = 'TKB1-';

  function fail(msg) {
    var e = new Error(msg);
    e.isBlueprintError = true;
    throw e;
  }

  function isHeader(u8) {
    if (!u8 || u8.length < 6) return false;
    for (var i = 0; i < 6; i++) if (u8[i] !== HEADER.charCodeAt(i)) return false;
    return true;
  }

  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

  /* ---------- .cai 封装 / 解封 ---------- */

  /* slot: { data: Uint8Array(6688), camPos:{x,y,z}|null, camAt:{x,y,z}|null } */
  function toCai(slot) {
    var data = u8(slot && slot.data);
    if (data.length !== CAI_SIZE || !isHeader(data)) fail('这个槽里没有有效蓝图');
    var out = new Uint8Array(CAI_EDITOR_SIZE);
    out.set(data, 0);
    var v = new DataView(out.buffer);
    ['camPos', 'camAt'].forEach(function (key, k) {
      var c = slot[key];
      if (!c) return;
      var base = CAI_SIZE + k * 12;
      v.setFloat32(base, +c.x || 0, true);
      v.setFloat32(base + 4, +c.y || 0, true);
      v.setFloat32(base + 8, +c.z || 0, true);
    });
    return out;
  }

  /* 接受 6688 / 6712 / 7840 三种长度；草稿只取前 6688（照开源 fromFile） */
  function parseCai(raw) {
    var b = u8(raw);
    if (b.length !== CAI_SIZE && b.length !== CAI_EDITOR_SIZE && b.length !== CAI_DRAFT_SIZE) {
      fail('不是有效的 .cai 蓝图（长度 ' + b.length + '，只认 6688 / 6712 / 7840）');
    }
    if (!isHeader(b)) fail('不是有效的 .cai 蓝图（缺 CmbAct 文件头）');
    var data = b.slice(0, CAI_SIZE);
    var out = { data: data, camPos: null, camAt: null, hasCamera: b.length === CAI_EDITOR_SIZE };
    if (out.hasCamera) {
      var v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      out.camPos = { x: v.getFloat32(CAI_SIZE, true), y: v.getFloat32(CAI_SIZE + 4, true), z: v.getFloat32(CAI_SIZE + 8, true) };
      out.camAt = { x: v.getFloat32(CAI_SIZE + 12, true), y: v.getFloat32(CAI_SIZE + 16, true), z: v.getFloat32(CAI_SIZE + 20, true) };
    }
    return out;
  }

  /* ---------- 零游程编码 ----------
   * 控制字节：0 → 后跟 2 字节大端长度表示连续零；1..255 → 后跟 N 个非零字节。
   * 空档 / 简单蓝图压缩率极高，且编解码都是几十行同步代码。 */
  function rleEncode(src) {
    var chunks = [], total = 0, i = 0;
    function put(arr) { chunks.push(arr); total += arr.length; }
    while (i < src.length) {
      if (src[i] === 0) {
        var run = 1;
        while (i + run < src.length && src[i + run] === 0 && run < 65535) run++;
        put(new Uint8Array([0, run >> 8, run & 255]));
        i += run;
      } else {
        var seg = [];
        while (i < src.length && src[i] !== 0 && seg.length < 255) { seg.push(src[i]); i++; }
        put(new Uint8Array([seg.length].concat(seg)));
      }
    }
    var out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  function rleDecode(src, expectLen) {
    var out = new Uint8Array(expectLen), p = 0, i = 0;
    while (i < src.length) {
      var c = src[i++];
      if (c === 0) {
        if (i + 2 > src.length) fail('分享码损坏（零游程被截断）');
        var run = (src[i] << 8) | src[i + 1]; i += 2;
        if (p + run > expectLen) fail('分享码损坏（数据超长）');
        p += run;                       // out 初始就是 0，不必逐字节填
      } else {
        if (i + c > src.length || p + c > expectLen) fail('分享码损坏（数据段被截断）');
        out.set(src.subarray(i, i + c), p);
        i += c; p += c;
      }
    }
    if (p !== expectLen) fail('分享码损坏（长度不符）');
    return out;
  }

  /* ---------- base64url（只处理 ASCII 字节流） ---------- */
  function b64encode(bytes) {
    var s = '', chunk = 8192;
    for (var i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64decode(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = global.atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fnv1a(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /* ---------- 分享码 ---------- */
  function encodeShare(cai) {
    var b = u8(cai);
    if (b.length !== CAI_EDITOR_SIZE || !isHeader(b)) fail('只能分享完整的 6712 字节蓝图');
    return PREFIX + b64encode(rleEncode(b)) + '-' + fnv1a(b);
  }

  function decodeShare(text) {
    var s = String(text || '').trim().replace(/\s+/g, '');
    if (s.indexOf(PREFIX) !== 0) fail('分享码要以 TKB1- 开头');
    /* base64url 自己就可能含 '-'，所以只认「最后一个」连字符后面是 8 位校验 */
    var rest = s.slice(PREFIX.length);
    var cut = rest.lastIndexOf('-');
    var b64 = cut > 0 ? rest.slice(0, cut) : '';
    var sum = cut > 0 ? rest.slice(cut + 1) : '';
    if (!b64 || !/^[0-9a-f]{8}$/.test(sum)) fail('分享码格式不对（缺校验位或被截断）');
    var body;
    try { body = rleDecode(b64decode(b64), CAI_EDITOR_SIZE); }
    catch (e) { fail('分享码解不开：' + e.message); }
    if (fnv1a(body) !== sum) fail('分享码校验不通过，可能复制时缺了几位');
    if (!isHeader(body)) fail('分享码里不是有效蓝图');
    return body;
  }

  /* ---------- 二维码（本地 vendor/qrcode.min.js，离线可用） ----------
   * 返回 SVG 字符串；太长或库没加载时返回 null，调用方降级为「只给分享码文本」。 */
  function qrSvg(text) {
    if (typeof global.qrcode !== 'function') return null;
    try {
      var qr = global.qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      /* 库自带的 createSvgTag 会给每个暗模块生成一个 <rect>，
       * 一张 2.5KB 分享码的码要上万节点、300KB+ 字符串，页面会明显卡。
       * 这里直接读模块矩阵、把同一行的连续暗块合并成一条 path，DOM 只剩一个节点。 */
      var n = qr.getModuleCount(), cell = 4, margin = 2, pad = margin * cell;
      var side = (n + margin * 2) * cell, d = '';
      for (var r = 0; r < n; r++) {
        var c = 0;
        while (c < n) {
          if (!qr.isDark(r, c)) { c++; continue; }
          var start = c;
          while (c < n && qr.isDark(r, c)) c++;
          var w = (c - start) * cell;
          d += 'M' + (start * cell + pad) + ' ' + (r * cell + pad) +
               'h' + w + 'v' + cell + 'h-' + w + 'z';
        }
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + side + '" height="' + side +
             '" viewBox="0 0 ' + side + ' ' + side + '" shape-rendering="crispEdges">' +
             '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    } catch (e) {
      return null;
    }
  }

  function download(bytes, filename) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.Blueprint = {
    HEADER: HEADER,
    CAI_SIZE: CAI_SIZE,
    CAI_EDITOR_SIZE: CAI_EDITOR_SIZE,
    CAI_DRAFT_SIZE: CAI_DRAFT_SIZE,
    PREFIX: PREFIX,
    isHeader: isHeader,
    toCai: toCai,
    parseCai: parseCai,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    qrSvg: qrSvg,
    download: download
  };
})(typeof window !== 'undefined' ? window : global);
