// 定位核心（方案 A：锁住就信，零自动扫描）。
// 对齐 live-python server.py / BotwNavi 被验证稳定的三个要素：
//   1. 全量扫描只在三种时机：程序启动、读数失效（读图/换场景）、手动 /rescan。
//      没有"站桩核对"、没有周期性重扫——扫描要读 6GB 内存，会拖卡游戏。
//   2. 锁定后 5Hz 纯读跟随；传送 = 值大跳变 = 直接接受新位置（BotwNavi poll 同款）。
//   3. 防冻结槽从源头解决：扫描候选不立即信任，进入"监听确认"（python
//      watch_shortlist 同款）——同时观察 top 组，谁在动锁谁；玩家在动必中活槽。
// 兜底（全部零扫描）：
//   - known 快路径：解锁后扫描先行，known 只作为扫描失败期间的 1s 一试备胎；
//   - 冻结共识：锁读数停滞 ≥30s 时读 known 偏移（十几次 12B 读，微秒级），
//     ≥3 个互相一致且与本锁差 >15m → 记为候选；候选在下一次检查时"动了"
//     才换锁（活副本证明），玩家站桩时绝不误换。
// 已删除（迭代中证明弊大于利）：站桩核对、自证回扫、无佐证回扫、
// teleport 共识仲裁、skipKnownOnce 强制扫描。

package main

import (
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

var (
	procMu     sync.Mutex
	procHandle uintptr
	procPID    uint32
	guestBase  atomic.Uintptr
)

type lockT struct {
	mu       sync.RWMutex
	addr     uintptr
	verified bool
	copies   int
	source   string
}

var lock = lockT{}

type stateT struct {
	mu         sync.RWMutex
	ok         bool
	gx, gy, gz float32 // gx=X东, gy=Y北, gz=Z高
	mx, my     float32 // 地图像素（Leaflet latlng = (Z北, X东)）
	layer      int
	age        float64
	verified   bool
	copies     int
	source     string
}

var state = stateT{}

func reopenProcess() bool {
	procMu.Lock()
	defer procMu.Unlock()
	pid := findPid("eden")
	if pid == 0 {
		return false
	}
	if pid == procPID && procHandle != 0 {
		return true
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		return false
	}
	if procHandle != 0 {
		closeHandle(procHandle)
	}
	procHandle, procPID = h, pid
	fmt.Printf("  [proc] re-attached to Eden pid=%d\n", pid)
	return true
}

func procHandleNow() uintptr {
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	return h
}

// guestRamBase 返回当前会话 guest DRAM 块（known fast path 用）。
func guestRamBase() uintptr {
	if currentSessionBase != 0 {
		return currentSessionBase
	}
	h := procHandleNow()
	if h == 0 {
		return 0
	}
	base, _ := largestGuestBlock(h, 1024.0)
	return base
}

// tryOffsets known 快路径（Eden 版）：直接试读上次验证过的绝对地址。
// Eden 无固定 guest DRAM 块锚点（内存碎片化，25082 区域），不能 rebase 块偏移；
// 改为记忆"验证过的绝对地址"，启动时逐条试读，读到合法坐标即锁（pending
// move confirm，与旧版同）。地址跨会话是否稳定由重启实测决定：稳定 → 秒锁；
// 不稳定 → 回退存档锚点全扫描（locate.go）。
func tryOffsets() (uintptr, [3]float32, bool) {
	if !reopenProcess() {
		return 0, [3]float32{}, false
	}
	h := procHandleNow()
	for _, a := range loadAddrs() {
		if v := decodePos(readMem(h, a, 12)); v != nil {
			guestBase.Store(a)
			return a, [3]float32{v[0], v[1], v[2]}, true
		}
	}
	return 0, [3]float32{}, false
}

// knownOffsetsForWatch 返回 known 列表里除当前锁外的全部绝对地址
// （known 锁确认窗口的交替观察用，逐条 12B 读微秒级）。
func knownOffsetsForWatch(cur uintptr) []uintptr {
	var out []uintptr
	for _, a := range loadAddrs() {
		if a != cur {
			out = append(out, a)
		}
	}
	return out
}

// ---- 块世代：Eden 重开游戏后区域集合变化（旧会话残留槽可读但位置错误）----
// 扫描时发现"从未见过的新块"判定为游戏重启/块重建 → 只扫新块、回 UNLOCKED。
var (
	knownBlocks        []uintptr
	currentSessionBase uintptr
)

// detectNewBlocks：对比本次扫描块与已知块，返回从未见过的新块 base 列表。
// 返回非空 = 游戏重启/块重建（knownBlocks 只保留新块）。
//
// Eden 版：**永远返回 nil**——Eden 内存区域持续动态分配/释放（实测每 3s
// 检查都出现新区域，一次检查最多 5556 个"新块"），区域集合天然动态，
// 不能作为"游戏重启"判据。强行用会把 knownBlocks 不断重置 → 无限重扫、
// 锁永远保不住（2026-10-04 实测循环：[sm] N NEW guest block(s) 每 ~10s 触发）。
// 游戏重启的检测交给：known 绝对地址失效（tryOffsets 读失败）→ 回退全量
// 扫描；残留旧槽防护交给活性探测 + copies 打分（真槽 29K 副本 vs 残留 44~2200）。
func detectNewBlocks(blocks []struct{ Base, Size uintptr }) []uintptr {
	return nil
}

// sessionBlocks 返回当前会话的 guest 块（currentSessionBase 所在块）。
// currentSessionBase 未定时返回全部块（块世代检测尚未建立）。
func sessionBlocks(h uintptr) []struct{ Base, Size uintptr } {
	blks := guestBlocks(h, minBlockMB)
	if currentSessionBase == 0 {
		return blks
	}
	var out []struct{ Base, Size uintptr }
	for _, b := range blks {
		if b.Base == currentSessionBase {
			out = append(out, b)
		}
	}
	if len(out) > 0 {
		return out
	}
	return blks
}

// ---- 单一状态机 ----

const (
	smTick        = 200 * time.Millisecond // 5Hz 循环
	invalidMax    = 10                     // 连续读数无效次数 → 回 UNLOCKED（~2s，扛过读图 Loading）
	teleportDist  = 300.0                  // 相邻采样位移超过 → 判传送
	moveDist      = 0.5                    // 移动确认最小位移（游戏单位/采样）
	moveConfirmN  = 3                      // 连续移动采样次数 → verified
	scanCooldown  = 15 * time.Second       // 扫描失败重试间隔（成功后由解锁事件清零触发立即扫）
	knownRetry    = 1 * time.Second        // known 快路径重试间隔（扫描失败期间）
	probeEvery    = 400 * time.Millisecond // 监听确认采样周期（原 600ms：实测换锁要 14 秒才完成）
	probeMoveN    = 2                      // 组内移动采样次数 ≥ 此值 → 判活组（原 3：配合 400ms 拍从 1.8s 降到 0.8s）
	probeLife     = 60 * time.Second       // 监听确认最长持续时间
	probeAddrCap  = 24                     // 每组最多观察的地址数
	probeNearDist = 50.0                   // 换锁候选与本锁位置的最大差（防远处微动槽误换）
	probeCopyKeep = 0.1                    // 换锁候选 copies 不得低于本锁的这个比例（Eden 下存档镜像簇 copies 可大于真槽，0.7 会锁死真槽）
	frozenTicks   = 150                    // 锁读数停滞 tick 数（30s）→ 启动共识兜底检查
	consensusMin  = 3                      // 共识簇最少成员数
	consensusDist = 15.0                   // 共识位置与本锁读数的最小差
	consensusEvery = 1 * time.Second       // 共识检查间隔
	// known 锁确认窗口（2026-10-02 实测补丁）：known 锁上后 30s 内从未出现
	// 移动采样（锁错垃圾槽时玩家走动读数也不变），进入交替观察——轮读 known
	// 列表其他偏移（微秒级），谁在动就是真玩家槽。秒锁正常 0.5s 就确认，
	// 窗口只惩罚锁错的场景，站桩玩家零开销。
	knownConfirmWin = 30 * time.Second
	knownWatchEvery = 400 * time.Millisecond // 交替观察采样周期
	knownWatchMoveN = 2                      // 观察偏移移动采样次数 ≥ 此值 → 判活槽
	knownWatchMax   = 60 * time.Second       // 交替观察最长持续时间：超时无活槽 → 判池活动决定保持/重扫
	// known-fallback 换锁位置闸门：观察偏移必须距本锁读数 30m 内（玩家走动中槽
	// 轮换时新副本位置连续；远处死槽/NPC 槽被拒）。live-go 无此闸门（其 known
	// 列表仅验证过的偏移），Eden 已知列表含校准副本簇，保留防御更稳。
	knownFallbackNear = 30.0
	// 净位移判据（减法修复 2026-10-04）：Eden 内存抖动频繁，单拍 0.5m 位移
	// 会被垃圾槽来回跳凑出来（净位移≈0）。"玩家在动"必须看相对观察起点的
	// 净位移 > 此值——玩家走动单向累积，抖动来回抵消。对齐 live-go 判据
	// （候选动了才换锁）的 Eden 参数收紧，不是新机制。
	moveNet = 2.0
	// 锁冻结单地址接管（pool-follow）已删除（2026-10-04 减法修复）：
	// 它在锁冻结 600ms 就扫池接管，站桩时被副本轮换/垃圾抖动误触发 → 连环
	// 换锁到垃圾槽 → invalid/teleport → 无限重扫。回到 live-go 验证版逻辑：
	// 锁住就信，副本轮换由冻结共识（候选净位移 >2m 才换）30s 内自愈。
	// 静止确认（Fix 2026-10-04）：玩家站桩时锁读数冻结属正常，但移动确认永不
	// 触发 → 锁永远 verified=false → 每 30s 冻结共识 → 候选"不动"被判死 → 全量
	// 重扫循环（每 90s 一次 10s 扫描，期间 /pos ok=false）。站桩但锁位置有副本簇
	// （≥3 一致成员在 15m 内）= 锁是活槽 → 直接确认。NPC 槽极少有 ≥3 一致副本簇。
	frozenConfirmTicks = 50                     // 冻结 10s（50×200ms）即检查静止确认
	frozenConfirmEvery = 2 * time.Second        // 静止确认检查间隔
	frozenConfirmNear  = 15.0                   // 副本簇候选与本锁位置的最大差
)

// Eden 版冻结纠偏增强（减法修复 2026-10-04，对齐 live-go 验证版）：
// knownPool：最近一次全量扫描的候选组代表地址（同会话内有效），冻结共识的成员来源，
// 解决 known_addrs.json 只有 1-2 条绝对地址、凑不够 consensusMin=3 成员簇的问题。
// bypassKnown：/rescan 或 known 观察超时有活动时置位，强制跳过 known 快路径直接
// 全量扫描，避免"锁回同一个冻结槽 → 再冻结"的死循环。
// pool-follow 机制已删除（见常量区注释）：站桩误换锁元凶，副本轮换交给冻结共识。
var (
	knownPool      []uintptr
	bypassKnown    bool
	lastRelocateAt time.Time
)

var (
	rescanCh   chan struct{} // /rescan 请求（server.go → requestRescan）
	lastScanAt time.Time
	useSaveScan = true // --no-save 时关闭存档锚点扫描（known 快路径不受影响）
)

func setLock(addr uintptr, verified bool, copies int, source string) {
	lock.mu.Lock()
	lock.addr = addr
	lock.verified = verified
	lock.copies = copies
	lock.source = source
	lock.mu.Unlock()
}

func goUnlocked(reason string) {
	setLock(0, false, 0, "locating...")
	state.mu.Lock()
	state.ok = false
	state.source = "locating..."
	state.mu.Unlock()
	// 解锁后重扫冷却：Eden 下场景切换垃圾期（占位池/未初始化槽）反复 scan 会
	// 锁垃圾 → invalid → 解锁 → 立即重扫 → 风暴（实测 ws 飙 2.6GB、一直 locating）。
	// 冷却 20s：垃圾期跳过重扫（场景加载完成后已知地址/候选恢复），真迁移靠
	// frozen → reLocateCooldown 重锚兜底（该路径 bypassKnown 强制重扫不受此冷却影响）。
	lastScanAt = time.Now().Add(20*time.Second - scanCooldown) // 解锁后 ~20s 才允许自动重扫
	fmt.Printf("  [sm] -> UNLOCKED (%s)\n", reason)
}

// requestRescan 供 /rescan HTTP 端点调用（非阻塞）。
func requestRescan() {
	select {
	case rescanCh <- struct{}{}:
	default:
	}
}

// dist3 两点距离（hud 序 = decodePos 序：东、北取反、高）。
func dist3(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// isShrinePos 判定神庙/洞穴本地场景：TOTK 神庙为独立场景，玩家坐标切到以神庙
// 原点为中心的本地坐标系。实测（2026-10-04）：无尽洞窟 X∈[0,32], Y北∈[54,87],
// alt∈[-135,-117]；另一神庙入口 alt=-42。判据 |X|<200 && |Y北|<200 && alt<0
// 留裕量（覆盖 alt∈[-135,-42]）；大地图地底玩家原点 200m 内会误判（红点停门口
// vs 画在空洞，影响极小，可接受）。
func isShrinePos(p [3]float32) bool {
	return abs32(p[0]) < 200 && abs32(p[1]) < 200 && p[2] < 0
}

// consensusCopy 在 known 地址 + 最近扫描候选池里找最大一致簇（互相 <2m，排除本锁地址）。
// 返回簇的一个代表地址与位置；成员 < consensusMin 视为无共识。
// Eden 版：known 记忆的是绝对地址，直接读取，无块 rebase；knownPool 补足成员数。
func consensusCopy(h uintptr, exclude uintptr) (uintptr, [3]float32, bool) {
	type val struct {
		addr uintptr
		pos  [3]float32
	}
	var vals []val
	seen := map[uintptr]bool{exclude: true}
	add := func(a uintptr) {
		if !seen[a] {
			seen[a] = true
			if d := decodePos(readMem(h, a, 12)); d != nil {
				vals = append(vals, val{a, [3]float32{d[0], d[1], d[2]}})
			}
		}
	}
	for _, a := range loadAddrs() {
		add(a)
	}
	for _, a := range knownPool {
		add(a)
	}
	best, bestN := val{}, 0
	for _, x := range vals {
		n := 0
		for _, y := range vals {
			if dist3(x.pos, y.pos) < 2 {
				n++
			}
		}
		if n > bestN {
			best, bestN = x, n
		}
	}
	if bestN < consensusMin {
		return 0, [3]float32{}, false
	}
	return best.addr, best.pos, true
}

// stateMachine 定位主循环：全程序只有这里写 lock.addr。
func stateMachine() {
	rescanCh = make(chan struct{}, 1)

	inLocked := false
	var prev [3]float32 // 上一次有效读数（hud 序）
	hasPrev := false
	moveN := 0    // 连续移动采样计数（≥moveConfirmN → verified）
	invalidN := 0 // 连续读数无效计数
	frozenN := 0  // 锁读数停滞 tick 计数（共识兜底触发用）
	lastConfirmAt := time.Time{}   // 静止确认检查节流（frozenConfirmEvery）
	var shrineEntry [3]float32     // 进入神庙前最后大地图坐标（红点停门口）
	shrineEntrySet := false
	inShrine := false // 当前是否在神庙本地场景
	var lastOverworld [3]float32  // 最近一次大地图坐标（独立于 prev：rescan/resetFollow
	lastOverworldSet := false     // 会清空 prev，但进神庙跳变路径需要入口锚点）
	savedKnown := false
	lastKnownAt := time.Now().Add(-knownRetry)
	lastConsensusAt := time.Time{}
	consensusCand := uintptr(0) // 冻结共识候选（需"动了"才换锁）
	var consensusCandPos [3]float32

	// known 锁确认窗口状态（交替观察）
	knownLockAt := time.Time{} // known 锁锁上时刻
	knownSeenMove := false     // 本锁是否出现过移动采样（出现过=锁对，玩家在动）
	knownWatchOn := false      // 交替观察模式开启
	knownWatchAt := time.Time{}
	var knownWatchAddrs []uintptr
	knownWatchBase := map[uintptr][3]float32{}
	knownWatchMoved := []int{}
	watchAnyMove := false // 交替观察期内是否有偏移净位移 >moveNet（站桩/活动的旁证）
	var lastGarbageLogAt time.Time // 场景切换垃圾跳变日志限频（2s 一行）

	// 监听确认（probe）状态：观察 shortlist 各组，谁在动锁谁
	probing := false
	var probeGroups []ShortlistEntry
	probeBase := map[uintptr][3]float32{}
	var probeMoved []int
	var probeStart, probeLast time.Time
	probeLockGi := -1 // 当前锁来自哪个探针组（该组由 moveN 正常确认）
	var probeRefPos [3]float32 // 换锁位置基准（展示序 X, Z, alt，与 decodeTripleAt 输出同序）
	lastProbeIgnoreGi := -1    // ignore 限频：同组 30s 内只打一行
	var lastProbeIgnoreAt time.Time

	resetFollow := func() {
		prev, hasPrev = [3]float32{}, false
		moveN, invalidN, frozenN = 0, 0, 0
		savedKnown = false
		consensusCand = 0
		knownSeenMove = false
		knownWatchOn = false
		knownWatchAddrs = nil
		knownWatchBase = map[uintptr][3]float32{}
		knownWatchMoved = []int{}
	}

	tick := time.NewTicker(smTick)
	defer tick.Stop()

	for range tick.C {
		// 0) Eden 附着（同 pid 时开销可忽略；未运行则等待）
		if !reopenProcess() {
			if inLocked {
				inLocked = false
				goUnlocked("Eden lost")
			} else {
				state.mu.Lock()
				state.ok = false
				state.source = "waiting for Eden"
				state.mu.Unlock()
			}
			continue
		}
		h := procHandleNow()

		// 1) 游戏重启检测：Eden 版已禁用（区域集合动态变化不可作重启判据，
		//    见 detectNewBlocks 注释；残留旧槽由活性探测 + copies 打分兜底）。

		// 2) /rescan 请求：回 UNLOCKED 立即重扫
		select {
		case <-rescanCh:
			lastScanAt = time.Time{}
			if inLocked {
				inLocked = false
				goUnlocked("/rescan requested")
			}
			bypassKnown = true // 主动重扫 = 全量扫描，跳过 known 快路径
		default:
		}

		// 2.5) 坐标校准锁定接管（coords.go）：GUI 提交游戏 HUD 坐标 →
		// 三轴精确匹配命中真槽 → 直接接管（与 known 快路径同款，pending move confirm）。
		select {
		case cr := <-coordsCh:
			setLock(cr.addr, false, cr.copies, "coords")
			inLocked = true
			resetFollow()
			probing = false
			probeGroups = nil
			bypassKnown = false
			fmt.Printf("  [sm] coords lock -> 0x%X copies=%d mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
				cr.addr, cr.copies, cr.pos[0], cr.pos[1], cr.pos[2])
			continue
		default:
		}

		// ---- UNLOCKED：known 快路径优先（秒锁、零扫描），失败再全量扫描 ----
		// Fix 6：原顺序是"扫描先行、known 只当扫描失败备胎"，且 lastScanAt 初始为
		// 零值导致启动第一拍必扫描 6GB。调成 known 优先：偏移记忆有效时毫秒级锁定，
		// 无效（游戏重启/换场景后读不到）才走扫描，扫描仍是永久兜底。
		if !inLocked {
			if isCoordsBusy() {
				continue // 坐标搜索进行中，等结果（双扫描竞争浪费 10s+）
			}
			if !bypassKnown && time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := tryOffsets(); ok {
					setLock(a, false, 0, "known")
					inLocked = true
					resetFollow()
					knownLockAt = time.Now()
					probing = false
					probeGroups = nil
					fmt.Printf("  [sm] known offset -> lock 0x%X mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
						a, v[0], v[1], v[2])
					continue
				}
			}
			if useSaveScan && time.Since(lastScanAt) >= scanCooldown {
				lastScanAt = time.Now()
				res := locate(procPID, 120.0, sessionBlocks(h), func(s string) { fmt.Println("    " + s) })
				if res != nil {
					// Eden 瞬态候选防御：扫描命中是"扫描窗口内"的快照，而 Eden 内存
					// 活跃（02AEC 区域实测 copies=18652 的组锁定瞬间读全零），锁定前
					// 必须即时重读候选；无效则按 shortlist 顺序找下一个可读地址。
					if decodePos(readMem(h, res.Addr, 12)) == nil {
						fixed := false
						for _, g := range res.Shortlist {
							for _, ad := range g.Addrs {
								if decodePos(readMem(h, ad, 12)) != nil {
									res.Addr = ad
									fixed = true
									break
								}
							}
							if fixed {
								break
							}
						}
						if !fixed {
							fmt.Println("  [sm] scan candidate stale on re-read - retrying")
							continue
						}
					}
					setLock(res.Addr, false, res.Copies, "scan")
					inLocked = true
					resetFollow()
					// Eden 版：重建扫描候选池（冻结共识成员来源）+ 解除 known 快路径屏蔽。
					// 池收下 shortlist 全部地址（~720 个）：top 组几十个玩家槽副本地址
					// 全部进池，站桩时它们聚成 <2m 一致簇（≥3 成员）→ 共识 ok 不误重扫；
					// 只取每组 1 个代表会让池太分散，站桩也被误判无共识。
					knownPool = knownPool[:0]
					for _, g := range res.Shortlist {
						knownPool = append(knownPool, g.Addrs...)
					}
					bypassKnown = false
					// 建立监听确认：观察 shortlist 各组，谁在动锁谁
					if len(res.Shortlist) > 0 {
						probing = true
						probeGroups = res.Shortlist
						probeMoved = make([]int, len(probeGroups))
						probeBase = map[uintptr][3]float32{}
						probeStart, probeLast = time.Now(), time.Time{}
						probeLockGi = 0 // best=ranked[0]
						probeRefPos = [3]float32{res.Hud[0], res.Hud[1], res.Hud[2]}
					}
					fmt.Printf("  [sm] scan -> lock 0x%X copies=%d struct=%d mem=(%.1f, %.1f, %.1f) [probing %d groups]\n",
						res.Addr, res.Copies, res.Struct, res.Hud[0], res.Hud[1], res.Hud[2], len(probeGroups))
				} else {
					fmt.Println("  [sm] scan found nothing - retrying")
				}
				continue
			}
			if !bypassKnown && time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := tryOffsets(); ok {
					setLock(a, false, 0, "known")
					inLocked = true
					resetFollow()
					knownLockAt = time.Now()
					knownLockAt = time.Now()
					probing = false
					probeGroups = nil
					fmt.Printf("  [sm] known offset -> lock 0x%X mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
						a, v[0], v[1], v[2])
				}
			}
			continue
		}

		// ---- LOCKED ----
		lock.mu.RLock()
		a := lock.addr
		lock.mu.RUnlock()
		if a == 0 {
			inLocked = false
			continue
		}

		// 监听确认（600ms 一拍）：观察各组是否在动；本锁未 verified 时"谁在动锁谁"
		if probing && time.Since(probeLast) >= probeEvery {
			probeLast = time.Now()
			for gi, g := range probeGroups {
				n := len(g.Addrs)
				if n > probeAddrCap {
					n = probeAddrCap
				}
				for i := 0; i < n; i++ {
					adr := g.Addrs[i]
					d := decodePos(readMem(h, adr, 12))
					if d == nil {
						continue
					}
					v := [3]float32{d[0], d[1], d[2]}
					b, ok := probeBase[adr]
					probeBase[adr] = v
					if ok && dist3(v, b) > moveDist {
						probeMoved[gi]++
					}
				}
			}
			lock.mu.RLock()
			ver := lock.verified
			lock.mu.RUnlock()
			if ver {
				probing = false // 本锁已由移动确认，不再换
			} else {
				bestGi, bestMv := -1, 0
				for gi, mv := range probeMoved {
					if mv >= probeMoveN && gi != probeLockGi && mv > bestMv {
						bestGi, bestMv = gi, mv
					}
				}
				if bestGi >= 0 {
					adr := probeGroups[bestGi].Addrs[0]
					// 换锁两道闸门。缺了它们实测会把锁切到远处的整数坐标死槽，
					// 再叠加"直接标 verified"就再也纠不回来（2026-10-02 TOTK 实测：
					// 从 copies=149 的组切到 copies=35 的第 22 组，位置 (30,-1500,1405)
					// 三轴皆整数，之后 6.5 分钟纹丝不动）。
					//   1) 位置校验：候选必须在本锁附近（玩家槽副本簇）——
					//      防止远处"微动槽"（相机 / UI / NPC / 物理波动）被当成玩家
					//   2) 丰裕度校验：copies 是主导维度，不允许明显少于本锁
					// 另外 setLock 传 false：换过去的槽要重新走移动确认才晋升 verified。
					lock.mu.RLock()
					curCopies := lock.copies
					lock.mu.RUnlock()
					if d := decodePos(readMem(h, adr, 12)); d != nil &&
						dist3([3]float32{d[0], d[1], d[2]}, probeRefPos) < probeNearDist &&
						float32(probeGroups[bestGi].Copies) >= float32(curCopies)*probeCopyKeep {
						setLock(adr, false, probeGroups[bestGi].Copies, "probe")
						saveKnown([]uintptr{adr}, sessionBaseForKnown())
						probing = false
						resetFollow()
						a = adr
						probeRefPos = [3]float32{d[0], d[1], d[2]}
						fmt.Printf("  [sm] probe -> switched to moving group #%d copies=%d addr=0x%X\n",
							bestGi, probeGroups[bestGi].Copies, adr)
					} else if bestGi != lastProbeIgnoreGi || time.Since(lastProbeIgnoreAt) > 30*time.Second {
						lastProbeIgnoreGi = bestGi
						lastProbeIgnoreAt = time.Now()
						dist := float32(-1)
						if d := decodePos(readMem(h, adr, 12)); d != nil {
							dist = dist3([3]float32{d[0], d[1], d[2]}, probeRefPos)
						}
						fmt.Printf("  [sm] probe: group #%d moving but rejected (%.0fm away, copies %d vs current %d) - ignore\n",
							bestGi, dist, probeGroups[bestGi].Copies, curCopies)
					}
				}
			}
			if probing && time.Since(probeStart) > probeLife {
				probing = false
			}
		}

		lock.mu.RLock()
		a = lock.addr // probe 可能已换锁
		lock.mu.RUnlock()
		if a == 0 {
			inLocked = false
			continue
		}
		v := decodePos(readMem(h, a, 12))
		if v == nil {
			invalidN++
			state.mu.Lock()
			state.ok = false
			state.source = "address lost"
			state.mu.Unlock()
			if invalidN >= invalidMax {
				inLocked = false
				goUnlocked(fmt.Sprintf("readings invalid x%d (scene change?)", invalidMax))
			}
			continue
		}
		cur := [3]float32{v[0], v[1], v[2]}
		delta := dist3(cur, prev)
		// 传送/场景切换：verified 锁大位移分两种——真传送（玩家 teleport/坐载具快移，
		// knownPool 副本同步更新到新位置）与场景切换垃圾跳变（锁地址读到另一处合法
		// 坐标，副本未同步）。用 knownPool 交叉验证区分：新位置 100m 内有 ≥1 活副本
		// = 真传送接受；无副本 = 垃圾跳变 → 保持旧输出 + 累积 invalid → 快速重锚，
		// 避免"飘到地下/天空"（神庙进出实测：副本轮换期锁地址短暂读到远处合法坐标）。
		// 未 verified 的锁出现大位移 = 坏槽跳变，回扫。
		if hasPrev && delta > teleportDist {
			lock.mu.RLock()
			ver := lock.verified
			lock.mu.RUnlock()
			if ver {
				liveCopy := 0
				for _, ad := range knownPool {
					dd := decodePos(readMem(h, ad, 12))
					if dd == nil {
						continue
					}
					if abs32(dd[0]-cur[0]) < 100 && abs32(dd[1]-cur[1]) < 100 && abs32(dd[2]-cur[2]) < 100 {
						liveCopy++
						break
					}
				}
				if liveCopy > 0 {
					incCounter("jumps")
					frozenN = 0
					fmt.Printf("  [sm] teleport jump %.0fm accepted (cross-verified %d copy)\n", delta, liveCopy)
				} else {
					// 场景切换垃圾跳变：/pos 保持上次有效值（红点停住不飘），
					// 累计 invalidN → invalidMax 后 UNLOCKED → 加载完成重扫新槽
					// 限频：垃圾时段（~2s）只打一行，避免每 200ms 刷屏。
					if time.Since(lastGarbageLogAt) >= 2*time.Second {
						fmt.Printf("  [sm] scene-switch garbage jump %.0fm (no cross copy) - holding prev, reanchor in ~%.1fs\n",
							delta, float64(invalidMax)*smTick.Seconds())
						lastGarbageLogAt = time.Now()
					}
					invalidN++
					if invalidN >= invalidMax {
						inLocked = false
						goUnlocked(fmt.Sprintf("readings invalid x%d (scene switch garbage)", invalidMax))
					}
					continue // 跳过 state 更新 → /pos 保持上次有效坐标
				}
			} else {
				inLocked = false
				goUnlocked(fmt.Sprintf("teleport jump %.0fm on unverified lock -> rescan", delta))
				continue
			}
		}
		invalidN = 0 // 正常读数（含真传送接受）清零无效计数

		// known 锁确认窗口状态：本锁槽出现移动采样 → 锁对（玩家在动且槽跟随）
		lock.mu.RLock()
		lockSrc, lockVer := lock.source, lock.verified
		lock.mu.RUnlock()

		// 移动确认：连续 3 次采样位移 >0.5m → verified（写 known 记忆）
		if hasPrev && delta > moveDist {
			moveN++
			frozenN = 0
			if lockSrc == "known" {
				knownSeenMove = true
			}
			if moveN >= moveConfirmN {
				lock.mu.Lock()
				if !lock.verified {
					fmt.Printf("  [sm] lock 0x%X confirmed live (moving)\n", a)
					lock.verified = true
				}
				lock.mu.Unlock()
				probing = false
				if !savedKnown {
					savedKnown = true
					// Fix 6：block 用兜底函数，不能用 currentSessionBase
					// （启动常态恒为 0，会把 known_addrs.json 的 block 写成 0x0）
					saveKnown([]uintptr{a}, sessionBaseForKnown())
				}
			}
		} else {
			moveN = 0
			if hasPrev {
				frozenN++
			}
			// 静止确认（Fix 2026-10-04）：玩家站桩时锁读数冻结属正常，但移动确认
			// 永不触发 → 锁一直 verified=false → 30s 冻结共识把"不动候选"判死 →
			// 全量重扫循环。站桩但锁位置有副本簇（consensusCopy ≥3 一致成员且距
			// 本锁 <15m）= 锁是活槽 → 直接确认（但不写 known）。
			// Eden 修正（方案 A 对齐）：known 只在移动确认（锁被证明在动）后写入。
			// 静止确认写 known 是污染根源——玩家在神庙/洞穴站桩时，静止确认会把
			// 神庙本地坐标槽写进 known_addrs.json，下次启动 known 快路径秒锁神庙槽，
			// 输出神庙坐标被当大地图坐标（红点画地下）。站桩验证过但"没动过"的槽
			// 不值得记忆，靠传送跳变/读失效/游戏重启兜底。
			if hasPrev && frozenN >= frozenConfirmTicks && time.Since(lastConfirmAt) >= frozenConfirmEvery {
				if _, v2, ok := consensusCopy(h, a); ok && dist3(v2, cur) < frozenConfirmNear {
					lock.mu.Lock()
					if !lock.verified {
						fmt.Printf("  [sm] lock 0x%X frozen steady (idle, copy %.0fm) - confirmed\n",
							a, dist3(v2, cur))
						lock.verified = true
					}
					lock.mu.Unlock()
					probing = false
					lastConfirmAt = time.Now()
				}
			}
		}

		// ---- known 锁确认窗口（2026-10-02 实测补丁，见常量 knownConfirmWin）----
		// 锁上 30s 从未出现移动采样 → 交替观察 known 列表其他偏移（微秒级），
		// 谁在动就是真玩家槽：换锁并给旧锁记 fail（连续 knownEvictFail 次移出）。
		// 单偏移（无候选）不动作：站桩与锁错在单偏移下不可分，误回扫会卡游戏；
		// 该场景靠传送跳变 / 读失效 / 游戏重启兜底。
		// 减法修复 2026-10-04：
		//   - coords 校准锁已写 known，并入交替观察（副本轮换时同样能兜住）；
		//   - "动"判据收紧为净位移 >moveNet（Eden 抖动免疫，见常量区说明）；
		//   - 观察超时 knownWatchMax 无活槽 → 按观察期是否有净位移区分：
		//     全静止 = 站桩（锁住就信，保持锁）；有净位移 = 玩家在动但 known
		//     全失效 → 重扫（覆盖 Eden 绝对地址失效的卡死场景）。
		if (lockSrc == "known" || lockSrc == "coords") && !lockVer && !knownSeenMove && !knownWatchOn && time.Since(knownLockAt) >= knownConfirmWin {
			knownWatchOn = true
			knownWatchAt = time.Now()
			knownWatchAddrs = knownOffsetsForWatch(a)
			knownWatchBase = map[uintptr][3]float32{}
			knownWatchMoved = make([]int, len(knownWatchAddrs))
			watchAnyMove = false
			fmt.Printf("  [sm] known lock not confirmed %.0fs - watching %d other offset(s)\n",
				knownConfirmWin.Seconds(), len(knownWatchAddrs))
		}
		if knownWatchOn && time.Since(knownWatchAt) >= knownWatchEvery {
			knownWatchAt = time.Now()
			for i, adr := range knownWatchAddrs {
				d := decodePos(readMem(h, adr, 12))
				if d == nil {
					continue
				}
				v := [3]float32{d[0], d[1], d[2]}
				if b, ok := knownWatchBase[adr]; ok {
					if dist3(v, b) > moveNet { // 相对观察起点的净位移（抖动来回抵消）
						knownWatchMoved[i]++
						watchAnyMove = true
					}
				} else {
					knownWatchBase[adr] = v // 首次记录观察起点
				}
			}
			best := -1
			for i, mv := range knownWatchMoved {
				if mv >= knownWatchMoveN && (best < 0 || mv > knownWatchMoved[best]) {
					best = i
				}
			}
			if best >= 0 {
				stale := a
				adr := knownWatchAddrs[best]
				if d := decodePos(readMem(h, adr, 12)); d != nil {
					// 位置闸门（30m）：known 列表可能含远处地址，换锁候选必须距
					// 本锁读数 30m 内（玩家走动中槽轮换时新副本位置连续，30m 足够；
					// 远处死槽/NPC 槽被拒）。
					if dist3([3]float32{d[0], d[1], d[2]}, cur) >= knownFallbackNear {
						fmt.Printf("  [sm] known watch: 0x%X moving but rejected (%.0fm away) - ignore\n",
							adr, dist3([3]float32{d[0], d[1], d[2]}, cur))
						knownFailInc(stale)
						knownWatchOn = false
						knownWatchAddrs = nil
						continue
					}
					knownFailInc(stale)
					setLock(adr, false, 0, "known-fallback")
					fmt.Printf("  [sm] known lock stale (no move %.0fs) -> fallback to live offset 0x%X (%.1f, %.1f, %.1f)\n",
						knownConfirmWin.Seconds(), adr, d[0], d[1], d[2])
					resetFollow()
					knownSeenMove = true // 阻止新锁立即再进观察
					knownWatchOn = false
					a = adr
					continue
				}
			}
			// 观察超时：known 记忆可能全失效（Eden 绝对地址跨会话失效）。
			if knownWatchOn && time.Since(knownWatchAt) > knownWatchMax {
				knownWatchOn = false
				knownWatchAddrs = nil
				if watchAnyMove {
					// 玩家在动但观察不到活槽（known 全失效）→ 重扫重新锚定
					fmt.Println("  [sm] known watch timeout with activity - rescanning")
					bypassKnown = true
					inLocked = false
					goUnlocked("known watch timeout - rescanning")
					continue
				}
				// 观察期全静止 = 玩家站桩 → 锁住就信，保持锁
				fmt.Println("  [sm] known watch timeout, pool idle - holding lock (stationary)")
			}
		}

		// 更新 STATE（/pos 输出口径与旧版一致）
		lock.mu.RLock()
		verified, copies, src := lock.verified, lock.copies, lock.source
		lock.mu.RUnlock()
		// Fix 2026-10-04：神庙/洞穴场景检测——TOTK 神庙是独立场景，玩家坐标切到
		// 本地坐标系（|X|<200, |Y北|<200, alt<-50，实测 0~32/54~87/-135~-117），
		// 直接输出会画到大地图"地下"且 layer 被判为地底(19)。进入瞬间记录入口
		// 大地图坐标（lastOverworld，独立于 prev——进神庙跳变路径会 rescan+
		// resetFollow 清空 prev），神庙内 /pos 恒输出入口坐标（红点停门口）+
		// source 标 shrine-hold；出神庙后自动恢复正常。启动即在神庙（无大地图
		// 记录）时无入口记忆 → 原样输出（保持旧行为，日志提示）。
		out, outSrc := cur, src
		if isShrinePos(cur) {
			if !inShrine && lastOverworldSet {
				shrineEntry, shrineEntrySet = lastOverworld, true
				fmt.Printf("  [sm] shrine detected (%.0f, %.0f, %.0f) - holding entry (%.0f, %.0f, %.0f)\n",
					cur[0], cur[1], cur[2], lastOverworld[0], lastOverworld[1], lastOverworld[2])
			} else if !shrineEntrySet {
				// Eden 修正（方案 A 对齐）：启动即在神庙（无入口锚点）时保持
				// ok=false 定位中，不输出神庙本地坐标（raw output 会画错地图），
				// 玩家出神庙后 lastOverworld 更新自动恢复。
				state.mu.Lock()
				state.ok = false
				state.source = "shrine-no-anchor"
				state.mu.Unlock()
				prev = cur
				hasPrev = true
				continue
			}
			if shrineEntrySet {
				out, outSrc = shrineEntry, "shrine-hold"
			}
			inShrine = true
		} else {
			inShrine = false
			lastOverworld, lastOverworldSet = cur, true
		}
		state.mu.Lock()
		state.ok = true
		state.gx, state.gy, state.gz = out[0], out[1], out[2]
		state.mx, state.my = -out[1], out[0]
		state.layer = layerOf(out[0], out[1], out[2])
		state.age = float64(time.Now().UnixNano()) / 1e9
		state.verified = verified
		state.copies = copies
		state.source = outSrc
		state.mu.Unlock()
		prev = cur
		hasPrev = true

		// 冻结共识兜底（零扫描，减法修复 2026-10-04 对齐 live-go）：锁读数停滞
		// ≥30s 时，找 known/knownPool 里互相 <2m 的 ≥3 成员一致簇作候选；候选
		// 相对 watching 起点净位移 >moveNet 才换锁（玩家走动=活副本跟随；站桩/
		// 抖动净位移≈0 → 永不误换）。候选不动就安静 watching（无 dead 分支、
		// 无重扫——站桩锁住就信；玩家动后 1~2s 内自愈）。known 地址全失效的
		// 卡死场景由 knownWatch 观察超时（有活动→重扫）兜底。
		if frozenN >= frozenTicks && time.Since(lastConsensusAt) >= consensusEvery {
			lastConsensusAt = time.Now()
			a2, v2, ok := consensusCopy(h, a)
			if !ok {
				consensusCand = 0
			} else if a2 != consensusCand {
				consensusCand, consensusCandPos = a2, v2
				fmt.Printf("  [sm] lock frozen %.0fs, consensus candidate 0x%X (%.0fm away) - watching\n",
					frozenTicks*smTick.Seconds(), a2, dist3(v2, cur))
			} else if dist3(v2, consensusCandPos) > moveNet {
				// 候选净位移 >moveNet = 活副本在跟随玩家 → 换锁
				fmt.Printf("  [sm] frozen lock 0x%X -> relock to live consensus copy 0x%X\n", a, a2)
				setLock(a2, false, 0, "consensus")
				resetFollow()
				probing = false
				continue
			}
		}
	}
}

// ---- 导航目标（server.go 使用，原样保留）----

func setTarget(t *targetT) {
	targetMu.Lock()
	target = t
	targetMu.Unlock()
}

func getTarget() *targetT {
	targetMu.Lock()
	defer targetMu.Unlock()
	return target
}

func clearTarget() {
	targetMu.Lock()
	target = nil
	targetMu.Unlock()
}
