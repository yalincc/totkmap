/* ============ TOTKMAP · 存档写回核心库（V2.7.0 · save-writer） ============
 *
 * 只做一件事：在浏览器内存里原地覆写 progress.sav 的指定字节，然后交回一整个新 ArrayBuffer。
 * 不新增字段、不删条目、不改文件长度 —— 写不进去的地方一律拒绝，绝不做"凑合写"。
 *
 * ========== 一、为什么不需要处理游戏版本差异 ==========
 *
 * 存档结构是「hash 表 + 数据区」：
 *   0x0028 起，每 8 字节一条 (u32 变量名哈希, u32 值/指针)
 *   直到 u32 === 0xa3db7114（MetaData.SaveTypeHash）为止 —— 这是表结束标记
 *
 * 定位某个变量 = murmur3_32("变量名") → 在表里找同样的 u32 → 取该条目 i+4。
 *   · 标量（Int / Float）：i+4 处 4 字节就是数据本身
 *   · 复合（数组 / Vector3）：i+4 处是绝对偏移，指向数据块
 *
 * 关键在于：**变量名哈希只跟变量名有关，跟游戏版本毫无关系。**
 * v1.0 / v1.1 / v1.2 / v1.4 的差别只是「表条数多了几条、数据往后挪了几百字节」，
 * 全部由表内自带的偏移消化掉了。所以本库**不硬编码任何数据偏移**，也就天然跨版本。
 *
 * 版本号只在两处用：
 *   1. 给用户看（识别得出就显示 v1.2.x，识别不出就显示"未知版本／可能装了 mod"）
 *   2. 兜底宽容：识别不出但结构自洽时，照样允许读写（参考项目也这么做）
 *
 * 唯一必须自己扫描的是 hash 表结束位置 —— 因为官方存档它在 0x3c800，
 * 但 v1.0 更靠前、装 mod 的存档可能更靠后。实测本机 v1.2.x 档在 0x3c080。
 * 硬编码这个值 = 换台机器就废，所以每次打开都扫一遍（3 万条 8 字节，毫秒级）。
 *
 * ========== 二、安全边界（本库自己守，不指望调用方） ==========
 *
 *   1. 魔数不对 / 文件太小 / 扫不到表结束标记 → 直接拒绝打开，抛错
 *   2. 每个写入地址必须落在 [表结束, 文件末尾) 内，且 4 字节对齐完整
 *   3. 写入量超过原文件字节数 → 拒绝（说明定位错了，宁可报错也不毁档）
 *   4. 全部改动先在内存副本上做完，最后统一返回 diff 供调用方核对
 *
 * ========== 三、数组结构（实测确认，见 数据校对/存档写回-POC实测报告-完成.md） ==========
 *
 * 背包是 SoA 不是 AoS —— 不是「一条物品一块」，而是「每个字段一个数组」：
 *   Pouch.Material.Content.Name      → 510 个 64 字节字符串，第 k 项 = 第 k 种材料名
 *   Pouch.Material.Content.StockNum  → 510 个 i32，第 k 项 = 第 k 种材料数量
 *   两者靠**同一个下标**对应，容量必须相等（不等就拒绝，说明定位错了）
 *
 * 数据块布局：[u32 count][元素0][元素1]...
 *   String64Array 元素 64 字节 / IntArray 元素 4 字节 / EnumArray 元素 4 字节（存枚举名的哈希）
 *
 * 附加属性（Effect.Type）存的是**枚举名字符串的哈希**，不是 0/1/2 序号。
 * 实测：Effect.Type = 0xb6eede09 = murmur3("None")。所以设攻击力提升就是写 murmur3("AttackUp")。
 *
 * 依赖：无。挂 window.SaveWriter。
 */
(function (global) {
  'use strict';

  /* ---------- 常量 ---------- */
  var MAGIC_FILE = 0x01020304;      // progress.sav 首 4 字节
  var MAGIC_TABLE_END = 0xa3db7114; // MetaData.SaveTypeHash，hash 表到此结束
  var TABLE_START = 0x28;           // 表起点（前 0x28 是文件头）
  var MIN_SIZE = 2307552;           // v1.0 官方档大小；更小的一定不是完整存档
  var MAX_SIZE = 4194304;           // 上限挡一下，防止把 caption.sav 之类递进来

  /* 已知版本（仅用于显示）：三要素全对才算「官方原版」*/
  var KNOWN_VERSIONS = [
    { label: 'v1.0', size: 2307552, header: 0x0046c3c8, metaDataStart: 0x0003c050 },
    { label: 'v1.1.x / v1.2.x', size: 2307656, header: 0x0047e0f4, metaDataStart: 0x0003c088 },
    { label: 'v1.4.x', size: 2307856, header: 0x0049e946, metaDataStart: 0x0003c138 }
  ];

  /* 附加属性枚举（装备三类共用一套，取自存档变量表的 EnumValues 定义） */
  var EFFECTS = ['None', 'AttackUp', 'AttackUpPlus', 'DurabilityUp', 'DurabilityUpPlus',
    'FinishBlow', 'LongThrow', 'RapidFire', 'ThreeWayZoom', 'FiveWay', 'GuardUp', 'GuardUpPlus'];

  /* ★ 附加数值（Effect.Value）这一个字段，含义随「附加属性」变：
   *   AttackUp*     → 攻击力加多少
   *   DurabilityUp* → 额外耐久（耐久上限 = 自身基础值 + 该值）
   *   GuardUp*      → 防御力加多少
   *   FinishBlow / LongThrow / RapidFire / ThreeWayZoom / FiveWay → 纯开关，不需要数值
   * 所以同一个 4 字节，界面上要念成三种东西，取值范围也不一样 —— 不区分就会写出无意义的值。
   *
   * ★ 一件装备只能带一种附加属性（存档里只有一组 Effect.Type/Value），
   *   所以「攻击力 +999」和「永不损坏」互斥，这是结构决定的，绕不过去。 */
  var INF_DURABILITY = 2100000000; /* 社区通用的「无限耐久」取值，游戏对此不做合理性校验 */

  function isAttackEff(e) { return e === 'AttackUp' || e === 'AttackUpPlus'; }
  function isGuardEff(e) { return e === 'GuardUp' || e === 'GuardUpPlus'; }
  function isDurEff(e) { return e === 'DurabilityUp' || e === 'DurabilityUpPlus'; }
  function needsValue(e) { return isAttackEff(e) || isGuardEff(e) || isDurEff(e); }

  /* 数值在当前属性下的称呼（null = 该属性不需要数值） */
  function valueLabel(e) {
    if (isAttackEff(e)) return '攻击力';
    if (isGuardEff(e)) return '防御力';
    if (isDurEff(e)) return '额外耐久';
    return null;
  }

  /* 允许范围。攻击/防御封 999：再高游戏面板会显示不下，也没有实际意义。
   * 耐久常规封 9999（游戏里最耐用的武器也就几百），另放行 INF_DURABILITY 这一个特例。 */
  function valueRange(e) {
    if (isAttackEff(e)) return [1, 999];
    if (isGuardEff(e)) return [1, 999];
    if (isDurEff(e)) return [1, 9999];
    return null;
  }

  /* ---------- 材料分类 ----------
   * 材料容器里是 100 多种东西（果实/蘑菇/矿石/鱼/肉/虫/怪物素材…）。
   * 「一键全 999」把几百种一次拉满，对玩家来说太粗暴，所以按类勾选。
   *
   * 归类依据是**物品内部名的前缀**，不是另外维护一张映射表：
   *   · 名字本身就在存档里，不依赖任何外部数据文件
   *   · 新增素材会自动落到对应类，不用改代码
   *   · 兜底 other 保证「一类都不漏」
   * 顺序有意义：从上往下第一个匹配的生效，other 必须放最后。 */
  var MAT_GROUPS = [
    {
      key: 'food', label: '食材',
      test: /^(Item_Fruit_|Item_Mushroom|Item_PlantGet_|Item_Meat_|Item_FishGet_|Item_Material_|BombFruit|FireFruit|IceFruit|LightFruit|SmokeFruit|WaterFruit|ElectricalFruit|ConfusionFruit|LightBall_)/
    },
    { key: 'enemy', label: '怪物素材', test: /^Item_Enemy_/ },
    { key: 'ore', label: '矿石宝石', test: /^Item_Ore_/ },
    { key: 'creature', label: '虫与生物', test: /^Animal_/ },
    { key: 'other', label: '其它', test: null }
  ];

  function classifyMaterial(name) {
    for (var i = 0; i < MAT_GROUPS.length; i++) {
      var g = MAT_GROUPS[i];
      if (!g.test) return g.key;          /* 兜底项 */
      if (g.test.test(name)) return g.key;
    }
    return 'other';
  }

  /* 变量名。字符串就是全部真相 —— 偏移一律运行时查。 */
  var V = {
    rupee: { n: 'PlayerStatus.CurrentRupee', t: 'i32' },
    life: { n: 'PlayerStatus.Life', t: 'i32' },
    maxLife: { n: 'PlayerStatus.MaxLife', t: 'i32' },
    stamina: { n: 'PlayerStatus.MaxStamina', t: 'f32' },
    energy: { n: 'PlayerStatus.MaxEnergy', t: 'f32' },
    pos: { n: 'PlayerStatus.SavePos', t: 'vec3' }
  };

  /* ★ 坐标必须写两处，缺一可能不生效：
   *   PlayerStatus.SavePos —— 存档点位置，读档时应当回到这里（本机实测在 0x53324）
   *   World_PlayerPos      —— 世界里的玩家位置（本机实测在 0x532AC，是另一个地址）
   * 实测这两个变量在刚存的档里数值完全相同（因为存档那一刻人就在那），但它们是**两段独立的字节**。
   * 只写一个的话，万一游戏读档优先用另一个就白改了。两个都写、写同样的值，无论游戏用哪个都是对的，
   * 也避免读档瞬间出现「SavePos 在新位置、World_PlayerPos 还在旧位置」的矛盾状态。 */
  var POS_VARS = ['PlayerStatus.SavePos', 'World_PlayerPos'];

  /* 背包四类（materials/arrows 只有数量；三类装备另有耐久与附加属性）
   *
   * ★ zonai（左纳乌装置）用的是**变量名哈希直连**，不是字符串名。
   *   原因：这个容器的变量名反查不出来（试过 Zonai / ZonaiDevice / SpObj / Capsule 等几十种组合都不中），
   *   但它的结构已经实测确认：容量 60 的 String64Array + 同容量 IntArray，
   *   物品名形如 SpObj_WindGenerator_Capsule_A_01（风扇）、SpObj_FlameThrower_Capsule_A_01（火龙头）。
   *   哈希和变量名一样与游戏版本无关（正文开头「一、为什么不需要处理版本差异」），所以直连哈希是安全的；
   *   另外带 expect 自检 —— 名字对不上就整类停用，宁可少改也不写错位置。 */
  var POUCH = {
    materials: { label: '材料', name: 'Pouch.Material.Content.Name', num: 'Pouch.Material.Content.StockNum' },
    arrows: { label: '箭矢', name: 'Pouch.Arrow.Content.Name', num: 'Pouch.Arrow.Content.StockNum' },
    zonai: {
      label: '左纳乌装置',
      name: 0xa86f2f10,
      num: 0x60d16ab0,
      expect: /^SpObj_.*Capsule/
    },
    weapons: {
      label: '武器', name: 'Pouch.Weapon.Content.Name',
      life: 'Pouch.Weapon.Content.Life',
      eff: 'Pouch.Weapon.Content.Effect.Type',
      effVal: 'Pouch.Weapon.Content.Effect.Value'
    },
    bows: {
      label: '弓', name: 'Pouch.Bow.Content.Name',
      life: 'Pouch.Bow.Content.Life',
      eff: 'Pouch.Bow.Content.Effect.Type',
      effVal: 'Pouch.Bow.Content.Effect.Value'
    },
    shields: {
      label: '盾', name: 'Pouch.Shield.Content.Name',
      life: 'Pouch.Shield.Content.Life',
      eff: 'Pouch.Shield.Content.Effect.Type',
      effVal: 'Pouch.Shield.Content.Effect.Value'
    }
  };

  /* ---------- murmur3 x86_32（seed 0）----------
   * 跟游戏内部存档变量名哈希算法一致；本库用它把变量名算成 hash 表里的 key。
   * 实测 11/11 与社区整理的 hash 表完全吻合（见 POC 报告）。 */
  var _hashCache = Object.create(null);
  function murmur3(str) {
    if (_hashCache[str] !== undefined) return _hashCache[str];

    var bytes = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }

    var len = bytes.length, h = 0, k, nblocks = len >> 2;
    for (i = 0; i < nblocks; i++) {
      k = (bytes[i * 4] & 0xff) | ((bytes[i * 4 + 1] & 0xff) << 8) |
        ((bytes[i * 4 + 2] & 0xff) << 16) | ((bytes[i * 4 + 3] & 0xff) << 24);
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
      h = (h << 13) | (h >>> 19);
      h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }

    k = 0;
    var tail = nblocks << 2, rem = len & 3;
    if (rem === 3) k ^= (bytes[tail + 2] & 0xff) << 16;
    if (rem >= 2) k ^= (bytes[tail + 1] & 0xff) << 8;
    if (rem >= 1) {
      k ^= bytes[tail] & 0xff;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, 0x1b873593);
      h ^= k;
    }

    h ^= len;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;

    var out = h >>> 0;
    _hashCache[str] = out;
    return out;
  }

  function fail(msg) {
    var e = new Error(msg);
    e.isSaveWriterError = true;
    throw e;
  }

  /* ---------- 打开存档 ---------- */
  function open(buffer) {
    if (!buffer || typeof buffer.byteLength !== 'number') fail('没有拿到存档数据');
    if (buffer.byteLength < MIN_SIZE || buffer.byteLength >= MAX_SIZE) {
      fail('文件大小不对（' + buffer.byteLength + ' 字节）。请确认选的是 progress.sav —— 存档目录里还有 caption.sav 等文件，那些不是。');
    }

    /* 改的是副本，原始 buffer 一个字节都不动 */
    var bytes = new Uint8Array(buffer.slice(0));
    var view = new DataView(bytes.buffer);
    var size = bytes.length;

    if (view.getUint32(0, true) !== MAGIC_FILE) {
      fail('文件头不匹配，这不是王国之泪的 progress.sav');
    }

    /* 扫 hash 表结束位置（不写死 0x3c800：v1.0 更靠前，装 mod 的档可能更靠后） */
    var tableEnd = -1;
    for (var p = TABLE_START; p + 4 <= size; p += 8) {
      if (view.getUint32(p, true) === MAGIC_TABLE_END) { tableEnd = p; break; }
    }
    if (tableEnd < 0) fail('找不到 hash 表的结束标记，存档结构异常，已停止（未做任何修改）');

    /* 建 hash → 表项位置 索引（一次扫描，后续查表 O(1)）*/
    var index = Object.create(null);
    for (var q = TABLE_START; q < tableEnd; q += 8) {
      index[view.getUint32(q, true)] = q;
    }

    /* 定位一个变量：返回表项位置，undefined = 这个版本里不存在
     * key 可以是变量名字符串，也可以直接是哈希数字（左纳乌容器用后者，见 POUCH 注释） */
    function hashOf(key) { return typeof key === 'number' ? (key >>> 0) : murmur3(key); }
    function slot(name) {
      return index[hashOf(name)];
    }

    /* 标量：数据就在表项 i+4 */
    function scalarOff(name) {
      var s = slot(name);
      return s === undefined ? -1 : s + 4;
    }

    /* 复合：表项 i+4 存的是绝对偏移 */
    function blockOff(name) {
      var s = slot(name);
      if (s === undefined) return -1;
      var off = view.getUint32(s + 4, true);
      if (off < TABLE_START || off + 4 > size) return -1;
      return off;
    }

    /* 数组容量（数据块首 4 字节） */
    function count(name) {
      var b = blockOff(name);
      return b < 0 ? -1 : view.getUint32(b, true);
    }

    /* ---------- 版本识别（只用于显示） ---------- */
    var header = view.getUint32(4, true);
    var metaDataStart = view.getUint32(8, true);
    var version = null, isKnown = false;
    for (var vi = 0; vi < KNOWN_VERSIONS.length; vi++) {
      var kv = KNOWN_VERSIONS[vi];
      if (kv.size === size && kv.header === header && kv.metaDataStart === metaDataStart) {
        version = kv.label; isKnown = true; break;
      }
    }

    var api = {
      size: size,
      /* 版本只是给人看的信息，读写从不依赖它 */
      version: version || '未知（可能装了 mod 或改过档）',
      isKnownVersion: isKnown,
      tableEnd: tableEnd,
      hashCount: (tableEnd - TABLE_START) / 8,
      effects: EFFECTS.slice(),
      hash: murmur3,

      /* ---------- 读 ---------- */
      readScalars: function () {
        var out = {}, miss = [];
        Object.keys(V).forEach(function (k) {
          var def = V[k];
          if (def.t === 'vec3') return;
          var off = scalarOff(def.n);
          if (off < 0) { miss.push(def.n); return; }
          out[k] = def.t === 'f32' ? view.getFloat32(off, true) : view.getInt32(off, true);
        });
        return { values: out, missing: miss };
      },

      readPos: function () {
        var b = blockOff(V.pos.n);
        if (b < 0 || b + 12 > size) return null;
        return {
          x: view.getFloat32(b, true),
          y: view.getFloat32(b + 4, true),
          z: view.getFloat32(b + 8, true)
        };
      },

      /* 读某一类背包。skipEmpty=true 时只返回有物品的槽位（v1 全用 true） */
      readPouch: function (cat, skipEmpty) {
        var def = POUCH[cat];
        if (!def) fail('未知背包类别 ' + cat);
        var nameBase = blockOff(def.name);
        var n = count(def.name);
        if (nameBase < 0 || n < 0) return { ok: false, error: def.label + ' 定位失败', items: [] };

        var numBase = def.num ? blockOff(def.num) : -1;
        var lifeBase = def.life ? blockOff(def.life) : -1;
        var effBase = def.eff ? blockOff(def.eff) : -1;
        var effValBase = def.effVal ? blockOff(def.effVal) : -1;

        /* SoA 的命门：同下标对应，容量必须相等，否则说明定位错了 → 整体不做 */
        var cnts = { name: n };
        if (def.num) cnts.num = count(def.num);
        if (def.life) cnts.life = count(def.life);
        if (def.eff) cnts.eff = count(def.eff);
        if (def.effVal) cnts.effVal = count(def.effVal);
        var mismatch = Object.keys(cnts).filter(function (k) { return cnts[k] !== n; });
        if (mismatch.length) {
          return { ok: false, error: def.label + ' 各字段容量不一致（' + JSON.stringify(cnts) + '），已停用该类以免写坏', items: [] };
        }

        /* 容量上限挡一下：510 是材料上限、40 是武器上限，超过 10 万肯定是定位错了 */
        if (n < 0 || n > 200000) return { ok: false, error: def.label + ' 容量异常（' + n + '）', items: [] };

        var items = [];
        for (var k = 0; k < n; k++) {
          var np = nameBase + 4 + k * 64;
          if (np + 64 > size) break;
          var name = '';
          for (var ci = 0; ci < 64; ci++) {
            var ch = bytes[np + ci];
            if (!ch) break;
            name += String.fromCharCode(ch);
          }
          if (!name) { if (skipEmpty) continue; }
          var it = { i: k, name: name };
          if (numBase >= 0) it.qty = view.getInt32(numBase + 4 + k * 4, true);
          if (lifeBase >= 0) it.life = view.getInt32(lifeBase + 4 + k * 4, true);
          if (effBase >= 0) {
            var ev = view.getUint32(effBase + 4 + k * 4, true);
            it.effRaw = ev;
            it.eff = nameByHash(ev) || ('?' + ev.toString(16));
          }
          if (effValBase >= 0) it.effVal = view.getInt32(effValBase + 4 + k * 4, true);
          items.push(it);
        }

        /* 结构自检：类目自带了「名字必须长这样"的规则时，逐条校验。
         * 定位对了 → 100% 通过；定位错了（版本差异 / 换了个档）→ 整类停用，不拿错误地址去写。
         * 这是用哈希直连定位时唯一的安全保障，别删。 */
        if (def.expect) {
          var off = items.filter(function (x) { return x.name && !def.expect.test(x.name); });
          if (off.length) {
            return {
              ok: false,
              items: [],
              error: def.label + ' 结构校验没通过（例：' + off[0].name + '），已停用该类以免写错位置'
            };
          }
        }

        return { ok: true, capacity: n, items: items };
      },

      /* ---------- 写（全部先算成 edits，最后统一落盘）----------
       * plan 里只放「要改的东西」，没提的一律不碰：
       *   { rupee, hearts, stamina, energy, pos:{x,y,z},
       *     materials999:true, arrows999:true,
       *     items:[{cat, i, qty, life, eff, effVal}] }
       * 返回 { ok, changed, edits:[{off,label,from,to}], bytes }
       */
      apply: function (plan) {
        plan = plan || {};
        var edits = [];

        /* ★ 标量与复合的落点天然不同，校验规则必须分开：
         *   标量（卢比/生命/精力/电池）—— 值就存在 hash 表条目的第二个 4 字节里，**落在表区内**才是对的
         *   复合（数组/坐标）—— 值在表外的数据区，**落到表区内就是定位错了**
         * 早期版本没区分这点，会把正确的标量写入误判成越界并中止。 */
        function pushI32(off, value, label, area) {
          if (off < 0) return { ok: false, error: label + ' 定位失败' };
          if (off + 4 > size) return { ok: false, error: label + ' 地址越界' };
          edits.push({ off: off, len: 4, kind: 'i32', value: value | 0, label: label, area: area || 'data' });
          return { ok: true };
        }
        function pushF32(off, value, label, area) {
          if (off < 0) return { ok: false, error: label + ' 定位失败' };
          if (off + 4 > size) return { ok: false, error: label + ' 地址越界' };
          edits.push({ off: off, len: 4, kind: 'f32', value: value, label: label, area: area || 'data' });
          return { ok: true };
        }

        /* ---- 基础数值 ---- */
        var errs = [];
        function note(r) { if (!r.ok) errs.push(r.error); }

        if (typeof plan.rupee === 'number') {
          note(pushI32(scalarOff(V.rupee.n), clamp(plan.rupee, 0, 999999), '卢比', 'table'));
        }
        if (typeof plan.hearts === 'number') {
          var maxLife = clamp(Math.round(plan.hearts), 1, 40) * 4;
          note(pushI32(scalarOff(V.maxLife.n), maxLife, '生命上限', 'table'));
          /* 当前生命一起拉满，否则进游戏显示「不满血」*/
          note(pushI32(scalarOff(V.life.n), maxLife, '当前生命', 'table'));
        }
        if (typeof plan.stamina === 'number') {
          note(pushF32(scalarOff(V.stamina.n), clamp(plan.stamina, 1000, 3000), '精力上限', 'table'));
        }
        if (typeof plan.energy === 'number') {
          note(pushF32(scalarOff(V.energy.n), clamp(plan.energy, 1000, 16000), '电池容量', 'table'));
        }

        /* ---- 坐标瞬移：两个变量都写（见 POS_VARS 注释），至少成功一个才算数 ---- */
        if (plan.pos) {
          var f = [plan.pos.x, plan.pos.y, plan.pos.z];
          var names = ['坐标X', '坐标Y(高度)', '坐标Z'];
          var bad = false;
          for (var fi = 0; fi < 3; fi++) {
            if (typeof f[fi] !== 'number' || !isFinite(f[fi])) { errs.push(names[fi] + ' 不是有效数字'); bad = true; }
          }
          if (!bad) {
            var wrote = 0, missed = [];
            POS_VARS.forEach(function (vn) {
              var b = blockOff(vn);
              if (b < 0 || b + 12 > size) { missed.push(vn); return; }
              for (var k2 = 0; k2 < 3; k2++) {
                edits.push({
                  off: b + k2 * 4, len: 4, kind: 'f32', value: f[k2],
                  label: names[k2] + (wrote === 0 ? '' : '（副本）')
                });
              }
              wrote++;
            });
            if (!wrote) errs.push('坐标定位失败（' + missed.join(', ') + '）');
          }
        }

        /* ---- 材料 / 左纳乌 / 箭矢 拉到目标值（只改已有槽位，不新增条目）----
         *
         * 三种调用形态（plan 里同时给多个也算数，互不干扰）：
         *   plan.materials999 = true            全部素材一次拉满（老行为，保留兼容）
         *   plan.matGroups = ['food','enemy']   只拉指定类别
         *   plan.zonai999 / plan.arrows999      左纳乌装置 / 箭矢
         * 空槽一律跳过 —— 绝不新增条目，避免把背包撑爆或踩坏后续数据。 */
        var fillTo = typeof plan.fillValue === 'number' ? clamp(Math.round(plan.fillValue), 1, 999) : 999;

        function nameAt(np) {
          var s = '';
          for (var ci = 0; ci < 64; ci++) {
            var ch = bytes[np + ci];
            if (!ch) break;
            s += String.fromCharCode(ch);
          }
          return s;
        }

        function fillPouch(catKey, keep) {
          var def = POUCH[catKey];
          var nb = blockOff(def.name), numBase = blockOff(def.num), n = count(def.name);
          if (nb < 0 || numBase < 0 || n < 0 || count(def.num) !== n) {
            errs.push(def.label + ' 定位失败'); return;
          }
          if (def.expect) {
            /* 用哈希直连的类目（左纳乌）先整体验一遍名字，不对就不动它 */
            for (var q = 0; q < n; q++) {
              var qp = nb + 4 + q * 64;
              if (qp + 64 > size) break;
              if (!bytes[qp]) continue;
              if (!def.expect.test(nameAt(qp))) {
                errs.push(def.label + ' 结构校验没通过（例：' + nameAt(qp) + '），已停用该类以免写错位置');
                return;
              }
            }
          }
          for (var k = 0; k < n; k++) {
            var np = nb + 4 + k * 64;
            if (np + 64 > size) break;
            if (!bytes[np]) continue;                 /* 空槽跳过 —— 绝不新增条目 */
            if (keep && !keep(nameAt(np))) continue;  /* 不在勾选的类别里 */
            var cur = view.getInt32(numBase + 4 + k * 4, true);
            if (cur >= fillTo) continue;              /* 已经够多了不动 */
            edits.push({
              off: numBase + 4 + k * 4, len: 4, kind: 'i32', value: fillTo,
              label: def.label + ' #' + k
            });
          }
        }

        if (plan.materials999) {
          fillPouch('materials', null);
        } else if (plan.matGroups && plan.matGroups.length) {
          var gs = plan.matGroups.filter(function (g) {
            return MAT_GROUPS.some(function (x) { return x.key === g; });
          });
          if (gs.length) {
            fillPouch('materials', function (nm) { return gs.indexOf(classifyMaterial(nm)) >= 0; });
          }
        }
        if (plan.zonai999) fillPouch('zonai', null);
        if (plan.arrows999) fillPouch('arrows', null);

        /* ---- 单件装备：耐久 / 附加属性 / 附加数值 ---- */
        if (plan.items && plan.items.length) {
          plan.items.forEach(function (it) {
            var def = POUCH[it.cat];
            if (!def || !def.life) { errs.push('未知装备类别 ' + it.cat); return; }
            var i = it.i | 0;
            if (i < 0) { errs.push('装备下标非法'); return; }

            if (typeof it.life === 'number') {
              var lb = blockOff(def.life);
              if (lb < 0) errs.push(def.label + ' 耐久定位失败');
              else pushI32(lb + 4 + i * 4, clamp(it.life, 1, 99999), def.label + '#' + i + ' 耐久');
            }
            if (typeof it.eff === 'string') {
              var eb = blockOff(def.eff);
              if (eb < 0) errs.push(def.label + ' 附加属性定位失败');
              else if (EFFECTS.indexOf(it.eff) < 0) errs.push('附加属性取值非法：' + it.eff);
              else {
                edits.push({
                  off: eb + 4 + i * 4, len: 4, kind: 'i32',
                  value: murmur3(it.eff) | 0, label: def.label + '#' + i + ' 附加属性',
                  /* 这格存的是枚举名哈希，直接把数字念给用户等于天书，预览时要翻成人话 */
                  enumTo: it.eff
                });
              }
            }
            if (typeof it.effVal === 'number') {
              var vb = blockOff(def.effVal);
              if (vb < 0) errs.push(def.label + ' 附加数值定位失败');
              else {
                /* 这个 4 字节的含义取决于「最终是什么附加属性」：
                 *   指定了 it.eff 就用它；只改数值不改属性时，退回存档里的现值来判断。 */
                var tgtEff = (typeof it.eff === 'string') ? it.eff : (function () {
                  var eb2 = def.eff ? blockOff(def.eff) : -1;
                  if (eb2 < 0) return null;
                  return nameByHash(view.getUint32(eb2 + 4 + i * 4, true));
                })();

                if (tgtEff === 'None') {
                  /* 选「无」必须一并清零 —— 残留的旧值不生效，但会变成脏数据 */
                  pushI32(vb + 4 + i * 4, 0, def.label + '#' + i + ' 附加数值（随属性清空）');
                } else {
                  var vr = tgtEff ? valueRange(tgtEff) : null;
                  if (!vr) {
                    errs.push(def.label + '#' + i + '『' + (tgtEff || '未知属性') + '』不需要数值');
                  } else {
                    var nv = it.effVal;
                    /* 无限耐久是唯一放行的超限值：2100000000 远超常规上限，但游戏确实认 */
                    if (!(isDurEff(tgtEff) && nv === INF_DURABILITY)) nv = clamp(Math.round(nv), vr[0], vr[1]);
                    pushI32(vb + 4 + i * 4, nv, def.label + '#' + i + ' ' + valueLabel(tgtEff));
                  }
                }
              }
            }
          });
        }

        if (errs.length) return { ok: false, error: errs.join('；'), edits: [] };
        if (!edits.length) return { ok: true, changed: 0, edits: [], bytes: new Uint8Array(bytes) };

        /* ---- 落盘前逐条校验：标量必须在表内、复合必须在数据区，且都不得越界 ---- */
        for (var e = 0; e < edits.length; e++) {
          var ed = edits[e];
          if (ed.off + ed.len > size) {
            return { ok: false, error: '内部错误：' + ed.label + ' 越界，已中止', edits: [] };
          }
          var inTable = ed.off + ed.len <= tableEnd;
          if (ed.area === 'table' && !inTable) {
            return { ok: false, error: '内部错误：' + ed.label + ' 是标量却指向数据区，已中止', edits: [] };
          }
          if (ed.area === 'data' && inTable) {
            return { ok: false, error: '内部错误：' + ed.label + ' 指向 hash 表区，已中止', edits: [] };
          }
        }

        /* ---- 在副本上写，原始 bytes 不动，方可重复对比 ---- */
        var out = new Uint8Array(bytes);
        var ov = new DataView(out.buffer);
        var report = [], touched = 0;
        edits.forEach(function (ed) {
          var before = ed.kind === 'f32' ? ov.getFloat32(ed.off, true) : ov.getInt32(ed.off, true);
          if (ed.kind === 'f32') ov.setFloat32(ed.off, ed.value, true);
          else ov.setInt32(ed.off, ed.value, true);
          var after = ed.kind === 'f32' ? ov.getFloat32(ed.off, true) : ov.getInt32(ed.off, true);
          if (before !== after) {
            var row = { off: ed.off, label: ed.label, from: round(before), to: round(after) };
            /* 枚举字段额外给出人话版本，页面优先用它显示 */
            if (ed.enumTo) {
              row.fromText = nameByHash(before) || ('未知(' + before + ')');
              row.toText = ed.enumTo;
            }
            report.push(row);
            touched++;
          }
        });

        return {
          ok: true,
          changed: touched,
          edits: report,
          bytes: out,
          /* 供调用方做「差异只落在目标区」自检 */
          verify: function () { return diffReport(bytes, out); }
        };
      }
    };

    /* 枚举名反查（Effect.Type 存的是名字哈希，读回来要显示成人话） */
    function nameByHash(h) {
      var u = h >>> 0;
      if (!nameByHash._t) {
        nameByHash._t = Object.create(null);
        EFFECTS.forEach(function (e) { nameByHash._t[murmur3(e)] = e; });
      }
      return nameByHash._t[u] || null;
    }

    return api;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round(v) {
    if (typeof v !== 'number') return v;
    return Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) : Math.round(v * 1000) / 1000;
  }

  /* 差异统计：返回「改了哪些字节区间」，用于确认改动没有漫出去 */
  function diffReport(before, after) {
    var segs = [], total = 0, start = -1;
    for (var i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        total++;
        if (start < 0) start = i;
      } else if (start >= 0) {
        segs.push({ from: start, to: i - 1, len: i - start });
        start = -1;
      }
    }
    if (start >= 0) segs.push({ from: start, to: before.length - 1, len: before.length - start });
    return { bytes: total, segments: segs, sameLength: before.length === after.length };
  }

  /* 触发下载（改档结果 + 备份都用它） */
  function download(buffer, filename) {
    var blob = new Blob([buffer], { type: 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  var SaveWriter = {
    open: open,
    murmur3: murmur3,
    diff: diffReport,
    download: download,
    EFFECTS: EFFECTS,
    /* 材料分类：页面据此画出「食材 / 怪物素材 / 矿石 / 生物 / 其它」的勾选项，
       规则只有这一份，前端不要另抄一套 */
    MAT_GROUPS: MAT_GROUPS,
    classifyMaterial: classifyMaterial,
    /* 附加数值这一组：界面要按「最终属性」决定输入框叫什么、能不能填、能填多大 */
    INF_DURABILITY: INF_DURABILITY,
    needsValue: needsValue,
    valueLabel: valueLabel,
    valueRange: valueRange,
    /* 心数 ↔ MaxLife 换算：MaxLife 单位是 1/4 心 */
    heartsOf: function (maxLife) { return maxLife / 4; },
    maxLifeOf: function (hearts) { return Math.round(hearts * 4); },
    /* 精力：1000 = 1 圈；电池：1000 = 1 格 */
    STAMINA_WHEEL: 1000,
    ENERGY_CELL: 1000,
    KNOWN_VERSIONS: KNOWN_VERSIONS
  };

  global.SaveWriter = SaveWriter;
  if (typeof module !== 'undefined' && module.exports) module.exports = SaveWriter;

})(typeof window !== 'undefined' ? window : this);
