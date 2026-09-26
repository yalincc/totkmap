# TOTKmap 更新日志

## V1.7.8 — 卡片尺寸定稿（2026-09-26）
- 卡片宽度回 300px，材料图标 180px 居中
- 点击卡片图标弹出 256px 原图预览（克洛格卡「查看原图」同款，点击任意处关闭）

## V1.7.7 — 单点位级完成（2026-09-26）
- 卡片图标 160px（按卡片宽度协调）
- 「标记完成」从整材料改为**单点位级**：只淡显当前点，不影响其他位置
- 材料会刷新：重新勾选左侧材料名即清除该材料所有「标记完成」，全部位置重新显示可再次采集

## V1.7.6 — 材料卡片克洛格卡式改造（2026-09-26）
- 材料详情卡片改为纵向信息卡：分类胶囊 → 名称 → 区域/坐标/位置 → 256px 大图 → 用途 → 三按钮
- 用途自动标签：升级素材（探索升级素材名单 17 种，含译名修正 静谧公主=宁静公主/远昔舌骨鱼=远昔骨舌鱼）+ 料理材料 + 强化材料（矿岩）
- 坐标对齐克洛格卡 X（东西）/ Z（南北）格式；区域=最近地区标注点近似（项目无区域多边形）
- 按钮：导航（定位该点，导航程序后续接入自动切下一位置）/ 收集（标记当前点+自动定位下一未收集位置，导航雏形）/ 标记完成
- 探索标点卡片保持原状

## V1.7.5 — 材料页叠加探索标点（2026-09-26）
- 切到材料 Tab 时保留已勾选的探索标点（神庙/鸟望塔等），与材料位置叠加显示便于定位
- 根因：setTab 材料分支把 state.groups（探索图层）全部 removeLayer，删除该逻辑即可
- 卡片图标 48→96px

## V1.7.4 — 搜索框紧凑模块（2026-09-26）
- 搜索框与「全选/清空」合并为单一紧凑模块（去中间分隔线，间距收紧 gap=0）
- 材料卡片展示高清图标（名称左侧 48px）

## V1.7.3 — 卡片 BOTWmap 化 + 高清图标包（2026-09-26）
- 详情卡片整体换用 BOTWmap 信息卡结构：分类胶囊+名称+描述+操作按钮，点击位置附近弹出（锚点右侧优先/放不下转左/避让面板）、点击地图空白自动关闭、按住头部可拖拽、手机端底部抽屉
- 材料页搜索框 UI 与探索页完全统一（共用 .search-box，搜索在上/按钮在下）
- 用户重导高清图标包全量接入（107/110 更新为 256×256，昆虫 24 种补齐；仅 3 个「昆虫群（随机）」无专属图标保留旧图）
- 体积结论：图标 3.93MB 仅占项目 1.3%，运行时按需加载；真正大头是瓦片 285MB

## V1.7.2 — 搜索框归属 + 地图边界 + 缩放控件（2026-09-26）
- 探索搜索只在探索 Tab、材料搜索只在材料 Tab（setTab 显隐全局搜索框）
- 地图 maxBounds=TILE_BOX + maxBoundsViscosity=1.0（实测 setView 超界被 clamp 回 3080）
- 删除右下角重复版本号（只留左侧 footer）
- 右下角缩放控件参考 BOTWmap：#zoomControls 百分比（100%×2^(z-3)）+ ＋－＋ 全图 + 定位（导航后续接入）

## V1.7.1 — 修复轮（2026-09-26）
- **根因**：index.html 材料面板漏建 #matSearchInput → app.js 对其 addEventListener 抛 TypeError → IIFE 中断 → 「最大仍聚合 / 视口外不渲染 / 探索度不可收起」三 bug 同源
- 材料搜索框补全；地底「散落的琥珀」正名「散落的左纳乌尼姆」（Obj_MineralGrain_A_03 = Zonaite Deposit，数据 地表228/天空30/地底4386 吻合）
- 图标随缩放分级：matIconSize z3=20 / z4=22 / z5=26 / z6=30 / z7=34，聚合 +6(≥20点)/+12(≥100点)
- 11 个矿物对象映射 ore/ 高清图，删除 35 个冗余 webp

## V1.7.0 — 材料收集 Tab（2026-09-26）

### 新增功能
- 独立「材料收集」Tab，与探索 Tab 并存切换，Tab 放在搜索栏下方
- 6 大类 110 种材料 / 44,279 点（地表 18,930 / 地底 23,094 / 天空 2,255）
- 每种材料独立 supercluster 实例（懒加载），勾选只重绘那一种
- 星标收藏 ☆（localStorage 持久化）+ 只看收藏筛选条
- 地图↔侧栏联动：点地图材料→侧栏滚动+闪烁高亮；点侧栏材料→显示在地图上
- 聚合点显示图标 + 数量徽标，单点显示透明底图标

### 数据管道
- `tools/build_materials_data.py` v2：扫描 `Banc/MainField/`、`Banc/MinusField/`、`Banc/MainField/Sky/` 的 bcett.byml.zs
- 天空岛材料在 `MainField/Sky/` 子目录（128个bcett），扫描后从 85 点增至 2,255 点
- 中文名从 MSBT (CNzh) 提取，手动覆盖见脚本 MANUAL_ZH

### 图标提取（重大技术攻关）
- TOTK 图标在 `UI/Tex/Icon/*.bntx.zs`，ASTC4x4 SRGB + Tegra X1 block-linear 交错
- **正确解码方法**（参考 SwitchThemeInjector DDS.cpp 的 getAddrBlockLinear）：
  1. zstd 解压（带 ZsDic.pack 字典）
  2. 搜 `b'BRTI'` magic 定位
  3. Format 在 BRTI+28，Width 在 +36，Height 在 +40，BlockHeightLog2 在 +52
  4. PtrsAddress 在 BRTI+112（int64），其指向第一个 int64 = data offset（通常 0x1000）
  5. 用 `texture2ddecoder.decode_astc(data, w, h, 4, 4)` 解码
  6. **关键：必须做 Tegra block-linear untile**，公式：
     ```
     def get_addr_block_linear(x, y, img_w_blocks, bpp, base, block_height):
         gw = (img_w_blocks * bpp + 63) // 64
         gob_addr = base + (y // (8*block_height)) * 512 * block_height * gw \
                        + (x * bpp // 64) * 512 * block_height \
                        + (y % (8*block_height) // 8) * 512
         x *= bpp
         return gob_addr + ((x%64)//32)*256 + ((y%8)//2)*64 + ((x%32)//16)*32 + (y%2)*16 + (x%16)
     ```
- 27 个 TOTK 原生图标已提取，75 个复用 BOTW 图标，共 110/110 覆盖
- 用户另用 astcenc + 位模式表提取了 233 个高清 PNG，已替换到 `assets/materials/`

### 已知问题（未解决）
1. **放到最大仍聚合**：supercluster maxZoom 已改为 6，但用户反馈仍有聚合现象。可能需要进一步排查 supercluster zoom 参数与 Leaflet zoom 映射关系（zoomSnap=0.5 导致 Math.round 不准）
2. **视口外点不显示**：平移后其他区域材料点不渲染。bbox 换算已修正为 `bounds.getWest()*FX`，padding 加到 800，但仍有问题
3. **探索度面板无法收起**：progressHead 点击事件绑定正常但不生效，待查
4. **地底"散落的琥珀"4386 点**：实际是左纳乌矿碎块，不是琥珀，需改名或过滤
5. **图标格式**：部分仍是旧 webp 转的 png，新提取的高清 png 部分未覆盖

### 踩坑记录
- **PowerShell 改 UTF-8 文件**：用 `Set-Content -Encoding UTF8` 会按 GBK 读原文件导致中文乱码。必须用 `[IO.File]::ReadAllText/WriteAllText` + `[Text.UTF8Encoding]::new($false)`
- **texture2ddecoder.decode_astc**：必须先做 block-linear untile，否则花屏条纹
- **BRTI 字段偏移**：PtrsAddress 在 +112 不是 +108（之前算错导致 struct.error）
- **代码重复**：多次编辑后出现重复代码块（updateLayerCount 等），需注意去重
- **git checkout**：恢复 index.html 时会连材料 Tab DOM 一起还原，需重建

### 文件清单
- `data/materials.js` — 891KB，110种/44279点
- `tools/build_materials_data.py` — 数据管道 v2
- `js/app.js` — 材料模块 per-material supercluster
- `css/style.css` — mat-cluster/mat-leaf/mat-star 样式
- `index.html` — V1.7.0
- `assets/materials/*.png` — 110 个图标
