package main

// CoreVersion xnavi 核心版本（GUI 壳必须与此一致，见 R11 版本解耦）。
// V3.0.0：全面对齐 BOTW xnavi v3.2.2 极简定位架构 + 发现 TOTK 主模块 .bss 跨场景持久变换槽：
//   1. 识别主模块 .bss 双缓冲 3x4 矩阵变换结构（stride=0x48=72B，[-0x24: 3x3 正交旋转矩阵] + [+0x00: XYZ]），
//      在 Eden/Ryujinx 全内存零误报且跨传送、进出神庙永不销毁（Rot > Quat > Dist 优先级）；
//   2. 收敛 Eden 内存枚举至主模块静态段 [arenaLow+0x78000000, +0x88000000) 与 Switch 堆段
//      [arenaLow+0x2000000000, +0x3000000000)，扫描耗时从 32s 降至 1.5s；
//   3. 100% 对齐 xnavi 死守 lockedAddr + [hold] + [shrine] + [warp] 零重扫传送与神庙进出机制，
//      移除旧版 known 持久化、冻结共识、probe 监听、lostState 等冗余状态机。
// V2.2.0：新增第 6 条锁定途径 —— 指针链快路径（解析主模块宿主基址 H +
// 换算常数 K，走固定偏移链读坐标；跑动掉锁后毫秒级重锁，失败回退 known/扫描/校准）。
// V2.1.2：定位引擎 Bug C~H 修复（两个 if 判据 + known 自愈 + 扫描互斥 +
// 组代表基准 + 空组拒绝）；手机镜像 Bug A（引导页/根路径/appReady 三态）。
const CoreVersion = "v3.0.0"
