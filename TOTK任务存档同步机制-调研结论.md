# TOTK 任务进度存档机制 —— 调研结论（已实测验证）

> 结论先行：**任务进度可以完整从 `progress.sav` 读出来，285/285 全命中，零缺失。**
> 本文所有数字都来自本机真实存档实测，不是推测。给后续接手的 AI 看。

---

## 一、机制（已验证）

### 1. 变量命名
每个任务在存档里对应**一个**变量，名字就是：

```
Step_<任务key>
```

例：`Step_AisyaRescue`、`Step_CarryToShrine01`、`Step_AssassinGerudoBase`

### 2. 存放位置：复用现有 hash 表，**不需要新的解析器**

这是最重要的发现——任务变量和神庙/克洛格变量**存在同一张表里**：

| 项 | 值 |
|---|---|
| hash 表起始偏移 | `0x28` |
| 每条步长 | 8 字节（`[hash:4][value:4]`）|
| 结束哨兵 | `hash == 0xA3DB7114`，其后的 4 字节是 GUID 表偏移 |
| 本机存档实测条目数 | **30700** |

也就是说 `js/save-parser.js` 里已有的这段**直接可用，任务不用另写解析**：

```js
var h = hash('Step_' + questKey);      // murmurHash3 x86 hash32
var off = parsed.valueByHash[h];
var val = parsed.dv.getUint32(off, true);
```

### 3. 值的语义：不是数字，是**阶段名的哈希**

值**不是** `1/0`，也不是小枚举序号，而是「当前所处阶段名字符串」的 murmurHash3。

每个任务有**自己的阶段枚举**（来自 ROM 的任务事件定义），末项固定是 `Complete`：

```
Step_AisyaRescue          → NotReady, Ready, Step1, Step1a, Step2, Complete
Step_CarryToShrine01      → NotReady, Ready, ...                     , Complete
Step_BallBring_Mini_Game  → NotReady, Ready, Craft, Playing, Retry, TimeOver, Complete
Step_SageOfSoul_Beam_CheckPoint → Ready, Beam_CheckPointTutorial, ..., Complete
```

所以**完成判定就是**：

```js
var DONE = hash('Complete');            // 0x4c0a63f4
var done = (val === DONE);
```

⚠️ 重要提醒：`Complete` 的哈希 `0x4c0a63f4` 是**全局固定**的（所有任务共用同一个末项名），
所以只要一个 `hash()` 函数就能判定全部 285 个任务，不需要为每个任务算完成哈希。

---

## 二、数据文件

### `app/data/task-save.js`（已生成，44KB，294 行）

```js
window.TOTK_TASK_SAVE = {
  "AisyaRescue": {
    hash: "0xe0c24add",              // murmurHash3("Step_AisyaRescue") —— hash 表的键
    done: "0x4c0a63f4",              // murmurHash3("Complete") —— 完成态的值
    doneIdx: 5,                      // Complete 在 stages 里的下标
    stages: ["NotReady","Ready","Step1","Step1a","Step2","Complete"]
  },
  ...
}
```

- **285 个任务全部映射成功，缺失 0**。
- `hash` / `done` 用十六进制**字符串**存储，避免 JS 大整数十进制精度丢失。
- 生成脚本：`tools/build_task_save.py`（可重跑，勿手改产物）

### 数据来源

`marcrobledo/savegame-editors`（MIT）仓库的 `zelda-totk/zelda-totk.hashes.csv`，
读它的 `EnumValues;Step_*;<阶段列表>` 行。该 CSV 共 596 个 `Step_` 枚举，
我们只取与 `tasks.js` 的 285 个 key 相交的部分。

> 下载踩坑：文件 1.6MB，`raw.githubusercontent.com` 和 `contents` API 都会 502 / 返回空content。
> 唯一可行方式是 **blob API + `Accept: application/vnd.github.raw`**：
> ```python
> sha = <contents API 拿到的 sha>
> GET /repos/marcrobledo/savegame-editors/git/blobs/<sha>
> Accept: application/vnd.github.raw      # 关键，直接返回原文
> ```

---

## 三、实测验证结果（重要：证明判定可信）

拿本机真实存档跑 `tools/verify_task_save.py`：

```
hash 表条目 = 30700
task-save.js 任务数 = 285
命中 hash 表 = 285 / 285      ← 100% 命中
判定为已完成 = 3
阶段分布：
  Ready      182      NotReady   96      Complete   3
  GotoUnderground 1   UnderSurveyOfFourVillages 1   LookingForZelda 1   1stSageClear 1
```

**"只完成 3 个任务"是真的，不是 bug。** 交叉验证 `tools/cross_check.py`：

```
神庙：已清除 9 / 152
鸟望台：已激活 2 / 15
```

9 神庙 + 2 鸟望台 = 刚出初始台地的程度，和"3 个任务完成"完全自洽。
所有 slot（00/03/05）数值一致，因为都是同一存档的自动备份。

已完成的任务（阶段反查正确）：
```
CookAtBaseCamp         在营地做饭
GOToTheCastleOfHyrule  去往海拉鲁城堡
LookingForLightSpot    紧闭之门
```

---

## 四、前端接入建议（给后续 AI）

### 1. 数据加载
`app/index.html` 里加一行（在 `save-parser.js` 之后，因为依赖 `hash()`）：
```html
<script src="data/task-save.js"></script>
```

### 2. 解析器加一个函数（`app/js/save-parser.js`）
和现有 `collect()` / `pointDone()` 平级：

```js
/* 任务完成判定：配合 data/task-save.js
 * 返回 { <任务key>: true, ... }（仅已完成的任务）
 */
function questDone(parsed, saveMap) {
  var out = {};
  if (!parsed || !parsed.ok) return out;
  var DONE = hash('Complete');          // 0x4c0a63f4
  saveMap = saveMap || window.TOTK_TASK_SAVE || {};
  for (var key in saveMap) {
    var off = parsed.valueByHash[saveMap[key].hash];   // 注意：表里存的是 "0x..." 字符串
    if (off === undefined) continue;                   // 用 parseInt(_,16) 或让产物存数值
    if (parsed.dv.getUint32(off, true) === DONE) out[key] = true;
  }
  return out;
}
```

⚠️ **接的时候注意**：`valueByHash` 的键是**数字**（JS 里 hash() 返回 uint32），
而 `task-save.js` 里存的是字符串 `"0xe0c24add"`。两种解法：
- 产物改成存十进制/十六进制数值（但 JS 位运算返回有符号数，>2^31 会变负）；
- **推荐**：消费侧统一 `parseInt(saveMap[key].hash, 16) >>> 0`。

### 3. 服务端同样口径（`live-python/server.py`）
`_parse_save()` 已经返回 `valueByHash`，在 `_progress_counts()` 里加一段即可，
Python 侧没有精度问题，直接 `int(h, 16)`。

### 4. 与 localStorage 的关系
建议**分开存、合并显示**：
- 存档读出的完成态 = `saveQuestDone`（每次加载存档覆盖）
- 用户手动标记的 = `localStorage: totkmap_task_done_v1`（存档没覆盖时兜底）
- 展示时取并集，但**存档优先**（存档是游戏真实进度，权威性更高）

---

## 五、已知坑

1. **别用 `Complete` 的十进制常数硬编码** —— 必须 `hash('Complete')` 算，
   不同 murmur 实现版本算出的小数值可能不同。
2. **`hash()` 返回值可能为负**（JS 位运算），查 `valueByHash` 时要用 `>>> 0` 无符号化。
3. **别把 `Step_` 的值当数字比大小** —— 它是哈希，`Ready`(hash) 和 `Complete`(hash)
   的大小关系没有意义，只能做**等值判定**。
4. **阶段列表每个任务不同** —— `Step_BallBring_Mini_Game` 有 6 个阶段，
   `Step_SageOfSoul_Beam_CheckPoint` 有 6 个，但名字完全不同。别写死通用阶段数组。
5. **`key=null` 的任务**：`tasks.js` 里有攻略孤儿条目（如 `key: null`），
   这类任务**没有** `Step_` 变量，无法从存档同步，只能 localStorage 手动标记。
   当前 285 个 key 全部有映射，说明进任务板块的都有 key。

---

## 六、已完成接入（2026-10-06 M5）

前面一到五节是调研结论，**第六节起是已落地的代码**，其他 AI 直接用即可。

### 已完成的改动

| 文件 | 改动 |
|---|---|
| `app/data/task-save.js` | 新增，285 条任务的存档变量表 |
| `app/js/save-parser.js` | 新增 `questDone()` / `questDoneHash()` |
| `app/js/task/task-done.js` | **新增文件**，完成态管理层（存档 + localStorage 合并）|
| `app/js/task/task-card.js` | 右上角复制 + 完成勾 + 类型行 + 进度行 + 标记完成按钮 + 追踪按钮 + 「任务原文」条件折叠 |
| `app/js/task/task-flow.js` | 新增追踪模式（关卡片保留流程线）|
| `app/js/task/task-panel.js` | 标题计数改为 `已完成/总数`，订阅完成态变化 |
| `app/js/app.js` | 两个存档入口都把 `questDone` 灌进 `TaskDone` |
| `live-python/server.py` | 新增 `_quest_done()`，`/progress` 响应带 `questDone` 字段 |
| `app/index.html` | 加载 `data/task-save.js` 与 `js/task/task-done.js` |

### 数据层修补（M5 顺手修掉的两个真问题）

1. **「一发入魂」重复条目合并**
   同一个任务在数据里有两条：`key=HourseInnChallenge004`（官方名「一击入魂」）+
   `key=null`（社区名「一发入魂」，坐标差 10 米）。
   **必须合，不然存档同步对这条永远无效** —— key=null 的没有 `Step_` 变量。
   合并后：`app/data/task-plan.js` 260 → 259 条，**key=null 归零**。
   脚本：`tools/merge_ippyujin.py`

2. **`kindCn` 任务性质分类**
   新增字段，把「情节 / 迷你挑战」拆清楚（ROM 的四分类里 `Other` 混了 121 条迷你挑战）。
   分布：迷你挑战 121 / 情节挑战 59 / 主线剧情 23 / 神庙探索 21 / 支线故事 17 /
   收集要素 6 / 地区任务 6 / 背景事件 4 / 其他 2。
   脚本：`tools/add_kindcn.py`

### ★★ 合并后的覆盖率（关键结论）

```
plan 任务数: 259
无 key 的: 0
有 key 但存档表里没有: 0
★结论: 全部 259 条任务均可从存档同步完成状态
```

**零缺口。** 这是 M5 最有价值的产出 —— 之前因为 `key=null` 的孤儿条目，
任务存档同步是做不到 100% 的。

### 完成态优先级

```
1. 存档态（src='save'）   —— 权威，不可取消
2. 手动态（src='manual'） —— localStorage: totkmap_task_done_v1
展示取并集，冲突时存档优先
```

⚠️ **实现时踩过的坑（务必注意）**：
`TaskDone.status(key)` 对**任何出现在存档里的任务**都返回 `src='save'`，
**包括未完成的**（语义是「读到存档数据了」而不是「存档说它完成了」）。
所以判断「已完成且来自存档」必须**同时判两个条件**：

```js
if (st.done && st.src === 'save') { /* 不可取消的完成态 */ }
```

只判 `src==='save'` 会让全部 259 个任务都显示成「已完成 ✓」且按钮全灰。
（这个 bug 真发生过，第一次浏览器验收就抓出来了。）

### 验收脚本

`tools/verify/task-card-m5.js` —— 覆盖模块加载、真实存档解析、卡片结构、
标记完成/取消、追踪持久化（Esc 关卡片）、reload 持久化、259 条全量渲染、控制台零报错。

| 文件 | 作用 |
|---|---|
| `app/data/task-save.js` | 产物：285 个任务的存档变量表 |
| `tools/build_task_save.py` | 生成脚本（从 hashes.csv + tasks.js）|
| `tools/probe_quest.py` | 探针：验证 `Step_` 是否在 hash 表、murmur 实现 |
| `tools/probe_quest2.py` | 探针：值语义深挖（跨存档对比、字符串表扫描）|
| `tools/verify_task_save.py` | 验证：真实存档跑一遍，输出任务名+阶段对照 |
| `tools/cross_check.py` | 交叉验证：用神庙/鸟望台数印证判定可信 |
| `tools/merge_ippyujin.py` | 合并「一发入魂」重复条目（key=null →有key）|
| `tools/add_kindcn.py` | 生成 kindCn 任务性质分类 |
| `tools/patch_tasks.py` | 定点补 npc/loc/前置任务（最小侵入，不重排 JSON）|
| `tools/check_server.py` | Python 与 JS 双实现对账 |
| `tools/verify/task-card-m5.js` | 真浏览器验收（M5）|

## 七、后续可做的事

- **地图完成态**：任务点标在地图上，完成后应显示勾（探索侧已有 `doneIconFor()` 可复用）
- **按分类统计完成率**：面板里四个分组各自显示 `已完成/总数`
- **写入存档**：目前只读不写。若要「在地图上标记完成 → 游戏里也完成」，
  需要改写 progress.sav 的 hash 表值（把 `Step_<key>` 写成 `hash('Complete')`），
  但**风险高**（存档损坏 = 丢档），且必须处理双副本与校验，建议不做。