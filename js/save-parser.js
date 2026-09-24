/*
 * TOTK 存档解析器 —— 纯前端读取《王国之泪》progress.sav，同步收集完成进度
 * 存档格式逆向参考：marcrobledo/savegame-editors (MIT) 
 * https://github.com/marcrobledo/savegame-editors
 * 依赖：vendor/murmurhash3js.min.js + data/totk_save_hashes.js（全局 hash() 与 CompletismHashes）
 */
var TOTKSaveParser = (function () {
  'use strict';

  var GAME_VERSIONS = [
    { v: 'v1.0',       fileSize: 2307552, header: 0x0046c3c8, metaDataStart: 0x0003c050 },
    { v: 'v1.1.x/v1.2.x', fileSize: 2307656, header: 0x0047e0f4, metaDataStart: 0x0003c088 },
    { v: 'v1.4.x',     fileSize: 2307856, header: 0x0049e946, metaDataStart: 0x0003c138 }
  ];
  var HASH_TABLE_END = 0x03c800;

  /* 解析 progress.sav 为可查询结构 */
  function parse(buffer) {
    var result = { ok: false };
    if (!buffer || !(buffer instanceof ArrayBuffer)) return { ok: false, error: '请选择有效的 progress.sav 文件' };
    var dv = new DataView(buffer);
    var fileSize = buffer.byteLength;

    if (dv.getUint32(0, true) !== 0x01020304) return { ok: false, error: '文件头校验失败，不是《王国之泪》存档' };
    if (fileSize < 2307552 || fileSize >= 4194304) return { ok: false, error: '存档大小异常（不是 progress.sav？）' };

    var header = dv.getUint32(4, true);
    var metaDataStart = dv.getUint32(8, true);
    var version = null;
    for (var i = 0; i < GAME_VERSIONS.length; i++) {
      if (fileSize === GAME_VERSIONS[i].fileSize && header === GAME_VERSIONS[i].header && metaDataStart === GAME_VERSIONS[i].metaDataStart) {
        version = GAME_VERSIONS[i].v;
        break;
      }
    }
    if (!version) return { ok: false, error: '暂不支持该存档版本（可能是修改过的存档）' };

    /* 扫描 hash 表：0x28 起每 8 字节 [hash][value]，直到 guidsArray 哨兵 */
    var valueByHash = {};
    var guidsOffset = null;
    var end = Math.min(HASH_TABLE_END, fileSize);
    for (var j = 0x28; j < end; j += 8) {
      var h = dv.getUint32(j, true);
      if (h === 0xa3db7114) { guidsOffset = dv.getUint32(j + 4, true); break; }
      valueByHash[h] = j + 4;
    }
    if (guidsOffset === null || guidsOffset <= 0 || guidsOffset >= fileSize) return { ok: false, error: '存档数据表解析失败' };

    /* GUID 数组：从 guidsOffset 每 8 字节一个，直到全 0 */
    var guids = [];
    for (var k = guidsOffset; k < fileSize - 8; k += 8) {
      var lo = dv.getUint32(k, true);
      var up = dv.getUint32(k + 4, true);
      if (lo === 0 && up === 0) break;
      var loHex = ('00000000' + lo.toString(16)).slice(-8);
      var upHex = ('00000000' + up.toString(16)).slice(-8);
      guids.push('0x' + upHex + loHex);
    }

    return { ok: true, version: version, dv: dv, valueByHash: valueByHash, guids: guids };
  }

  /* 计数：值为 valueTrue 的 hash 个数（缺省 1；字符串先 hash） */
  function count(dv, valueByHash, hashList, valueTrue) {
    if (typeof valueTrue === 'string') valueTrue = hash(valueTrue);
    else if (typeof valueTrue !== 'number') valueTrue = 1;
    var n = 0;
    for (var i = 0; i < hashList.length; i++) {
      var off = valueByHash[hashList[i]];
      if (off !== undefined && dv.getUint32(off, true) === valueTrue) n++;
    }
    return n;
  }

  /* 计数：GUID 表存在个数 */
  function countGuids(guidsArray, guidList) {
    var n = 0;
    for (var i = 0; i < guidList.length; i++) {
      var g = String(guidList[i]);
      var target = /^0x/i.test(g) ? g : '0x' + BigInt(g).toString(16);
      for (var j = 0; j < guidsArray.length; j++) {
        if (guidsArray[j] === target) { n++; break; }
      }
    }
    return n;
  }

  /* 计算全部可同步类别的完成数，返回 {分类名: {done, total}} */
  function collect(parsed) {
    var dv = parsed.dv, vb = parsed.valueByHash, gs = parsed.guids;
    var C = CompletismHashes;
    var out = {};

    function c(name, list, val) { out[name] = { done: count(dv, vb, list, val), total: list.length }; }
    function cg(name, list) { out[name] = { done: countGuids(gs, list), total: list.length }; }

    /* 龙之泪：IsVisitLocation.DragonTears01-12（哈希表无独立键，直接内联） */
    var DRAGON_TEARS = [
      0x95eaf7f7, 0xd8f6148f, 0xea112a5c, 0x0ba4de99, 0x5a630ce5, 0x2146bc12,
      0x9061714b, 0x7cc0375a, 0xa14c6ed1, 0x587df5b0, 0x5279d33f, 0xc595c991
    ];
    c('鸟望台', C.TOWERS_FOUND);
    c('龙之泪', DRAGON_TEARS);
    c('神庙', C.SHRINES_STATUS, 'Clear');
    c('树根', C.LIGHTROOTS_STATUS, 'Open');
    c('克洛格', C.KOROKS_HIDDEN);
    c('双倍克洛格', C.KOROKS_CARRY, 'Clear');
    cg('魔犹伊遗失物', C.BUBBULS_GUIDS);
    c('残旧的地图', C.TREASURE_MAPS_FOUND);
    cg('贤者的遗志', C.SAGE_WILLS_FOUND);
    c('设计图石板', C.SCHEMATICS_STONE_FOUND.concat(C.SCHEMATICS_YIGA_FOUND));
    cg('卡邦达立牌', C.ADDISON_COMPLETED);
    c('独眼巨人', C.BOSSES_HINOXES_DEFEATED);
    c('岩石巨人', C.BOSSES_TALUSES_DEFEATED);
    c('莫尔德拉吉克', C.BOSSES_MOLDUGAS_DEFEATED);
    c('方块魔像', C.BOSSES_FLUX_CONSTRUCT_DEFEATED);
    c('巨霸伽马', C.BOSSES_FROXS_DEFEATED);
    c('古栗欧克', C.BOSSES_GLEEOKS_DEFEATED);
    c('地洞入口', C.LOCATION_CHASMS_VISITED);
    c('洞穴入口', C.LOCATION_CAVES_VISITED);
    c('井', C.LOCATION_WELLS_VISITED);

    return out;
  }

  return {
    parse: parse,
    collect: collect,
    count: count,
    countGuids: countGuids
  };
})();
