// locator_ryujinx.go — Ryujinx 定位策略（TOTK live-go V1.8.7 原逻辑）。
//
// 与 live-go 完全一致：known 块+偏移 rebase 快路径、只扫最大 guest DRAM 块、
// 整数三元组拒绝（死槽特征）、verified 传送直接接受、无神庙 hold、
// 无 knownPool / 静止确认 / 净位移判据（默认值）。

package main

import (
	"fmt"
	"math"
	"runtime"
	"sort"
	"sync"
	"time"
)

// ---- 解码与校验（原 live-go locate.go decodePos）----

// decode 读 12 字节内存 → hud 序 (gx=X东, gy=-Y北, gz=Z高)；无效返回 nil。
// TOTK 内存序 = (X, Z_stored, Y_north)，Z_stored = 真实高度 + elevBias(105)。
// 注意：hud gy = -Y北（负北向，与 live-python 的 hud=(X,-my,alt) 一致；前端
// mx=-gy 得到地图北向坐标）。BOTW 是 -Y 北、TOTK 是 +Y 北，这里统一取反。
func (p *ryujinxPlatform) decode(h uintptr, addr uintptr) []float32 {
	d := readMem(h, addr, 12)
	if len(d) < 12 {
		return nil
	}
	a := floats(d[:12])
	gx, zs, yn := a[0], a[1], a[2]
	if a[0] == 0 && a[1] == 0 && a[2] == 0 {
		return nil // 标题/加载画面，槽位未初始化
	}
	gy, gz := -yn, zs-elevBias
	// NaN / Inf 必须单独判：NaN 与任何数比较都是 false，下面的绝对值与范围
	// 检查全都抓不住它（实际症状是会算出 "NaN 米" 这种脏距离）。
	if math.IsNaN(float64(gx)) || math.IsNaN(float64(gy)) || math.IsNaN(float64(gz)) ||
		math.IsInf(float64(gx), 0) || math.IsInf(float64(gy), 0) || math.IsInf(float64(gz), 0) {
		return nil
	}
	// Fix 5：近零残留（原点附近残留）判无效——known 快路径会锁零残留槽。
	// 阈值 5.0 与运动扫描玩家候选门槛一致（真实坐标 |x|,|y| 都 >5）。
	if abs32(gx) < 5 && abs32(gy) < 5 {
		return nil
	}
	// denormal 必须按 1e-6 判，且三轴都要查。旧实现用 1e-20 形同虚设
	// （只有精确 0 才拦得住），且漏掉了 gz 轴 —— 放过"半个槽被覆写"的垃圾值。
	if abs32(gx) < 1e-6 || abs32(gy) < 1e-6 || abs32(gz) < 1e-6 {
		return nil
	}
	// 默认坐标陷阱：未初始化 / 占位 Actor 的坐标常常三轴皆为整齐整数，
	// 而它的副本数量极大，在"副本最多"的排序里稳居第一。
	// 实测 2026-10-02 TOTK：probe 换锁把玩家锁定到这样一个静止的整数坐标槽，
	// 之后 6.5 分钟位置纹丝不动且被标为 verified，再也无法纠偏。
	// 判据取原始内存三元组（未经 elevBias 换算），不受 bias 影响。
	if isWhole32(a[0]) && isWhole32(a[1]) && isWhole32(a[2]) {
		return nil
	}
	if gx <= -6000 || gx >= 6000 || gy <= -6000 || gy >= 6000 ||
		gz <= -1300 || gz >= 3200 {
		return nil
	}
	return []float32{gx, gy, gz}
}

// isWhole32 判断浮点数是否恰等于自己的整数截断值。
// 浮点世界坐标不会三轴同时这么整齐，据此剔除占位 / 未初始化的值。
func isWhole32(v float32) bool {
	if v > 4e9 || v < -4e9 { // 超出 float32 精确表示的整数不用此法判
		return false
	}
	return v == float32(int64(v))
}

// ---- known 快路径（原 live-go watch.go tryOffsets / knownOffsetsForWatch / consensusCopy）----

// tryLock known 快路径：把记住的偏移 rebase 到当前块并读取（顺序优先试读——
// known_addrs.json 里最新写入的偏移最可信，读到合法坐标即锁）。
func (p *ryujinxPlatform) tryLock(h uintptr) (uintptr, [3]float32, bool) {
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
	for _, o := range loadOffsets() {
		if v := p.decode(h, base+o); v != nil {
			return base + o, [3]float32{v[0], v[1], v[2]}, true
		}
	}
	return 0, [3]float32{}, false
}

// knownWatchAddrs known 列表里除当前锁外、rebase 到当前块的全部偏移地址。
func (p *ryujinxPlatform) knownWatchAddrs(cur uintptr) []uintptr {
	base := currentSessionBase
	if base == 0 {
		base = loadKnownBlock()
	}
	if base == 0 {
		base = guestRamBase()
	}
	if base == 0 {
		return nil
	}
	var out []uintptr
	for _, o := range loadOffsets() {
		adr := base + o
		if adr != cur {
			out = append(out, adr)
		}
	}
	return out
}

// consensusCopy 在 known 偏移里找最大一致簇（互相 <2m，排除本锁地址）。
func (p *ryujinxPlatform) consensusCopy(h uintptr, exclude uintptr) (uintptr, [3]float32, bool) {
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
		if d := p.decode(h, adr); d != nil {
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

// ---- known 持久化（委托全局 known.go 的 Ryujinx 实现）----

func (p *ryujinxPlatform) saveKnown(addrs []uintptr, block uintptr) { knownSaveRyu(addrs, block) }
func (p *ryujinxPlatform) knownFailInc(a uintptr)                   { knownFailIncRyu(a) }

// ---- 扫描（原 live-go locate.go 全套）----

// scanBytes 扫描内存缓冲，收集 window 内任一锚点附近的 float32 三元组。
func scanBytes(buf []byte, base uintptr, refs [][3]float32, window float32, hits *[]Hit) {
	if len(buf) < 12 {
		return
	}
	gx0, gx1 := refs[0][0]-window, refs[0][0]+window
	gh0, gh1 := refs[0][1]-window, refs[0][1]+window
	gz0, gz1 := refs[0][2]-window, refs[0][2]+window
	for _, r := range refs[1:] {
		if r[0]-window < gx0 {
			gx0 = r[0] - window
		}
		if r[0]+window > gx1 {
			gx1 = r[0] + window
		}
		if r[1]-window < gh0 {
			gh0 = r[1] - window
		}
		if r[1]+window > gh1 {
			gh1 = r[1] + window
		}
		if r[2]-window < gz0 {
			gz0 = r[2] - window
		}
		if r[2]+window > gz1 {
			gz1 = r[2] + window
		}
	}
	win2 := window * window
	a := floats(buf)
	for i := 0; i+3 <= len(a); i++ {
		x, y, z := a[i], a[i+1], a[i+2]
		if x <= gx0 || x >= gx1 {
			continue
		}
		if y <= gh0 || y >= gh1 {
			continue
		}
		if z <= gz0 || z >= gz1 {
			continue
		}
		bestD, bestRi := float32(1e18), 0
		for ri, r := range refs {
			dx, dy, dz := x-r[0], y-r[1], z-r[2]
			d := dx*dx + dy*dy + dz*dz
			if d < bestD {
				bestD, bestRi = d, ri
			}
		}
		if bestD <= win2 {
			*hits = append(*hits, Hit{base + uintptr(i)*4, x, y, z, bestRi, float32(math.Sqrt(float64(bestD)))})
		}
	}
}

// scanRegion 读进程内存后扫描。
func scanRegion(h uintptr, base, size uintptr, refs [][3]float32, window float32, hits *[]Hit) {
	gx0, gx1 := refs[0][0]-window, refs[0][0]+window
	gh0, gh1 := refs[0][1]-window, refs[0][1]+window
	gz0, gz1 := refs[0][2]-window, refs[0][2]+window
	for _, r := range refs[1:] {
		if r[0]-window < gx0 {
			gx0 = r[0] - window
		}
		if r[0]+window > gx1 {
			gx1 = r[0] + window
		}
		if r[1]-window < gh0 {
			gh0 = r[1] - window
		}
		if r[1]+window > gh1 {
			gh1 = r[1] + window
		}
		if r[2]-window < gz0 {
			gz0 = r[2] - window
		}
		if r[2]+window > gz1 {
			gz1 = r[2] + window
		}
	}
	win2 := window * window
	off := uintptr(0)
	for off < size {
		if len(*hits) > hitCap {
			return
		}
		n := uintptr(chunkSize)
		if size-off < n {
			n = size - off
		}
		buf := readMem(h, base+off, int(n))
		if buf == nil || len(buf) < 12 {
			off += n
			continue
		}
		a := floats(buf)
		for i := 0; i+3 <= len(a); i++ {
			x, y, z := a[i], a[i+1], a[i+2]
			if x <= gx0 || x >= gx1 {
				continue
			}
			if y <= gh0 || y >= gh1 {
				continue
			}
			if z <= gz0 || z >= gz1 {
				continue
			}
			bestD, bestRi := float32(1e18), 0
			for ri, r := range refs {
				dx, dy, dz := x-r[0], y-r[1], z-r[2]
				d := dx*dx + dy*dy + dz*dz
				if d < bestD {
					bestD, bestRi = d, ri
				}
			}
			if bestD <= win2 {
				*hits = append(*hits, Hit{base + off + uintptr(i)*4, x, y, z, bestRi, float32(math.Sqrt(float64(bestD)))})
			}
		}
		off += n
	}
}

// groupAndRank 命中分组打分（方案唯一规则）：
// struct>0 只作活槽门槛（不比较 struct 大小），然后 copies 降序，最后距存档锚点升序。
func groupAndRank(h uintptr, hits []Hit) ([]*Group, []ShortlistEntry) {
	groups := map[[3]int32]*Group{}
	for _, hit := range hits {
		k := [3]int32{
			int32(math.Round(float64(hit.X) * 10)),
			int32(math.Round(float64(hit.Y) * 10)),
			int32(math.Round(float64(hit.Z) * 10)),
		}
		g := groups[k]
		if g == nil {
			g = &Group{Ri: hit.Ri, Dist: hit.Dist, X: hit.X, Y: hit.Y, Z: hit.Z}
			groups[k] = g
		}
		g.Addrs = append(g.Addrs, hit.Addr)
		if hit.Dist < g.Dist {
			g.Dist, g.Ri = hit.Dist, hit.Ri
		}
	}
	var byCopies []*Group
	for _, g := range groups {
		g.Copies = len(g.Addrs)
		byCopies = append(byCopies, g)
	}
	sort.Slice(byCopies, func(i, j int) bool { return byCopies[i].Copies > byCopies[j].Copies })
	top := byCopies
	if len(top) > 30 {
		top = top[:30]
	}
	for _, g := range top {
		for _, a := range g.Addrs {
			if rotOK(h, a) {
				g.Struct++
			}
		}
	}
	sort.Slice(top, func(i, j int) bool {
		a, b := top[i], top[j]
		aLive, bLive := a.Struct > 0, b.Struct > 0
		if aLive != bLive {
			return aLive
		}
		if a.Copies != b.Copies {
			return a.Copies > b.Copies
		}
		return a.Dist < b.Dist
	})
	shortlist := make([]ShortlistEntry, 0, len(top))
	for _, g := range top {
		shortlist = append(shortlist, ShortlistEntry{
			Hud:    [3]float32{g.X, -g.Z, g.Y - elevBias},
			Copies: g.Copies,
			Struct: g.Struct,
			Dist:   g.Dist,
			Slot:   g.Ri,
			Addrs:  g.Addrs[:min(len(g.Addrs), 24)],
		})
	}
	return top, shortlist
}

// locate 主流程：save anchor → 窗口扫描（120 / 400）→ 分组打分。
func (p *ryujinxPlatform) locate(window float64, onlyBlocks []MemBlock, logf func(string)) *LocateResult {
	t0 := time.Now()
	log := func(s string) {
		if logf != nil {
			logf(s)
		}
	}
	anchors := readTotkAnchors()
	if len(anchors) == 0 {
		log("no usable save anchor found")
		return nil
	}
	refs := anchorRefs(anchors, 8, 4.0)
	log(fmt.Sprintf("save anchors: %d file offsets -> %d distinct positions", len(anchors), len(refs)))
	for i, r := range refs {
		log(fmt.Sprintf("  slot#%d mem=(%.1f, %.1f, %.1f)  hud=(%.1f, %.1f, %.1f)",
			i, r[0], r[1], r[2], r[0], -r[2], r[1]-elevBias))
	}

	h := p.Handle()
	if h == 0 {
		log("no platform attached")
		return nil
	}

	// 块枚举实测 6 秒（Ryujinx），走短期缓存；块布局秒级内不会变。
	blocks := blocksCached(p, minBlockMB)
	if onlyBlocks != nil {
		blocks = onlyBlocks
	}
	var total uintptr
	for _, b := range blocks {
		total += b.Size
	}
	log(fmt.Sprintf("RW regions>=%.0fMB: %d  (%.1f GB)", minBlockMB, len(blocks), float64(total)/1073741824.0))
	for _, b := range blocks {
		log(fmt.Sprintf("  region 0x%012X  %8.0f MB", b.Base, float64(b.Size)/1048576.0))
	}

	var best *Group
	var shortlist []ShortlistEntry
	for attempt, win := range []float32{float32(math.Max(window, 120.0)), 400.0} {
		var hits []Hit
		scanAll(h, blocks, refs, win, &hits)
		log(fmt.Sprintf("pass %d (window +/-%.0f): %d triple hits in %.1fs", attempt+1, win, len(hits), time.Since(t0).Seconds()))
		if len(hits) == 0 {
			continue
		}
		var ranked []*Group
		ranked, shortlist = groupAndRank(h, hits)
		for i := 0; i < len(ranked) && i < 12; i++ {
			g := ranked[i]
			log(fmt.Sprintf("    x%-5d struct %2d  d=%6.1f  slot#%d  mem=(%.1f, %.1f, %.1f)",
				g.Copies, g.Struct, g.Dist, g.Ri, g.X, g.Y, g.Z))
		}
		best = ranked[0]
		if best.Struct > 0 {
			break
		}
	}
	if best == nil {
		log("FAILED: no confident candidate")
		return nil
	}
	addr := best.Addrs[0]
	log(fmt.Sprintf("candidate 0x%012X  copies=%d struct=%d  [pending liveness]", addr, best.Copies, best.Struct))
	log(fmt.Sprintf("shortlist: %d groups, %d addresses", len(shortlist), shortlistAddrs(shortlist)))
	log(fmt.Sprintf("total %.1fs", time.Since(t0).Seconds()))

	var hud [3]float32
	if d := p.decode(h, addr); d != nil {
		hud = [3]float32{d[0], d[1], d[2]}
	}
	return &LocateResult{
		Addr:      addr,
		Copies:    best.Copies,
		Struct:    best.Struct,
		Hud:       hud,
		Shortlist: shortlist,
	}
}

// scanAll 并发扫描所有区域（worker pool）。
func scanAll(h uintptr, blocks []MemBlock, refs [][3]float32, window float32, hits *[]Hit) {
	var jobs []struct{ base, size uintptr }
	for _, b := range blocks {
		off := uintptr(0)
		for off < b.Size {
			n := uintptr(chunkSize)
			if b.Size-off < n {
				n = b.Size - off
			}
			jobs = append(jobs, struct{ base, size uintptr }{b.Base + off, n})
			off += n
		}
	}
	workers := runtime.NumCPU()
	if workers > 16 {
		workers = 16
	}
	var mu sync.Mutex
	wg := sync.WaitGroup{}
	ch := make(chan struct{ base, size uintptr })
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []Hit
			for j := range ch {
				scanRegion(h, j.base, j.size, refs, window, &local)
			}
			if len(local) > 0 {
				mu.Lock()
				*hits = append(*hits, local...)
				mu.Unlock()
			}
		}()
	}
	for _, j := range jobs {
		ch <- j
	}
	close(ch)
	wg.Wait()
}

// ---- 默认策略值（Ryujinx = live-go 原行为，无特化）----

func (p *ryujinxPlatform) afterScan(res *LocateResult)          {}
func (p *ryujinxPlatform) scanRescue(h uintptr, res *LocateResult) bool { return true }
func (p *ryujinxPlatform) teleportAccept(h uintptr, cur [3]float32, delta float32, dirSustained bool) (bool, bool) {
	return true, false
}
func (p *ryujinxPlatform) poolAlive(h uintptr) bool { return true }
func (p *ryujinxPlatform) shrine(cur [3]float32) ([3]float32, string) { return cur, "" }
func (p *ryujinxPlatform) stationaryConfirm(h uintptr, a uintptr, cur [3]float32) bool { return false }
func (p *ryujinxPlatform) onUnlocked() { lastScanAt = time.Time{} } // 解锁后立即重扫
func (p *ryujinxPlatform) onRescan()    {}
func (p *ryujinxPlatform) knownBypassed() bool { return false }
func (p *ryujinxPlatform) probeCopyKeep() float32                                   { return 0.7 }
func (p *ryujinxPlatform) consensusMoveNet() float32                                { return moveDist }
func (p *ryujinxPlatform) knownWatchMoveNet() float32                               { return moveDist }
func (p *ryujinxPlatform) knownWatchNear() float32                                  { return 1e9 }
func (p *ryujinxPlatform) knownWatchMax() time.Duration                             { return 0 }
func (p *ryujinxPlatform) detectNewBlocks(blocks []MemBlock) []uintptr              { return detectNewBlocks(blocks) }
func (p *ryujinxPlatform) coordsBusy() bool                                         { return false }
func (p *ryujinxPlatform) coordsPeek() (uintptr, [3]float32, int, bool)             { return 0, [3]float32{}, 0, false }

var _ locator = (*ryujinxPlatform)(nil)
