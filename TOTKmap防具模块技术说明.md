# TOTKmap 防具模块技术说明（V2.1 M6.5–M6.8）

> 归档时间：2026-10-06 晚 · 涉及提交：`87caf2d6` → `13c45e7e` → `7905f799` → `5ef78766` → `a2b9e9b0` → `4dc034fa` → `3ace0395`
> 覆盖文件：`app/js/armor/armor-enhance.js`、`app/data/armors.js`、`app/data/armor-upgrade.js`、`tools/build_armor_upgrade.py`、`tools/verify/verify-armor-*.js`
> 一句话：**防具信息不另开面板、不另做卡片，全部长在现有探索卡片（`#exploreCard`）上。**

---

## 0. 这份文档是干什么的

记录防具模块的**数据来源、口径、踩过的坑、以及以后改代码前必须知道的事**。

**不是**使用说明（那个在 `README.md`），**不是**任务板块文档（那个在 `V2.1任务板块-规划与架构方案.md`）。

| 谁 | 负责 |
|---|---|
| 资料侧 | 数据挖掘、口径对齐、生成脚本 —— 第 1–3 节 |
| 地图侧 | 渲染、交互、联动 —— 第 4–6 节 |
| 改代码前 | **必读**第 7 节（三次返工的教训） |

---

## 1. ★ 命名：为什么叫「防具」不叫「装备」

> **防具是唯一不会损坏的装备。武器和盾牌用久了会坏。**

这不是随手起的分类名，是游戏机制的根本区别。所以：

- 侧栏 / 卡片 / 分类 / 变量名统一用「防具」（`armor`）
- 即使 `totk-site` 那边数据叫 `cat: "Armor"`、未来可能收录武器盾牌，也**不要**改叫「装备」

---

## 2. ★ 数据来源：三份文件，两个外部依赖

### 2.1 仓库内的数据

| 文件 | 内容 | 规模 |
|---|---|---|
| `app/data/armors.js` | **结构化防具**：`window.TOTK_ARMORS`，34 字段 | 136 条（只含 `rank=1` 基装） |
| `app/data/armor-upgrade.js` | 强化链：每级防御 / 星星数 / 材料 | 137 条（自动生成） |
| `app/data/catalogs.js` | 分类表，含「防具」4 个 + 「防具店」3 个 | — |
| `app/data/markers.js` | 地图标点，含防具的 120 条 | 3183 条总量 |

### 2.2 外部依赖（生成脚本的上游）

`E:/WorkSpace/BOTWroms/totk-site/public/data/`

| 文件 | 内容 | 为什么需要 |
|---|---|---|
| `items.json` | 553 条 `cat: "Armor"` | 强化链的 `next` 全在这里 |
| `enhancement.json` | 每级材料 + 星星数 | 本地完全没有 |
| `icons/armor/` | 557 张图标 | 本地只抽了 136 张 |

`totk-site` 不在本仓库里，属于**外部只读依赖**。跑生成脚本前请确认该路径存在。

### 2.3 生成脚本

```bash
python tools/build_armor_upgrade.py --dry    # 只看统计
python tools/build_armor_upgrade.py --write  # 写出 app/data/armor-upgrade.js
```

脚本顶部有完整注释。它会过滤 `_B` 结尾的备用款（游戏里同名不同来源的两件，独立一件，不混进主链）。

---

## 3. ★★ 核心口径：防具是两套**互补**数据，不是一套

这是整个模块最需要理解的一点。

| 来源 | 提供什么 | 有/无 |
|---|---|---|
| `armors.js`（136 条） | 官方名 / 防御 / 买价 / 部位 / 套装 / 图标 / 图层 / **商店坐标** | ✅ 有坐标 |
| `markers.js` 里防具标点（120 条） | 中文名 / **攻略原文**（"从魔人像处兑换，需要通过解锁地魔人石像"）/ 坐标 | ✅ 有说明 |

**按中文名一对一：101 件对上，35 件对不上。**

那 35 件**全是 `how === "商店购买"`**。原因：卖防具的店不需要逐件标点，地图上是**一个「防具店」标点代表一整家店**（实测 6 个店）。

> **结论：`armors.js` 说「这防具是什么」，地图标点说「哪来的」。合起来才是一件完整信息。**

### 3.1 标点 → 防具的三级匹配

`ArmorEnhance.match(ptName)` 逐级放宽：

| 级 | 判据 | 命中示例 |
|---|---|---|
| ① 名字全等 | `BY_NAME[n]` | 鬼神服 |
| ② 套装名相等 | `BY_SET[n]` | 暗黑套装 |
| ③ 去后缀再比 | 剥掉「套装/铠甲/之铠/之服/礼装/便服/和服」 | 海利亚套装、卓拉铠甲 |
| 兜底 | 名字包含套装名 | 神兽兵装·鲁达尼亚 |

**实测 120 个防具标点：101 单件 / 10 套装统称 / 9 无匹配。**

9 个无匹配里 6 个是「防具店」（本来就不是某一件防具），另 3 个是名字带特殊字符的。这是**预期行为，不是 bug**。

### 3.2 三种卡片形态

| 形态 | 触发 | 渲染 |
|---|---|---|
| **单件** | `match` 命中且有 `armor` | 图标+部位套装 / 防御(带满级箭头) / 售价回收 / 强化摘要 / 去哪买 / 同套部件 / 关联任务 / 说明 |
| **套装统称** | `match` 命中但无 `armor`（`mode: "set"`） | 标题「套装 · N 件」+ 成员图标横排 |
| **商店** | `cat === 防具店` | 标题「店内防具」+ 可买清单（图标+名字+价格） |

非防具标点 → `#ecArmor` 为空 → CSS `:empty { display: none }` 不占位。

---

## 4. ★ 强化数据：不能用 `armors.js` 的 `next` 自己推导

### 4.1 那个坑

`armors.js` **只收录 `rank=1` 的基装**。`next` 指向的 `Armor_002_*` 等升级条目**根本不在本地数据里**：

```
实测 104/136 条的 next 目标不存在 → 自己遍历的结果是「每件都只有 1 级」
→ upgradeable 数 = 0，且看起来「跑通了」
```

**这是最阴的一种错**——代码不报错、数字为 0、但结论完全错。

### 4.2 正确做法

用 `tools/build_armor_upgrade.py` 从 `totk-site` 的两个源合并：

```
items.json（next 串链）+ enhancement.json（材料/星星）
        ↓
app/data/armor-upgrade.js   { key: { zh, slot, steps: [{lv, zh, def, stars, mats}] } }
        ↓
ArmorEnhance.upgradeOf(key) 直接读，不自己算
```

**实测结果：104 套可强化到 5 级，33 套不可强化。**

| 级 | 防御 | 星星 | 材料 |
|---|---|---|---|
| L1 | 3 | 10 | 波克布林的犄角×5 |
| L2 | 5 | 50 | 蓝色波克布林的犄角×5、波克布林的牙齿×3 |
| L3 | 8 | 200 | 黑色波克布林的犄角×5、波克布林的肝脏×3、琥珀×20 |
| L4 | 12 | 500 | 白银波克布林的犄角×5、波克布林的肝脏×5、琥珀×30 |
| L5 | 20 | **源数据无** | 无 |

> **L5 的 `stars` 源数据为 `null`，卡片照实显示「（星星数未收录）」，不编造。**

### 4.4 ★ `upgradeOf()` 收的是**对象**，不是 key 字符串

```js
ArmorEnhance.upgradeOf(armor)     // ✅ armor = {key:'Armor_001_Upper', ...}
ArmorEnhance.upgradeOf('Armor_001_Upper')   // ❌ 静默返回空
```

传字符串时 `UPGRADE[a.key]` → `UPGRADE[undefined]` → 返回 `{steps:[]}`，**不报错**。

**症状极其难辨**：强化数据在（137 条）、`stats` 也对，唯独所有防具都显示"不可强化"。
（我核对文档数字时就是这么误判"强化功能坏了"的。）

现已加 `console.warn` 显式拦截。改这块代码时传对象。

### 4.5 「套装数」有两个口径，别混

| 口径 | 数值 | 用途 |
|---|---|---|
| **`setId` 去重** | **67** | 真实套装数（海利亚套装有 `Armor_001` 与 `Armor_005` 两个 ID） |
| 套装**名**去重 | 64 | 只用于按名字匹配地图标点（`BY_SET`） |

`stats().套装数` 走 `setId`。用套装名去重会漏算 3 个。

### 4.3 卡片上只给摘要

老大要求「强化文字太多，可链接到 totk-site」。所以卡片**不铺 5 级材料表**，只给：

```
强化    可升至 5 级（防御 3 → 20）  满级需 白银波克布林的犄角×5、波克布林的肝脏×5
```

图鉴外链位置已留（`.ae-comp-slot`，**当前留空不实现**，等发话）。

---

## 5. 商店防具聚合

### 5.1 判据：坐标，不是 `desc`

**不要按 `desc` 解析商品清单。** 实测 6 个店里只有 3 个 `desc` 写了清单，卡卡利科那家明明卖潜行 + 夜光六件却是空的。**`desc` 不可靠，坐标可靠。**

### 5.2 三条规则

| 规则 | 理由 |
|---|---|
| 按坐标就近归店，**阈值 200 单位** | 再远玩家白跑路 |
| **超阈值不硬塞** | 4 个怪物面罩距最近店 2063 单位（它们在**怪物商人**手里）。宁可少给不错给 |
| **已有逐件标点的不塞** | 格鲁德小镇那 11 件（热沙/珠宝/靴子）本就有图标，塞进去重复 |

实测：19 件待聚合 → **15 件归入 5 家店**（利特村 3 / 鼓隆桥 3 / 监视堡垒 3 / 卡卡利科 6 / 卡拉卡拉 1），4 件怪物面罩不归店。

---

## 6. 交互与联动

### 6.1 三个入口都走 `gotoMarker`

```
① 防具卡「同套部件」   → gotoArmor(key)      → gotoMarker(pt) + openDetail(pt)
② 防具卡「关联任务」   → findTaskMarker(t)   → gotoMarker(pt) + TaskCard.open(t)
③ 防具卡「去哪买」     → gotoMarker(shopPt)  + openDetail(shopPt)
④ 任务卡「防具图标」   → gotoArmor(key)
⑤ 探索卡「坐标旁定位针」→ gotoMarker({id,cat,layer,x,y,name})
```

`gotoMarker(m)` 完整流程：**切层 → 勾分类 → flyTo → 等 `moveend` → 金色光圈**。

### 6.2 三个必须知道的坑

**① marker 只在被勾选时才画**

`renderMarkers` 里 `if (!state.selected[m.cat]) return`。直接 `flyTo` 会飞到**一片空白**。所以 `gotoMarker` 先自动勾上目标分类。

**② 顺序要紧：先切层，再勾分类**

`state.selected` 是 `selectedByLayer[当前层]` 的**引用**，切层会把它换成新层的对象——先勾后切等于白勾。

**③ 任务点挂在攻略分类下，不叫「任务」**

实测「拉姆达的财宝」标点 `cat=185「迷你挑战」`。按分类名找必然落空。`findTaskMarker` 用「同图层 + 同坐标 + 同名」，退到坐标邻近 ±2。

### 6.3 定位按钮 vs 导航按钮

**语义不同，别混淆**（已写进 `app/css/style.css` 注释）：

| | 干什么 | 依赖 |
|---|---|---|
| **导航**（底部） | 交给 xnavi 引导玩家在**游戏里**走过去 | 要 `live-python` 在跑 |
| **定位**（坐标旁小图标） | 只把**网页地图视角**移回该点 | 纯前端 `flyTo` |

定位按钮补上了 `gotoArmor` 的缺口：19 件商店防具挂在「防具店」一个标点下、任务点挂在别的分类下——这些按名字找不到自己的标点，只弹 toast 飞不过去。有坐标就能飞。

无坐标的标点自动隐藏该按钮（`display: none`，不占位）。

---

## 7. ★★★ 三次返工的教训（改代码前必读）

这三版都失败了，全是**实测**出来的，已写进 `app/css/style.css` 的注释里。

### 7.1 ✗ 不能用 `transform` 做 marker 动画

Leaflet 用 `transform: translate3d()` **定位** marker。动画关键帧里的 `scale()` 会**整个覆盖**它：

```
改前：matrix(1, 0, 0, 1, 600, 450)     ← 定位正常（视口中心）
改后：matrix(1.18, 0, 0, 1.18, 0, 0)   ← 平移量被吃掉，图标飞到左上角
```

> **Leaflet marker 的 `transform` 是定位通道，不是动画通道。**

### 7.2 ✗ 不能放大 marker

- marker 元素**本身就是 `<img>`**（`L.icon` 生成），不是「`div > img`」结构 → `.xxx img` 选不到它
- `.leaflet-marker-icon` 自带 **`overflow: clip`**（实测）→ 任何 `scale` 放大都被裁成**空白图标**

### 7.3 ✗ `box-shadow` 打不亮 marker

marker 背景是 `background-color: rgba(0,0,0,0)` + `background-image: none`。`box-shadow` 贴在**透明元素的外框**上，看不到光。

### 7.4 ✓ 最终方案：独立光圈 DOM

在目标 marker 的屏幕位置插一个绝对定位 `div`（`append` 到地图容器，**不动 marker 自己**）：

- 双层圆环（内环实 + 外环柔）+ 金色 `drop-shadow`
- `z-index: 940`，压过 `leaflet-marker-pane`(600)
- 脉冲 2 次 × 1.1s → **换静态环再留 3 秒**（动画一停玩家就不知道哪个是目标）
- marker 本体另加 `.mk-locate-target`（`filter: drop-shadow + brightness(1.25)`）
- 光圈定位必须在 `append` **之前**算好 `left/top`（append 后进入动画态会偏移半个身位）

### 7.5 ✓ 还需挪开卡片

`flyTo` 把目标放在**视口中心**，而 `positionExploreCard` 也定位视口中部 —— 两者 100% 重叠。实测 `elementFromPoint(图标中心)` 返回 `DIV.ec-card`。

`moveCardAside(rect)` 检测重叠（`pad=52`）后把卡片推到目标另一侧。`gotoArmor` 顺序也改成**先 `openDetail` 后 `gotoMarker`**（反过来会被 `positionExploreCard` 推回中间）。

### 7.6 ✗ 另一个坑：`releasePointerCapture` 让点击失效

任务卡片防具图标**真实鼠标点击**没反应，但 `elementFromPoint` 正常、`element.click()` 也正常。

根因：`makeDraggable` 的 `end()` 里 `card.releasePointerCapture(pointerId)` **重定向后续 click 的 target**，原本落在 `<img>` 上的 click 被改派到卡片自己。

修法：`[data-go-armor]` 加进 `makeDraggable.start()` 的排除名单。

> **验收里测「点击某元素」必须用真实鼠标序列（`p.mouse.move/down/up`），
> 不能用 `element.click()`** —— 后者不派发 `pointerdown`/`mousedown`，
> 直接绕开整条指针事件链，测不出「点了没反应」这类 bug。

---

## 8. 验收

```bash
node tools/verify/verify-all.js
```

防具相关的两套：

| 脚本 | 覆盖 |
|---|---|
| `verify-armor-enhance.js` | 三级匹配 / 两种卡片形态 / 非防具不占位 / 关联任务 / 同套跳转 / 任务卡片联动 |
| `verify-armor-locate.js` | `gotoMarker` 地图真的动 / 自动勾选 / **光圈时序（等 moveend）** / 商店清单 / 归店阈值 |
| `verify-locate-btn.js` | 坐标旁定位按钮 / 无坐标隐藏 / 神庙等非防具可用 / **真实鼠标点击回归** / 拖动回归 |
| `verify-armor-drop.js` | 任务卡片防具区（注意：套装名里有「›」按钮，断言要剥掉） |

**改动防具代码后至少跑这四个。**

---

## 9. 待办 / 已知不足

| 项 | 状态 |
|---|---|
| 图鉴外链跳转 | 位置已留 `.ae-comp-slot`，**当前留空不实现**（老大发话再做） |
| 强化 L5 星星数 | 源数据为 `null`，**照实留空不编造** |
| `reqTasks` 准确度 | 靠名字匹配，**仅 17 件命中**。权威映射需从 ROM 挖「任务 → 掉落物品」 |
| 防具完成态 | **没有**「已获得」标记机制（任务有 `progress.sav`，防具没有对应数据） |
| 4 个怪物面罩 | 不归防具店（距 2063），靠「怪物面具」标点覆盖 |
| 3 个无匹配标点 | 名字带特殊字符，预期行为 |

---

## 10. 相关文件速查

```
app/data/armors.js               136 条结构化防具（基装）
app/data/armor-upgrade.js        强化链（自动生成，勿手改）
app/js/armor/armor-enhance.js    ★ 核心：三级匹配 / 商店聚合 / 强化 / 卡片 HTML
app/js/app.js                    gotoMarker / moveCardAside / bindArmorEnhance / #ecLocate
app/js/task/task-card.js         任务卡片的防具区（data-go-armor）
app/css/style.css                .ae* 防具区块 / .mk-locate-ring 光圈 / .ec-locate 定位针
tools/build_armor_upgrade.py     强化数据生成器
tools/verify/verify-armor-*.js   验收
```
