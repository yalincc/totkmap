# 龙轨迹 ROM 数据整理（官方轨道提取）

> 整理时间：2026-10-05 · 数据源：`G:\YUZU\Switch Games\TOTKroms`（TOTK 完整解包 ROMFS）
> 目标：把游戏里四条龙的**官方飞行轨道**从 ROM 中提取出来，替换地图现有的社区近似数据

---

## 一、结论：ROM 里确实有精确的龙轨迹数据

之前 `app/data/dragon_paths.js` 用的是社区手工近似数据（文件里自己注明"走向准确、非精确飞行线"）——
14 个点标出沿途的塔，然后用直线连接。

**ROM 里有真正的官方轨道**：三次贝塞尔曲线、控制柄、弧长、轨道连接关系全都有，共 **8 条轨道 / 131 个原始控制点**。

| 轨道内部名 | 归属龙 | 原始点 | 采样点 | 全长 | 飞行高度 Y | 闭合 |
|---|---|---|---|---|---|---|
| `Low_Rail_For_Dragon_Light` | 白龙 | 26 | 568 | 33.3 km | 700~1000 | 是 |
| `High_Rail_For_Dragon_Light` | 白龙 | 26 | 577 | 33.8 km | 1600~2370 | 是 |
| `Low_Rail_For_Dragon_Light_Inter` | 白龙 | 3 | 28 | 1.6 km | 600~800 | 否 |
| `High_Rail_For_Dragon_Light_Inter` | 白龙 | 3 | 40 | 2.3 km | 600~1600 | 否 |
| `First_Island_Rail_For_Dragon_Light` | 白龙 | 4 | 36 | 2.0 km | 1800 | 是 |
| `Rail_For_Dragon_Fire` | 奥尔龙 | 31 | 256 | 14.3 km | **-552**~830 | 是 |
| `Rail_For_Dragon_Ice` | 费罗龙 | 17 | 151 | 8.6 km | **-440**~700 | 是 |
| `Rail_For_Dragon_Electric` | 聂尔龙 | 21 | 186 | 10.4 km | **-441**~550 | 是 |

关键发现：

1. **白龙有两条同走向的轨道** —— 高空线与低空线都绕全图一圈（33.8km / 33.3km），这就是"白龙绕全图大圈"的官方依据。
2. **白龙不是一条线，是 5 条** —— 主环线 ×2（高/低空）+ 2 条联络轨（`Connections` 字段明确指向主环线第 0 点和第 11 点）+ 1 条初岛支线。
3. **三元素龙的 Y 坐标出现负值** —— 奥尔龙最低 -552m、费罗龙 -440m、聂尔龙 -441m。这说明**地表与地底是同一条闭合环线**，龙在地下段是潜入的。之前地图把"地上实线 / 地下虚线"当成两条不同轨迹处理，其实是一条线的不同部分。
4. **龙的起点坐标直接写在 Actors 里** —— `Enemy_Dragon_Fire` 在 (4032, -2181, -350)，`Enemy_Dragon_Ice` 在 (3600, 1345, -300)，`Enemy_Dragon_Light_001` 在 (150, 350, 1700)。

---

## 二、数据源文件清单

| 文件（相对 ROM 根目录） | 内容 | 压缩方式 |
|---|---|---|
| `Banc/MainField/DeepHole/Set_DragonRail_Static.bcett.byml.zs` | **主数据**：8 条龙轨道 + 5 个龙 Actor | zstd + BCETT 字典 |
| `Scene/Component/DragonMgrParam/Default.game__scene__DragonMgrParam.bgyml` | 龙行为参数（角速度/滚转/重算间隔） | 未压缩 BGYML |
| `Banc/MainField/LargeDungeon/Set_DragonBattleAndZeldaCatch_Static.bcett.byml.zs` | 龙战（涡旋挑战）螺旋轨 + 27 个相关 Actor | zstd + BCETT 字典 |

参考（未使用）：`Phive/StaticCompoundBody/MainField/DeepHole/Set_DragonRail.Nin_NX_NVN.bphsc.zs`（物理碰撞体）

---

## 三、解压方法（踩坑记录）

`.zs` 后缀文件是 **zstd 压缩 + ROM 自带字典**，直接用标准 zstd 解压会报 `Dictionary mismatch`。

字典位置：`Pack/ZsDic.pack.zs` 解压后的 **偏移 0x20088，长度 0x20000（131072 字节）**。

```python
import zstandard as zstd

d = open(r'ROM\Pack\ZsDic.pack.zs', 'rb').read()
raw = zstd.ZstdDecompressor().decompress(d, max_output_size=64*1024*1024)
dic = raw[0x20088:0x20088 + 0x20000]
dec = zstd.ZstdDecompressor(dict_data=zstd.ZstdCompressionDict(dic))

# 再解压 .bcett.byml.zs
raw_banc = dec.decompress(open(banc_path, 'rb').read(), max_output_size=32*1024*1024)
root = byml.Byml(raw_banc).parse()   # 需 pylibs 的 byml
```

环境备注：本机 `zstandard` + `byml` 都装在 `C:\Users\Administrator\.workbuddy\binaries\python\envs\default`，
`byml` 需要手动 `sys.path.append(r'D:\dev\pylibs')`（该目录的 zstandard 是 py3.14 编译的，和 venv 冲突）。

---

## 四、轨道点数据结构

每个轨道点是一段三次贝塞尔：

| 字段 | 含义 |
|---|---|
| `Translate` | 曲线上的节点 P0，格式 `[X, Y高度, Z]` |
| `Control1` | 本节点的出点手柄（→ 下一个点） |
| `Control0` | 下一个节点的入点手柄（← 来自上一个点） |
| `NextDistance` | 本点到下一点之间的弧长（米）—— **官方直接给的，不用自己算** |
| `PrevDistance` | 到上一点的弧长 |
| `Hash` | 该点的唯一哈希，供 `Connections` 引用 |
| `Connections` | 连接到其他轨道的哪个点（白龙联络轨靠这个串起来） |

轨道级字段：`IsClosed`（是否闭合）、`Dynamic.UniqueName`（轨道名）、
`Dynamic.IsEnabledGameDataFlagName`（游戏 flag，如 `IsEnabled_LowRail_For_DragonLight`）。

采样算法：按 `NextDistance` 每 ~58m 取一个点，三次贝塞尔公式求值。闭合环首尾残差均 < 55m，符合采样精度。

---

## 五、坐标系（已验证）

ROM `Translate = [X, Y高度, Z]`，项目 markers 用 `[x, y] = [X, Z]`，**一一对应，无需轴交换**。

验证方式：把 ROM 轨道点和项目里 1312 个官方地标（`app/data/markers.js`）算最近距离。

| 检查项 | 结果 |
|---|---|
| 费罗龙起点 ↔ 泡泡拉高地鸟望台 | **53 m** |
| 白龙途经点 ↔ 茨茨齐齐雪原鸟望台 | 322 m |
| 奥尔龙途经点 ↔ 格鲁德族圣域 | 111 m |
| 聂尔龙途经点 ↔ 乌尔利山鸟望台 | 25 m |
| 白龙起点 (150, 350) ↔ 监视堡垒 | 535 m（初岛支线在初始空岛，符合设定） |

全部落在合理范围，坐标系确认无误。

---

## 六、与现有社区数据的差异

现有 `app/data/dragon_paths.js` 的每个点落在 ROM 曲线上的距离（量化对比见 `验证对比.html`）：

社区数据是**正确的手工近似**——走向对，但点与点之间是直线，细节丢失。例如白龙的 14 个点里，
「德依布朗遗迹塔」在 ROM 高空轨上的最近点只差 88m，说明当初就是照着塔标定的。

**升级价值**：
- 曲线从 14 段直线 → 577 段贝塞尔，飞行路线细节完全还原
- 新增**飞行高度 Y**，可以画出精确的地下段（此前靠"虚线"猜测）
- 新增白龙的 **5 条轨道**（原来只有 1 条大圈）
- 地标从手工挑的 14 个塔 → 自动匹配的神庙/鸟望台/深穴/洞窟（沿线 900m 内，每类最多 3 个）

---

## 七、产出文件

### 本目录（`归档/龙轨迹ROM数据/`）

| 文件 | 说明 |
|---|---|
| `extract_dragon_rails.py` | 提取脚本：解压 ROMFS → 解析 BGYML → 贝塞尔采样 |
| `build_dragon_paths_rom.py` | 生成网站数据：匹配地标 → 输出 `dragon_paths_rom.js` |
| `dragon_rails_raw.json` | 原始轨道点（控制柄 / 弧长 / 连接关系全保留） |
| `dragon_rails_path.json` | 采样后的三维折线（1842 点） |
| `dragon_battle.json` | 龙战涡旋点 + 27 个相关 Actor |
| `dragon_config.json` | 龙行为参数 |
| `轨迹校验地图.html` | **地图可视化校验**（三层切换 + 高度着色 + 社区数据对照） |
| `验证对比.html` | 偏差量化对比表 + 轨道清单 |
| `raw/` | 上述 JSON 的 JS 包装版（供上面两个 HTML 加载） |

### 已生成到网站

| 文件 | 说明 |
|---|---|
| `app/data/dragon_paths_rom.js` | 挂 `window.TOTK_DRAGON_PATHS_ROM`，1842 采样点 |
| `app/data/catalogs.js` | 由 `add_dragon_catalog.py` 插入 3 个「龙的轨迹」分类项（id 229/230/231） |

网站侧实现见 `app/js/dragon-layer.js`（独立模块：分类项当开关、跨层自动补勾、
实虚线分层、方向箭头）。

### 三个脚本的职责

| 脚本 | 作用 | 幂等 |
|---|---|---|
| `extract_dragon_rails.py` | 解压 ROMFS → 解析 BGYML → 贝塞尔采样 | 是 |
| `build_dragon_paths_rom.py` | 采样数据 → 切地表/地下段 → 匹配地标 → 输出 `dragon_paths_rom.js` | 是 |
| `add_dragon_catalog.py` | 往 `catalogs.js` 插入/更新「龙的轨迹」分类项 | 是 |

改动顺序：先跑 `extract`，再跑 `build`，最后跑 `add_dragon_catalog`（或按需）。
改分类项参数（id / groupIndex / count）只需重跑第三个，它会先删掉旧项再插。

数据结构与现有 `dragon_paths.js` 保持一致（`segments` 为二维 `[x, y]`），
额外多了 `altitude`（高度数组）、`groundSegs`/`depthSegs`（按高度切分）、
`depthStarts`（地下出入口）、`extraRails`（白龙支线）、`start`（起点）。

**注意**：`app/data/dragon_paths.js`（豆包 1.9.5 的社区近似数据）**已不在 app/ 目录**，
归档在 `归档/豆包1.9.5半成品-已回退/`，页面也不再加载它。

### 配色

| 龙 | 色值 | 说明 |
|---|---|---|
| 白龙 | `#e8e6f0` | 天空层，带深色描边（浅色线在浅色瓦片上看不清） |
| 奥尔龙（火） | `#ff7a45` | 橙红 |
| 费罗龙（冰） | `#7ad7f0` | 青蓝 |
| 聂尔龙（雷） | `#f5c542` | **黄色**（原紫色，按老大要求改，贴合雷电意象） |

### 沿线地标标注（默认关闭）

脚本里的 `ENABLE_MARKS = False`。这些白点与左侧栏「神庙/鸟望台/驿站/地洞入口」分类图标
**坐标完全重复**，同屏显示会出现"同一地点两个图标、位置对不上"的错觉（用户实测反馈），故关闭。
需要时置为 `True` 重跑脚本即可恢复（半径/数量由 `MARK_RADIUS` / `MARK_MAX_PER_KIND` 控制）。

**注意：目前只是把数据放进去了，`app/index.html` 还没引入这个文件，`app/js/dragon-layer.js` 读的仍是旧的
`window.TOTK_DRAGON_PATHS`。要切换需要改这两处。**

---

## 八、龙行为参数（DragonMgrParam）

| 内部名 | 角速度 | 滚转角 | 重算间隔 | 位置写回 GameData |
|---|---|---|---|---|
| `Enemy_Dragon_Light_001`（白龙） | 12.0 | 0.20 | — | 是 |
| `Enemy_Dragon_Fire`（奥尔龙） | 12.0 | — | 2 | 是 |
| `Enemy_Dragon_Electric`（聂尔龙） | 12.0 | — | 2 | 是 |
| `Enemy_Dragon_Ice`（费罗龙） | 12.0 | — | 2 | 是 |

白龙没有 `CalcSkipInterval`（不跳帧重算），且滚转角 0.2 与其他龙不同——三条元素龙转弯更利落。
`IsWritePosToGameData: true` 说明龙的位置会写回 GameData，这也解释了为什么存档里有龙的位置信息。

---

## 九、重新生成

```bash
cd E:\WorkSpace\TOTKmap\归档\龙轨迹ROM数据
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe extract_dragon_rails.py
C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe build_dragon_paths_rom.py
```

两个脚本都是幂等的，直接重跑即可。改了地标筛选规则（`LANDMARK_CATS` / `MARK_RADIUS` / `MARK_MAX_PER_KIND`）
只需重跑第二个。
