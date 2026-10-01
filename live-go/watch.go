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
	pid := findPid("ryujinx")
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
	fmt.Printf("  [proc] re-attached to Ryujinx pid=%d\n", pid)
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

// tryOffsets known 快路径：把记住的偏移 rebase 到当前块并读取（多副本一致才算数）。
func tryOffsets() (uintptr, [3]float32, bool) {
	if !reopenProcess() {
		return 0, [3]float32{}, false
	}
	h := procHandleNow()
	base := currentSessionBase
	if base == 0 {
		base = loadKnownBlock()
	}
	if base == 0 {
		base = guestRamBase()
	}
	if base == 0 {
		return 0, [3]float32{}, false
	}
	guestBase.Store(base)
	offs := loadOffsets()
	type val struct {
		addr uintptr
		pos  [3]float32
	}
	var vals []val
	for _, o := range offs {
		if v := decodePos(readMem(h, base+o, 12)); v != nil {
			vals = append(vals, val{base + o, [3]float32{v[0], v[1], v[2]}})
		}
	}
	if len(vals) == 0 {
		return 0, [3]float32{}, false
	}
	best, bestN := val{}, -1
	for _, a := range vals {
		n := 0
		for _, b := range vals {
			if abs32(a.pos[0]-b.pos[0]) < 2 && abs32(a.pos[1]-b.pos[1]) < 2 && abs32(a.pos[2]-b.pos[2]) < 2 {
				n++
			}
		}
		if n > bestN {
			best, bestN = a, n
		}
	}
	if bestN < 2 && len(offs) > 1 {
		return 0, [3]float32{}, false
	}
	return best.addr, best.pos, true
}

// ---- 块世代：Ryujinx 重开游戏后新旧 guest DRAM 块并存（旧块残留上次会话玩家槽）----
// 扫描时发现"从未见过的新块"判定为游戏重启/块重建 → 只扫新块、回 UNLOCKED。
var (
	knownBlocks        []uintptr
	currentSessionBase uintptr
)

// detectNewBlocks：对比本次扫描块与已知块，返回从未见过的新块 base 列表。
// 返回非空 = 游戏重启/块重建（knownBlocks 只保留新块）。
// 首次（knownBlocks 空）：以 known_addrs 记录的 block 为"上次会话块"参照，
// 当前块 ≠ 参照块 → 判定新会话（TOTKNavi 与游戏同时重启也能识别）。
func detectNewBlocks(blocks []struct{ Base, Size uintptr }) []uintptr {
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
				// 参照块还在 → 游戏未重启（同一会话）→ 全部记 known，不触发
				for _, b := range blocks {
					knownBlocks = append(knownBlocks, b.Base)
				}
				return nil
			}
			// 参照块不在 → 游戏重启 → 当前全部块都是新会话
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

// consensusCopy 在 known 偏移里找最大一致簇（互相 <2m，排除本锁地址）。
// 返回簇的一个代表地址与位置；成员 < consensusMin 视为无共识。
func consensusCopy(h uintptr, exclude uintptr) (uintptr, [3]float32, bool) {
	base := currentSessionBase
	if base == 0 {
		base = loadKnownBlock()
	}
	if base == 0 {
		return 0, [3]float32{}, false
	}
	type val struct {
		addr uintptr
		pos  [3]float32
	}
	var vals []val
	for _, o := range loadOffsets() {
		adr := base + o
		if adr == exclude {
			continue
		}
		if d := decodePos(readMem(h, adr, 12)); d != nil {
			vals = append(vals, val{adr, [3]float32{d[0], d[1], d[2]}})
		}
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
	}

	tick := time.NewTicker(smTick)
	defer tick.Stop()
	genN := 0 // 块世代检测计数（15 tick ≈ 3s）

	for range tick.C {
		// 0) Ryujinx 附着（同 pid 时开销可忽略；未运行则等待）
		if !reopenProcess() {
			if inLocked {
				inLocked = false
				goUnlocked("Ryujinx lost")
			} else {
				state.mu.Lock()
				state.ok = false
				state.source = "waiting for Ryujinx"
				state.mu.Unlock()
			}
			continue
		}
		h := procHandleNow()

		// 1) 游戏重启检测（每 ~3s）：出现从未见过的新块 → 只扫新块 + 回 UNLOCKED
		genN++
		if genN >= 15 {
			genN = 0
			if blks := guestBlocks(h, minBlockMB); len(blks) > 0 {
				if newOnes := detectNewBlocks(blks); newOnes != nil {
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

		// 2) /rescan 请求：回 UNLOCKED 立即重扫
		select {
		case <-rescanCh:
			lastScanAt = time.Time{}
			if inLocked {
				inLocked = false
				goUnlocked("/rescan requested")
			}
		default:
		}

		// ---- UNLOCKED：扫描先行（解锁时冷却已清零），known 作为扫描失败期间的备胎 ----
		if !inLocked {
			if useSaveScan && time.Since(lastScanAt) >= scanCooldown {
				lastScanAt = time.Now()
				res := locate(procPID, 120.0, sessionBlocks(h), func(s string) { fmt.Println("    " + s) })
				if res != nil {
					setLock(res.Addr, false, res.Copies, "scan")
					inLocked = true
					resetFollow()
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
			if time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := tryOffsets(); ok {
					setLock(a, false, 0, "known")
					inLocked = true
					resetFollow()
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

		// 移动确认：连续 3 次采样位移 >0.5m → verified（写 known 记忆）
		if hasPrev && delta > moveDist {
			moveN++
			frozenN = 0
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
					saveKnown([]uintptr{a}, currentSessionBase)
				}
			}
		} else {
			moveN = 0
			if hasPrev {
				frozenN++
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
