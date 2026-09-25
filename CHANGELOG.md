# TOTKmap 更新日志

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
