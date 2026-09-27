// 内存定位：以存档锚点扫描 guest RAM，找玩家坐标槽。
// 策略与 Python 版完全一致：save anchor → 窗口扫描 → 分组打分（旋转矩阵
// 结构特征优先）→ shortlist 监听确认。坐标系 (X east, Y altitude, Z south+)。

package main

import (
	"fmt"
	"math"
	"runtime"
	"sort"
	"sync"
	"time"
	"unsafe"
)

const (
	chunkSize  = 64 << 20 // 每次读取 64MB
	hitCap     = 3000000  // 命中上限（防窗口过宽）
	minBlockMB = 512.0
)

type Hit struct {
	Addr     uintptr
	X, Y, Z  float32 // (X, alt, Z) 内存顺序
	Ri       int
	Dist     float32
}

type Group struct {
	Addrs  []uintptr
	Ri     int
	Dist   float32
	Struct int
	Copies int
	X, Y, Z float32 // 组坐标（内存顺序）
}

type ShortlistEntry struct {
	Hud    [3]float32 // (X, Z, alt) 展示顺序
	Copies int
	Struct int
	Dist   float32
	Slot   int
	Addrs  []uintptr
}

type LocateResult struct {
	Addr      uintptr
	Copies    int
	Struct    int
	Hud       [3]float32
	Shortlist []ShortlistEntry
	Log       []string
}

func floats(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

// decodePos 12 字节内存 → hud 序 (gx=X东, gy=-Y北, gz=Z高)；无效返回 nil。
// TOTK 内存序 = (X, Z_stored, Y_north)，Z_stored = 真实高度 + elevBias(105)。
// 注意：hud gy = -Y北（负北向，与 live-python 的 hud=(X,-my,alt) 一致；前端
// mx=-gy 得到地图北向坐标）。BOTW 是 -Y 北、TOTK 是 +Y 北，这里统一取反。
func decodePos(d []byte) []float32 {
	if len(d) < 12 {
		return nil
	}
	a := floats(d[:12])
	gx, zs, yn := a[0], a[1], a[2]
	if a[0] == 0 && a[1] == 0 && a[2] == 0 {
		return nil // 标题/加载画面，槽位未初始化
	}
	gy, gz := -yn, zs-elevBias
	// Fix 5：近零残留（原点附近残留）判无效——known 快路径会锁零残留槽。
	// 阈值 5.0 与运动扫描玩家候选门槛一致（真实坐标 |x|,|y| 都 >5）。
	if abs32(gx) < 5 && abs32(gy) < 5 {
		return nil
	}
	if abs32(gx) < 1e-20 || abs32(gy) < 1e-20 {
		return nil
	}
	if gx <= -6000 || gx >= 6000 || gy <= -6000 || gy >= 6000 ||
		gz <= -1300 || gz >= 3200 {
		return nil
	}
	return []float32{gx, gy, gz}
}

// rotOKBytes 检查缓冲区内是否存在正交 3x3 旋转矩阵（ActorBase 特征）。
func rotOKBytes(buf []byte) bool {
	if len(buf) < 64 {
		return false
	}
	a := floats(buf) // 128 字节 → 32 个 float
	// TOTK ActorBase：mPosition 后紧跟 mRotation（矩阵在 offset 12，float st=3）。
	// live-python rot_ok 只查 st=4..16 会漏掉玩家槽 → struct=0 → 排序退化。
	// 这里从 st=3 起检查（offset 12-56），保留 4..16 兼容其他布局。
	for st := 3; st < 17 && st+9 <= len(a); st++ {
		m := a[st : st+9]
		cols := [3][3]float32{
			{m[0], m[3], m[6]},
			{m[1], m[4], m[7]},
			{m[2], m[5], m[8]},
		}
		ok := true
		for i := 0; i < 3; i++ {
			n := math.Sqrt(float64(cols[i][0]*cols[i][0] + cols[i][1]*cols[i][1] + cols[i][2]*cols[i][2]))
			if math.Abs(n-1.0) >= 0.05 {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		for i := 0; i < 3 && ok; i++ {
			for j := i + 1; j < 3; j++ {
				dot := cols[i][0]*cols[j][0] + cols[i][1]*cols[j][1] + cols[i][2]*cols[j][2]
				if math.Abs(float64(dot)) >= 0.08 {
					ok = false
					break
				}
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// rotOK 读进程内存后检查旋转矩阵特征。
func rotOK(h uintptr, addr uintptr) bool {
	return rotOKBytes(readMem(h, addr, 128))
}

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

// groupAndRank 命中分组打分：struct>0 优先 → struct 降序 → dist 升序 → copies 降序。
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
		// 检查组内全部地址（不限 64）：并发扫描使 hits 顺序不确定，
		// 截断采样会把矩阵槽（ActorBase 特征）漏出窗口，导致玩家组 struct=0。
		for _, a := range g.Addrs {
			if rotOK(h, a) {
				g.Struct++
			}
		}
	}
	sort.Slice(top, func(i, j int) bool {
		a, b := top[i], top[j]
		// 与 live-python 排序完全一致：struct>0 硬优先 → struct 降序 → dist 升序 → copies 降序。
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
func locate(pid uint32, window float64, logf func(string)) *LocateResult {
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

	h, err := openProcess(pid)
	if err != nil || h == 0 {
		log("OpenProcess failed")
		return nil
	}
	defer closeHandle(h)

	blocks := guestBlocks(h, minBlockMB)
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

	// best hud（展示顺序 X, -Y北, alt，与 Python candidate hud 同口径）
	var hud [3]float32
	if d := decodePos(readMem(h, addr, 12)); d != nil {
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

func shortlistAddrs(sl []ShortlistEntry) int {
	n := 0
	for _, g := range sl {
		n += len(g.Addrs)
	}
	return n
}

// scanAll 并发扫描所有区域（worker pool）。
func scanAll(h uintptr, blocks []struct{ Base, Size uintptr }, refs [][3]float32, window float32, hits *[]Hit) {
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
