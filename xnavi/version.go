package main

// CoreVersion xnavi 核心版本（GUI 壳必须与此一致，见 R11 版本解耦）。
// V2.2.0：新增第 6 条锁定途径 —— 指针链快路径（解析主模块宿主基址 H +
// 换算常数 K，走固定偏移链读坐标；跑动掉锁后毫秒级重锁，失败回退 known/扫描/校准）。
// V2.1.2：定位引擎 Bug C~H 修复（两个 if 判据 + known 自愈 + 扫描互斥 +
// 组代表基准 + 空组拒绝）；手机镜像 Bug A（引导页/根路径/appReady 三态）。
const CoreVersion = "v2.2.0"
