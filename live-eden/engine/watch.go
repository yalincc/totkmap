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
	probeCopyKeep = 0.7                    // 换锁候选 copies 不得低于本锁的这个比例（copies 是主导维度）
	frozenTicks   = 150                    // 锁读数停滞 tick 数（30s）→ 启动共识兜底检查
	consensusMin  = 3                      // 共识簇最少成员数
	consensusDist = 15.0                   // 共识位置与本锁读数的最小差
	consensusEvery = 1 * time.Second       // 共识检查间隔
	reLocateCooldown = 90 * time.Second    // 冻结无共识 → 全量重锚 冷却（防站桩每 30s 重扫）
	// known 锁确认窗口（2026-10-02 实测补丁）：known 锁上后 30s 内从未出现
	// 移动采样（锁错垃圾槽时玩家走动读数也不变），进入交替观察——轮读 known
	// 列表其他偏移（微秒级），谁在动就是真玩家槽。秒锁正常 0.5s 就确认，
	// 窗口只惩罚锁错的场景，站桩玩家零开销。
	knownConfirmWin = 30 * time.Second
	knownWatchEvery = 400 * time.Millisecond // 交替观察采样周期
	knownWatchMoveN = 2                      // 观察偏移移动采样次数 ≥ 此值 → 判活槽
)

// Eden 版冻结纠偏增强：
// knownPool：最近一次全量扫描的候选组代表地址（同会话内有效），冻结共识的成员来源，
// 解决 known_addrs.json 只有 1-2 条绝对地址、凑不够 consensusMin=3 成员簇的问题。
// bypassKnown：冻结无共识 / /rescan 时置位，强制跳过 known 快路径直接全量扫描，
// 避免"锁回同一个冻结槽 → 再冻结"的死循环。
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
	lastScanAt = time.Time{} // 解锁后下一拍立即扫描；15s 冷却只约束"扫不到"的重试
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

		// ---- UNLOCKED：known 快路径优先（秒锁、零扫描），失败再全量扫描 ----
		// Fix 6：原顺序是"扫描先行、known 只当扫描失败备胎"，且 lastScanAt 初始为
		// 零值导致启动第一拍必扫描 6GB。调成 known 优先：偏移记忆有效时毫秒级锁定，
		// 无效（游戏重启/换场景后读不到）才走扫描，扫描仍是永久兜底。
		if !inLocked {
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
		invalidN = 0
		cur := [3]float32{v[0], v[1], v[2]}
		delta := dist3(cur, prev)

		// 传送：verified 锁的大位移就是真传送，直接接受新位置（零扫描）。
		// 未 verified 的锁出现大位移 = 坏槽跳变，回扫。
		if hasPrev && delta > teleportDist {
			lock.mu.RLock()
			ver := lock.verified
			lock.mu.RUnlock()
			if ver {
				incCounter("jumps")
				frozenN = 0
				fmt.Printf("  [sm] teleport jump %.0fm accepted in place (no scan)\n", delta)
			} else {
				inLocked = false
				goUnlocked(fmt.Sprintf("teleport jump %.0fm on unverified lock -> rescan", delta))
				continue
			}
		}

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
		}

		// ---- known 锁确认窗口（2026-10-02 实测补丁，见常量 knownConfirmWin）----
		// 锁上 30s 从未出现移动采样 → 交替观察 known 列表其他偏移（微秒级），
		// 谁在动就是真玩家槽：换锁并给旧锁记 fail（连续 knownEvictFail 次移出）。
		// 单偏移（无候选）不动作：站桩与锁错在单偏移下不可分，误回扫会卡游戏；
		// 该场景靠传送跳变 / 读失效 / 游戏重启兜底。
		if lockSrc == "known" && !lockVer && !knownSeenMove && !knownWatchOn && time.Since(knownLockAt) >= knownConfirmWin {
			knownWatchOn = true
			knownWatchAt = time.Now()
			knownWatchAddrs = knownOffsetsForWatch(a)
			knownWatchBase = map[uintptr][3]float32{}
			knownWatchMoved = make([]int, len(knownWatchAddrs))
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
				b, ok := knownWatchBase[adr]
				knownWatchBase[adr] = v
				if ok && dist3(v, b) > moveDist {
					knownWatchMoved[i]++
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
		}

		// 更新 STATE（/pos 输出口径与旧版一致）
		lock.mu.RLock()
		verified, copies, src := lock.verified, lock.copies, lock.source
		lock.mu.RUnlock()
		state.mu.Lock()
		state.ok = true
		state.gx, state.gy, state.gz = cur[0], cur[1], cur[2]
		state.mx, state.my = -cur[1], cur[0]
		state.layer = layerOf(cur[0], cur[1], cur[2])
		state.age = float64(time.Now().UnixNano()) / 1e9
		state.verified = verified
		state.copies = copies
		state.source = src
		state.mu.Unlock()
		prev = cur
		hasPrev = true

		// 冻结共识兜底（零扫描）：锁读数停滞 ≥30s 时，找 known 偏移里与本锁
		// 差 >15m 的 ≥3 成员一致簇作候选；候选在下一次检查"动了"（活副本证明）
		// 才换锁——玩家站桩时绝不误换，玩家一动 1~2s 内自愈。
		if frozenN >= frozenTicks && time.Since(lastConsensusAt) >= consensusEvery {
			lastConsensusAt = time.Now()
			a2, v2, ok := consensusCopy(h, a)
			if !ok {
				consensusCand = 0
				// Eden 新增兜底：known 地址/候选池凑不够 ≥3 一致簇（站桩但槽已迁
				// 移、或池内全失效）→ 无法零扫描自愈 → 回退全量扫描重新锚定。
				// bypassKnown 防止重锚前 known 快路径又把同一个冻结槽锁回来。
				// 冷却 reLocateCooldown：玩家站桩时槽合法，重扫锁回同槽即可，
				// 无需每 30s 重复；真传送/迁移后一次重扫即自愈。
				if time.Since(lastRelocateAt) >= reLocateCooldown {
					lastRelocateAt = time.Now()
					bypassKnown = true
					inLocked = false
					goUnlocked("frozen without consensus - rescanning")
				}
			} else if a2 != consensusCand {
				consensusCand, consensusCandPos = a2, v2
				fmt.Printf("  [sm] lock frozen %.0fs, consensus candidate 0x%X (%.0fm away) - watching\n",
					frozenTicks*smTick.Seconds(), a2, dist3(v2, cur))
			} else if dist3(v2, consensusCandPos) > moveDist {
				// 候选位置变了 = 活副本在跟随玩家 → 换锁
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
