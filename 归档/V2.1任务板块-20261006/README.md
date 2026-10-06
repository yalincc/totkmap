# V2.1 任务板块 —— 完整归档（截至 M5）

> 归档日期：2026-10-06 · 对应提交 `1e187bf5 feat(V2.1M5)`
> 覆盖范围：M0（数据提取）→ M5（存档同步打通）全部产出
> 用途：任务板块后续迭代（完成态上地图、任务链、依赖图）的完整基线快照

---

## 一、这个板块现在是什么

一个**完全独立**的可插拔模块。核心价值：**要下线只需删 `app/index.html` 里 5 行 `<script>`，
界面完全回到 V2.0 状态**，不触碰任何既有代码。

```
app/data/task-plan.js      260→259 条任务（清洗后的展示层，脚本生成，勿手改）
app/data/task-save.js      285 条任务的存档变量表（脚本生成，勿手改）
app/js/task/task-data.js   数据适配层（tasks.js + task-plan.js 合并、分类、统计）
app/js/task/task-panel.js  侧栏面板 + 地图任务点绘制
app/js/task/task-card.js   任务卡片（可拖动 + 完成态 + 任务原文折叠）
app/js/task/task-flow.js   流程线（多点/单点/列表三档 + 追踪模式）
app/js/task/task-done.js   完成态管理层（存档态 + localStorage 手动态合并）
```

依赖前提：`task-*.js` 必须在 `app.js` 之后加载（要用 `window.TOTK` / `TOTK_APP`）。

---

## 二、数据口径（改动前必须知道）

| 项 | 数值 | 说明 |
|---|---|---|
| `tasks.js` 原始条目 | 286 | ROM `Quest` BGYML + 玩家攻略 `markers.js` 合并 |
| 排除小游戏 | −26 | 小游戏不进任务板块，留在原地点分类 |
| `task-plan.js` 最终 | **259** | 合并「一发入魂」重复条目后 |
| `key = null` | **0** | 全部任务都能从存档同步完成状态 |
| 可上图 | 254 | 地上 236 / 天空 15 / 地下 3 |
| 流程档位 | L1 74 / L2 178 / L3 8 | L1=多点可画线 L2=单点 L3=仅列表 |
| 官方分步 | 1077 → 463 | ROM `Steps` 是事件触发器数组，600 条空壳已清 |

**坐标铁律**（搞错就是点位乱飞）：
```
mapX = gz
mapY = gx
Leaflet 坐标 = [gz, gx]← 注意经纬顺序是反的
```

---

## 三、存档同步机制（本板块最硬的成果，已用真存档实测）

**不需要新解析器**——任务进度就存在神庙/克洛格那张 hash 表里（30700 条）。

```
键 = murmurHash3("Step_" + 任务key)
值 = 当前阶段名的哈希，末项固定 Complete（0x4c0a63f4，全局唯一）
→ 完成判定就一句：val === hash('Complete')
```

- 枚举来源：`marcrobledo/savegame-editors` 的 `zelda-totk.hashes.csv`，
  `EnumValues;Step_*;<阶段列表>` 行，共 596 条，与 `tasks.js` 相交取 285 条。
- 验证方式：真实 `progress.sav`（Ryujinx，2307656 字节 v1.1.x）+ 神庙/鸟望台数交叉印证。
- Python 与 JS 两套实现输出**完全一致**（`tools/check_server.py` 对账）。

---

## 四、三个必须知道的坑（改代码前看）

### 1. `status()` 的 `src` 语义
`TaskDone.status(key)` 对**任何出现在存档里的任务**都返回 `src='save'`，
**包括未完成的** —— 语义是「读到存档数据了」而不是「存档说它完成了」。

```js
//✅ 判「存档已完成」必须同时判两个条件
if (st.done && st.src === 'save') { /* 不可取消 */ }
// ❌ 只判 src === 'save' → 259 个任务全显示「已完成✓」且按钮全灰
```

### 2. 没有 `render()` 函数
`task-card.js` 只有 `open` / `close`，就地重绘要用自己加的 `redraw()`。
调不存在的函数 → 控制台 PAGEERROR + 点了没反应。

### 3. 改超大数据 JS 文件的铁律
`tasks.js`(400KB) / `task-plan.js`(530KB) 这种紧凑 JSON：

- ❌ **绝对不要 `json.loads` + `json.dumps` 重写**。实测踩过两次：
  ① `io.open(...,'w')` 默认把 CRLF 改成 LF → 整个文件 diff 没法看
  ② 截header 时把 `window.TOTK_TASKS=` 变量名丢了 → 文件彻底报废（靠 git 恢复）
- ✅ 正确做法：`io.open(path, encoding='utf-8', newline='')` 读写
  + 字符串定点替换（`'"name":"XXX"' in txt` → `.replace(..., 1)`）。
  先 `cp` 备份 + `--dry` 参数双保险。

---

## 五、目录内容

```
V2.1任务板块-20261006/
├── tasks.js          数据快照（tasks.js 286 条，勿手改）
├── task-plan.js      展示层快照（259 条，勿手改）
├── task-save.js      存档变量表快照（勿手改）
├── catalogs.js       分类定义快照（含 groupCn，修复 156 个标题错位）
├── task-panel.js     面板快照（M5.1 完成态版）
├── 数据脚本/          14 个可重跑脚本，按执行顺序：
│   extract_quests.py     ROM 提取 → tasks_raw.json
│   fix_guide_fields.py   修攻略字段误解析
│   clean_steps.py        清官方 Steps（空壳/重复/控制字符/动态占位符）
│   build_task_plan.py    → task-plan.js
│   build_task_save.py    → task-save.js（需 hashes.csv）
│   patch_tasks.py        定点修补 tasks.js（--dry 支持）
│   merge_ippyujin.py     合并「一发入魂」重复条目
│   add_kindcn.py         生成 kindCn 任务性质分类
│   probe_quest.py/2.py   存档机制探测（探路用，结论已固化）
│   verify_task_save.py   完成判定验证
│   cross_check.py        神庙数交叉印证
│   check_server.py       Python/JS 双实现对账
│   task-done-map.js      真浏览器验收：完成态上地图（M5.1，8 组断言）
└── 过程文档/
    ├── V2.1任务板块-规划与架构方案.md
    ├── V2.1技术方案-隐患与关键技术.md
    ├── TOTK任务数据参考指南.md
    ├── TOTK任务存档同步机制-调研结论.md   ← 存档机制完整调研，其他 AI 接手看这份
    ├── 进度.md                             （含 V2.1 状态段）
    └── CHANGELOG.md                         （含 V2.1 完整记录 + 踩坑）
```

> **根目录那几个 `.js` 快照不入 git**（`.gitignore` 已排除）——
> 它们与 `app/data/`、`app/js/task/` 下的同名文件逐字节相同，git 里已有，
> 重复入库只是让仓库胖 1MB。快照只留本地做基线参照，**别以为丢了**。

---

## 六、后续可做（截至归档时未做）

1. ~~完成态上地图~~ ✅ **已做（V2.1M5.1）**：`taskIconDot()` 加 `is-done` 分支
   （右上角 ✓ + `opacity:.42` + 去饱和），tooltip 加 ✓ 前缀。
   重绘靠把 `doneRev` 混进 `signature()` —— 面板已有 150ms 轮询，
   **不要**在 `onChange` 里直接调 `render()`（存档加载时连续 notify 十几次会卡）。
2. 任务链 / 依赖图可视化（`reqs` 字段数据已就绪，未做图）。
3. `task-save.js` 285 条vs plan 层 259 条，差26 条是被排除的小游戏，属正常。
