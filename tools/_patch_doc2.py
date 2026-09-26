# -*- coding: utf-8 -*-
"""TOTKmap V1.8.0开发计划.md：契约/十三节更新 + 新增十四节（存档自动同步）。"""
import io

P = r"E:\WorkSpace\TOTKmap\TOTKmap V1.8.0开发计划.md"
with io.open(P, "r", encoding="utf-8", newline="") as f:
    t = f.read()

def rep(old, new, label):
    global t
    n = t.count(old)
    assert n == 1, "%s count=%d" % (label, n)
    t = t.replace(old, new)
    print("OK:", label)

# 1) 契约表：/pos 加 progressGen、/progress 行、删除“V1 不做 /progress”旧说明
rep("""| `GET /pos` | `{ok, mx, my, gz, layer, verified, source, age}`；mx/my = 地图坐标（Leaflet latlng = 游戏坐标 Z/X），layer = 18/19/20 |
| `POST /target` | `{x, y, name, type}` 设置 / `{clear:true}` 清除（网页 → 服务，浮窗等客户端可共享） |
| `GET /rescan` | 手动重新定位（地址失效时） |
| `GET /config` | 图层勾选同步（预留，浮窗等后续用） |

> V1 不做 `/progress` 自动同步：探索逐点完成由「加载存档（逐点映射）+ 手动标记」在网页侧判定；存档只读解析逻辑沿用现有 `js/save-parser.js`。""",
"""| `GET /pos` | `{ok, mx, my, gz, layer, verified, source, age, progressGen}`；mx/my = 地图坐标（Leaflet latlng = 游戏坐标 Z/X），layer = 18/19/20；progressGen = `slot路径:mtime`（游戏内保存→变化→网页自动重拉进度） |
| `POST /target` | `{x, y, name, type}` 设置 / `{clear:true}` 清除（网页 → 服务，浮窗等客户端可共享） |
| `GET /rescan` | 手动重新定位（地址失效时） |
| `GET /progress` | `{ok, version, save, doneIds, mapped, counts, mtime}`；counts = 与 `js/save-parser.js collect()` 同口径的 20 类 `{done,total}`；doneIds = 逐点完成 id（鸟望台/龙之泪/魔犹伊）；缓存 2s |
| `GET /config` | 图层勾选同步（预留，浮窗等后续用） |

> V1.8.0 起 `/progress` 为服务端存档自动同步核心（对齐 BOTWmap live-go 机制：服务自动定位存档、网页加载一次即同步、游戏保存后自动刷新）；手动上传 `progress.sav` 保留为离线兜底。""",
"契约表")

# 2) 十三节：槽位/缓存/实测更新
rep("""- **服务端** live-python/server.py 新增 GET /progress（Python 复刻 js/save-parser.js 解析：版本表 / HASH_TABLE_END=0x03c800 / 0xa3db7114 哨兵 / GUID 格式；读 data/explore_save_map.js；取 mtime 最新槽=游戏当前槽；5s 缓存）。实测：slot_05 mapped=118、doneIds=[119 监视堡垒鸟望台, 135 泡泡拉高地鸟望台] 与用户真实存档一致""",
"""- **服务端** live-python/server.py 新增 GET /progress（Python 复刻 js/save-parser.js 解析：版本表 / HASH_TABLE_END=0x03c800 / 0xa3db7114 哨兵 / GUID 格式；读 data/explore_save_map.js；**优先 slot_00**（Ryujinx 保存时 6 槽 mtime 全同，mtime 判槽不可靠）；2s 缓存）。实测：slot_00 mapped=118、doneIds=[119 监视堡垒鸟望台, 135 泡泡拉高地鸟望台, 2976(一只已收集魔犹伊)] 与用户真实存档一致""",
"十三节服务端行")

# 3) 追加十四节
t += """
## 十四、存档自动同步（新增需求，已完成，2026-09-26）

**需求**（用户："你看看 botwmap 加载存档是怎么弄的…只要加载一次，就基本可以同步游戏信息的"）：对齐 BOTWmap live-go——服务端自动定位存档（不用上传文件），网页加载一次即同步游戏进度，游戏内保存后 ~1-2s 自动刷新。

### 槽位调查结论（用户反馈"存档位置不对/塔数 2 不变"）
- **6 槽 mtime 全同**（17:08:52）：Ryujinx 保存把所有槽 mtime 写成同一时刻 → mtime 判槽不可靠，原 `_find_save` 会随机选中非当前槽。
- **各槽 md5 不同但完成度一致**（同一周目）：塔数均为 2/15 → 计数不受槽位影响。
- **slot_00 逐塔 dump**（15 塔 hash 全查）：仅 119 监视堡垒 / 135 泡泡拉高地 value=1，其余 13 座全 0 → **存档事实就是 2 塔**（用户到塔但未在塔底发光处互动激活，或刚保存时未到激活点），非读错槽；网页不自动刷新是旧版行为，本次一并改。

### 实现
- **服务端**（live-python/server.py）：
  - `_find_save`：**slot_00 优先**（用户实际槽），不存在则回退 mtime 最新。
  - `_murmur3_32`：与 js `murmurHash3.x86.hash32` 完全一致（'hello'=0x248bfa47、'Clear'=0x62965740、'Open'=0x1818ec02 验证通过）。
  - `_parse_completism`：读 `data/totk_save_hashes.js` 的 CompletismHashes（踩坑：① 文件尾是 `}` 无分号；② 数组注释含 `[x,y,z]` 会截断非贪婪正则 → 按"换行+缩进 `]`"闭合匹配）。
  - `_progress_counts`：20 类与 `js/save-parser.js collect()` 同口径（神庙/鸟望台/树根/龙之泪/克洛格/双倍/魔犹伊/残旧地图/贤者遗志/设计图石板/卡邦达/6 类 BOSS/地洞/洞穴/井），随 /progress 返回。
  - `/pos` 增加 `progressGen` = `slot路径:mtime`（游戏保存 → mtime 变化 → 代次变化）。
  - 缓存 5s → **2s**。
- **前端**：
  - `js/live.js` poll()：检测 `/pos.progressGen` 变化（**服务可达即检测，不依赖定位成功**；3s 节流）→ 调 `TOTK_APP.syncProgressFromServer()`。
  - `js/app.js`：新增 `syncProgressFromServer()`——`applyProgressDone(doneIds)`（逐点完成注入）+ `state.save = counts` → `renderProgress()`（探索度自动显示）+ `buildCatalogPanel()` + `updateCount()`；按钮显示「存档自动同步 ✓（slot_XX）」；`state.saveVersion` 标注「· 服务端自动同步」。
  - 手动上传 `progress.sav`（saveSyncBtn）保留为离线兜底。

### 实测（浏览器端到端）
- 页面加载**无需上传**自动显示：神庙 8/152、鸟望台 2/15、树根 0/120、克洛格 4/800、双倍克洛格 2/100、魔犹伊 4/147、卡邦达立牌 1/81（与 slot_00 真实存档一致）。
- touch 存档 progress.sav mtime → 网页自动重新拉取 `/progress`（network 观测到新请求）✓。
- 逐点注入生效：doneIds 含 119/135 → 对应塔标点完成态。
"""
with io.open(P, "w", encoding="utf-8", newline="") as f:
    f.write(t)
print("开发计划文档已更新")
