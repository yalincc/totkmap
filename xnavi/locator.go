// locator.go — 定位策略接口（两套定位策略的隔离边界）。
//
// TOTK 的 Ryujinx（live-go）与 Eden（live-eden）状态机同骨架、策略差异巨大：
//   - Ryujinx：known 块+偏移 rebase、只扫最大 guest DRAM 块、整数三元组拒绝、
//     verified 传送直接接受、无神庙 hold
//   - Eden：known 绝对地址、全 RW 区域扫描（碎片化）、占位池过滤、瞬态候选防御、
//     knownPool 交叉验证传送、神庙 hold、静止确认、净位移判据
//
// 两套策略混进一个状态机 = BOTW 已踩过的坑（"并入 TOTK Ryujinx 曾导致
// Cemu/Ryujinx BOTW 也无法锁定"）。因此全部策略点经本接口注入：
// ryujinxPlatform / edenPlatform 各自实现本接口，状态机只面向接口编程，
// 禁止平台分支堆叠。Platform 接口负责"内存访问能力"，本接口负责"定位策略"。

package main

import "time"

// locator 定位策略。nil 返回值一律表示"无候选/不成立"（状态机按默认路径走）。
type locator interface {
	// decode 读 12 字节 + 解码 + 校验 → hud 序 (X, -Y北, alt)；无效返回 nil。
	// Ryujinx 拒绝整数三元组（死槽特征）；Eden 不拒绝（真槽坐标是整数），
	// 改为拒绝 Z_stored 近零（未初始化槽）。
	decode(h uintptr, addr uintptr) []float32

	// tryLock known 快路径：Ryujinx = 块+偏移 rebase 试读；Eden = 绝对地址试读。
	tryLock(h uintptr) (uintptr, [3]float32, bool)

	// knownWatchAddrs known 锁确认窗口的交替观察候选（除当前锁外）。
	knownWatchAddrs(cur uintptr) []uintptr

	// consensusCopy 冻结共识：Ryujinx = known 偏移簇；Eden = known 绝对地址 + knownPool。
	consensusCopy(h uintptr, exclude uintptr) (uintptr, [3]float32, bool)

	// locate 全量扫描（两版策略完全不同：块枚举/窗口过滤/分组打分/junk 过滤）。
	locate(window float64, onlyBlocks []MemBlock, logf func(string)) *LocateResult

	// saveKnown / knownFailInc known 持久化：
	// Ryujinx = known_addrs.json（块+偏移）；Eden = known_eden_totk.json（绝对地址，
	// knownSlotOK 过滤神庙槽）。
	saveKnown(addrs []uintptr, block uintptr)
	knownFailInc(a uintptr)

	// afterScan 扫描锁定的后续处理：Eden = knownPool 重建 + 解除 bypassKnown；
	// Ryujinx = 无操作。
	afterScan(res *LocateResult)

	// scanRescue 瞬态候选防御：扫描命中是窗口快照，Eden 锁定前必须即时重读候选
	// （无效则按 shortlist 找下一个）；Ryujinx = 恒 true。
	scanRescue(h uintptr, res *LocateResult) bool

	// teleportAccept 传送/场景切换判定（verified 锁大位移时）：
	// 返回 (accept, garbage)。Eden = "位置+方向连续性"判活模型：
	//   - 位置连续：knownPool 活副本 100m 内 = 真传送（副本同步到新位置）
	//   - 方向连续：dirSustained（状态机最近 2 拍位移同向）= 快速移动
	//     （跳伞/滑翔下落，速度太快副本跟不上但路径连续）——同样接受
	//   - 两者皆无 = 场景切换垃圾跳变 → 保持旧输出 + 累积 invalid / 立即重锚
	// Ryujinx = (true, false) 直接接受（其 known 列表只验证过的偏移）。
	// dirSustained 由状态机从位移方向历史计算（见 watch.go dotDirHist）。
	teleportAccept(h uintptr, cur [3]float32, delta float32, dirSustained bool) (bool, bool)

	// poolAlive 当前已知候选池（knownPool）是否仍有活副本：
	// Eden = 任一 knownPool 地址 12B 读有效（非零三元组）；Ryujinx = 恒 true。
	// 状态机在"读数无效 / 垃圾跳变"时查此：池无活副本 = 场景切换全池失效 →
	// 立即重锚（不等 invalidMax 累积、不等 30s frozen）；池有活 = 副本轮换中，
	// 走 pool-follow 接管。
	poolAlive(h uintptr) bool

	// shrine 神庙/洞穴本地场景检测：
	// 返回 (输出坐标, source)。Eden = isShrinePos 判定 + 入口锚点 hold
	// （source "shrine-hold"；启动即在神庙无锚点返回 "shrine-no-anchor"，
	// 状态机保持 ok=false）；Ryujinx = (cur, "") 原样输出。
	shrine(cur [3]float32) ([3]float32, string)

	// stationaryConfirm 静止确认：Eden 站桩锁经共识近邻验证直接 confirmed
	// （不写 known）；Ryujinx = false（无此机制）。
	stationaryConfirm(h uintptr, a uintptr, cur [3]float32) bool

	// onUnlocked 解锁后行为：Eden = 场景垃圾期重扫冷却 20s；Ryujinx = 立即重扫。
	onUnlocked()

	// onRescan /rescan 请求处理：Eden = bypassKnown 置位（强制跳过 known 快路径
	// 直接全量扫描，避免锁回同一冻结槽）；Ryujinx = 无操作。
	onRescan()

	// knownBypassed known 快路径是否被屏蔽：Eden = bypassKnown（观察超时有活动
	// 或 /rescan 后置位）；Ryujinx = false。
	knownBypassed() bool

	// probeCopyKeep 探针换锁丰裕度：Ryujinx 0.7；Eden 0.1（存档镜像簇可大于真槽）。
	probeCopyKeep() float32

	// consensusMoveNet 冻结共识换锁净位移判据：Ryujinx 0.5；Eden 2.0（抖动免疫）。
	consensusMoveNet() float32

	// knownWatchMoveNet known 观察"动"的净位移判据（同抖动免疫）。
	knownWatchMoveNet() float32

	// knownWatchNear known-fallback 换锁位置闸门（距本锁读数上限）：Ryujinx 无限制
	// （返回极大值）；Eden 30m。
	knownWatchNear() float32

	// knownWatchMax 交替观察最长持续时间：Ryujinx 无限（0 = 不超时）；Eden 60s。
	knownWatchMax() time.Duration

	// detectNewBlocks 游戏重启检测：Ryujinx = 新块判定；Eden = 恒 nil
	// （内存区域持续动态分配，不可作重启判据）。
	detectNewBlocks(blocks []MemBlock) []uintptr

	// coordsPeek / coordsBusy 坐标校准锁定（Eden 特有）：
	// coordsBusy = 后台全 RAM 搜索进行中；coordsPeek 取到结果返回 (addr, pos, copies, true)。
	coordsBusy() bool
	coordsPeek() (uintptr, [3]float32, int, bool)
}

// currentLocator 返回当前平台的定位策略；平台未实现 locator 时返回 nil。
func currentLocator() locator {
	p := currentPlatform()
	if p == nil {
		return nil
	}
	if l, ok := p.(locator); ok {
		return l
	}
	return nil
}

// coordsStarter 坐标校准入口（Eden 特有，server /set-coords 用，同步全 RAM 扫描）。
type coordsStarter interface {
	coordsLocate(gx, gy, gz float32) coordsResp
}
