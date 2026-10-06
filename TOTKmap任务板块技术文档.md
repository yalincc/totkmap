# TOTKmap 任务板块技术文档（V2.1 M6.1–M6.9）

> 归档时间：2026-10-07 · 提交范围：`87caf2d6`（M6.1 防具区）→ `5ef78766`（M6.7 联动）→ `c472cf74`（M6.9 分类）→ `22fbc7e7`（分类修复）
> 覆盖文件：`app/js/task/`（5 个模块）、`app/data/task-*.js`、`tools/*.py`、`tools/verify/verify-task-*.js`
> **给接手的 AI/开发者：先读第 0 节和第 8 节（必读坑），再动手。**

---

## 0. 三十秒上手

```bash
# 1. 打开（不需要起服务器，file:// 直接双击 index.html 即可）
E:/WorkSpace/TOTKmap/app/index.html

# 2. 改数据 → 重新生成（顺序不能乱，见第 2 节）
cd E:/WorkSpace/TOTKmap
python tools/build_task_plan.py --write
python tools/merge_ippyujin.py
python tools/add_kindcn.py

# 3. 改前端 → bump 版本号（★ 忘了这步改动看不到）
#    index.html 里所有 ?v=NNN 改成新号，sw.js 的 SW_VER 也改

# 4. 验收
node tools/verify/verify-all.js      # 三层全跑（L1数据/L2浏览器/L3 file协议）
node tools/verify/verify-all.js --l1 # 只跑数据体检（秒级）
```

**三条最容易踩的坑**（详见第 8 节）：

1. 改完 `app/` 下的 js/css **必须 bump `?v=` 和 `SW_VER`**，否则页面看不到变化
2. **localStorage 存了旧格式的键**时，改键命名必须做迁移，否则用户界面整个失效
3. 换键命名要 **grep 全部读取点**，尤其别漏了「真正执行动作的那一行」

---

## 1. 命名与范围

- 叫「**任务**」，不叫「 quest 列表」等
- 分类叫「**迷你挑战**」（游戏内正式类别），不叫「小任务」
- 叫「**防具**」不叫「装备」——防具是唯一不会损坏的装备，武器盾牌会坏
- 覆盖：259 个任务条目（含支线、迷你挑战、收集要素、部分背景事件）

**不在本板块范围**：神庙/鸟望塔/克洛格等（走探索侧的`catalogs.js`）、材料（走`materials.js`）、防具详情（走 `armor-enhance.js`）。

---

## 2. ★ 数据管线（顺序不能乱）

```
 源数据 ─┬─ romtasks.json（ROM 提取）    ─┐
         └─ 社区攻略（地图标点 desc）  ─┴─→ tools/extract_quests.py
                                                    ↓
                                        app/data/tasks.js      403 KB
                                                    ↓
                     tools/build_task_plan.py --write   ★ 主生成器
                                        （剔除小游戏/合并重复/分类判定/9 个阶段报告）
                                                    ↓
                     tools/merge_ippyujin.py  （补「一发入魂」等重复条目）
                                                    ↓
                     tools/add_kindcn.py      （补kindCn 字段）
                                                    ↓
                                        app/data/task-plan.js    537 KB  ★ 唯一数据源
                                                    ↓
                                        js/task/task-data.js   （适配层）
                                                    ↓
                        task-panel.js / task-card.js / task-flow.js
```

**重跑顺序**（错一步数据会互相覆盖）：

```bash
python tools/build_task_plan.py --write
python tools/merge_ippyujin.py
python tools/add_kindcn.py
```

| 脚本 | 产出 | 幂等 |
|---|---|---|
| `build_task_plan.py` | `app/data/task-plan.js` | ✅ 全量重写 |
| `merge_ippyujin.py` | 就地改 `task-plan.js` | ✅ 全量重写 |
| `add_kindcn.py` | 就地改 `task-plan.js`，补 `kindCn` | ✅ 全量重写 |
| `build_task_save.py` | `app/data/task-save.js` | ✅ 独立 |

**外部依赖**（不在本仓库，只读）：
- `E:/WorkSpace/BOTWroms/totk-site/public/data/` — 防具/强化/图鉴数据
- `E:/WorkSpace/BOTWroms/...zelda-totk.hashes.csv`（marcrobledo/savegame-editors）— 存档变量哈希表

---

## 3. 数据结构（`task-plan.js`，45 字段）

`window.TOTK_TASK_PLAN` = 259 条。关键字段分组：

### 3.1 身份

| 字段 | 说明 |
|---|---|
| `key` | ROM 内部 ID（主键）。实测**无 `null` 值**（孤儿条目已在上次合并时消掉） |
| `name` | 显示名。`nameSrc` = `rom`（官方中文）/`guide`（社区名）/`key`（**ROM 里就没中文，5 条**） |
| `src` | 来源标记 |

> `nameSrc === 'key'` 时，卡片走 `prettyKey()` 做**可读化兜底**（拆词+分隔符，如 `Mercenary_Akkare_Bloody` → 「佣兵 · 阿克雷 · 血战」）。
> **只做词间分隔不做词翻译**——凭空猜中文地名会误导玩家。

### 3.2 分类（★ 两个口径，正交，别混）

| 字段 | 口径 | 用途 |
|---|---|---|
| `cat` | **ROM 官方分类**（`Main`/`ImportantMini`/`Sub`/`Other`） | 只作数据溯源，界面不用 |
| `group` | **界面分类**（5 档中文，2026-10-07起） | **面板筛选、徽标、地图点配色都用它** |
| `catCn` | 从 `cat` 推的中文（4 档） | 遗留字段，体检脚本用 |
| `oldCat` | 来自**地图标点分类 id**（攻略侧标记，185/192=迷你挑战） | `group` 的判据 |
| `kindCn` | 玩家视角分类（主线剧情/迷你挑战/神庙探索/收集要素…） | 交叉参考 |

**`group` 判定优先级**：`oldCat=='迷你挑战'` **优先于** ROM `cat`。

```python
def group_of(t):
    if t.get("oldCat") == MINI_CHALLENGE: return "迷你挑战"
    return CAT_TO_GROUP.get(t.get("cat"), "其他")
```

> ★ 用 `oldCat` 而不是 ROM `cat`：ROM cat 只有 4 档，游戏里正式存在的迷你挑战
> 被塞进 Other → 「其他」曾有 139 条，其中 120 条是迷你挑战（86%）。
> `oldCat` 来自玩家攻略侧的标点 id，可信度更高。
> 实测 `oldCat=='迷你挑战'` 120 条，与 `kindCn` 一致。

**当前分布**：主线 23 / 重要支线 65 / 普通支线 31 / **迷你挑战 120** / 其他 20

界面顺序（`CAT_ORDER`，数组不是对象，避免依赖键序）：

```js
['主线', '重要支线', '普通支线', '迷你挑战', '其他']
```

### 3.3 坐标

| 字段 | 说明 |
|---|---|
| `gx`/`gy`/`gz` | **游戏坐标**（X 东西 / Y 高度 / Z 南北）—— **对外唯一口径** |
| `mapX`/`mapY` | Leaflet 绘制基准（`mapX = gz`, `mapY = gx`），**不展示给用户** |
| `posValid` | 原始坐标是否有效 |
| `onMap` | **最终判定能不能上图**（`build_task_plan.py` 算，已排除 (0,0) 陷阱） |
| `layer` | 18 地表 / 19 地底 / 20 天空 |
| `hasHeight` | 是否有高度值 |

> ★ `(0,0)` **不是空值，是海拉鲁城堡中心**。`onMap` 显式排除了 `|gx|<1 && |gz|<1`。
> ★ 用户看到的一切坐标必须是 `gx`/`gz`；`mapX`/`mapY` 是实现细节。

### 3.4 流程（`tier` / `flowPts`）

| `tier` | 条件 | 表现 |
|---|---|---|
| `L1` | `flowPts.length >= 2` | 地图可画**流程线** |
| `L2` | `== 1` | 单点 |
| `L3` | `== 0` | 仅列表（卡片有名字但没坐标） |

`flowPts` = 任务的多个地点（经 `dedup_flow` 去重），卡片里可点**流程线**。

### 3.5 步骤（★ 关键：用 `stepsUI` 不是 `steps`）

| 字段 | 说明 |
|---|---|
| `steps` | ROM 原始步骤 —— **是「事件触发器数组」不是「玩家步骤」**，600/1077 条是空壳（`Ready`/`Collect2nd` 这类纯钩子） |
| `stepsUI` | **清洗后**，喂给卡片的就是这个。实测 259 条里 246 条有可展示内容 |
| `nStepsUI` | 玩家真正看到的步数（卡片顶部「N 步」用） |
| `hasStepText` | 是否有可展示文字 |

> ⚠ 早期版本文档写过「`key=null` 的攻略孤儿条目 1 条」——**现已不成立**。
> `merge_ippyujin.py` 阶段已把孤儿条目合并掉，实测 `key` 全有值。
> `task-done.js` 里也没有 `!t.key` 这类分支，**不需要特殊处理空 key**。

> ★ 早期卡片直接按 `i+1` 编号 → 空壳照样占号，序号与文字整体错位。
> **原始 `steps` 一字不改**（流程线要用它的 `pts`）。

清洗掉的：空壳 485 / 重复 12 / 脏字符 316 —— 950 → 451（砍 53%）。

### 3.6 完成度（三个来源，见第 4 节）

`reqs`（前置）/ `unlockList`（解锁）/ `reqTasks`（可获得防具）

---

## 4. ★ 完成态：三个来源，权威性不同

`js/task/task-done.js` 管理 259 个任务的「已完成」标记。

| 来源 | 存储 | 权威性 |
|---|---|---|
| **存档态** | `progress.sav` 解析（M5.1） | ★ **最高**，重新加载存档应覆盖手动态 |
| **手动态** | `localStorage['totkmap_task_done_v1']` | 兜底/补充 |
| **流程线自动** | 由 `flowPts` 推导（走到第 N 步） | 中间态 |

**展示时取并集，冲突时存档优先。**

实测分布：`L1`(可画线) 74 / `L2`(单点) 178 / `L3`(仅列表) 7

存档机制（详见 `TOTK任务存档同步机制-调研结论.md`）：

```
键 = hash('Step_' + 任务key)      值 = 阶段名哈希
值 hash == hash('Complete')      → 已完成
```

- 哈希表来自 `marcrobledo/savegame-editors` 的 `zelda-totk.hashes.csv`
- 由 `tools/build_task_save.py` 生成 `app/data/task-save.js`
- 服务端接口 `GET /progress`（`live-python/server.py`）

**为什么要分来源**：存档里没有的条目（`key=null` 的孤儿条目、用户想提前标记的支线）只能靠 localStorage。

---

## 5. 模块职责与接口

```
app/js/task/
├── task-data.js    595 行  数据适配层    → global.TaskData
├── task-done.js  195 行  完成状态管理   → global.TaskDone
├── task-panel.js   422 行  侧栏面板      → global.TaskPanel
├── task-card.js   1186 行  任务卡片      → global.TaskCard
└── task-flow.js    376 行  流程线/追踪   → global.TaskFlow
```

**依赖顺序**（`index.html` 里的 script 顺序不能乱）：
`data/task-plan.js` → `data/task-save.js` → `data/armors.js` → `data/armor-upgrade.js` → `task-data.js` → `task-done.js` → `task-panel.js` → `task-card.js` → `task-flow.js`

> ★ `task-data.js` 必须在 `data/armors.js` **之后**——它的 `armorsOf()` 要读 `window.TOTK_ARMORS` 做「任务→可获得防具」反查，顺序错了反查全空。

### 5.1 `TaskData`（task-data.js）

```js
TaskData.tasks              // 全部任务
TaskData.byKey(k)           // → task|null
TaskData.byName(n)          // → task|null（官方任务名 → task，reqs 反查用）
TaskData.catOrder           // ['主线','重要支线','普通支线','迷你挑战','其他']
TaskData.statsByLayer(l)    // → [{cat,name,count}] 按 group 分组
TaskData.listBy(layer, cat) // 过滤（cat 传中文 group）
TaskData.armorsOf(taskKey)  // → {total, groups:[{set,slots,items}]}
TaskData.seriesOf(taskKey)  // → {total, tasks:[...]} 同系列（任务链用）
```

### 5.2 `TaskDone`（task-done.js）

```js
TaskDone.init()             // 载入存档 + localStorage
TaskDone.isDone(key)        // → bool
TaskDone.status(key)        // → {done, src, stage, idx, total}
TaskDone.stats()            // → 汇总统计
TaskDone.toggle(key)        // 切换完成态（手动）
TaskDone.markDone(key)      // 标记完成
TaskDone.markUndone(key)    // 取消完成
TaskDone.clearManual()      // 清掉手动态（不动存档态）
TaskDone.applySave(save)    // 用存档刷新（progress.sav 解析后喂进来）
TaskDone.hasSave()          // → bool 当前有无存档数据
TaskDone.onChange(fn)       // 变更订阅
TaskDone.exportManual()     // 导出手动态（字符串，给用户备份用）
TaskDone.importManual(str)  // 导入手动态
TaskDone.LS_KEY             // localStorage 键名
```

### 5.3 `TaskPanel`（task-panel.js）

侧栏「任务」大组：5 个分类勾选框 + 完成度标题（`done/total`）。
勾选状态存 `localStorage['totkmap_task_sel_v1']`，结构 `{ [layer]: { [group]: true } }`。

### 5.4 `TaskCard`（task-card.js）

**独立卡片**（`#taskCard`），与探索侧的 `exploreCard` **完全分离**——两套模板互不干扰。内容区：

| 区块 | 说明 |
|---|---|
| 头部 | 分类徽标（`tk-chip-*`，含迷你挑战紫）+ 名称 + 复制按钮 |
| 任务链 | 同系列流程（`tk-flow.js` 渲染） |
| 官方分步 | `stepsUI` 渲染，带「展开」 |
| 获取地点 | 区域 / 塔域 / 坐标 / 位置 / 注意事项 / 宝箱 |
| **本任务可获得防具** | M6.1，`armorsOf()`，图标可点跳转 |
| **同系列折叠列表** | M6.3，`<details>` 列出全部同系列可切换 |
| 底部 | 追踪 / 导航 / 标记完成 |

可拖动（`makeDraggable`）。

### 5.5 `TaskFlow`（task-flow.js）

地图上的流程线：多地点任务连成折线 + 追踪（`toggleTrack`）。
追踪状态存 `localStorage`，绘制时把线画在 marker 之上。

---

## 6. 交互与联动

```
① 侧栏勾选分类 → 地图画该分类任务点（颜色按 group）
② 点地图任务点 → 打开 TaskCard
③ 卡片「同系列列表」→ 直接切到那一项的卡片
④ 卡片「防具图标」→ TOTK_APP.gotoArmor(key) → 跳地图上那件防具 → exploreCard
⑤ exploreCard「关联任务」→ findTaskMarker → gotoMarker + TaskCard.open
⑥ 追踪按钮 → TaskFlow.toggleTrack → 地图画线
⑦ 坐标旁定位针（ecLocate）→ gotoMarker（纯前端，不依赖 xnavi）
```

**两个「导航」的语义别混**（写在 `app/css/style.css` 注释里）：

| | 干什么 | 依赖 |
|---|---|---|
| **导航**（卡片底部） | 交给 xnavi 引导在**游戏里**走过去 | 要 `live-python` 在跑 |
| **定位**（坐标旁小图标） | 只把**网页地图视角**移回该点 | 纯前端 `flyTo` |

### 6.1 `gotoMarker` 的三个坑（其他 AI 必读）

```js
gotoMarker(m)   // 切层 → 勾分类 → flyTo → 等 moveend → 金色光圈
```

**① marker 只在被勾选时才画**
`renderMarkers` 里 `if (!state.selected[m.cat]) return`。直接 `flyTo` 会飞到**一片空白**——目标根本没渲染。所以要先自动勾上目标分类。

**② 顺序要紧：先切层，再勾分类**
`state.selected` 是 `selectedByLayer[当前层]` 的**引用**，切层会把它换成新层的对象——先勾后切等于白勾。

**③ 任务点挂在攻略分类下，不叫「任务」**
实测「拉姆达的财宝」标点 `cat=185「迷你挑战」`。按分类名找必然落空。`findTaskMarker` 用「同图层 + 同坐标 + 同名」，退到坐标邻近 ±2。

---

## 7. 验收

```bash
node tools/verify/verify-all.js
```

**三层结构**：

| 层 | 内容 | 备注 |
|---|---|---|
| **L1** | `verify-data.js` 数据体检（纯 Node，秒级） | 0 ERROR / 2 WARN / 3 INFO |
| **L2** | 8 套浏览器回归（真实点击，自起服务） | 见下|
| **L3** | `verify-file-protocol.js` — `file://` 直开 | 证明不启服务器也能跑 |

L2 的 8 套：

| 脚本 | 覆盖 |
|---|---|
| `verify-chain.js` | M6 任务链 / 系列 |
| `verify-task-card.js` | M5 卡片 / 完成态 / 追踪 |
| `verify-armor-drop.js` | M6.1 本任务可获得防具 |
| `verify-series-list.js` | M6.3 同系列折叠列表 |
| `verify-mobile.js` | M6.4 移动端视口（iPhone SE / 14 / Pixel 7） |
| `verify-armor-enhance.js` | M6.6 防具增强 **+ 分类分组断言** |
| `verify-armor-locate.js` | M6.7 跳转定位 + 商店聚合 |
| `verify-locate-btn.js` | M6.8 坐标定位按钮 + 点击回归 |
| `task-done-map.js` | M5.1 完成态上地图（需 `PROGRESS_SAV`） |

**`verify-armor-enhance.js` 里的「分类分组」断言**同时守M6.9 的三处坑：五档齐全 / 迷你挑战 = 120 / 「其他」≤ 25 / `listBy` 过滤有效 / **勾选真的传到地图**。

---

## 8. ★★★ 必读：踩过的坑（别再犯）

### 8.1 改了 js/css 但页面没变化 → 没 bump 版本号

项目开了 Service Worker 做瓦片秒开，代价是资源走 **cache-first**。

- `index.html` 里每个 `?v=NNN` 是资源版本，**改文件必须 bump**
- `app/sw.js` 的 `SW_VER` 也要 bump —— 因为 `register('sw.js')` **没带版本号**，
  浏览器永远用第一次缓存的 SW，`SW_VER` 不变 → 清旧缓存的逻辑不执行
- **光 bump 资源版本号没用**，浏览器连新版 `sw.js` 都拿不到

> ★ `file://` 下 SW 根本不注册（浏览器只在 https/localhost 允许），
> 所以本地看不到改动是**另一个原因**（见 8.2）。这是两件事，别混。

### 8.2 `file://` 直接打开看不到新改动

老大平时用 `file:///E:/WorkSpace/TOTKmap/app/index.html` 查看。
这个协议下 SW 不生效、缓存不是原因。可能是：标签页恢复（Chrome 会恢复崩溃的标签）/ 没刷新。

**排查顺序**：`Ctrl+Shift+R` 强刷 → 还不行跑 L3 验收 → 仍不对再查代码。

### 8.3 ★★ 换键命名但没迁移 localStorage → 界面整个失效

**M6.9 事故**：分类键从 ROM `cat`（`Main`/`Sub`/…）改成中文 `group`（`主线`/…），
但 `localStorage['totkmap_task_sel_v1']` 里存的还是旧键 → `isOn()` 全false
→ 五档渲染出来了但一个都没勾 → `render()` 里 `Object.keys(on).length===0` 直接 return
→ **地图上一个点都不画**，看起来像「任务大分类完全不显示」。

**两条铁律**：

1. **换键命名必须做迁移**（`task-panel.js` 的 `LEGACY_CAT_MAP`就是干这个的）
2. **必须有「默认全勾」兜底**——原设计「任务分类默认全开」只存在于老用户的
   localStorage 里，新用户/清缓存/改键名后就全空。默认必须由代码兜住。

### 8.4 ★★ 换键命名要 grep 全部读取点

同一起事故里，我把 `isOn`/`ensureChecked`/`signature`/`statsByLayer` 都改了，
**唯独漏了 `render()` 里真正画点的那行** `if (!on[t.cat]) return` —— 键对不上，
每个任务都被 return 掉。

> ★ **「面板正常 + 地图空」是最难自查的组合**——UI 元素都在、计数也对，只有地图空。
> 数据体检是绿的，验收如果只数「分类数量对不对」也发现不了。
> **所以验收必须断言「行为真的传到地图」**（点数增减）。

### 8.5 `releasePointerCapture` 让点击失效

任务卡片的防具图标**真实鼠标点击**没反应，但 `elementFromPoint` 正常、
`element.click()` 也正常。

根因：`makeDraggable` 的 `end()` 里 `card.releasePointerCapture(pointerId)`
**重定向后续 click 的 target**，原本落在 `<img>` 上的 click 被改派到卡片自己。

修法：`[data-go-armor]` 加进 `makeDraggable.start()` 的排除名单。

> ★ **验收里测「点击」必须用真实鼠标序列**（`p.mouse.move/down/up`），
> **不能用 `element.click()`** —— 后者不派发 `pointerdown`/`mousedown`，
> 直接绕开整条指针事件链，测不出「点了没反应」这类 bug。

### 8.6 定位光圈：Leaflet marker 的 transform 不能碰

Leaflet 用 `transform: translate3d()` **定位** marker。动画里写 `transform: scale()`
会**整个覆盖**它：

```
改前：matrix(1, 0, 0, 1, 600, 450)     ← 定位正常
改后：matrix(1.18, 0, 0, 1.18, 0, 0)   ← 平移被吃掉，图标飞到左上角
```

加上 `.leaflet-marker-icon` 自带 `overflow: clip`（放大必被裁成空白）、
marker 背景透明（`box-shadow` 贴在空气上）。

**✓ 正确做法：独立光圈 DOM** —— 在目标 marker 屏幕位置插一个绝对定位 `div`
（append到地图容器，不动marker 自己）。详见 `TOTKmap防具模块技术说明.md` 第 7 节。

### 8.7 浮点存 localStorage 的层丢失

- 任务完成态：`'{"18":{"主线":true}}'` → `JSON.parse` 回来正常
- 但坐标类浮点（`-212.83`）经 JSON 往返可能有精度损失
- 坐标**不要存 localStorage**，以数据文件为准

### 8.8 缺失的中文名（5 条，登记备查）

| key | 原因 |
|---|---|
| `FindSunaNui2` | ROM 里就没中文名 |
| `Npc_BaseCamp_Assistant_ReactingStatue` ~ `4` | **ROM 内部事件（空壳）** |

后 4 条是**完全空壳**：name = 英文 key 原样 / 无中文名 / 无坐标 / 无攻略 / 无说明。
推断是「雕像感应」类触发器的内部函数名，**玩家无法接取**。
⚠ **这是推断不是权威结论** —— 只能确定它们没有任何信息。老大未定去留。

处理方式：`noPlaceReason` 标注原因，体检 INFO 报告（不算缺陷）。

### 8.9 其他要知道的

- **ROM 内部事件**（`Npc_BaseCamp_Assistant_ReactingStatue{,2,3,4}`）别当任务
- **`(0,0)` 是城堡中心**，不是空值
- **`key=null` 的攻略孤儿条目**（1 条）不能进 `reqs` 反查
- **低置信度的任务-防具匹配宁可不做**（如「卓拉铠甲」撞「卓拉领地的希多」）
- 改 JS 对象字面量时，**改过的行立刻 grep 一次**——重复键不报错、只静默覆盖
- `git add`别整目录 add（曾误提交 119 个 `tools/_*.py` 调试脚本）

---

## 9. 待办 / 已知不足

| 项 | 状态 |
|---|---|
| 「其他」20 条待人工判断 | 老大检查中。4 条 ROM 内部 + 3 条 WANTED（`DefeatHugeEnemy_1/2/3`）+ 13 条 |
| `Connect_FirstIsland`「来自地底的呼唤」 | ROM 标 `ImportantMini`，攻略标迷你挑战。**暂归迷你挑战**（它是台地守护者四前置之一）。老大如认为 ROM 更权威，告知即改 |
| 5 条缺失中文名 | 见 8.8 |
| NPC 中文名 228 条缺失 | ROM 侧没抽 `Npc_*` → 中文名映射 |
| 任务-防具权威映射 | `reqTasks` 靠名字匹配，仅 17 件命中。需从 ROM 挖「任务→掉落物品」 |
| 分类细化 | 已完成迷你挑战单列；剩 20 条待人工判断 |
| `M5.1 完成态上地图` 验收 | 需设 `PROGRESS_SAV` 环境变量才跑 |

---

## 10. 相关文件速查

```
app/data/tasks.js          403 KB  ROM 原始提取（tasks.js 是中间产物）
app/data/task-plan.js537 KB  ★ 唯一数据源（45 字段 × 259 条）
app/data/task-save.js        44 KB  存档变量哈希表（murmurHash3）
app/data/armors.js                  136 件防具（任务卡片的防具区用）
app/data/armor-upgrade.js           强化链（自动生成）

app/js/task/task-data.js   595 行  数据适配层
app/js/task/task-done.js   195 行  完成状态（存档 + 手动）
app/js/task/task-panel.js  422 行  侧栏面板
app/js/task/task-card.js  1186 行  任务卡片
app/js/task/task-flow.js   376 行  流程线/追踪
app/js/app.js                      gotoMarker / gotoArmor / findTaskMarker / #ecLocate
app/js/armor/armor-enhance.js       防具信息（exploreCard 上的区块）

tools/build_task_plan.py            ★ 主生成器（9 阶段报告）
tools/merge_ippyujin.py             重复条目合并
tools/add_kindcn.py                 kindCn 字段
tools/build_task_save.py            存档哈希表
tools/verify/verify-all.js          验收总入口（三层）
tools/verify/verify-data.js         L1 数据体检

TOTKmap防具模块技术说明.md           防具的详细技术文档
TOTK任务存档同步机制-调研结论.md     存档同步机制
TOTK任务数据参考指南.md             数据源说明
V2.1任务板块-规划与架构方案.md        原始规划
进度.md                              全部进度与待办
```

---

## 11. 验收与自查清单（提交前逐条过）

```
□ 改app/ 下的 js/css → bump index.html 的 ?v= 和 sw.js 的 SW_VER
□ 数据改动 → 按build → merge → kindcn 顺序重跑
□ node tools/verify/verify-all.js 全绿
□ git status 确认没误加调试脚本
□ 改键命名 → grep 全部读取点 + 确认 localStorage 迁移 + 默认值兜底
□ 改前端交互 → 验收用真实鼠标序列（p.mouse），不用 element.click()
□ 动 Leaflet marker → 不碰它的 transform
□ 写文档里的数字 → 在浏览器里核一遍（Node 里 eval 顺序不同会读错）
```
