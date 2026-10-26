// scan_mutex.go — Eden 全量内存扫描互斥（v2.1.2 Bug F）。
//
// 现场（2026-10-10 16:56:02~05）：coords 校准与状态机 rescan 两路全量扫描
// 重叠 2.4s，各自锁到不同地址，时序混乱。v2.1.2 只做 TryLock 兜底：
// 先到先得，后到方跳过本轮（状态机下轮再试 / coords 提示稍后重试）。
// v2.2.0 再把 coordsLocate 纳入单一状态机调度，届时可删本文件。
package main

import "sync"

// globalScanMu 保护 Eden 全量内存扫描（locate / coordsLocate）互斥。
var globalScanMu sync.Mutex
