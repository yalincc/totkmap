# TOTKmap V1.1.0 开发计划（TOTKNavi GUI 完整化改版）

> 状态：**方案已确认，实施中**（2026-10-02 用户拍板："先做 v1.1，做完我看看再说"）
> 本文档为 v1.1.0 唯一方案依据；开工后按里程碑推进，关键界面完成先给用户看效果再继续。
> 背景：v1.0.0（秒锁定位 + GUI 独立工程）已发布并推送 tag；v1.1.0 聚焦 GUI 从"工具面板"升级为"完整软件"。

---

## 一、项目基本信息

| 项 | 内容 |
|---|---|
| 项目名称 | TOTKNavi · TOTK 定位导航程序（GUI） |
| 项目位置 | `E:\WorkSpace\TOTKmap` |
| 代码仓库 | GitHub `origin`：git@github.com:yalincc/totkmap.git；gitee：git@gitee.com:yalincc/totkmap.git（master） |
| 当前版本 | **v1.0.0 → 目标 v1.1.0**（GUI tag 前缀 totknavi-） |
| 相关文档 | `进度.md`（交接入口）、`CHANGELOG.md`、`TOTKmap go定位核心重构方案.md`、`TOTKmap V1.9.0开发计划.md`、`E:\WorkSpace\BOTWmap\归档\docs-过程文档-20261002\Xnavi交接文档-20261002-BOTW与TOTK分离及TOTK定位稳定性.md` |
| 协作约定 | 方案先行确认后执行；每完成一阶段（尤其是界面）先给用户看效果再继续；功能改动同步版本号；README 只写功能简介；文档命名 = 项目名+版本+用途 |

## 二、背景与问题

### 2.1 现状架构（代码实证）

```
TOTKNavi-GUI.exe（wails v2.16 + Vue3 + Tailwind，源码 E:\WorkSpace\TOTKmap\xnavi-gui）
├── app.go（457 行）  Wails 后端
│   ├── 管理 core 子进程（StartCore/StopCore）
│   ├── 文件通信：status.json（core 400ms 写）+ 日志增量读（800ms 轮询）
│   ├── 更新检查（totknavi- tag）/ 诊断包导出 / 基准校准
└── App.vue（399 行） 单文件前端，全部界面
    ├── 头部：状态灯 + 设置/地图/关于
    ├── 配置区：模拟器(Cemu/Ryujinx) + 游戏(BOTW/TOTK) 下拉
    ├── 开始/停止 + 存档信息卡（5 类）+ 状态步骤条 + 基准校准 + 日志面板

live-go（xnavi-core.exe）
├── watch.go  单一状态机 5Hz：known 秒锁 / 扫描兜底 / probe 换组 / 传送 / 冻结共识
├── server.go HTTP API：/pos /target /rescan /progress（网页地图消费）
├── monitor.go statusLoop 400ms 写 status.json（含 GUI 套壳兼容字段）
└── progress_totk*.go  存档解析 20 类进度（/progress 现算）
```

- **导航本体 100% 在地图端**（`js/live.js`）：红点/轨迹/引导线/距离/自动切层/到达提示/`?follow=1` 协议，V1.8.0-V1.9.2 已迭代成熟。
- GUI 的角色 = **启动器 + 状态显示**，与网页端双入口独立（GUI 走文件、网页走 HTTP）。

### 2.2 六大痛点（改版依据）

| # | 问题 | 严重度 |
|---|---|---|
| 1 | BOTW/Cemu 残留：模拟器下拉、游戏下拉、关于文案"多游戏定位导航（BOTW + TOTK × Cemu + Ryujinx）" | 中 |
| 2 | 单页平铺：配置/按钮/存档/状态/校准/日志全挤首屏，不像完整软件 | 中 |
| 3 | 导航功能没有 GUI 入口（目标状态/清除）——引擎有 /target，界面无 | 高 |
| 4 | 状态靠解析日志文本（parseState 正则），非结构化（status.json 已有 pos/source/verified） | 中 |
| 5 | eventBridge 800ms 刷新延迟；日志无过滤/搜索 | 低 |
| 6 | 存档信息卡只有 5 类（神庙/鸟望台/呀哈哈/龙之泪/树根），引擎现算 20 类 | 低 |

## 三、目标

1. GUI 升级为**完整软件**：侧边栏多页信息架构（实时定位 / 导航目标 / 存档进度 / 设置）。
2. **砍掉 BOTW/Cemu** 界面选项，TOTK 独立干净（引擎 core 保留兼容，界面聚焦 Ryujinx+TOTK）。
3. **导航目标联动**：GUI ↔ core ↔ 地图双向同步（目标状态显示、清除目标、打开地图导航）。
4. 存档进度完整页：全 20 类展示 + 探索度总览。
5. 体验优化：刷新率、日志过滤/搜索、窗口自适应。

## 四、已确认决策（用户拍板 2026-10-02）

| # | 决策 |
|---|---|
| 1 | v1.1.0 完整做（用户："先做 v1.1，做完我看看再说"），关键界面完成先给用户看效果 |
| 2 | 砍 BOTW/Cemu 界面选项，只做 Ryujinx + TOTK |
| 3 | 导航本体在地图端，GUI 只做 3 个小功能：打开地图导航入口、目标状态显示、清除目标 |
| 4 | 清除目标**双向同步**：GUI 点清除 → 写 nav-clear.json → core 清 target → 地图 /pos 读到 null 引导线消失；地图清除 → POST /target clear → core 清 → GUI status.json 同步显示"无目标" |
| 5 | 自动启动不做（保持手动点"开始定位"），秒锁能力已由 known 快路径保证 |

## 五、详细设计

### M1 架构重排（侧边栏 + 去 BOTW/Cemu + 拆组件）

**前端拆组件**（`xnavi-gui/frontend/src/`）：

```
src/
├── App.vue                壳：侧边栏 + 视图切换 + 头部状态灯
├── composables/useCore.js 共享状态（coreStatus/logs/progress/target/env/cfg）+ 全部 Wails 调用
├── views/
│   ├── LocateView.vue     实时定位：状态卡 + 步骤条 + 日志面板
│   ├── NavView.vue        导航目标：当前目标/距离/层 + 清除 + 打开地图导航
│   ├── ProgressView.vue   存档进度：全 20 类进度条 + 保存信息
│   └── SettingsView.vue   设置：Ryujinx 路径 + 存档路径（去 Cemu）
└── components/
    ├── SideNav.vue
    ├── StatusCard.vue
    └── LogPanel.vue
```

**去 BOTW/Cemu（app.go）**：
- `Config` 精简：`{ RyujinxDir, SaveDir }`（删 CemuDir/Emulator/Game；旧 config json 多余字段 Unmarshal 自动忽略，兼容）
- `StartCore` 固定 `--emu=ryujinx --game=totk --no-open` + 可选 `--ryujinx-dir/--save-dir`
- `EnvDetect` 只查 ryujinx；`ExportDiagnostics` 去 Cemu 字段；`checkUpdate` 不变

**App.vue 对应**：删模拟器/游戏下拉（固定显示 Ryujinx + 王国之泪）、关于文案 TOTK 版、mapUrl 固定 totk。

### M2 定位体验（状态卡 + 结构化状态）

- 状态卡：游戏坐标（gx/gy/gz）+ 地图坐标（mx/my）、层名（18 地上/19 地下/20 天空）、锁定来源（known=秒锁 / scan / probe / consensus）、verified 状态灯、copies。
- 状态源从 **status.json 结构化字段**（pos/source/verified/copies/ageSec）驱动，不再靠日志正则 parseState。
- 步骤条保留（就绪→定位→验证→锁定），映射改为结构化判断。
- 锁定方式高亮：source=known 显示"⚡ 秒锁"。

### M3 导航模块（3 个小功能）

| # | 功能 | 实现 |
|---|---|---|
| 1 | 打开地图导航 | 现有 `?follow=1&game=totk` 协议（buildMapUrl 固定 totk），入口移入导航页并强化文案 |
| 2 | 目标状态显示 | monitor.go statusLoop 补 `target` 字段（getTarget() 已有，抄 5 行）→ GUI 显示目标名/距离/层 |
| 3 | 清除目标 | GUI 写 `nav-clear.json`（文件通信，双入口原则）→ core 新 goroutine `navClearLoop()` 消费 → `clearTarget()` → 删文件；地图下一轮 /pos 读到 target=null 引导线消失 |

**双向同步不变式**：core 是唯一状态持有者，GUI 与地图都经它读写，天然一致。

### M4 存档进度完整页

- monitor.go 的 progress 映射从 5 类扩展为 **20 类**（progress_totk2.go progressCounts 全部 key：鸟望台/龙之泪/神庙/树根/克洛格/双倍克洛格/魔犹伊遗失物/残旧的地图/贤者的遗志/设计图石板/卡邦达立牌/独眼巨人/岩石巨人/莫尔德拉吉克/方块魔像/巨霸伽马/古栗欧克/地洞入口/洞穴入口/井）。
- 前端 ProgressView：分类卡片 + 进度条 + done/total；顶部显示存档路径 + 探索度总览（可算完成率）。
- 注意：status.json progress 目前只有 5 个 key 前端必读；扩展后前端按新结构渲染，旧的兼容判断去掉。

### M5 设置与体验

- `eventBridge` 800ms → 300ms（app.go，一行）。
- 日志面板加过滤框（关键字过滤）+ 现有清屏/导出/打开目录保留。
- 窗口：检查 wails.json / main.go 窗口尺寸与最小尺寸（自适应）。
- 设置页整理（去 Cemu，剩 Ryujinx 路径 + 存档路径 + 关于/更新入口）。

### M6 收尾发布

- 版本号同步：app.go `guiVersion` v1.1.0 + App.vue ver（构建时从 Version() 读，前端常量同步）。
- README 功能简介更新（只写功能）；CHANGELOG 加 v1.1.0 条目；进度.md 状态更新。
- 构建：`go build -ldflags "-s -w"` → xnavi-core.exe；`wails build` → TOTKNavi-GUI.exe。
- release：`release\TOTKNavi-v1.1.0\`（两 exe + 使用说明.md，参照 v1.0.0）。
- git：分里程碑 commit（中文信息走 UTF-8 文件 + `git commit -F`），M6 完成后 commit + tag `totknavi-v1.1.0` → 用户看效果确认后 push 双远程。

## 六、里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 本计划文档 + 确认 | ✅ 用户已拍板 v1.1 全量做 |
| M1 | 架构重排：侧边栏 + 去 BOTW/Cemu + 拆组件 | 编译通过 + **给用户看界面效果** |
| M2 | 定位体验：状态卡 + 结构化状态 | 秒锁/扫描/锁定状态正确显示 |
| M3 | 导航模块：目标状态 + 清除 + 打开地图 | GUI↔地图双向同步实测 |
| M4 | 存档进度完整页（20 类） | 对照游戏存档数字正确 |
| M5 | 设置与体验优化 | 刷新 300ms、日志过滤、窗口正常 |
| M6 | 收尾发布 v1.1.0 | exe 冒烟通过 + release + commit/tag |

> 节奏：M1+M2 完成后先给用户看界面效果并确认，再继续 M3-M6；每步编译验证，坏的不留。

## 七、风险与开放问题

- **拆组件风险**：wails 前端 vite 构建错误 / 样式丢失 → 每步 `wails build` 验证 + 界面截图核验；组件间状态用 composable 统一管理，不散 props。
- **status.json progress 全量扩展**：旧版 GUI 与新 core 混用会缺 key 渲染报错 → 发布时 GUI+core 同包更新（live-gui 四件套），release 目录两 exe 同步。
- **nav-clear.json 与 server /target clear 并发**：core 内统一 `clearTarget()`（已有锁），无竞争。
- **wails build 环境**：PATH 前置 `D:\tools\go\gopath\bin`（wails v2.16.0 已装，勿重装）。
- **网页端无需改动**：live.js 已支持 `?follow=1&game=totk`；status.json target 字段对网页无影响。
