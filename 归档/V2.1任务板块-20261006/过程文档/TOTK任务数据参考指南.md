# TOTKmap 任务数据参考指南

> 版本：2026-10-06 · 数据文件 `app/data/tasks.js`（`window.TOTK_TASKS`，286 条）
> 提取脚本：`tools/extract_quests.py`（一键重跑）
> 提取报告：`归档/任务数据交接/提取报告.md`

## 0. 这份文档是干什么的

给**做地图任务板块**用的数据说明书。分工：

| 谁 | 负责 |
|---|---|
| 资料侧 | 数据源挖掘、清洗、字段定义、坐标口径 —— **本文件覆盖的范围** |
| 地图 agent | 网站编程：分类面板、图层开关、任务卡片、完成度追踪 |

改数据不会影响现有网站（`tasks.js` 是新增文件，未被任何页面引用）。

---

## 1. ★ 坐标体系（最重要，先读这节）

### 1.1 存在两套坐标，别混用

| 体系 | 字段 | 含义 | 用途 |
|---|---|---|---|
| **游戏坐标** | `gx` / `gy` / `gz` | X = 东西向，Y = **高度**，Z = 南北向 | **对外唯一口径** |
| 地图坐标 | `mapX` / `mapY` | Leaflet 图标绘制基准 | 仅内部绘制，**不展示给用户** |

### 1.2 铁律

> **用户看到的一切坐标信息，必须是游戏坐标（X / Y / Z）。**
> 地图的 `mapX` / `mapY` 只是把图标画到正确位置的基准，属于实现细节，
> **用户不需要知道、界面上也不应出现**。

这条适用于：任务卡片、悬浮提示、搜索结果、复制按钮、导出文件、以及任何面向用户的文案。

### 1.3 映射公式（双向）

```
游戏坐标 -> 地图坐标：    mapX = gz         mapY = gx
地图坐标 -> 游戏坐标：    gx   = mapY       gz   = mapX
```

**轴是交换的** —— 地图的 x 装的是游戏的 Z，地图的 y 装的是游戏的 X。
`markers.js` 现有的 `x` / `y` 字段就是地图坐标，套用上式即可换回游戏坐标。

### 1.4 这个映射是怎么验证出来的（别再靠文档猜）

拿 ROM `RSDB/Challenge` 的目标点与 `markers.js` 里 170 个任务标点做距离比对：

| 假设 | 距离中位数 | 落在 500 内的样本 |
|---|---|---|
| `markers.(x,y) = 游戏(X,Z)`（交接文档的原写法） | **3681** | 9 / 144 |
| `markers.(x,y) = 游戏(Z,X)`（实测正确） | **12** | 130 / 144 |

3681 ≈ 随机分布，说明原文档写反了。数值范围也对得上：

- `markers.x` ∈ [-3553, 3583] ↔ ROM `Z` ∈ [-3535, 3579]
- `markers.y` ∈ [-3891, 4657] ↔ ROM `X` ∈ [-3888, 4805]

> **结论已写进 skill `skill-totk-romfs-extract`。以后任何把 ROM 坐标落到地图上的活，
> 先跑一遍这个比对再动手，不要信文档里的口径。**

### 1.5 高度 `gy`

- 游戏 Y 是海拔，范围实测 **-631 ~ 2002**（地底最深 -631，天空最高 2002）
- 玩家标点（markers.js）是 2D 的、**没有高度**
- 有 ROM 目标点且水平位置吻合（< 500）时才回填高度，用 `hasHeight` 标明有没有
- 286 条中 **246 条**有高度

### 1.6 图层判定（按游戏高度）

| 图层 | 判定 | 条数 |
|---|---|---|
| 18 地表 | 其余 | 267 |
| 19 地底 | `gy < -250` | 3 |
| 20 天空 | `gy >= 700` | 16 |

**不要用 `gy < 0` 判地底** —— 井底实测 -99，会误判。

---

## 2. 数据源

ROM 路径：`G:\YUZU\Switch Games\TOTKroms`

### 2.1 `RSDB/Challenge.Product.121.rstbl.byml.zs` —— 权威任务定义（285 条）

解压：zstd + 字典 `zs.zsdic`（字典源在 `Pack/ZsDic.pack.zs`），解出是小端 BYML v7 数组。

| 字段 | 说明 | 覆盖 |
|---|---|---|
| `__RowId` | `Work/Challenge/<Key>.game__challenge__Challenge.gyml`，**Key 即任务内部名，唯一** | 285 |
| `Category` | `Main` / `ImportantMini` / `Sub` | 120 |
| `DependFlagName` | 前置依赖 flag，如 `CarryGoronKid1_IsCompleted_Exp` | 100 |
| `RequestActor` | 委托 NPC，如 `Npc_oasis012` | 272 |
| `RequestLocation` | 所属地点，如 `Gerudo` | 270 |
| `SortIndex` | 游戏内排序 | 254 |
| `Steps[]` | 阶段：`Name` / `DestinationPoint[]` / `Participants[]` / `IsMiniGame` | 285 |
| `Steps[].DestinationPoint` | `Pos{X,Y,Z}` 或 `Actor` + `AlternativePos{X,Y,Z}` —— **任务目标点的游戏坐标** | 789 个点 |

> ⚠️ 交接文档里猜的 `Banc/Quest/` 目录**不存在**，别再去找。

### 2.2 `Mals/CNzh.Product.121.sarc.zs` —— 官方简体中文文本

| 内容 | 路径 | 条数 |
|---|---|---|
| 任务名 + 各阶段描述 | `ChallengeMsg/Info_<Key>.msbt` | 253 |
| 地名 / 神庙名 | `LocationMsg/Location.msbt` | 101 |
| NPC 名 | `ActorMsg/Npc.msbt` | 101 |

MSBT 解析两个坑（TotK 新版，与 BOTW 不同）：

1. `LBL1` 段**带 hash 桶表**：`[n(4)]` 之后要跳过 `n × 8` 字节才是第一条目标条目
2. **section 的 size 字段不能用于累加定位**（padding 不对齐）—— 必须
   `re.finditer(rb"(LBL1|TXT2)", data)` 扫 magic 定位，否则 TXT2 解出来是空的

label 名即含义：`Name` = 任务名，`Step1` / `Step2` / `Complete` = 各阶段描述。

### 2.3 `app/data/markers.js` —— 现有玩家攻略（170 条）

`desc` 里按 `【字段名】` 存着：前置任务 / 开启任务 / 注意事项 / 任务奖励 / 解锁任务。
**社区手写、非 ROM 提取**，有错别字和过时风险；价值在于「怎么开启、注意什么、奖励是什么」
这类 ROM 里没有的攻略信息。

与官方名的匹配结果：**169 / 170**（精确 128、去标点 22、系列拆分 15、模糊 12），
只剩「一发入魂」未匹配（官方是「一击入魂」，相似度 0.2，不敢硬配）。

---

## 3. 数据文件与字段

`app/data/tasks.js` → `window.TOTK_TASKS`，数组，286 条。

### 3.1 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 任务内部名（ROM），唯一；未匹配官方的这条为 `null` |
| `name` | string | **官方简体中文任务名**（`nameSrc=rom`）；无中文时退回 key |
| `nameSrc` | string | `rom` / `key` / `guide` |
| `cat` / `catCn` | string | 官方分类：Main/主线、ImportantMini/重要支线、Sub/普通支线、Other/其他 |
| `kind` | string | 兜底类型：`story` / `side` / `quest` / `minigame` / `tutorial` / `shrine` |
| `oldCat` | string | 玩家侧旧分类：情节挑战 / 迷你挑战（有则填） |
| `layer` | int | 18 地表 / 19 地底 / 20 天空 |
| **`gx` / `gy` / `gz`** | number | **游戏坐标，对外唯一口径** |
| `hasHeight` | bool | `gy` 是否有值 |
| `mapX` / `mapY` | number | 地图绘制基准（= `gz` / `gx`），**内部用，不展示** |
| `posSrc` | string | 坐标来源：`marker`（玩家标点）/ `rom` / `none` |
| `posValid` | bool | 是否为有效坐标（ROM 有 `0,0` 占位，如 `GetMasterSword`） |
| `npc` / `npcCn` | string | 委托 NPC 内部名 / 中文名（中文名仅 31 条有） |
| `loc` / `locCn` | string | 地点内部名 / 中文名（中文名仅 10 条有） |
| `sort` | int | 游戏内排序号 |
| `steps[]` | array | `[{name, text, pts:[{gx,gy,gz}]}]` —— 各阶段的官方中文描述与目标点 |
| `requires[]` | array | 前置依赖，见第 4 节 |
| `unlocks[]` | array | 反向索引：哪些任务以我为前置（40 条有） |
| `dependFlag` | string | 原始 flag 名，便于追溯 |
| `guide` | object | 玩家攻略：`{requires[], start, note, reward[], unlocks[]}`，178 条有 |
| `match` | string | 与官方名的匹配方式：exact / norm / series / fuzzy / null |
| `src` | string | `rom+guide` 177 / `rom` 108 / `guide` 1 |

### 3.2 一条完整样例

```json
{
  "key": "AisyaRescue",
  "name": "下落不明的老板",
  "cat": "Other", "catCn": "其他", "kind": "quest", "oldCat": "迷你挑战",
  "layer": 18,
  "gx": -3838.08, "gy": 150.64, "gz": 2876.757, "hasHeight": true,
  "mapX": 2876.757, "mapY": -3838.08,
  "posSrc": "marker", "posValid": true,
  "npc": "Npc_oasis012", "loc": "Gerudo",
  "steps": [
    {"name": "Step1", "text": "珠宝店的工匠玛卡拉正烦恼不已…", "pts": [{"gx":-3835.6,"gy":150.6,"gz":2874.9}]}
  ],
  "requires": [], "unlocks": [],
  "guide": {
    "start": "来到格鲁德小镇珠宝店找玛卡拉",
    "note": "米尼塔尼高神庙右侧打败莫尔德拉吉克就能见到珠宝店老板",
    "reward": ["钻石"]
  },
  "match": "exact", "src": "rom+guide"
}
```

---

## 4. 任务链（前置 / 解锁）

### 4.1 怎么来的

ROM 的 `DependFlagName` 形如 `CarryGoronKid1_IsCompleted_Exp`。
**按 `_` 从长到短截前缀，命中 Challenge 的 key 就是真前置**：

```
CarryGoronKid2  -> CarryGoronKid1_IsCompleted_Exp -> 前置 = CarryGoronKid1  ✅
FindSunaNui2    -> FindSunaNui_IsCompleted_Exp    -> 前置 = FindSunaNui     ✅
```

截不出 key 的就是**条件型 flag**，不能当任务链用：

```
SageOfGerudo_IsCompleted_Exp              （贤者剧情进度，不是任务名）
Rito_Npc_AfterSecretStoneOrAfterSong      （事件 flag）
EnemyKilled_AccidentOfDekutree            （击败敌人）
```

### 4.2 现状

- 100 条有 `DependFlagName`，**76 条能解析成真实任务 key**，24 条是条件 flag
- 40 条有 `unlocks`（被别人依赖）
- 依赖最密的主线：「卓拉领地的希多」解锁 10 个、「利特村的丘栗」解锁 8 个、「海拉鲁城堡的异变」解锁 5 个

### 4.3 两条使用纪律

1. **`requires[].resolved` 为 false 的不要渲染成任务链接**（那是条件，不是任务）
2. 现有攻略里的 `guide.requires` / `guide.unlocks` 是**玩家手写的文本**，与 ROM 链是两套东西，
   卡片上若都显示要分开标注来源，不要混为一谈

---

## 5. 分类体系

| cat | catCn | 条数 | 说明 |
|---|---|---|---|
| Main | 主线 | 23 | 主线剧情 |
| ImportantMini | 重要支线 | 66 | 重要支线（希顿三兄弟、贤者相关等） |
| Sub | 普通支线 | 31 | 普通支线 |
| Other | 其他 | 166 | **ROM 未标分类** |

`Other` 里 166 条用 `kind` 兜底：

| kind | 条数 | 说明 |
|---|---|---|
| quest | 143 | 普通任务（ROM 没标分类但确实是任务） |
| side | 97 | 支线（同 Sub/ImportantMini） |
| minigame | 21 | 小游戏，key 含 `MiniGame` |
| tutorial | 2 | 教程，key 含 `Tutorial` |
| shrine | 23 | 神庙水晶任务，key 含 `CarryToShrine` |

> 界面上建议：**有 `cat` 的用官方三级，没有的退回 `oldCat`（情节挑战/迷你挑战），
> 两者都没有的按 `kind` 归类或归入「其他」。**

---

## 6. 数据质量与已知问题

### 6.1 已修的缺陷（原交接文档列的 1-8）

| 缺陷 | 处理 |
|---|---|
| 字段串位（2 条） | 从 `markers.js` 原始 desc 用 `【字段名】` 正则重切，不再依赖换行 |
| 一个字段多个任务（9 处） | 拆成数组 |
| HTML / P.s. 备注 | 剥标签，去掉「点击左下角查看攻略」类残留 |
| 任务链匹配率低（17% / 8%） | 改用 ROM `DependFlagName`，解析率提到 76% |
| 语义混杂 | 每个依赖带 `type`：quest / flag |
| 错别字 | 用官方名订正（柯尔天、萝莱尔、沃托里村、岩熔温泉等，共 12 条模糊匹配） |
| 170 条丢失风险 | 169 匹配 + 1 保留为独立记录，**零丢失** |

### 6.2 尚存限制（做界面时要注意）

| 问题 | 影响 | 建议 |
|---|---|---|
| NPC 中文名仅 31/272 | 大部分只能显示内部名 `Npc_oasis012` | 界面上不显示 NPC 名，或只显示有中文的。真名在 `EventFlowMsg`（1139 个文件）里，未深挖 |
| 地名中文名仅 10/270 | 同上 | 同上 |
| 25 条无坐标 | 画不了点 | 用 `posValid` 过滤，或单列「无位置」分组 |
| 2 条坐标是 ROM 占位 `0,0` | 会画到地图原点 | `posValid: false` 已标记，**渲染前必须过滤** |
| 23 条 `minigame` 无中文名 | 显示英文 key | 可考虑不收录小游戏类 |
| 玩家攻略文本口语化 | 显示略随意 | 保留原样（攻略建议本身有价值） |

### 6.3 待人工确认的两份清单

在 `归档/任务数据交接/提取报告.md`：

- **模糊匹配明细**（26 条）：官方名订正，如「科尔天→柯尔天」「岩溶温泉→岩熔温泉」
- **坐标偏差 top15**：玩家标点与 ROM 目标点差异大的（多为多阶段任务，保留玩家坐标）
- **4 条图层冲突**：洛美岛预言系列（玩家标地表 / ROM 判天空）

---

## 7. 网站接入要点（给地图 agent）

### 7.1 加载

```html
<script src="data/tasks.js"></script>
<!-- window.TOTK_TASKS 即可用 -->
```

### 7.2 画点（坐标换算）

```js
TOTK_TASKS.filter(t => t.posValid && t.layer === currentLayer).forEach(t => {
  // ★ 画点用地图坐标，但不要展示给用户
  L.marker([t.mapX, t.mapY], {icon: taskIcon(t)}).addTo(map);

  // ★ 展示给用户的必须是游戏坐标
  const coordText = `X ${t.gx.toFixed(0)}  Y ${t.gy != null ? t.gy.toFixed(0) : '—'}  Z ${t.gz.toFixed(0)}`;
});
```

换算就一行，但**别在界面上把 `mapX` / `mapY` 当坐标显示**：

```js
const toGame = m => ({gx: m.mapY, gz: m.mapX});   // 地图 -> 游戏
const toMap  = g => ({mapX: g.gz,  mapY: g.gx});   // 游戏 -> 地图
```

### 7.3 卡片展示建议

优先级从高到低，缺项就跳过：

1. 官方任务名 `name`（有 `oldCat` 的可作为副标题）
2. **游戏坐标** `gx / gy / gz`
3. 分类 `catCn`（或 `oldCat` / `kind`）
4. 委托 NPC / 地点（有中文才显示）
5. 阶段描述 `steps[].text`（官方中文，最有价值的内容）
6. 玩家攻略 `guide.start` / `guide.note` / `guide.reward`
7. 前置 `requires`（只渲染 `resolved: true` 的）+ 后续 `unlocks`

### 7.4 分类面板

建议新增「任务」大组，按 `catCn` 三级分组，`Other` 里按 `kind` 再分。
现有的 `情节挑战 / 迷你挑战`（`oldCat`）可作为二级筛选保留。

### 7.5 完成度追踪（后续）

`app/data/totk_save_hashes.js` 里的 `CompletismHashes` **没有 quest 分组**
（只有塔/神庙/克洛格/BOSS 等收集品）。要做任务完成度，需要另外建立
任务 flag 的 murmurhash3 表 —— flag 名现成的就在 `dependFlag` 字段里，
可以批量生成。

---

## 8. 复现

```bash
cd E:\WorkSpace\TOTKmap
python tools/extract_quests.py
```

依赖：`zstandard` `sarc` `byml`（已装在 `C:\Users\Administrator\.workbuddy\binaries\python\envs\default`）。
换 ROM 版本直接重跑即可，字典会自动适配。

产出：`app/data/tasks.js` + `归档/任务数据交接/提取报告.md`。

---

## 9. 后续可做的增强

| 方向 | 说明 | 成本 |
|---|---|---|
| NPC / 地名中文名 | 从 `EventFlowMsg`（1139 个 msbt）挖 NPC 真名 | 中 |
| 任务完成度 | 用 `dependFlag` 批量生成 murmurhash3 表，接存档读取 | 中 |
| 任务奖励结构化 | 奖励在 EventFlow 里，目前只有玩家手写的 `guide.reward` | 高 |
| 32 条无中文任务 | 多为小游戏，可考虑不收录 | 低 |
