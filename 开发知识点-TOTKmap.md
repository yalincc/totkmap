# TOTKmap 开发知识点 · 踩坑与技术方案（V1.7.x 迭代实录）

> 面向后续迭代与同类项目（Leaflet 互动地图 / 数据管道 / 游戏资源解码）的经验沉淀。
> 按「坑 → 根因 → 方案」记录，可直接复用。

---

## 一、前端架构与调试

### 1. DOM 缺失导致 IIFE 中断 → 多个无关 bug 同源（V1.7.1 最大坑）
- **现象**：材料层不随缩放/平移重绘、「最大仍聚合」、探索度面板无法收起，三个看似无关的 bug 同时出现。
- **根因**：`index.html` 材料面板漏建 `#matSearchInput`，`app.js` 对它执行 `addEventListener` 抛 `TypeError` → 整个 IIFE 立即中断 → 后续所有初始化代码（缩放监听、重绘逻辑、折叠事件）全部未执行。
- **方案**：
  - 页面结构改动后，浏览器 console 必须先清零报错再往下排查；
  - 关键 DOM 绑定前加存在性守卫（`if (el) el.addEventListener(...)`）或启动时校验；
  - 特征：「多个功能同时坏」优先怀疑初始化链路中断，而非逐个功能查。

### 2. Leaflet divIcon 不响应合成点击（测试手段）
- `bu.click_xy` / `dispatchEvent(new MouseEvent('click'))` 打不动 Leaflet 的 divIcon marker（Leaflet 内部用 `_simulateEvent` 包装，合成事件不触发 `marker.on('click')`）。
- **方案**：物理点击不可靠时，直接 JS 调用内部函数（如 `window.TOTK.openDetail(marker, fakeEvt)`）验证逻辑链路；真实点击链路（`mk.on('click')` 标准绑定）由生产环境用户实测兜底。

### 3. 行尾符（CRLF/LF）与文本替换
- 同一仓库内文件行尾不一致：`app.js` 是 CRLF，`index.html`/`style.css` 是 LF（Git autocrlf 在改动时报 LF→CRLF 警告）。
- **坑**：用 python 做多行字符串替换时，`\n` 锚点在 CRLF 文件里匹配不到（count=0 静默失败）。
- **方案**：替换前先检测行尾（`s.count('\r\n')` vs `s.count('\n')`），按文件实际行尾构造锚点；单行锚点无此问题。

### 4. 浏览器实测环境要点
- 本地服务：`python -m http.server 8765`；每次改代码把资源引用 `?v=N` 升号（4 处）防缓存；
- supercluster 的 `setZoom` 动画会吞缩放值 → 用 `setView(..., {animate:false})`；
- 聚合/叶子渲染范围受 `bbox padding` 影响，视口内不一定有单点（leaf），测试选点需放宽坐标条件。

---

## 二、Leaflet 互动地图方案

### 5. 地图边界约束（V1.7.2）
```js
maxBounds: TILE_BOX,            // ±5000/±6000（游戏坐标）
maxBoundsViscosity: 1.0         // 拖拽/平移越界时硬回弹
```
实测 `setView(9000,9000)` 被 clamp 回 3080 —— 无需手写边界逻辑。

### 6. 详情卡片弹出定位（参考 BOTWmap positionCard）
- 锚点 = 点击点，卡片放锚点**右侧**（+20px）、纵向居中；右侧放不下转左侧；再 clamp 避让左侧面板（guard=366）与视口。
- 手机端（≤720px）交给 CSS：`left/right/bottom` 固定成**底部抽屉**，不再用 JS 定位。
- 拖拽：mousedown/touchstart 记偏移 → document mousemove 平移，clamp 视口内。
- 空白关闭：`map.on('click')` 非放置模式时 `detail.classList.add('hidden')`。

### 7. 材料点位级状态（收集/标记完成，V1.7.6-1.7.7）
- **supercluster features 必须带 `id: i`**（点索引），否则 leaf 拿不到点级索引，无法做点级状态。
- 点级状态存储用**紧凑索引数组**：`state.matCollected[mid] = [idx, idx, ...]`（4.4 万点全收集 ≈ 176KB，localStorage 可承受）；不能用 `mid_${idx}` 撒 key（超 5MB）。
- 聚合（cluster）无法按点淡显 → 只有 z7 叶子层可见点级效果，聚合层只做数量徽标。
- **材料刷新交互**：游戏里材料会重新生长 → UI 上「重新勾选左侧材料名」即清除该材料全部点级完成状态、点位全显（把游戏刷新语义映射为重新勾选事件）。

### 8. 材料 Tab 叠加探索标点（V1.7.5）
- 根因：`setTab` 材料分支把 `state.groups`（探索图层组）全部 `removeLayer`。
- 方案：删掉该清理逻辑即可；探索 marker 是普通 `L.marker`（无聚合），缩放/平移自动跟随，无需重绘。

### 9. 图标随缩放分级（V1.7.1）
```js
matIconSize(z) = {3:20, 4:22, 5:26, 6:30, 7:34}
聚合 size = base + (count>=100 ? 12 : count>=20 ? 6 : 0)
```
与「地名随缩放字号调整」同一思路；supercluster `{radius:36, maxZoom:6, minZoom:2}` 保证 z7 全叶子。

### 10. 区域判定（无多边形数据）
- 项目只有**区域标注点**（`AREAS`：{name, x, y, layer}），没有区域多边形 → 卡片区域 = **最近标注点**近似归属（欧氏距离，同 layer）。
- 塔域不做：无官方塔域数据（用户确认"没官方信息就不加"）。

### 11. 坐标格式对齐克洛格卡
- 克洛格卡用「游戏坐标 X（东西）· Z（南北）」；地图数据 lat/lng 对应 Z/X → 卡片显示 `X = lng`、`Z = lat`。

---

## 三、数据管道与游戏资源

### 12. TOTK 图标解码（V1.7.0 攻关，BNTX/ASTC/Tegra）
- 图标在 `UI/Tex/Icon/*.bntx.zs`：zstd（带 ZsDic.pack 字典）→ 搜 `BRTI` magic → Format+28 / Width+36 / Height+40 / BlockHeightLog2+52 / **PtrsAddress+112**（int64，指向 data offset）→ `texture2ddecoder.decode_astc(data,w,h,4,4)`。
- **必须做 Tegra block-linear untile**，否则花屏条纹；公式见 CHANGELOG V1.7.0。
- 结论：能用 astcenc+位模式表导出高清 PNG（用户方案）优于自研解码。

### 13. 高清图标包接入与体积
- 256×256 PNG 全量接入（107/110），运行时**按需加载**（勾选才请求）→ 不一次性拉全量。
- 体积结论：图标 3.93MB 仅占项目 1.3%；真正大头是瓦片 285MB（97%）。优化优先级：瓦片 > 图标转 webp。

### 14. 升级素材名单与译名差异
- 探索「升级素材」（cat=175）16 个 marker 名称与材料库 110 种做匹配，命中 17 种（含**译名差异**：静谧公主=宁静公主、远昔舌骨鱼=远昔骨舌鱼）。
- 用途标签：升级素材名单自动打「升级素材」；矿岩打「强化材料」；植物/蘑菇/水果/昆虫/鱼打「料理材料」。

---

## 四、工程与工具

### 15. 版本同步点（用户定规）
- 版本号需同步：`app.js VERSION`、`index.html` 左侧 footer、`README.md` 底部、资源引用 `?v=N`（4 处）；右下角版本号已删（V1.7.2），不再有第 4 个文本位。
- 每次功能改动必须同步，交付前核对。

### 16. 文件编辑工具异常（Edit "File has not been read yet"）
- 某些轮次 Edit 工具持续报"未读"（Read 后仍失败）→ 改用 **python 精确替换脚本**（按行尾适配多行锚点），带 count 校验（≠1 即 WARN/ABORT），比反复 Edit 可靠。

### 17. 推送节奏（用户确认制）
- 每轮浏览器实测通过 → 本地 commit → 向用户汇报并请求确认 → 用户确认后批量 push + 打 tag。
- 本项目节奏：V1.7.1~V1.7.8 八笔本地提交一次性推送双 remote（GitHub origin + gitee）+ 补 tag v1.7.1~v1.7.8。
