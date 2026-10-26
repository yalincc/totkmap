# TOTKmap 发布说明规范（Release Notes Guide）

> 适用范围：**本规范生效之后的新版本**。旧版本（v2.6.0 及更早）的 Release 正文与
> `release/notes-*.md` 一律**不回填**，保持原样。

## 一、核心原则：三层分离

发布说明不再一份文档写到底，按读者的「耐心深度」分三层：

| 层 | 载体 | 写什么 | 长度 | 读者 |
|---|---|---|---|---|
| **L1 发布页** | GitHub Release 正文 | 一句话定位 + 4~5 条要点 + 下载 + 指路链接 | **≤ 15 行** | 扫一眼就决定要不要升 |
| **L2 更新明细** | `CHANGELOG.md`（仓库）+ 包内 `MAP-README.txt`「本版更新」 | 完整更新条目，可含技术说明 | 不限 | 想知道改了什么 |
| **L3 深度文档** | `docs/releases/TOTKmap-vX.Y.Z.md`、`GUIDE.md`、`TROUBLESHOOTING.md` | 技术方案、踩坑、验收记录 | 不限 | 排查 / 二次开发 |

**铁律：使用方法、目录结构、FAQ 一律不进 L1。** 包内 `README.txt` / `MAP-README.txt` /
`GUIDE.md` 已经写了，发布页只负责指路。

## 二、L1 模板：网页地图线（`totkmap-vX.Y.Z`）

```markdown
TOTKmap vX.Y.Z

王国之泪简体中文互动地图 · 离线地图包

### 本次更新
- 动词开头的一句话，≤25 字
- 动词开头的一句话，≤25 字
- 动词开头的一句话，≤25 字
- 动词开头的一句话，≤25 字

### 下载
- `TOTKmap-vX.Y.Z.zip` 离线地图包（手机镜像 / 离线使用）
- PC 直接用在线版：https://totk.yalin.site

详细更新记录见 CHANGELOG.md，使用说明见包内 MAP-README.txt。
```

## 三、L1 模板：导航线（`totknavi-vX.Y.Z`）

```markdown
TOTKNavi vX.Y.Z —— 王国之泪实时定位导航（支持 Ryujinx / Eden）

### 本次更新
- 动词开头的一句话，≤25 字
- 动词开头的一句话，≤25 字
- 动词开头的一句话，≤25 字

### 下载
- `TOTKNavi-vX.Y.Z.zip` 桌面导航程序（解压到纯英文路径）
- 手机镜像需配合离线地图包 `totkmap-vX.Y.Z.zip`

详细更新记录见 CHANGELOG.md，使用说明见包内 GUIDE.md。
```

## 四、写作规则（5 条，防止写长）

1. **一条一行，≤25 字**，动词开头：新增 / 修复 / 优化 / 移除 / 统一。
2. **不写实现细节**：文件路径、模块名、技术名词（如 SW_VER、GUID、bss 偏移）全部进 L2/L3。
3. **不写使用方法与目录树**，不复制包内 README 的内容。
4. **不用 emoji 堆砌**（历史版本 v3.0.0 的 ⚡🛡️⛩️ 风格不再沿用）。
5. **要点最多 5 条**；超出的合并成「其他优化若干，详见 CHANGELOG.md」一行。

## 五、CHANGELOG 摘要块（L1 的唯一数据源）

每个版本条目**开头**放一个摘要块，Release 正文直接复制它，不另起炉灶改写：

```markdown
## TOTKMAP VX.Y.Z — 一句话标题（YYYY-MM-DD）

> **摘要（Release 正文用这几条）**
> - 要点一
> - 要点二
> - 要点三
```

摘要块下面是该版本的完整明细，写多细都行。**改 CHANGELOG 时先更新摘要块**，发布时复制。

## 六、发布操作流程

1. 功能做完 → 更新 `CHANGELOG.md`（先写摘要块，再写明细）
2. 版本号三处同步：`app/js/app.js` VERSION、`app/index.html` foot-version、`MAP-README.txt`；
   改过 js/css/data 必须 bump `app/sw.js` 的 `SW_VER`（否则线上「老页面配新资源」）
3. 导航线同步：`totknavi/version.go` CoreVersion 与 `totknavi-gui/app.go` guiVersion 同号
4. 打包 → 本地 `release/notes-map-vX.Y.Z.md` / `notes-nav-vX.Y.Z.md` 按本规范写正文
5. push 双端 → 打 tag → 用 notes 文件内容建 GitHub Release
6. Gitee Pages 需到仓库 Pages 页面手动点「更新」才会部署
