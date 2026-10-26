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

  /* 30处左纳乌制造机 (Device Dispensers) 的 IsVisit 变量哈希 */
  var DEVICE_DISPENSERS = [
    0x9b6a5c7d, 0x33bed6b9, 0xa4a0c1e1, 0x80ad67ca, 0xcb37cba6, 0xaf95d7f2,
    0x9ea4dc51, 0x6e27e851, 0x7fe19c4e, 0x20c6ab34, 0x8196cef8, 0xba01ae92,
    0x9dcd1483, 0xb17658ee, 0xe16fe679, 0xa747e6d8, 0x10f54076, 0x96297877,
    0x816d62ee, 0x82ca53e2, 0x885441e9, 0x90c2c180, 0x5b2c65ec, 0x63ae4b5c,
    0x6612d7b4, 0xd93c006a, 0xbbe67181, 0xd40cb282, 0xec359b9e, 0x698c7010
  ];

  /* 辅助：从 DataView 读取 64 字节 ASCII 字符串 */
  function readAscii64(dv, offset) {
    var str = '';
    for (var i = 0; i < 64; i++) {
      var b = dv.getUint8(offset + i);
      if (b === 0) break;
      if (b >= 32 && b <= 126) str += String.fromCharCode(b);
      else return null;
    }
    return str;
  }

  /* 规范化 GUID 为统一的 0x + 16位小写十六进制 */
  function normalizeGuid(g) {
    if (!g) return '';
    var s = String(g).trim().toLowerCase();
    if (!/^0x/i.test(s)) {
      try {
        s = '0x' + BigInt(s).toString(16).toLowerCase();
      } catch (e) {
        s = '0x' + s;
      }
    }
    var hex = s.replace(/^0x/i, '');
    return '0x' + ('0000000000000000' + hex).slice(-16);
  }

  /* 解析 progress.sav 为纯数据驱动的集合对象 */
  function parse(buffer) {
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

    /* 1. 扫描 32位 Murmur3 GameData hash 表：0x28 起每 8 字节 [hash][value]，直到 guidsArray 哨兵 0xA3DB7114 */
    var valueByHash = {};
    var hashes = {};
    var guidsOffset = null;
    var end = Math.min(HASH_TABLE_END, fileSize);
    for (var j = 0x28; j < end; j += 8) {
      var h = dv.getUint32(j, true);
      var val = dv.getUint32(j + 4, true);
      if (h === 0xa3db7114) { guidsOffset = val; break; }
      valueByHash[h] = j + 4;
      hashes[h] = val;
    }
    if (guidsOffset === null || guidsOffset <= 0 || guidsOffset >= fileSize) return { ok: false, error: '存档数据表解析失败' };

    /* 2. 扫描 64位 GUID 稀疏数组：从 guidsOffset 每 8 字节一个 uint64，直到全 0 */
    var guids = [];
    var guidSet = new Set();
    for (var k = guidsOffset; k < fileSize - 8; k += 8) {
      var lo = dv.getUint32(k, true);
      var up = dv.getUint32(k + 4, true);
      if (lo === 0 && up === 0) break;
      var loHex = ('00000000' + lo.toString(16)).slice(-8);
      var upHex = ('00000000' + up.toString(16)).slice(-8);
      var gStr = '0x' + (upHex + loHex).toLowerCase();
      guids.push(gStr);
      guidSet.add(gStr);
    }
    guids.has = function (g) { return guidSet.has(normalizeGuid(g)); };

    /* 3. 扫描背包物品 PouchItem（从数据区指针数组提取道具 Actor 键名） */
    var pouches = [];
    var pouchSet = new Set();
    var scannedOffsets = {};
    for (var hKey in hashes) {
      var offVal = hashes[hKey];
      if (offVal >= HASH_TABLE_END && offVal < fileSize - 4 && !scannedOffsets[offVal]) {
        scannedOffsets[offVal] = true;
        var itmCount = dv.getUint32(offVal, true);
        if (itmCount >= 1 && itmCount <= 1000) {
          var first = readAscii64(dv, offVal + 4);
          if (first && (first.indexOf('_') >= 0 || first.indexOf('Medal') >= 0 || /^[A-Za-z0-9_]{3,48}$/.test(first))) {
            for (var ki = 0; ki < itmCount; ki++) {
              var itemPos = offVal + 4 + ki * 64;
              if (itemPos + 64 <= fileSize) {
                var itmName = readAscii64(dv, itemPos);
                if (itmName && !pouchSet.has(itmName)) {
                  pouchSet.add(itmName);
                  pouches.push(itmName);
                }
              }
            }
          }
        }
      }
    }
    pouches.has = function (name) { return pouchSet.has(name); };

    /* 4. 组装统计与元数据 */
    var stats = {
      version: version,
      fileSize: fileSize,
      guidsCount: guids.length,
      hashesCount: Object.keys(hashes).length,
      pouchesCount: pouches.length
    };

    return {
      ok: true,
      version: version,
      dv: dv,
      valueByHash: valueByHash,
      hashes: hashes,
      guids: guids,
      guidSet: guidSet,
      pouches: pouches,
      pouchSet: pouchSet,
      stats: stats
    };
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

  /* 计数：GUID 表存在个数（使用 Set O(1) 优化） */
  function countGuids(guidsArray, guidList) {
    var set = (guidsArray && guidsArray.has && guidsArray._set) || null;
    if (!set) {
      set = new Set();
      for (var j = 0; j < guidsArray.length; j++) {
        set.add(normalizeGuid(guidsArray[j]));
      }
      if (guidsArray) guidsArray._set = set;
    }
    var n = 0;
    for (var i = 0; i < guidList.length; i++) {
      if (set.has(normalizeGuid(guidList[i]))) n++;
    }
    return n;
  }

  /* 计算全部可同步类别的完成数，返回 {分类名: {done, total}} */
  function collect(parsed) {
    var dv = parsed.dv, vb = parsed.valueByHash, gs = parsed.guids;
    var C = (typeof CompletismHashes !== 'undefined') ? CompletismHashes : ((typeof window !== 'undefined' && window.CompletismHashes) || (typeof global !== 'undefined' && global.CompletismHashes) || {});
    var out = {};

    function c(name, list, val) { out[name] = { done: count(dv, vb, list, val), total: list.length }; }
    function cg(name, list) { out[name] = { done: countGuids(gs, list), total: list.length }; }

    /* 龙之泪：IsVisitLocation.DragonTears01-12 */
    var DRAGON_TEARS = [
      0x95eaf7f7, 0xd8f6148f, 0xea112a5c, 0x0ba4de99, 0x5a630ce5, 0x2146bc12,
      0x9061714b, 0x7cc0375a, 0xa14c6ed1, 0x587df5b0, 0x5279d33f, 0xc595c991
    ];

    // 基础探索
    c('鸟望台', C.TOWERS_FOUND);
    c('龙之泪', DRAGON_TEARS);
    c('神庙', C.SHRINES_STATUS, 'Clear');
    c('树根', C.LIGHTROOTS_STATUS, 'Open');
    c('地洞入口', C.LOCATION_CHASMS_VISITED);
    c('洞穴入口', C.LOCATION_CAVES_VISITED);
    c('井', C.LOCATION_WELLS_VISITED);

    // 收集要素
    c('克洛格', C.KOROKS_HIDDEN);
    c('双倍克洛格', C.KOROKS_CARRY, 'Clear');
    cg('魔犹伊遗失物', C.BUBBULS_GUIDS);
    cg('贤者的遗志', C.SAGE_WILLS_FOUND);
    cg('卡邦达立牌', C.ADDISON_COMPLETED);
    c('残旧的地图', C.TREASURE_MAPS_FOUND);
    c('设计图石板', C.SCHEMATICS_STONE_FOUND.concat(C.SCHEMATICS_YIGA_FOUND));
    c('左纳乌制造机', DEVICE_DISPENSERS);

    // 宝箱 (1,334 官方宝箱 GUID)
    var chestGuids = [];
    var official = (typeof window !== 'undefined' && (window.TOTK_CHESTS_OFFICIAL || window.CHESTS_OFFICIAL)) ||
                   (typeof global !== 'undefined' && (global.TOTK_CHESTS_OFFICIAL || global.CHESTS_OFFICIAL)) || null;
    if (official) {
      if (Array.isArray(official)) {
        for (var ci = 0; ci < official.length; ci++) {
          var og = official[ci] && (official[ci].guid || official[ci].hash || official[ci].save_guid);
          if (og) chestGuids.push(og);
        }
      } else if (typeof official === 'object') {
        for (var ok in official) {
          var ov = official[ok];
          var og2 = typeof ov === 'string' ? ov : (ov && (ov.guid || ov.hash || ov.save_guid));
          if (og2) chestGuids.push(og2);
        }
      }
    }
    if (!chestGuids.length && typeof window !== 'undefined' && window.TOTK_EXPLORE_MAP && window.TOTK_EXPLORE_MAP.chests) {
      for (var chid in window.TOTK_EXPLORE_MAP.chests) {
        chestGuids.push(window.TOTK_EXPLORE_MAP.chests[chid]);
      }
    } else if (!chestGuids.length && typeof global !== 'undefined' && global.TOTK_EXPLORE_MAP && global.TOTK_EXPLORE_MAP.chests) {
      for (var chid2 in global.TOTK_EXPLORE_MAP.chests) {
        chestGuids.push(global.TOTK_EXPLORE_MAP.chests[chid2]);
      }
    }
    if (chestGuids.length) {
      out['宝箱'] = { done: countGuids(gs, chestGuids), total: Math.max(1334, chestGuids.length) };
    } else {
      out['宝箱'] = { done: 0, total: 1334 };
    }

    // 战斗讨伐
    c('独眼巨人', C.BOSSES_HINOXES_DEFEATED);
    c('岩石巨人', C.BOSSES_TALUSES_DEFEATED);
    c('巨霸伽马', C.BOSSES_FROXS_DEFEATED);
    c('方块魔像', C.BOSSES_FLUX_CONSTRUCT_DEFEATED);
    c('古栗欧克', C.BOSSES_GLEEOKS_DEFEATED);
    c('莫尔德拉吉克', C.BOSSES_MOLDUGAS_DEFEATED);

    return out;
  }

  /* 纯数据驱动遍历 exploreMap 和 chestsOfficial，返回完成状态字典 { [id]: true } */
  function matchExploreDone(parsed, exploreMap, chestsOfficial) {
    var out = {};
    if (!parsed || !parsed.ok) return out;

    var dv = parsed.dv;
    var vb = parsed.valueByHash || {};
    var hashes = parsed.hashes || {};
    var guidSet = parsed.guidSet;
    var guidsArr = parsed.guids || [];
    var pouchSet = parsed.pouchSet;

    function hasGuid(g) {
      if (!g) return false;
      var norm = normalizeGuid(g);
      if (guidSet) {
        if (guidSet.has(norm) || guidSet.has(String(g).toLowerCase())) return true;
      }
      return guidsArr.indexOf(norm) >= 0 || guidsArr.indexOf(String(g).toLowerCase()) >= 0;
    }

    function hval(hashKey) {
      if (hashKey == null) return null;
      var hNum;
      if (typeof hashKey === 'number') {
        hNum = hashKey >>> 0;
      } else {
        var str = String(hashKey).trim();
        hNum = parseInt(str, 16) >>> 0;
      }
      if (hashes && hashes[hNum] !== undefined) {
        return hashes[hNum];
      }
      var off = vb[hNum];
      if (off !== undefined && dv) {
        return dv.getUint32(off, true);
      }
      return null;
    }

    var map = exploreMap || (typeof window !== 'undefined' ? window.TOTK_EXPLORE_MAP : {}) || (typeof global !== 'undefined' ? global.TOTK_EXPLORE_MAP : {}) || {};

    // 1. 鸟望台 (32位 Hash，值为 1 表示已发现)
    if (map.towers) {
      for (var tid in map.towers) {
        if (hval(map.towers[tid]) === 1) out[tid] = true;
      }
    }

    // 2. 龙之泪 (32位 Hash，值为 1 表示已访问)
    if (map.tears) {
      for (var trid in map.tears) {
        if (hval(map.tears[trid]) === 1) out[trid] = true;
      }
    }

    // 3. 魔犹伊遗失物 (64位 GUID，已击败魔犹伊进入 GUID 稀疏表)
    if (map.bubbuls) {
      for (var bid in map.bubbuls) {
        if (hasGuid(map.bubbuls[bid])) out[bid] = true;
      }
    }

    // 4. exploreMap 宝箱 (64位 GUID，已开启进入 GUID 稀疏表)
    if (map.chests) {
      for (var chid in map.chests) {
        if (hasGuid(map.chests[chid])) out[chid] = true;
      }
    }

    var CLEAR_HASH = (typeof hash === 'function' ? (hash('Clear') >>> 0) : 0x62965740);
    var OPEN_HASH = (typeof hash === 'function' ? (hash('Open') >>> 0) : 0x1818ec02);
    var COMPLETE_HASH = (typeof hash === 'function' ? (hash('Complete') >>> 0) : 0x4c0a63f4);

    // 5. 遍历 exploreMap 的其他任意映射分支
    for (var catKey in map) {
      if (catKey === 'towers' || catKey === 'tears' || catKey === 'bubbuls' || catKey === 'chests') continue;
      var group = map[catKey];
      if (!group || typeof group !== 'object') continue;
      for (var gid in group) {
        var target = group[gid];
        if (typeof target === 'string') {
          if (target.length > 10 || /^0x[0-9a-fA-F]{16}$/i.test(target)) {
            if (hasGuid(target)) out[gid] = true;
          } else if (/^0x[0-9a-fA-F]{1,8}$/i.test(target) || /^[0-9a-fA-F]{8}$/i.test(target)) {
            var val = hval(target);
            if (catKey === 'shrines') {
              if (val === CLEAR_HASH || val === 1) out[gid] = true;
            } else if (catKey === 'lightroots') {
              if (val === OPEN_HASH || val === 1) out[gid] = true;
            } else if (catKey === 'koroks_carry') {
              if (val === CLEAR_HASH || val === 1) out[gid] = true;
            } else if (catKey === 'quests') {
              if (val === COMPLETE_HASH || val === 1) out[gid] = true;
            } else {
              if (val === 1) out[gid] = true;
            }
          } else if (pouchSet && pouchSet.has(target)) {
            out[gid] = true;
          }
        }
      }
    }

    // 6. 官方独立大世界宝箱 (chestsOfficial: 数组或对象均支持)
    var cOff = chestsOfficial || (typeof window !== 'undefined' && (window.TOTK_CHESTS_OFFICIAL || window.CHESTS_OFFICIAL)) || (typeof global !== 'undefined' && (global.TOTK_CHESTS_OFFICIAL || global.CHESTS_OFFICIAL)) || null;
    if (cOff) {
      if (Array.isArray(cOff)) {
        for (var i = 0; i < cOff.length; i++) {
          var item = cOff[i];
          if (!item) continue;
          var chestId = item.id != null ? item.id : (item.markerId != null ? item.markerId : i);
          var cGuid = item.guid || item.hash || item.save_guid || item.saveGuid || item.instanceId;
          if (cGuid && hasGuid(cGuid)) {
            out[chestId] = true;
          }
        }
      } else if (typeof cOff === 'object') {
        for (var cid2 in cOff) {
          var val = cOff[cid2];
          var cGuid2 = typeof val === 'string' ? val : (val && (val.guid || val.hash || val.save_guid || val.saveGuid));
          if (cGuid2 && hasGuid(cGuid2)) {
            out[cid2] = true;
          }
        }
      }
    }

    // 7. 背包物品 PouchItem 联动识别（用于商店/兑换防具标点自动识别）
    if (pouchSet && pouchSet.size > 0 && typeof window !== 'undefined') {
      var armors = window.TOTK_ARMORS;
      var markers = window.TOTK_MARKERS;
      if (Array.isArray(armors) && Array.isArray(markers)) {
        var ownedArmorNames = {};
        for (var a = 0; a < armors.length; a++) {
          var arm = armors[a];
          if (arm && arm.key && pouchSet.has(arm.key)) {
            if (arm.name) ownedArmorNames[arm.name] = true;
          }
        }
        for (var m = 0; m < markers.length; m++) {
          var mk = markers[m];
          if (mk && (mk.cat === 176 || mk.cat === 201 || mk.cat === 215)) {
            if (ownedArmorNames[mk.name] || (mk.full && ownedArmorNames[mk.full])) {
              out[mk.id] = true;
            }
          }
        }
      }
    }

    return out;
  }

  /* 逐点完成判定（向后兼容接口，内部转调 matchExploreDone） */
  function pointDone(parsed, map) {
    return matchExploreDone(parsed, map, null);
  }

  /* 任务完成判定（配合 data/task-save.js） */
  var QUEST_DONE_HASH = null;
  function questDoneHash() {
    if (QUEST_DONE_HASH === null) {
      QUEST_DONE_HASH = (typeof hash === 'function') ? (hash('Complete') >>> 0) : 0x4c0a63f4;
    }
    return QUEST_DONE_HASH;
  }

  function questDone(parsed, saveMap) {
    var out = {};
    if (!parsed || !parsed.ok) return out;
    var map = saveMap || (typeof window !== 'undefined' ? window.TOTK_TASK_SAVE : null);
    if (!map) return out;
    var DONE = questDoneHash();

    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var entry = map[key];
      var h = parseInt(entry.hash, 16) >>> 0;
      var val = null;
      if (parsed.hashes && parsed.hashes[h] !== undefined) {
        val = parsed.hashes[h];
      } else {
        var off = parsed.valueByHash ? parsed.valueByHash[h] : undefined;
        if (off === undefined) continue;
        val = parsed.dv.getUint32(off, true);
      }
      var stages = entry.stages || [];
      var stage = '';
      for (var i = 0; i < stages.length; i++) {
        if ((hash(stages[i]) >>> 0) === val) { stage = stages[i]; break; }
      }
      out[key] = {
        done: val === DONE,
        stage: stage,
        idx: stage ? stages.indexOf(stage) : -1,
        total: stages.length
      };
    }
    return out;
  }

  var exp = {
    parse: parse,
    collect: collect,
    pointDone: pointDone,
    matchExploreDone: matchExploreDone,
    questDone: questDone,
    questDoneHash: questDoneHash,
    count: count,
    countGuids: countGuids
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exp;
  }
  return exp;
})();
