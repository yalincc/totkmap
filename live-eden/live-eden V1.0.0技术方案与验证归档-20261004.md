# live-eden V1.0.0 技术方案与验证归档

- **项目名称**：live-eden（Eden 模拟器《王国之泪》实时定位程序）
- **版本**：V1.0.0（2026-10-04 首次验证通过归档）
- **所在路径**：E:\WorkSpace\TOTKmap\live-eden\
- **代码仓库**：totkmap（gitee:yalincc/totkmap + github:yalincc/totkmap，live-eden 子目录）
- **参考实现**：E:\WorkSpace\TOTKmap\live-go（Ryujinx 版实时定位引擎）
- **运行环境**：Windows，Eden v0.2.1（G:\YUZU\eden\eden.exe），TOTK 1.2.1，Go 编译工具 D:\tools\go\bin\go.exe

## 1. 背景与目标

在 Eden 模拟器下运行《王国之泪》，实现与 TOTKmap（Ryujinx 版）等价的实时玩家坐标定位：秒锁、稳定跟随、游戏重启后自动重锚。初版假设"只更换一个固定偏移值即可"，实测结论：**不止换偏移**——Eden（Yuzu 系、8GB DRAM 配置）内存模型与 Ryujinx 不同，旧偏移 0xECB52A48 失效，玩家槽实际落在 0.44MB 微型 MEM_MAPPED 区域（区域偏移 0xA0 量级）。

## 2. 移植方案（已确认并执行）

1. 复制 live-go 引擎到 live-eden\engine，删除 spike_as.go 与 asProbe 分支
2. 进程名 findPid("ryujinx") → "eden"，新增 QueryFullProcessImageNameW
3. 重写 guestBlocks：全 RW 提交区域扫描（MEM_MAPPED+MEM_PRIVATE，≥64KB）
4. known 快路径改为绝对地址记忆（loadAddrs/saveKnown）
5. 存档根目录从 eden.exe 路径推导，按标题 ID 0100F2C0115B6000 过滤（防 BOTW 01007EF00011E000 污染）
6. build.bat 输出 xnavi-core-eden.exe
7. 删除块世代检测（detectNewBlocks 恒 nil）——Eden 区域集合动态变化（每 3s 出现新区域），不可作重启判据

## 3. 坐标口径（三重验证，已锁定）

- 标准游戏坐标（UltraCam HUD）：X 东 / Y 北 / Z 高（示例：329, -937, 1439）
- 内存原始（mod 调试面板）：X 东 / Z_stored = 高度+105 / Y 北（示例：329, 1545, 937）
- 内存布局序 (X, Z_stored, Y_north) 与 live-go decodePos 假设完全一致，可直接复用
- elevBias = 105.0

## 4. 关键改动与根因修复（2026-10-04 实测驱动）

### 4.1 移除 decodePos 的 isWhole32 整数过滤（核心修复）

- **现象**：扫描命中 10 万+ 三元组，候选锁定瞬间读数判无效 (0,0,0) → 自动重扫无限循环，锁不上
- **根因**：decodePos（locate.go）保留 Ryujinx 期判据"三轴皆整齐整数 → 判无效"（防整数死槽）。Eden 实测玩家站定时真槽坐标就是精确整数（0x024E7A0B7F70 连续 5 次采样 = 320.00/1540.00/950.00，copies=1898）——该判据把真槽整组误杀
- **修复**：删除 isWhole32 检查，真/死槽改由活性确认机制区分（probe 监听 + 移动确认 verified + 冻结共识兜底），站桩锁正确整数槽无需拒绝
- **效果**：修复后立即秒锁，HUD 三轴对齐（误差 <2m，含走动误差）

### 4.2 冻结共识增强：knownPool 扫描候选池

- **现象**：known 快路径锁到冻结值（槽迁移后地址不更新），known_addrs.json 只有 1-2 条绝对地址，共识簇凑不够 3 个成员，永远无法零扫描自愈
- **修复**：全量扫描后把 shortlist 全部地址（~720 个）存入内存池 knownPool，consensusCopy 从"池 + known 文件"找一致簇；站桩时 top 组几十个玩家槽副本聚成 <2m 簇 → 共识 ok 不误重扫，玩家一动平滑换锁

### 4.3 bypassKnown 重锚兜底

- **现象**：冻结无共识时引擎什么都不做，锁死冻结值
- **修复**：无共识且距上次重锚 >90s → bypassKnown 置位 + goUnlocked → 强制全量扫描重新锚定（known 快路径跳过，防锁回同一冻结槽死循环）；/rescan 请求同样置位

### 4.4 扫描瞬态候选即时重读防御

- **现象**：扫描命中是"扫描窗口内"的快照，Eden 内存活跃（0x02AEC7 区域实测 copies=18652 组锁定瞬间读全零），锁定后 readings invalid
- **修复**：locate 返回后锁定前，对候选地址即时重读；无效则按 shortlist 顺序找下一个可读地址

## 5. 实测验证记录（2026-10-04）

| 时间 | 事件 | 结论 |
|---|---|---|
| 12:05 | 全量扫描 9.1s → 锁 0x22BDDFEB4B8 copies=30653 | 会话内成功锁定 |
| 12:07:29 | 玩家移动 → confirmed live → 写入 known | known 快路径可用 |
| 12:08 | 读数无效 x10 解锁（场景切换）| 槽迁移 → 旧地址失效 |
| 12:22 | 重扫 102947 hits，候选锁瞬间读 0 → 无限重扫循环 | **触发根因调查** |
| 12:26 | 移除 isWhole32 后重启 → known 秒锁 0x24DF6B37000 + verified | 根因修复生效 |
| 12:33 | 锁值冻结 (324.46 固定)，HUD 实时变化 | 发现冻结死锁（无共识兜底）|
| 12:37-12:41 | 加 knownPool/bypassKnown/瞬态防御，多轮验证 | 机制逐个跑通 |
| 12:44 | 引擎 313.1/-950.4/1443.6 vs HUD 0313/-0950/1443 | 三轴对齐 verified |
| 12:53 | **游戏重启**：known 失效 → 全量扫描 → 锁 0x22C31D67BC0 | 自动重锚通过 |
| 12:54 | 旧真槽 0x22BDDFEB4B8 重启后"复活"读回玩家坐标 | **Eden 地址复用发现** |
| 12:57-13:02 | 冻结共识两次平滑换锁（0x22C52D5D534 ↔ 0x22BDDFEB4B8）| 自愈机制完整 |
| 13:01 | 引擎 304.9/-950.3/1450.1 verified，跟随玩家从 319 走到 300 | 跨重启 + 长距离跟随通过 |

## 6. 调研结论：现成项目借用分析（2026-10-04）

- **无现成 Eden 定位成品**，live-eden 是首个
- Eden 为 GPLv3 开源（Yuzu→Citron 分裂），主仓库 self-hosted Forgejo git.eden-emu.dev/eden-emu/eden，GitHub 仅 releases 镜像 github.com/eden-emulator/Releases
- TOTK cheat 代码现成：bad1dea/NXCheats（Atmosphère 580F0000 指针链）、CheatSlips/Tinfoil（BID 9B4E43650501A4D4）、FearLess Revolution CE 表（Ryujinx/Yuzu 版，绝对地址针对特定模拟器布局，Eden 上已证失效）
- UltraCam（MaxLastBreath/nx-optimizer）：坐标读取在进程内 subsdk3 二进制、无源码、无文件/网络输出 → 仅作屏幕验证基准，外部程序不可借用
- 跟踪类项目（TotK Unexplored、Tears Companion、MapGenie）全是存档分析/手动标记，无实时内存定位

## 7. 已知限制与后续方向

- **known 跨重启秒锁**：实测 Eden 内存布局稳定，旧真槽重启后复活（0x22BDDFEB4B8）——需多次重启验证后可将 known 快路径升级为跨重启秒锁
- **cheat 指针链（v1.1 方向）**：TOTK cheat 代码现成（游戏 main 模块内偏移，跨模拟器通用），若 Eden 支持 Atmosphère cheat 可做精确读取替代全量扫描；2026-10-04 实测时 cheat 未挂载，暂缓
- **扫描耗时**：全量扫描 10-18s（RW 区域 2400-6000 个，24-28GB），场景切换/重启后自动重锚可接受；进一步优化方向为缩小扫描窗口或地址复用优先

## 8. 结论

live-eden V1.0.0 已达到 TOTKmap 等价定位能力：会话内秒锁、HUD 三轴对齐、冻结自愈、跨游戏重启自动重锚。核心价值结论：
1. **"只换偏移"不可行**——内存模型差异需整链适配（块枚举/known/存档/进程名）
2. **整数坐标过滤在 Eden 下必须移除**（Eden 站桩真槽坐标整数化，判据误杀真槽）
3. **Eden 模拟器内存布局稳定**，绝对地址可跨重启复用（利好 known 快路径，后续版本可验证固化）
