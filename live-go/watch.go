// 定位核心（重构版）：单一状态机。
// 设计见《TOTKmap go定位核心重构方案.md》：一个 goroutine 5Hz 循环独占 lock.addr，
// 两态循环——UNLOCKED（known 快路径 / 存档锚点扫描 → 锁定）与 LOCKED（读数跟随、
// 移动确认 verified、传送检测、30s 站桩核对）。判据只有三条硬规则：
//   读数失效 ×3 / 相邻采样位移 >300m（传送）/ 站桩核对位置差 >15m → 回 UNLOCKED 重扫。
// 已删除旧版的多事件源机制：teleportCh、jitterCheck 黑名单、组内 swap、
// watchShortlist 多 goroutine、betterStruct/betterMoved/betterIdle 多级策略、
// verifyKnown、watchdog、motion scan。块世代检测与 known_addrs 记忆保留。

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

// tryOffsets known fast path：把记住的偏移 rebase 到当前块并读取（多副本一致才算数）。
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
	smTick       = 200 * time.Millisecond // 5Hz 循环
	invalidMax   = 3                      // 连续读数无效次数 → 回 UNLOCKED
	teleportDist = 300.0                  // 相邻采样位移超过 → 判传送，回 UNLOCKED
	moveDist     = 0.5                    // 移动确认最小位移（游戏单位/采样）
	moveConfirmN = 3                      // 连续移动采样次数 → verified
	reconEvery   = 30 * time.Second       // 站桩核对周期
	reconDist    = 15.0                   // 站桩核对允许位置差
	scanCooldown = 15 * time.Second       // UNLOCKED 全量扫描重试间隔
	knownRetry   = 1 * time.Second        // UNLOCKED known 快路径重试间隔
)

var (
	rescanCh   chan struct{} // /rescan 请求（server.go → requestRescan）
	reconCh    chan reconRes // 站桩核对结果（缓冲 1，仅状态机消费）
	reconBusy  atomic.Bool
	lastScanAt time.Time
	useSaveScan = true // --no-save 时关闭存档锚点扫描（known 快路径不受影响）
	// skipKnownOnce：启动/游戏重启后首轮跳过 known 快路径——旧块残留偏移
	// rebase 到新块后可能"值可读但位置错误"，先靠扫描建立本次会话的锁。
	skipKnownOnce bool
)

type reconRes struct {
	found bool
	hud   [3]float32
}

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

// stateMachine 定位主循环：全程序只有这里写 lock.addr。
func stateMachine() {
	rescanCh = make(chan struct{}, 1)
	reconCh = make(chan reconRes, 1)

	inLocked := false
	var prev [3]float32 // 上一次有效读数（hud 序）
	hasPrev := false
	moveN := 0        // 连续移动采样计数（≥moveConfirmN → verified）
	movedWin := false // 本核对周期内出现过移动（锁活性证明）
	savedKnown := false
	invalidN := 0
	lastReco := time.Now()
	lastKnownAt := time.Now().Add(-knownRetry)

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
					skipKnownOnce = true
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

		// 3) 消费站桩核对结果（未锁定时结果作废直接丢弃）
		select {
		case r := <-reconCh:
			if inLocked && r.found {
				lock.mu.RLock()
				a := lock.addr
				lock.mu.RUnlock()
				if a != 0 {
					if v := decodePos(readMem(h, a, 12)); v != nil {
						cur := [3]float32{v[0], v[1], v[2]}
						d := dist3(r.hud, cur)
						if d > reconDist {
							inLocked = false
							goUnlocked(fmt.Sprintf("idle check mismatch: scan %.0fm away from lock", d))
							continue
						}
						fmt.Printf("  [sm] idle check ok (scan dist %.0fm) - lock stands\n", d)
					}
				}
			}
		default:
		}

		// ---- UNLOCKED：known 快路径 → 存档锚点全量扫描 → 锁定候选 ----
		if !inLocked {
			if !skipKnownOnce && time.Since(lastKnownAt) >= knownRetry {
				lastKnownAt = time.Now()
				if a, v, ok := tryOffsets(); ok {
					setLock(a, false, 0, "known")
					inLocked = true
					hasPrev, moveN, movedWin, savedKnown, invalidN = false, 0, false, false, 0
					lastReco = time.Now()
					fmt.Printf("  [sm] known offset -> lock 0x%X mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
						a, v[0], v[1], v[2])
					continue
				}
			}
			if useSaveScan && time.Since(lastScanAt) >= scanCooldown {
				lastScanAt = time.Now()
				skipKnownOnce = false // 扫过一次后 known 快路径恢复可用
				res := locate(procPID, 120.0, sessionBlocks(h), func(s string) { fmt.Println("    " + s) })
				if res != nil {
					setLock(res.Addr, false, res.Copies, "scan")
					inLocked = true
					hasPrev, moveN, movedWin, savedKnown, invalidN = false, 0, false, false, 0
					lastReco = time.Now()
					fmt.Printf("  [sm] scan -> lock 0x%X copies=%d struct=%d mem=(%.1f, %.1f, %.1f) [pending move confirm]\n",
						res.Addr, res.Copies, res.Struct, res.Hud[0], res.Hud[1], res.Hud[2])
				} else {
					fmt.Println("  [sm] scan found nothing - retrying")
				}
			}
			continue
		}

		// ---- LOCKED：读锁地址 → 跟随 / 校验 ----
		lock.mu.RLock()
		a := lock.addr
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

		// 传送检测：相邻采样位移 >300m → 立即回 UNLOCKED 重扫
		if hasPrev && delta > teleportDist {
			incCounter("jumps")
			inLocked = false
			goUnlocked(fmt.Sprintf("teleport jump %.0fm", delta))
			continue
		}

		// 移动确认：连续 3 次采样位移 >0.5m → verified（写 known 记忆）
		if hasPrev && delta > moveDist {
			moveN++
			movedWin = true
			if moveN >= moveConfirmN {
				lock.mu.Lock()
				if !lock.verified {
					fmt.Printf("  [sm] lock 0x%X confirmed live (moving)\n", a)
					lock.verified = true
				}
				lock.mu.Unlock()
				if !savedKnown {
					savedKnown = true
					saveKnown([]uintptr{a}, currentSessionBase)
				}
			}
		} else {
			moveN = 0
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

		// 站桩核对：每 30s 一次全量扫描，扫描候选与锁位置差 >15m → 重扫。
		// 只在"本周期无移动"时执行——移动本身就是锁活性证明，冻结的锁不会动；
		// 移动期间扫描会拖出轨迹簇，核对结果不可靠（旧版误杀的根源）。
		if time.Since(lastReco) >= reconEvery {
			lastReco = time.Now()
			if movedWin {
				movedWin = false
			} else if !reconBusy.Swap(true) {
				go runReconcile(h, prev)
			}
		}
	}
}

// runReconcile 后台执行站桩核对扫描（只算结果，不写锁——状态机是唯一写者）。
func runReconcile(h uintptr, cur [3]float32) {
	defer reconBusy.Store(false)
	res := locate(procPID, 120.0, sessionBlocks(h), nil)
	r := reconRes{}
	if res != nil {
		r.found = true
		r.hud = res.Hud
	}
	select { // 先清掉可能滞留的旧结果，保证消费到的是本次扫描
	case <-reconCh:
	default:
	}
	select {
	case reconCh <- r:
	default:
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
