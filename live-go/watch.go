// 运行状态机：坐标轮询、看门狗、校验、短名单监听、运动扫描兜底。
// 完全对应 Python start.py 的 poll / watchdog / verify_known /
// watch_shortlist / relocalize / locate_by_motion。

package main

import (
	"fmt"
	"math"
	"sort"
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
	mu       sync.RWMutex
	ok       bool
	gx, gy, gz float32 // gx=X东, gy=Y北, gz=Z高
	mx, my   float32   // 地图像素
	layer    int
	age      float64
	verified bool
	copies   int
	source   string
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

// guestRamBase 返回最大 guest DRAM 块（known fast path 用）。
func guestRamBase() uintptr {
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	if h == 0 {
		return 0
	}
	base, _ := largestGuestBlock(h, 1024.0)
	return base
}

// tryOffsets known fast path：把记住的偏移 rebase 到当前块并读取。
func tryOffsets() (uintptr, [3]float32, bool) {
	if !reopenProcess() {
		return 0, [3]float32{}, false
	}
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	base := guestRamBase()
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

// poll 10Hz 把锁定的地址镜像到 STATE。
// 跳变过滤：打开暂停菜单/过场动画时相机 actor 会跳变（如果误锁到相机），
// 单次位移 >10 米视为可疑；连续 3 次才确认新坐标（快速旅行后位置稳定）。
var (
	lastPollGx, lastPollGy, lastPollGz float32
	bigJumpN                           int
)

func poll() {
	for {
		lock.mu.RLock()
		a := lock.addr
		verified := lock.verified
		copies := lock.copies
		src := lock.source
		lock.mu.RUnlock()

		var v []float32
		if a != 0 {
			procMu.Lock()
			h := procHandle
			procMu.Unlock()
			if h != 0 {
				v = decodePos(readMem(h, a, 12))
			}
		}
		state.mu.Lock()
		if v != nil {
			gx, gy, gz := v[0], v[1], v[2]
			// 跳变过滤：与上一个有效坐标比
			accept := true
			if state.ok && lastPollGx != 0 {
				dx, dy, dz := gx-lastPollGx, gy-lastPollGy, gz-lastPollGz
				delta := float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
				if delta > pollJumpMax {
					bigJumpN++
					if bigJumpN < pollJumpConfirmN {
						accept = false
					} else {
						fmt.Printf("  [poll] big jump %.1fm x%d -> accept new position\n", delta, pollJumpConfirmN)
					}
				} else {
					bigJumpN = 0
				}
			}
			if accept {
				lastPollGx, lastPollGy, lastPollGz = gx, gy, gz
				state.ok = true
				state.gx, state.gy, state.gz = gx, gy, gz
				state.mx, state.my = -gy, gx
				state.layer = layerOf(gx, gy, gz)
				state.verified = verified
				state.copies = copies
				state.source = src
			}
			state.age = float64(time.Now().UnixNano()) / 1e9
		} else {
			state.ok = false
			if a != 0 {
				state.source = "address lost"
			} else {
				state.source = "locating..."
			}
		}
		state.mu.Unlock()
		time.Sleep(100 * time.Millisecond)
	}
}

// poll 跳变过滤参数（见 poll 注释）。
const (
	pollJumpMax      = 10.0 // 单次采样位移上限（游戏单位）：正常走/跑/骑远小于此；菜单/过场/坏槽会超
	pollJumpConfirmN = 3   // 连续 N 次大跳变才确认新坐标（快速旅行后位置稳定；菜单跳变只有 1-2 次）
)

// watchShortlist 锁定真正在动的候选组。
func watchShortlist(sl []ShortlistEntry) {
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	if h == 0 {
		return
	}
	type addrState struct {
		base  [3]float32
		moved int
	}
	states := map[uintptr]*addrState{}
	groupMoved := make([]int, len(sl))
	for gi, g := range sl {
		for _, a := range g.Addrs {
			if d := readMem(h, a, 12); d != nil && len(d) >= 12 {
				f := floats(d[:12])
				states[a] = &addrState{base: [3]float32{f[0], f[1], f[2]}}
				_ = gi
			}
		}
	}
	confirmed := -1
	started := time.Now()
	for {
		time.Sleep(600 * time.Millisecond)
		procMu.Lock()
		h = procHandle
		procMu.Unlock()
		if h == 0 {
			continue
		}
		for gi, g := range sl {
			for _, a := range g.Addrs {
				d := readMem(h, a, 12)
				if d == nil || len(d) < 12 {
					continue
				}
				f := floats(d[:12])
				v := [3]float32{f[0], f[1], f[2]}
				st, ok := states[a]
				if !ok {
					states[a] = &addrState{base: v}
					continue
				}
				if abs32(v[0]-st.base[0]) > 0.5 || abs32(v[1]-st.base[1]) > 0.5 || abs32(v[2]-st.base[2]) > 0.5 {
					st.moved++
					groupMoved[gi]++
				}
				st.base = v
			}
		}
		// 选组：moved>=3 的组按 struct 高 → dist 小；站桩 30s 后兜底锁
		pick := -1
		for gi := range sl {
			if groupMoved[gi] >= 3 {
				if pick < 0 || betterShortlist(sl, gi, pick) {
					pick = gi
				}
			}
		}
		if pick < 0 && time.Since(started) > 30*time.Second {
			pick = 0
			for gi := 1; gi < len(sl); gi++ {
				if betterShortlist(sl, gi, pick) {
					pick = gi
				}
			}
		}
		// 防抖：当前锁槽读数在本轮监听中仍在更新（moved>0）→ 不切换。
		// 真玩家槽的多个副本组会同时移动，频繁横跳会让 poll 反复跳变确认；
		// 只有锁槽变死（玩家移动它不再同步）才允许切到其他移动组。
		curMoving := false
		if confirmed >= 0 {
			lock.mu.RLock()
			la := lock.addr
			lock.mu.RUnlock()
			if st, ok := states[la]; ok && st.moved > 0 {
				curMoving = true
			}
		}
		if pick >= 0 && pick != confirmed && !curMoving {
			// 锁组内 moved 最高的地址（副本组里"会动"的那个才是真槽）
			a := uintptr(0)
			bestM := -1
			for _, cand := range sl[pick].Addrs {
				if st, ok := states[cand]; ok && st.moved > bestM {
					bestM, a = st.moved, cand
				}
			}
			if a == 0 {
				a = sl[pick].Addrs[0]
			}
			confirmed = pick
			lock.mu.Lock()
			lock.addr = a
			lock.verified = true
			lock.copies = sl[pick].Copies
			lock.source = "scan"
			lock.mu.Unlock()
			addrs := loadKnownAddrs()
			addrs = append(addrs, a)
			saveKnown(addrs, guestBase.Load())
			fmt.Printf("  [watch] locked onto group %d: copies=%d struct=%d mem=%v (addr 0x%X, moved=%d)\n",
				pick, sl[pick].Copies, sl[pick].Struct, sl[pick].Hud, a, bestM)
			// 锁到新槽后重置计数：只累计"本次锁定后"的移动（切换依据）
			groupMoved = make([]int, len(sl))
			for _, st := range states {
				st.moved = 0
			}
		}
	}
}

// betterShortlist 与 locate.go 排序同口径：struct>0 硬优先 → struct 降序 →
// dist 升序 → copies 降序。
func betterShortlist(sl []ShortlistEntry, i, j int) bool {
	a, b := sl[i], sl[j]
	aLive, bLive := a.Struct > 0, b.Struct > 0
	if aLive != bLive {
		return aLive
	}
	if a.Struct != b.Struct {
		return a.Struct > b.Struct
	}
	if a.Dist != b.Dist {
		return a.Dist < b.Dist
	}
	return a.Copies > b.Copies
}

func loadKnownAddrs() []uintptr {
	// 已知偏移转绝对地址（当前块）
	base := guestBase.Load()
	if base == 0 {
		return nil
	}
	var out []uintptr
	for _, o := range loadOffsets() {
		out = append(out, base+o)
	}
	return out
}

// verifyKnown 后台校验锁定的地址，读不到时重新定位。
// 死槽保护：remembered-offset 快速路径（source="known"）可能锁到 Ryujinx 重启后
// 残留的旧坐标槽——地址可读、数值合理但永不更新。此时 verifyKnown 永远等不到
// "移动"信号（verified 一直 false），位置追踪/导航/收集全部按错误坐标工作。
// 处理：known 地址长时间无移动 → 按存档锚点重新扫描定位（20s 首试，失败后 2min 重试）。
func verifyKnown(addr uintptr) {
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	if h == 0 {
		return
	}
	prev := decodePos(readMem(h, addr, 12))
	bad := 0
	smoothN := 0
	staleSince := time.Now()
	staleGap := 20 * time.Second
	for {
		time.Sleep(300 * time.Millisecond)
		lock.mu.RLock()
		curAddr := lock.addr
		lock.mu.RUnlock()
		if curAddr != addr {
			return
		}
		procMu.Lock()
		h = procHandle
		procMu.Unlock()
		if h == 0 {
			return
		}
		cur := decodePos(readMem(h, addr, 12))
		if cur == nil {
			bad++
			if bad == 2 {
				reopenProcess()
			}
			if bad >= 4 {
				if a, v, ok := tryOffsets(); ok {
					fmt.Printf("  [verify] re-based offset onto new block -> 0x%X mem=(%.1f, %.1f, %.1f)\n", a, v[0], v[1], v[2])
					lock.mu.Lock()
					lock.addr = a
					lock.verified = false
					lock.copies = 0
					lock.source = "known"
					lock.mu.Unlock()
					go verifyKnown(a) // 新地址需要新 goroutine 校验；本实例退出
					return
				}
			}
			if bad >= 10 {
				fmt.Println("  [verify] address went bad - re-locating")
				lock.mu.Lock()
				lock.addr = 0
				lock.verified = false
				lock.mu.Unlock()
				relocalize("remembered address became unreadable")
				return
			}
			continue
		}
		bad = 0
		// 位移量（游戏单位/次采样 ≈ 0.3s）。正常走/跑/骑/滑翔单次采样位移远小于
		// verifyJumpMax；快传、读错槽、或跳到无关数据才会出现大跳变。
		delta := float32(math.Inf(1))
		if prev != nil {
			dx, dy, dz := cur[0]-prev[0], cur[1]-prev[1], cur[2]-prev[2]
			delta = float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
		}
		// 平滑移动：位移在 (verifyMoveMin, verifyJumpMax) 区间，且连续多次才确认。
		// 避免把"静止时抖动"或"坏槽跳变"误判为玩家在移动。
		if prev != nil && delta > verifyMoveMin && delta < verifyJumpMax {
			smoothN++
		} else {
			smoothN = 0
		}
		if smoothN >= verifySmoothN {
			lock.mu.Lock()
			if !lock.verified {
				fmt.Printf("  [verify] address 0x%X is live (moving smoothly) -> verified\n", addr)
				lock.verified = true
			}
			lock.mu.Unlock()
		}
		prev = cur
		// 死槽/坏槽保护（仅针对 remembered-offset 快速路径 source="known"）：
		// 未确认期间，地址可读但始终等不到平滑移动——要么是 Ryujinx 重启后残留的
		// 死槽（静止不动），要么是跳到无关数据的坏槽（跳变），都不是玩家坐标槽。
		// 超时后按存档锚点重新扫描定位（20s 首试，失败后 2min 重试）。
		lock.mu.RLock()
		staleSrc := lock.source
		lock.mu.RUnlock()
		if staleSrc == "known" && time.Since(staleSince) >= staleGap {
			// Fix 1：超时无移动 ≠ 死槽——玩家站桩时锁一样「不动」。
			// 先按存档锚点扫描一次：候选位置与当前锁接近（<verifyKeepDist）
			// 说明锁的值就是玩家当前位置 → 站桩，锁有效，直接 verified；
			// 候选与锁差异大才判定死槽/坏槽 → 重新定位。
			// 旧逻辑 20s 无条件 relocalize，站桩玩家会被反复误杀 → 位置漂移。
			cur := decodePos(readMem(h, addr, 12))
			if cur != nil {
				silent := func(string) {}
				if res := locate(procPID, 60.0, silent); res != nil {
					dx, dy, dz := cur[0]-res.Hud[0], cur[1]-res.Hud[1], cur[2]-res.Hud[2]
					scanDist := float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
					if scanDist < verifyKeepDist {
						fmt.Printf("  [verify] player idle (scan dist=%.1fm) - lock valid, keeping\n", scanDist)
						staleSince, staleGap = time.Now(), 60*time.Second
						continue
					}
					fmt.Printf("  [verify] scan dist=%.1fm disagrees -> re-locating\n", scanDist)
				} else {
					fmt.Println("  [verify] idle check scan found nothing -> re-locating")
				}
			}
			fmt.Printf("  [verify] address 0x%X stale/bad (no movement sync) -> re-locating\n", addr)
			relocalize("remembered address is stale or erratic (no smooth movement)")
			if lock.addr != addr {
				return
			}
			staleSince, staleGap = time.Now(), 60*time.Second
		}
	}
}

// verifyKnown 的移动判定参数（见上方注释）。
const (
	verifyMoveMin  = 0.2  // 判定"在移动"的最小位移（游戏单位/采样）
	verifyJumpMax  = 50.0 // 单次采样位移上限：正常移动不可能超过（快传/坏槽会超）
	verifySmoothN  = 3    // 连续 N 次平滑移动才确认 verified
	verifyKeepDist = 15.0 // Fix 1：站桩判定——扫描候选与当前锁的允许距离（m）
)

// relocalize 方案 B：save anchor 扫描 + shortlist 监听。
func relocalize(reason string) bool {
	if !reopenProcess() {
		fmt.Printf("  [relocate] %s -> Ryujinx not running\n", reason)
		return false
	}
	fmt.Printf("  [relocate] %s -> running save-anchor scan\n", reason)
	res := locate(procPID, 60.0, func(s string) { fmt.Println("    " + s) })
	if res == nil {
		fmt.Println("  [relocate] scan found nothing")
		return false
	}
	lock.mu.Lock()
	lock.addr = res.Addr
	lock.verified = false
	lock.copies = res.Copies
	lock.source = "scan"
	lock.mu.Unlock()
	if len(res.Shortlist) > 0 {
		go watchShortlist(res.Shortlist)
	} else {
		lock.mu.Lock()
		lock.verified = true
		lock.mu.Unlock()
	}
	saveKnown(append([]uintptr{res.Addr}, loadKnownAddrs()...), guestBase.Load())
	fmt.Printf("  [relocate] candidate 0x%X mem=(%.1f, %.1f, %.1f) - being watched\n",
		res.Addr, res.Hud[0], res.Hud[1], res.Hud[2])
	return true
}

var lastScanAt = time.Now().Add(-time.Hour)

// watchdog 无需用户操作持续保持锁定。
func watchdog() {
	for {
		time.Sleep(3 * time.Second)
		lock.mu.RLock()
		hasAddr := lock.addr != 0
		src := lock.source
		lock.mu.RUnlock()
		state.mu.RLock()
		ok := state.ok
		state.mu.RUnlock()
		// scan 来源的地址不被 watchdog 覆盖（watchShortlist 刚锁时 poll 可能还没同步）
		if hasAddr && (ok || src == "scan") {
			continue
		}
		if a, v, ok := tryOffsets(); ok {
			first := !hasAddr
			lock.mu.Lock()
			lock.addr = a
			lock.verified = false
			lock.copies = 0
			lock.source = "known"
			lock.mu.Unlock()
			fmt.Printf("  [watchdog] recovered 0x%X mem=(%.1f, %.1f, %.1f)\n", a, v[0], v[1], v[2])
			if first {
				go verifyKnown(a)
			}
			continue
		}
		if time.Since(lastScanAt) > 180*time.Second {
			lastScanAt = time.Now()
			relocalize("watchdog: no remembered offset works")
		}
	}
}

// ---- motion scan（结构性 fallback）----

const (
	motionChunk = 32 << 20
	motionWorkers = 8
	rotTol = 0.2
	motionCountdown = 5
)

type motionJob struct{ base, size uintptr }

func scanChunkMotion(h uintptr, base, size uintptr) []Hit {
	buf := readMem(h, base, int(size)+64)
	if len(buf) < 256 {
		return nil
	}
	a := floats(buf)
	N := len(a) - 12
	var out []Hit
	for s := 0; s < N; s++ {
		x, y, z := a[s], a[s+1], a[s+2]
		if !(abs32(x) > 5 && abs32(x) < 7000 && y > -600 && y < 5000 && abs32(z) > 5 && abs32(z) < 7000) {
			continue
		}
		r0x, r0y, r0z := a[s+3], a[s+4], a[s+5]
		r1x, r1y, r1z := a[s+6], a[s+7], a[s+8]
		r2x, r2y, r2z := a[s+9], a[s+10], a[s+11]
		n0 := r0x*r0x + r0y*r0y + r0z*r0z
		n1 := r1x*r1x + r1y*r1y + r1z*r1z
		n2 := r2x*r2x + r2y*r2y + r2z*r2z
		if abs32(n0-1) >= rotTol || abs32(n1-1) >= rotTol || abs32(n2-1) >= rotTol {
			continue
		}
		d01 := r0x*r1x + r0y*r1y + r0z*r1z
		d02 := r0x*r2x + r0y*r2y + r0z*r2z
		d12 := r1x*r2x + r1y*r2y + r1z*r2z
		if abs32(d01) >= rotTol || abs32(d02) >= rotTol || abs32(d12) >= rotTol {
			continue
		}
		out = append(out, Hit{base + uintptr(s)*4, x, y, z, 0, 0})
	}
	return out
}

func beep(times int) {
	for i := 0; i < times; i++ {
		fmt.Print("\a")
		time.Sleep(120 * time.Millisecond)
	}
}

// locateByMotion 结构性候选 + 走几步差分（save anchor 失效时的兜底）。
func locateByMotion() uintptr {
	procMu.Lock()
	h := procHandle
	procMu.Unlock()
	if h == 0 {
		return 0
	}
	blocks := guestBlocks(h, minBlockMB)
	if len(blocks) == 0 {
		fmt.Println("  guest RAM blocks not found")
		return 0
	}
	var jobs []motionJob
	for _, b := range blocks {
		off := uintptr(0)
		for off < b.Size {
			n := uintptr(motionChunk)
			if b.Size-off < n {
				n = b.Size - off
			}
			jobs = append(jobs, motionJob{b.Base + off, n})
			off += n
		}
	}
	t0 := time.Now()
	var mu sync.Mutex
	var hits []Hit
	wg := sync.WaitGroup{}
	ch := make(chan motionJob)
	for w := 0; w < motionWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				local := scanChunkMotion(h, j.base, j.size)
				if len(local) > 0 {
					mu.Lock()
					hits = append(hits, local...)
					mu.Unlock()
				}
			}
		}()
	}
	for _, j := range jobs {
		ch <- j
	}
	close(ch)
	wg.Wait()
	fmt.Printf("  scan: %d structural candidates in %.0fs\n", len(hits), time.Since(t0).Seconds())
	if len(hits) == 0 {
		return 0
	}
	baseline := map[uintptr][3]float32{}
	for _, hit := range hits {
		baseline[hit.Addr] = [3]float32{hit.X, hit.Y, hit.Z}
	}

	fmt.Println("")
	fmt.Println("  >>> WALK A FEW STEPS IN THE GAME NOW <<<")
	fmt.Println("      (do NOT open the in-game map - it pauses the world)")
	beep(3)
	for i := motionCountdown; i > 0; i-- {
		fmt.Printf("      sampling in %d ...\n", i)
		time.Sleep(1 * time.Second)
	}

	type changedT struct {
		addr uintptr
		pos  [3]float32
	}
	var changed []changedT
	for a, b := range baseline {
		d := readMem(h, a, 12)
		if d == nil || len(d) < 12 {
			continue
		}
		f := floats(d[:12])
		x, y, z := f[0], f[1], f[2]
		if abs32(x-b[0]) < 0.5 && abs32(y-b[1]) < 0.5 && abs32(z-b[2]) < 0.5 {
			continue
		}
		if !(abs32(x) < 7000 && abs32(z) < 7000 && y > -600 && y < 5000 && (abs32(x) > 5 || abs32(z) > 5)) {
			continue
		}
		changed = append(changed, changedT{a, [3]float32{x, y, z}})
	}
	fmt.Printf("  %d of %d addresses moved\n", len(changed), len(baseline))
	if len(changed) == 0 {
		fmt.Println("  nothing moved. Re-run and walk during the countdown.")
		return 0
	}
	counts := map[[3]int32]int{}
	sample := map[[3]int32]uintptr{}
	for _, c := range changed {
		k := [3]int32{int32(math.Round(float64(c.pos[0]) * 10)), int32(math.Round(float64(c.pos[1]) * 10)), int32(math.Round(float64(c.pos[2]) * 10))}
		counts[k]++
		if _, ok := sample[k]; !ok {
			sample[k] = c.addr
		}
	}
	type kv struct {
		k [3]int32
		n int
	}
	var sorted []kv
	for k, n := range counts {
		sorted = append(sorted, kv{k, n})
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].n > sorted[j].n })
	fmt.Println("  top moved-value clusters:")
	for i := 0; i < len(sorted) && i < 8; i++ {
		fmt.Printf("     %5d copies   mem=(%9.1f, %9.1f, %9.1f)\n",
			sorted[i].n, float32(sorted[i].k[0])/10, float32(sorted[i].k[1])/10, float32(sorted[i].k[2])/10)
	}
	addr := sample[sorted[0].k]
	fmt.Printf("  player locked: copies=%d  address = 0x%X\n", sorted[0].n, addr)
	return addr
}

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
