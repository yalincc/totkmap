// 定位核心（方案 A：锁住就信，零自动扫描）。
// 蓝本：TOTKmap live-go/watch.go（V1.8.7，已真机验证"零自动扫描 + 探针监听 +
// 冻结共识"方案）+ live-eden/watch.go（2026-10-04 方案 A 实测修复）。
//
// 统一状态机 + locator 策略注入：两平台状态机同骨架（锁定/移动确认/传送/
// 冻结共识/known 观察），策略差异（known 绝对地址 vs 块偏移、瞬态候选防御、
// knownPool 交叉验证传送、神庙 hold、静止确认、净位移判据、coords 校准）全部
// 经 locator 接口注入（见 locator.go / locator_ryujinx.go / locator_eden.go），
// 本文件不写平台分支堆叠（BOTW 踩坑：策略混入致多平台无法锁定）。
//
// 核心原则（两版原样保留）：
//   - 单一状态机：同一时刻只有 stateMachine() 写 lock.addr。
//   - 全量扫描只在三种时机：程序启动、读数失效（读图/换场景）、手动 /rescan。
//   - known 快路径优先（秒锁、零扫描），失败再全量扫描。
//   - 冻结共识兜底：锁读数停滞 ≥30s 时读 known 候选，候选"动了"才换锁。

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
	gx, gy, gz float32 // gx=X东, gy=-Y北, gz=Z高（decode 输出序）
	mx, my     float32 // 地图像素（Leaflet latlng = (Z北, X东)）
	layer      int
	age        float64
	verified   bool
	copies     int
	source     string
}

var state = stateT{}

// guestRamBase 返回当前会话 guest DRAM 块（known fast path 用；经当前平台）。
func guestRamBase() uintptr {
	if currentSessionBase != 0 {
		return currentSessionBase
	}
	p := currentPlatform()
	if p == nil || p.Handle() == 0 {
		return 0
	}
	base, _ := p.LargestBlock(1024.0)
	return base
}

// ---- 块世代：Ryujinx 重开游戏后新旧 guest DRAM 块并存（旧块残留上次会话玩家槽）----
// 扫描时发现"从未见过的新块"判定为游戏重启/块重建 → 只扫新块、回 UNLOCKED。
// （Eden 版经 locator.detectNewBlocks 恒 nil：内存区域持续动态分配，不可作重启判据。）
var (
	knownBlocks        []uintptr
	currentSessionBase uintptr
)

// detectNewBlocks：对比本次扫描块与已知块，返回从未见过的新块 base 列表。
// 返回非空 = 游戏重启/块重建（knownBlocks 只保留新块）。仅 Ryujinx 语义。
func detectNewBlocks(blocks []MemBlock) []uintptr {
	var newOnes []uintptr
	if len(knownBlocks) == 0 {
		if ref := loadKnownBlock(); ref != 0 {
			still := false
			for _, b := range blocks {
				if b.Base == ref {
					still = true
					break
				}
			}
			if still {
				for _, b := range blocks {
					knownBlocks = append(knownBlocks, b.Base)
				}
				return nil
			}
			for _, b := range blocks {
				knownBlocks = append(knownBlocks, b.Base)
				newOnes = append(newOnes, b.Base)
			}
			return newOnes
		}
		for _, b := range blocks {
			knownBlocks = append(knownBlocks, b.Base)
		}
		return nil
	}
	for _, b := range blocks {
		found := false
		for _, k := range knownBlocks {
			if k == b.Base {
				found = true
				break
			}
		}
		if !found {
			newOnes = append(newOnes, b.Base)
		}
	}
	if len(newOnes) > 0 {
		knownBlocks = newOnes
		return newOnes
	}
	return nil
}

// ---- 单一状态机 ----

const (
	smTick         = 200 * time.Millisecond // 5Hz 循环
	invalidMax     = 10                     // 连续读数无效次数 → 回 UNLOCKED（~2s，扛过读图 Loading）
	teleportDist   = 300.0                  // 相邻采样位移超过 → 判传送
	moveDist       = 0.5                    // 移动确认最小位移（游戏单位/采样）
	moveConfirmN   = 3                      // 连续移动采样次数 → verified
	scanCooldown   = 15 * time.Second       // 扫描失败重试间隔（成功后由解锁事件清零触发立即扫）
	knownRetry     = 1 * time.Second        // known 快路径重试间隔（扫描失败期间）
	probeEvery     = 400 * time.Millisecond // 监听确认采样周期
	probeMoveN     = 2                      // 组内移动采样次数 ≥ 此值 → 判活组
	probeLife      = 60 * time.Second       // 监听确认最长持续时间
	probeAddrCap   = 24                     // 每组最多观察的地址数
	probeNearDist  = 50.0                   // 换锁候选与本锁位置的最大差（防远处微动槽误换）
	frozenTicks    = 150                    // 锁读数停滞 tick 数（30s）→ 启动共识兜底检查
	consensusMin   = 3                      // 共识簇最少成员数
	consensusEvery = 1 * time.Second        // 共识检查间隔
	// known 锁确认窗口（2026-10-02 实测补丁）：known 锁上后 30s 内从未出现
	// 移动采样（锁错垃圾槽时玩家走动读数也不变），进入交替观察——轮读 known
	// 列表其他偏移/地址（微秒级），谁在动就是真玩家槽。
	knownConfirmWin = 30 * time.Second
	knownWatchEvery = 400 * time.Millisecond
	knownWatchMoveN = 2
	// ---- Eden 特化参数（2026-10-04 实测收敛值；Ryujinx 经 locator 返回默认值）----
	// 净位移判据：Eden 内存抖动频繁，单拍 0.5m 位移会被垃圾槽来回跳凑出来
	// （净位移≈0）。"玩家在动"必须看相对观察起点的净位移 >moveNet。
	moveNet = 2.0
	// known-fallback 换锁位置闸门：观察偏移必须距本锁读数 30m 内（玩家走动中
	// 槽轮换时新副本位置连续；远处死槽/NPC 槽被拒）。
	knownFallbackNear = 30.0
	// 交替观察最长持续时间：超时无活槽 → 按观察期是否有净位移决定保持/重扫。
	knownWatchMax = 60 * time.Second
	// 静止确认：玩家站桩时锁读数冻结属正常，但移动确认永不触发 → 锁永远
	// verified=false → 30s 冻结共识把"不动候选"判死 → 全量重扫循环。站桩但
	// 锁位置有副本簇（≥3 一致成员在 15m 内）= 锁是活槽 → 直接确认。
	frozenConfirmTicks = 50              // 冻结 10s（50×200ms）即检查静止确认
	frozenConfirmEvery = 2 * time.Second // 静止确认检查间隔
	frozenConfirmNear  = 15.0            // 副本簇候选与本锁位置的最大差
)

var (
	rescanCh    chan struct{} // /rescan 请求（server.go → requestRescan）
	lastScanAt  time.Time
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
	// 重扫时机由平台策略决定：Ryujinx = 立即重扫；Eden = 场景垃圾期 20s 冷却。
	if loc := currentLocator(); loc != nil {
		loc.onUnlocked()
	} else {
		lastScanAt = time.Time{}
	}
	fmt.Printf("  [sm] -> UNLOCKED (%s)\n", reason)
}

// requestRescan 供 /rescan HTTP 端点调用（非阻塞）。
func requestRescan() {
	select {
	case rescanCh <- struct{}{}:
	default:
	}
}

// dist3 两点距离（hud 序 = decode 序：东、北取反、高）。
func dist3(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// dotDirHist 计算最近两组位移方向的点积（尾部 3 分量 = 最近方向，倒数第二组 =
// 前一方向）。不足两组返回 -1（判为不连续）。连续同向大位移（跳伞下落）时
// 点积趋近 1；场景切换随机跳变两次方向一致的概率低。
func dotDirHist(d []float32) float32 {
	n := len(d)
	if n < 6 {
		return -1
	}
	return d[n-3]*d[n-6] + d[n-2]*d[n-5] + d[n-1]*d[n-4]
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
	savedKnown := false
	lastKnownAt := time.Now().Add(-knownRetry)
	lastConsensusAt := time.Time{}
	consensusCand := uintptr(0) // 冻结共识候选（需"动了"才换锁）
	var consensusCandPos [3]float32
	lastConfirmAt := time.Time{} // 静止确认检查节流（frozenConfirmEvery）
	var lastGarbageLogAt time.Time // 场景切换垃圾跳变日志限频（2s 一行）
	dirHist := []float32{} // 最近 3 次位移方向（归一化，3 分量/组）；连续同向
	// 大位移（跳伞/滑翔下落）豁免场景切换垃圾判定用（2026-10-09 修复）

	// known 锁确认窗口状态（交替观察）
	knownLockAt := time.Time{} // known 锁锁上时刻
	knownSeenMove := false     // 本锁是否出现过移动采样（出现过=锁对，玩家在动）
	knownWatchOn := false      // 交替观察模式开启
	knownWatchAt := time.Time{}
	var knownWatchAddrs []uintptr
	knownWatchBase := map[uintptr][3]float32{}
	knownWatchMoved := []int{}
	watchAnyMove := false // 交替观察期内是否有偏移净位移 >moveNet（站桩/活动的旁证）

	// 监听确认（probe）状态：观察 shortlist 各组，谁在动锁谁
	probing := false
	var probeGroups []ShortlistEntry
	probeBase := map[uintptr][3]float32{}
	var probeMoved []int
	var probeStart, probeLast time.Time
	probeLockGi := -1 // 当前锁来自哪个探针组（该组由 moveN 正常确认）
	var probeRefPos [3]float32 // 换锁位置基准（展示序 X, -Y北, alt，与 decode 输出同序）
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
		dirHist = dirHist[:0]
	}

	tick := time.NewTicker(smTick)
	defer tick.Stop()
	genN := 0 // 块世代检测计数（15 tick ≈ 3s）

	for range tick.C {
		loc := currentLocator()
		if loc == nil {
			continue // 平台未注册 locator（理论不发生：全部平台均实现）
		}

		// 0) 平台附着（同 pid 时开销可忽略；未运行则等待；auto 模式可自动切换平台）
		if !ensureAttach() {
			if inLocked {
				inLocked = false
				goUnlocked("emulator lost")
			} else {
				state.mu.Lock()
				state.ok = false
				state.source = "waiting for emulator"
				state.mu.Unlock()
			}
			continue
		}
		p := currentPlatform()
		h := p.Handle()
		procPID = p.PID()

		// 1) 游戏重启检测（每 ~3s，仅 Ryujinx 语义）：出现从未见过的新块 →
		// 只扫新块 + 回 UNLOCKED。Eden 恒 nil（内存区域动态分配，见
		// locator_eden.detectNewBlocks）且 512MB 块枚举开销大，跳过。
		if _, isRyu := p.(*ryujinxPlatform); isRyu {
			genN++
			if genN >= 15 {
				genN = 0
				if blks := p.Blocks(minBlockMB); len(blks) > 0 {
					if newOnes := loc.detectNewBlocks(blks); newOnes != nil {
						fmt.Printf("  [sm] %d NEW guest block(s) (game restart) -> rescan on new blocks\n", len(newOnes))
						bestBase, bestSize := uintptr(0), uintptr(0)
						for _, b := range blks {
							for _, nb := range newOnes {
								if b.Base == nb && b.Size > bestSize {
									bestBase, bestSize = b.Base, b.Size
								}
							}
						}
						currentSessionBase = bestBase
						lastScanAt = time.Time{}
						if inLocked {
							inLocked = false
							goUnlocked("game restart (new blocks)")
						}
					}
				}
			}
		}

		// 2) /rescan 请求：回 UNLOCKED 立即重扫（Eden 置 bypassKnown 强制全量）
		select {
		case <-rescanCh:
			lastScanAt = time.Time{}
			loc.onRescan()
			if inLocked {
				inLocked = false
				goUnlocked("/rescan requested")
			}
		default:
		}

		// 2.5) 坐标校准锁定接管（Eden coords.go；Ryujinx 恒无）：/set-coords 三轴
		// 精确匹配命中真槽 → 直接接管（与 known 快路径同款，pending move confirm）。
		if a, v, c, ok := loc.coordsPeek(); ok {
			setLock(a, false, c, "coords")
			inLocked = true
			resetFollow()
			probing = false
			probeGroups = nil
			fmt.Printf("  [sm] coords lock -> 0x%X copies=%d mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
				a, c, v[0], v[1], v[2])
			continue
		}

		// ---- UNLOCKED：known 快路径优先（秒锁、零扫描），失败再全量扫描 ----
		if !inLocked {
			if loc.coordsBusy() {
				continue // 坐标搜索进行中，等结果（双扫描竞争浪费 10s+）
			}
			if !loc.knownBypassed() && time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := loc.tryLock(h); ok {
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
				res := loc.locate(120.0, nil, func(s string) { fmt.Println("    " + s) })
				if res != nil {
					// Eden 瞬态候选防御：扫描命中是窗口快照，Eden 内存活跃可能
					// 瞬间失效（Ryujinx 恒 true）。候选失效则按 shortlist 找下一
					// 个可读地址；全部失效重试。
					if !loc.scanRescue(h, res) {
						fmt.Println("  [sm] scan candidate stale on re-read - retrying")
						continue
					}
					setLock(res.Addr, false, res.Copies, "scan")
					inLocked = true
					resetFollow()
					// Eden：重建 knownPool（冻结共识成员来源）+ 解除 known 屏蔽。
					loc.afterScan(res)
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
			if !loc.knownBypassed() && time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := loc.tryLock(h); ok {
					setLock(a, false, 0, "known")
					inLocked = true
					resetFollow()
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

		// 监听确认（400ms 一拍）：观察各组是否在动；本锁未 verified 时"谁在动锁谁"
		if probing && time.Since(probeLast) >= probeEvery {
			probeLast = time.Now()
			for gi, g := range probeGroups {
				n := len(g.Addrs)
				if n > probeAddrCap {
					n = probeAddrCap
				}
				for i := 0; i < n; i++ {
					adr := g.Addrs[i]
					d := loc.decode(h, adr)
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
					// 换锁两道闸门（live-go 原样）：位置校验（候选必须在本锁附近）
					// + 丰裕度校验（copies 是主导维度；Eden 阈值 0.1：存档镜像簇
					// copies 可大于真槽，0.7 会锁死真槽）。
					lock.mu.RLock()
					curCopies := lock.copies
					lock.mu.RUnlock()
					if d := loc.decode(h, adr); d != nil &&
						dist3([3]float32{d[0], d[1], d[2]}, probeRefPos) < probeNearDist &&
						float32(probeGroups[bestGi].Copies) >= float32(curCopies)*loc.probeCopyKeep() {
						setLock(adr, false, probeGroups[bestGi].Copies, "probe")
						loc.saveKnown([]uintptr{adr}, sessionBaseForKnown())
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
						if d := loc.decode(h, adr); d != nil {
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
		v := loc.decode(h, a)
		if v == nil {
			invalidN++
			state.mu.Lock()
			state.ok = false
			state.source = "address lost"
			state.mu.Unlock()
			// 场景切换立即重锚（方案 A 收敛，2026-10-09）：读数无效 + 候选池全
			// 失效 = 场景切换（副本整体迁移）→ 不等 invalidMax 累积直接解锁重扫；
			// 池仍有活副本 = 单拍读失败/副本轮换中 → 走原 invalidN 路径。
			if !loc.poolAlive(h) {
				inLocked = false
				goUnlocked("readings invalid + pool dead (scene switch) - immediate reanchor")
				continue
			}
			if invalidN >= invalidMax {
				inLocked = false
				goUnlocked(fmt.Sprintf("readings invalid x%d (scene change?)", invalidMax))
			}
			continue
		}
		cur := [3]float32{v[0], v[1], v[2]}
		delta := dist3(cur, prev)

		// 位移方向记录（归一化，保留最近 3 组）：连续同向大位移（跳伞/滑翔
		// 下落）豁免场景切换垃圾判定用。prev 未更新期间方向仍从旧 prev 起算，
		// 下落基本直线 → 连续方向点积高 → 豁免成立。
		if hasPrev && delta > 0.5 {
			inv := 1 / delta
			dirHist = append(dirHist, (cur[0]-prev[0])*inv, (cur[1]-prev[1])*inv, (cur[2]-prev[2])*inv)
			if len(dirHist) > 9 {
				dirHist = dirHist[len(dirHist)-9:]
			}
		}

		// 传送/场景切换：verified 锁大位移分两种——真传送（玩家 teleport/坐载具
		// 快移，knownPool 副本同步更新到新位置）与场景切换垃圾跳变（锁地址读到
		// 另一处合法坐标，副本未同步）。Eden 用"位置+方向连续性"判活（对齐复盘
		// 铁律 1）：新位置 100m 内有活副本 = 真传送；无副本但最近 2 拍位移同向
		// （dirSustained，跳伞/滑翔快速下落）= 快速移动同样接受；两者皆无 = 垃圾
		// 跳变（Ryujinx 恒接受：其 known 列表只验证过的偏移）。
		// 未 verified 的锁出现大位移 = 坏槽跳变，回扫。
		if hasPrev && delta > teleportDist {
			lock.mu.RLock()
			ver := lock.verified
			lock.mu.RUnlock()
			if ver {
				dirSustained := len(dirHist) >= 6 && dotDirHist(dirHist) > 0.7
				accept, garbage := loc.teleportAccept(h, cur, delta, dirSustained)
				if accept {
					incCounter("jumps")
					frozenN = 0
					fmt.Printf("  [sm] teleport jump %.0fm accepted in place (no scan)\n", delta)
				} else if garbage {
					// 场景切换垃圾跳变：/pos 保持上次有效值（红点停住不飘）。
					// 池无活副本（全池失效）= 场景切换 → 立即重锚（不等 invalidMax）；
					// 池有活副本 = 副本轮换 → 累积 invalid 走 pool-follow 接管。
					// 限频：垃圾时段（~2s）只打一行，避免每 200ms 刷屏。
					if time.Since(lastGarbageLogAt) >= 2*time.Second {
						fmt.Printf("  [sm] scene-switch garbage jump %.0fm (no cross copy) - holding prev, reanchor in ~%.1fs\n",
							delta, float64(invalidMax)*smTick.Seconds())
						lastGarbageLogAt = time.Now()
					}
					invalidN++
					if !loc.poolAlive(h) {
						inLocked = false
						goUnlocked("garbage jump + pool dead (scene switch) - immediate reanchor")
						continue
					}
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
					// （启动常态恒为 0，会把 known 文件 block 写成 0x0）。
					loc.saveKnown([]uintptr{a}, sessionBaseForKnown())
				}
			}
		} else {
			moveN = 0
			if hasPrev {
				frozenN++
			}
			// 静止确认（Eden；Ryujinx 恒 false）：站桩锁读数冻结属正常，但移动
			// 确认永不触发 → 锁一直 verified=false → 30s 冻结共识把"不动候选"
			// 判死 → 全量重扫循环。站桩但锁位置有副本簇 = 活槽 → 直接确认
			// （但不写 known——"没动过"的槽不值得记忆，避免神庙槽污染 known）。
			if hasPrev && frozenN >= frozenConfirmTicks && time.Since(lastConfirmAt) >= frozenConfirmEvery {
				if loc.stationaryConfirm(h, a, cur) {
					lock.mu.Lock()
					if !lock.verified {
						fmt.Printf("  [sm] lock 0x%X frozen steady (idle, copy) - confirmed\n", a)
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
		// 单偏移（无候选）不动作：站桩与锁错在单偏移下不可分，误回扫会卡游戏。
		// Eden 特化：coords 校准锁并入观察；"动"判据收紧为净位移 >moveNet
		// （抖动免疫）；观察超时 knownWatchMax 无活槽 → 按观察期是否有净位移
		// 区分：全静止 = 站桩（锁住就信，保持锁）；有净位移 = 玩家在动但 known
		// 全失效 → 重扫（覆盖 Eden 绝对地址失效的卡死场景）。
		if (lockSrc == "known" || lockSrc == "coords") && !lockVer && !knownSeenMove && !knownWatchOn && time.Since(knownLockAt) >= knownConfirmWin {
			knownWatchOn = true
			knownWatchAt = time.Now()
			knownWatchAddrs = loc.knownWatchAddrs(a)
			knownWatchBase = map[uintptr][3]float32{}
			knownWatchMoved = make([]int, len(knownWatchAddrs))
			watchAnyMove = false
			fmt.Printf("  [sm] known lock not confirmed %.0fs - watching %d other offset(s)\n",
				knownConfirmWin.Seconds(), len(knownWatchAddrs))
		}
		if knownWatchOn && time.Since(knownWatchAt) >= knownWatchEvery {
			knownWatchAt = time.Now()
			mvNet := loc.knownWatchMoveNet()
			for i, adr := range knownWatchAddrs {
				d := loc.decode(h, adr)
				if d == nil {
					continue
				}
				v := [3]float32{d[0], d[1], d[2]}
				if b, ok := knownWatchBase[adr]; ok {
					if dist3(v, b) > mvNet { // 相对观察起点的净位移（抖动来回抵消）
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
				if d := loc.decode(h, adr); d != nil {
					// 位置闸门（Eden 30m；Ryujinx 极大值=不拒）：known 列表可能含
					// 远处地址，换锁候选必须距本锁读数闸门内（玩家走动中槽轮换时
					// 新副本位置连续；远处死槽/NPC 槽被拒）。
					if dist3([3]float32{d[0], d[1], d[2]}, cur) >= loc.knownWatchNear() {
						fmt.Printf("  [sm] known watch: 0x%X moving but rejected (%.0fm away) - ignore\n",
							adr, dist3([3]float32{d[0], d[1], d[2]}, cur))
						loc.knownFailInc(stale)
						knownWatchOn = false
						knownWatchAddrs = nil
						continue
					}
					loc.knownFailInc(stale)
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
			// 观察超时（Eden 60s；Ryujinx 0=不超时）：known 记忆可能全失效。
			if watchMax := loc.knownWatchMax(); watchMax > 0 && time.Since(knownWatchAt) > watchMax {
				knownWatchOn = false
				knownWatchAddrs = nil
				if watchAnyMove {
					// 玩家在动但观察不到活槽（known 全失效）→ 重扫重新锚定
					fmt.Println("  [sm] known watch timeout with activity - rescanning")
					loc.onRescan()
					inLocked = false
					goUnlocked("known watch timeout - rescanning")
					continue
				}
				// 观察期全静止 = 玩家站桩 → 锁住就信，保持锁
				fmt.Println("  [sm] known watch timeout, pool idle - holding lock (stationary)")
			}
		}

		// 神庙/洞穴本地场景（Eden；Ryujinx 原样输出）：进神庙瞬间记录入口
		// 大地图坐标，神庙内 /pos 恒输出入口坐标（红点停门口）+ source
		// "shrine-hold"；出神庙后自动恢复正常。启动即在神庙（无入口锚点）→
		// 保持 ok=false "shrine-no-anchor"（不输出神庙本地坐标画错地图）。
		lock.mu.RLock()
		verified, copies, src := lock.verified, lock.copies, lock.source
		lock.mu.RUnlock()
		out, outSrc := cur, src
		if o, s := loc.shrine(cur); s == "shrine-no-anchor" {
			state.mu.Lock()
			state.ok = false
			state.source = "shrine-no-anchor"
			state.mu.Unlock()
			prev = cur
			hasPrev = true
			continue
		} else if s != "" {
			// Eden 神庙 hold：输出入口坐标 + source "shrine-hold"；
			// s==""（Ryujinx / Eden 非神庙）保持锁的原始 source。
			out, outSrc = o, s
		}

		// 更新 STATE（/pos 输出口径与 live-go 一致）
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
		// 无重扫——站桩锁住就信；玩家动后 1~2s 内自愈）。
		if frozenN >= frozenTicks && time.Since(lastConsensusAt) >= consensusEvery {
			lastConsensusAt = time.Now()
			a2, v2, ok := loc.consensusCopy(h, a)
			if !ok {
				consensusCand = 0
			} else if a2 != consensusCand {
				consensusCand, consensusCandPos = a2, v2
				fmt.Printf("  [sm] lock frozen %.0fs, consensus candidate 0x%X (%.0fm away) - watching\n",
					frozenTicks*smTick.Seconds(), a2, dist3(v2, cur))
			} else if dist3(v2, consensusCandPos) > loc.consensusMoveNet() {
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
