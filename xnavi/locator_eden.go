// locator_eden.go — Eden 定位策略（TOTK live-eden engine 原逻辑，2026-10-04
// 方案 A 实测修复全保留）。
//
// 与 Ryujinx 策略的根本差异：
//   - known = 绝对地址（无固定块锚点），known_eden_totk.json 独立文件
//   - 全 RW 区域扫描（碎片化，玩家槽可落在 0.44MB 微型区域）+ 占位池过滤
//   - decode 不拒绝整数三元组（Eden 真槽坐标是精确整数），改拒 Z_stored 近零
//   - 扫描锁定前瞬态候选防御（窗口快照可能瞬间失效）
//   - knownPool 交叉验证传送（无活副本 = 场景垃圾跳变，保持旧值）
//   - 神庙 hold（红点停门口）、静止确认（站桩不写 known）、净位移判据（抖动免疫）
//   - coords 校准：/set-coords 三轴精确匹配全 RAM 扫描

package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---- Eden 扫描常量（与 Ryujinx 版不同：8MB 块读、64KB 区域下限）----

const (
	edenChunkSize  = 8 << 20  // 每次读取 8MB（内存受限环境防 OOM）
	edenMinBlockMB = 0.0625   // 64KB（edenGuestBlocks 内部 floor）
	edenHitCap     = 3000000  // 命中上限
)

// isShrinePos 判定神庙/洞穴本地场景：TOTK 神庙为独立场景，玩家坐标切到以神庙
// 原点为中心的本地坐标系。实测（2026-10-04）：无尽洞窟 X∈[0,32], Y北∈[54,87],
// alt∈[-135,-117]；另一神庙入口 alt=-42。判据 |X|<200 && |Y北|<200 && alt<0
// 留裕量（覆盖 alt∈[-135,-42]）；大地图地底玩家原点 200m 内会误判（红点停门口
// vs 画在空洞，影响极小，可接受）。
func isShrinePos(p [3]float32) bool {
	return abs32(p[0]) < 200 && abs32(p[1]) < 200 && p[2] < 0
}

// ---- 解码（Eden 版：无 isWhole32 拒绝，改拒 Z_stored 近零）----

// edenDecodeBytes 12 字节内存 → hud 序 (gx=X东, gy=-Y北, gz=Z高)；无效返回 nil。
// 与 Ryujinx 版 decode 的差异：**不拒绝整数三元组**（Eden 玩家站定时真槽坐标
// 就是精确整数，如 320.00/1540.00/950.00——该判据会把真槽整组误杀 → 无限重扫），
// 改为拒绝 Z_stored 近零（内存 Y 轴 = 高度+105，未初始化槽恒为 0；实测占位池
// 垃圾如 (-8,8,-105) 坐标"合法"但 Z_stored=0）。
func edenDecodeBytes(d []byte) []float32 {
	if len(d) < 12 {
		return nil
	}
	a := floats(d[:12])
	gx, zs, yn := a[0], a[1], a[2]
	if a[0] == 0 && a[1] == 0 && a[2] == 0 {
		return nil // 标题/加载画面，槽位未初始化
	}
	gy, gz := -yn, zs-elevBias
	if math.IsNaN(float64(gx)) || math.IsNaN(float64(gy)) || math.IsNaN(float64(gz)) ||
		math.IsInf(float64(gx), 0) || math.IsInf(float64(gy), 0) || math.IsInf(float64(gz), 0) {
		return nil
	}
	// Fix 5：近零残留判无效（同 Ryujinx）。
	if abs32(gx) < 5 && abs32(gy) < 5 {
		return nil
	}
	// Z_stored 近零判无效（Eden 特有，见函数头注释）。
	if abs32(zs) < 5 {
		return nil
	}
	// denormal 三轴全查。
	if abs32(gx) < 1e-6 || abs32(gy) < 1e-6 || abs32(gz) < 1e-6 {
		return nil
	}
	if gx <= -6000 || gx >= 6000 || gy <= -6000 || gy >= 6000 ||
		gz <= -1300 || gz >= 3200 {
		return nil
	}
	return []float32{gx, gy, gz}
}

func (p *edenPlatform) decode(h uintptr, addr uintptr) []float32 {
	return edenDecodeBytes(readMem(h, addr, 12))
}

// ---- known 快路径（绝对地址）----

// tryLock 逐条试读已验证绝对地址，读到合法坐标即锁（地址跨会话是否稳定由
// 重启实测决定：稳定 → 秒锁；不稳定 → 回退存档锚点全扫描）。
func (p *edenPlatform) tryLock(h uintptr) (uintptr, [3]float32, bool) {
	for _, a := range edenLoadAddrs() {
		if v := p.decode(h, a); v != nil {
			guestBase.Store(a)
			return a, [3]float32{v[0], v[1], v[2]}, true
		}
	}
	return 0, [3]float32{}, false
}

// knownWatchAddrs known 列表里除当前锁外的全部绝对地址。
func (p *edenPlatform) knownWatchAddrs(cur uintptr) []uintptr {
	var out []uintptr
	for _, a := range edenLoadAddrs() {
		if a != cur {
			out = append(out, a)
		}
	}
	return out
}

// consensusCopy 在 known 绝对地址 + knownPool（最近扫描候选池）里找最大一致簇
// （互相 <2m，排除本锁地址）。knownPool 解决 known_addrs.json 只有 1-2 条、
// 凑不够 consensusMin=3 成员簇的问题。
func (p *edenPlatform) consensusCopy(h uintptr, exclude uintptr) (uintptr, [3]float32, bool) {
	type val struct {
		addr uintptr
		pos  [3]float32
	}
	var vals []val
	seen := map[uintptr]bool{exclude: true}
	add := func(a uintptr) {
		if !seen[a] {
			seen[a] = true
			if d := p.decode(h, a); d != nil {
				vals = append(vals, val{a, [3]float32{d[0], d[1], d[2]}})
			}
		}
	}
	for _, a := range edenLoadAddrs() {
		add(a)
	}
	for _, a := range p.knownPool {
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

// ---- known 持久化（known_eden_totk.json）----

func (p *edenPlatform) saveKnown(addrs []uintptr, block uintptr) { edenSaveKnown(p.Handle(), addrs, block) }
func (p *edenPlatform) knownFailInc(a uintptr)                   { edenKnownFailInc(a) }

// ---- 扫描（Eden 版：占位池过滤 / junkGroup / top80）----

// edenScanBytes 扫描内存缓冲（占位池同值快速过滤）。
func edenScanBytes(buf []byte, base uintptr, refs [][3]float32, window float32, hits *[]Hit) {
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
		// 占位池同值快速过滤（同 edenScanRegion）。
		if abs32(x-y) < 0.5 && abs32(y-z) < 0.5 {
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

// edenScanRegion 读进程内存后扫描（占位池过滤：近零三元组 + 同值三元组）。
func edenScanRegion(h uintptr, base, size uintptr, refs [][3]float32, window float32, hits *[]Hit) {
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
		if len(*hits) > edenHitCap {
			return
		}
		n := uintptr(edenChunkSize)
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
			// 占位 Actor 池过滤：Eden 下大量未使用 Actor 槽结构完整但坐标全零，
			// copies 可达千万级（排序永远第一）。近零三元组直接跳过；z 为内存
			// Y 轴（=高度+105），近零 = 未初始化槽（实测占位池垃圾 Z_stored=0）。
			if (x < 5 && x > -5) && (y < 5 && y > -5) {
				continue
			}
			if z < 5 && z > -5 {
				continue
			}
			// 占位池同值快速过滤：255/8/72/20/512/-24.22 等"三值近似相等"
			// 是占位 Actor 池的主特征（玩家真坐标三轴几乎不可能两两相等到 0.5m）。
			if abs32(x-y) < 0.5 && abs32(y-z) < 0.5 {
				continue
			}
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

// edenJunkGroup 占位池垃圾组判定（2026-10-04 6GB 场景切换实验实测特征）。
// 窗口过滤被神庙本地坐标污染时，占位池 copies 可达数万-百万、struct 全 0，
// 把玩家真坐标（copies 数百-数千）压出 top30。排序前丢弃，让玩家组浮出。
func edenJunkGroup(g *Group) bool {
	// 1) 海量重复 + 无 Actor 结构 = 占位池主特征（阈值 18000：玩家组实测最高
	//    15584；占位组 2万-143万）。
	if g.Copies > 18000 && g.Struct == 0 {
		return true
	}
	// 2) 三值近似相等（同值占位：255/8/72/20/512/-24.22 等）
	if abs32(g.X-g.Y) < 0.5 && abs32(g.Y-g.Z) < 0.5 {
		return true
	}
	// 3) 原点附近小值占位（|x|,|y|,|z| 全 <20：如 (9.9,9.12,7.42)）
	if abs32(g.X) < 20 && abs32(g.Y) < 20 && abs32(g.Z) < 20 {
		return true
	}
	// 4) 北轴近零 + 中小坐标占位（如 (80,100,1)，实测三时段稳定出现）
	if abs32(g.Z) < 5 && abs32(g.X) < 500 && abs32(g.Y) < 500 {
		return true
	}
	return false
}

// edenGroupAndRank 命中分组打分：struct>0 只作活槽门槛，copies 降序，dist 升序。
// 占位池过滤：先扩 top80 检查 struct，再 junk 过滤、截断 top30（占位组 copies
// 巨大必然排最前，若直接截 top30 玩家组被压在外面，struct 永远检查不到）。
func edenGroupAndRank(h uintptr, hits []Hit) ([]*Group, []ShortlistEntry) {
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
	if len(top) > 80 {
		top = top[:80]
	}
	for _, g := range top {
		// 检查组内全部地址（不限 64）：并发扫描使 hits 顺序不确定，截断采样
		// 会把矩阵槽漏出窗口，导致玩家组 struct=0。
		for _, a := range g.Addrs {
			if rotOK(h, a) {
				g.Struct++
			}
		}
	}
	kept := top[:0]
	for _, g := range top {
		if edenJunkGroup(g) {
			continue
		}
		kept = append(kept, g)
	}
	if len(kept) > 30 {
		kept = kept[:30]
	}
	sort.Slice(kept, func(i, j int) bool {
		a, b := kept[i], kept[j]
		aLive, bLive := a.Struct > 0, b.Struct > 0
		if aLive != bLive {
			return aLive
		}
		if a.Copies != b.Copies {
			return a.Copies > b.Copies
		}
		return a.Dist < b.Dist
	})
	shortlist := make([]ShortlistEntry, 0, len(kept))
	for _, g := range kept {
		shortlist = append(shortlist, ShortlistEntry{
			Hud:    [3]float32{g.X, -g.Z, g.Y - elevBias},
			Copies: g.Copies,
			Struct: g.Struct,
			Dist:   g.Dist,
			Slot:   g.Ri,
			Addrs:  g.Addrs[:min(len(g.Addrs), 24)],
		})
	}
	return kept, shortlist
}

// ---- 存档锚点（Eden 版：标题 ID 过滤 + 缓存 + 聚类）----

// edenFindTotkSaveFiles 递归找 TOTK 标题目录下所有 progress.sav（含 caption.sav）。
// 必须按标题 ID 过滤：Eden 存档根下同时存在 BOTW（01007EF00011E000）与 TOTK
// （0100F2C0115B6000），BOTW 的 progress.sav 布局不同、偏移无效，混入即锚点污染。
func edenFindTotkSaveFiles(root string) []string {
	var out []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			n := strings.ToLower(d.Name())
			if n == "progress.sav" || n == "caption.sav" {
				if !strings.Contains(p, totkTitleID) {
					return nil // 非 TOTK 存档（如 BOTW），跳过防锚点污染
				}
				out = append(out, p)
			}
		}
		return nil
	})
	return out
}

// edenReadAnchors 读全部存档锚点（按标题过滤 + 位置去重，slot_00 优先）。
func edenReadAnchors() []*SaveAnchor {
	var cands []cand
	seen := map[[3]int32]bool{}
	roots := []string{}
	if p := currentPlatform(); p != nil {
		roots = p.SaveRoots()
	}
	for _, root := range roots {
		for _, p := range edenFindTotkSaveFiles(root) {
			var offs []int
			n := strings.ToLower(filepath.Base(p))
			switch n {
			case "progress.sav":
				offs = []int{progressOff1, progressOff2}
			case "caption.sav":
				offs = []int{captionOff}
			default:
				continue
			}
			fi0, _ := os.Stat(p)
			if fi0 == nil {
				continue
			}
			mt0 := fi0.ModTime().UnixNano()
			data, err := os.ReadFile(p)
			if err != nil {
				continue
			}
			// 防半写垃圾锚点（2026-10-09 实测）：Eden 自动存档写入中读 progress.sav
			// 可能读到"旧数据+新数据"混合，偏移处坐标变成垃圾（曾锁出 (-3743,-2537)
			// 这类不在任何存档槽的位置）。读后复查 mtime，变化 = 写入进行中 → 跳过。
			if fi1, err := os.Stat(p); err == nil && fi1.ModTime().UnixNano() != mt0 {
				continue
			}
			mt := mt0
			for _, off := range offs {
				if off+12 > len(data) {
					continue
				}
				mx := math.Float32frombits(binary.LittleEndian.Uint32(data[off:]))
				mz := math.Float32frombits(binary.LittleEndian.Uint32(data[off+4:]))
				my := math.Float32frombits(binary.LittleEndian.Uint32(data[off+8:]))
				gx, gz, gy := mx, mz-elevBias, my
				if !totkSane(gx, gy, gz) {
					continue
				}
				mem := [3]float32{gx, mz, my} // 内存序 (X, Z_stored, Y_north)
				key := [3]int32{
					int32(math.Round(float64(gx) * 10)),
					int32(math.Round(float64(mz) * 10)),
					int32(math.Round(float64(my) * 10)),
				}
				if seen[key] {
					continue
				}
				seen[key] = true
				cands = append(cands, cand{mt, p, mem})
			}
		}
	}
	sortBySlot00ThenMtime(cands)
	var out []*SaveAnchor
	for _, c := range cands {
		out = append(out, &SaveAnchor{Path: c.path, Pos: c.pos})
	}
	return out
}

// ---- 锚点缓存 ----
// 场景切换（进神庙/传送）触发游戏自动存档时 progress.sav/caption.sav 可能被
// 独占写入，edanReadAnchors 瞬时读空（实测 2026-10-04：锚点读空 + 窗口过滤
// 失效 → 扫描爆炸 114 万组）。缓存最近一次成功锚点，读空回退缓存防击穿。
var (
	edenAnchorCache   []*SaveAnchor
	edenAnchorCacheAt time.Time
)

const edenAnchorCacheTTL = 10 * time.Minute

func edenReadAnchorsCached() []*SaveAnchor {
	a := edenReadAnchors()
	if len(a) > 0 {
		edenAnchorCache = a
		edenAnchorCacheAt = time.Now()
		return a
	}
	if len(edenAnchorCache) > 0 && time.Since(edenAnchorCacheAt) < edenAnchorCacheTTL {
		return edenAnchorCache
	}
	return nil
}

// edenAnchorClusterRadius 锚点聚类半径：大地图历史存档点彼此通常 <300m，
// 神庙/洞穴本地坐标与大地图锚点相距 >1500m。以 slot_00 为圆心、半径 800m
// 完整收下同区域历史锚点、同时剔除神庙本地坐标（防窗口过滤被小数值占位区
// 污染：窗口组数 2万 → 114万 爆炸）。
const edenAnchorClusterRadius = 800.0

// edenAnchorRefs 锚点去重合并 + 离群剔除（以 slot_00 为权威圆心，只保留
// 距其 ≤800m 的锚点；slot_00 缺失时退化为最大簇兜底）。
func edenAnchorRefs(anchors []*SaveAnchor, limit int, merge float32) [][3]float32 {
	if limit <= 0 {
		limit = 8
	}
	if merge <= 0 {
		merge = 4.0
	}
	var auth *SaveAnchor
	// 权威圆心 = 最新 mtime 存档槽（anchors 已按 mtime 降序，同 mtime 时 slot_00 优先）。
	// 原版硬编码 slot_00 假设其"最新"，但 Eden 自动存档写 slot_01/03/04/05 时
	// slot_00 停留旧手动存档（2026-10-09 实测）→ 旧圆心剔除玩家真实位置锚点 →
	// 扫描锁旧镜像。最新槽 = 玩家最近位置，作为圆心才收得住同区域自动存档簇。
	if len(anchors) > 0 {
		auth = anchors[0]
	}
	var cluster []*SaveAnchor
	if auth != nil {
		cluster = append(cluster, auth)
		for _, a := range anchors {
			if a == auth {
				continue
			}
			if dist3f(a.Pos, auth.Pos) <= edenAnchorClusterRadius {
				cluster = append(cluster, a)
			}
		}
	} else {
		best := []*SaveAnchor{}
		for i, a := range anchors {
			c := []*SaveAnchor{a}
			for j, b := range anchors {
				if i != j && dist3f(a.Pos, b.Pos) <= edenAnchorClusterRadius {
					c = append(c, b)
				}
			}
			if len(c) > len(best) {
				best = c
			}
		}
		cluster = best
	}
	var out [][3]float32
	for _, a := range cluster {
		r := a.Pos
		dup := false
		for _, o := range out {
			if abs32(r[0]-o[0]) <= merge && abs32(r[1]-o[1]) <= merge && abs32(r[2]-o[2]) <= merge {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, r)
		}
		if len(out) >= limit {
			break
		}
	}
	return out
}

func dist3f(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// ---- locate 主流程（Eden 版）----

func (p *edenPlatform) locate(window float64, onlyBlocks []MemBlock, logf func(string)) *LocateResult {
	t0 := time.Now()
	log := func(s string) {
		if logf != nil {
			logf(s)
		}
	}
	anchors := edenReadAnchorsCached()
	if len(anchors) == 0 {
		log("no usable save anchor found")
		return nil
	}
	refs := edenAnchorRefs(anchors, 8, 4.0)
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

	blocks := blocksCached(p, edenMinBlockMB)
	if onlyBlocks != nil {
		blocks = onlyBlocks
	}
	var total uintptr
	for _, b := range blocks {
		total += b.Size
	}
	log(fmt.Sprintf("RW regions (>=64KB): %d  (%.1f GB)", len(blocks), float64(total)/1073741824.0))
	for i, b := range blocks {
		if i >= 10 {
			log(fmt.Sprintf("  ... %d more regions", len(blocks)-10))
			break
		}
		log(fmt.Sprintf("  region 0x%012X  %8.0f MB", b.Base, float64(b.Size)/1048576.0))
	}

	var best *Group
	var shortlist []ShortlistEntry
	for attempt, win := range []float32{float32(math.Max(window, 120.0)), 400.0} {
		var hits []Hit
		edenScanAll(h, blocks, refs, win, &hits)
		log(fmt.Sprintf("pass %d (window +/-%.0f): %d triple hits in %.1fs", attempt+1, win, len(hits), time.Since(t0).Seconds()))
		if len(hits) == 0 {
			continue
		}
		var ranked []*Group
		ranked, shortlist = edenGroupAndRank(h, hits)
		for i := 0; i < len(ranked) && i < 12; i++ {
			g := ranked[i]
			log(fmt.Sprintf("    x%-5d struct %2d  d=%6.1f  slot#%d  mem=(%.1f, %.1f, %.1f)",
				g.Copies, g.Struct, g.Dist, g.Ri, g.X, g.Y, g.Z))
		}
		best = ranked[0]
		if best.Struct > 0 {
			// 锁定前 decode 校验：占位池/垃圾组可能排第一（坐标近零被窗口放过时），
			// 从 ranked 依次取第一个 decode 非 nil 的组作候选。
			for _, g := range ranked {
				if d := p.decode(h, g.Addrs[0]); d != nil {
					if g != best {
						log(fmt.Sprintf("    candidate #1 (copies=%d struct=%d) invalid pos - fallback to 0x%012X (copies=%d)",
							best.Copies, best.Struct, g.Addrs[0], g.Copies))
					}
					best = g
					break
				}
			}
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

// edenScanAll 并发扫描所有区域（跳过 ≥2GB 巨型块，worker ≤6）。
func edenScanAll(h uintptr, blocks []MemBlock, refs [][3]float32, window float32, hits *[]Hit) {
	var jobs []struct{ base, size uintptr }
	for _, b := range blocks {
		if b.Size >= 2<<30 { // 跳过 ≥2GB 巨型块（DRAM 主映射，历史从未命中玩家槽）
			continue
		}
		off := uintptr(0)
		for off < b.Size {
			n := uintptr(edenChunkSize)
			if b.Size-off < n {
				n = b.Size - off
			}
			jobs = append(jobs, struct{ base, size uintptr }{b.Base + off, n})
			off += n
		}
	}
	workers := runtime.NumCPU()
	if workers > 6 {
		workers = 6
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
				edenScanRegion(h, j.base, j.size, refs, window, &local)
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

// ---- 状态机策略点（Eden 特化）----

// afterScan 扫描锁定后：重建 knownPool（冻结共识成员来源）+ 解除 known 快路径
// 屏蔽。池收下 shortlist 全部地址（~720 个）：top 组几十个玩家槽副本地址全部
// 进池，站桩时它们聚成 <2m 一致簇（≥3 成员）→ 共识 ok 不误重扫；只取每组
// 1 个代表会让池太分散，站桩也被误判无共识。
func (p *edenPlatform) afterScan(res *LocateResult) {
	p.knownPool = p.knownPool[:0]
	for _, g := range res.Shortlist {
		p.knownPool = append(p.knownPool, g.Addrs...)
	}
	p.bypassKnown = false
}

// scanRescue 瞬态候选防御：扫描命中是"扫描窗口内"的快照，而 Eden 内存活跃
// （02AEC 区域实测 copies=18652 的组锁定瞬间读全零），锁定前必须即时重读候选；
// 无效则按 shortlist 顺序找下一个可读地址。全部失效返回 false（状态机重试）。
func (p *edenPlatform) scanRescue(h uintptr, res *LocateResult) bool {
	if p.decode(h, res.Addr) != nil {
		return true
	}
	for _, g := range res.Shortlist {
		for _, ad := range g.Addrs {
			if p.decode(h, ad) != nil {
				res.Addr = ad
				return true
			}
		}
	}
	return false
}

// teleportAccept 传送/场景切换判定（verified 锁大位移）——"位置+方向连续性"判活
// 模型（对齐复盘铁律 1：位置一致性 > 移动性）：
//   - 位置连续：新位置 100m 内有 ≥1 活副本（knownPool 交叉验证）= 真传送接受；
//   - 方向连续：dirSustained（状态机位移方向历史最近 2 拍同向）= 跳伞/滑翔快速
//     下落——副本跟不上同步但路径连续，同样接受（2026-10-09 跳伞卡死根治）；
//   - 两者皆无 = 场景切换垃圾跳变（锁地址短暂读到远处合法坐标）→ garbage：
//     /pos 保持旧值 + 状态机查 poolAlive（全池失效 → 立即重锚；有活副本 →
//     累积 invalid 走 pool-follow 接管）。
func (p *edenPlatform) teleportAccept(h uintptr, cur [3]float32, delta float32, dirSustained bool) (bool, bool) {
	for _, ad := range p.knownPool {
		dd := edenDecodeBytes(readMem(h, ad, 12))
		if dd == nil {
			continue
		}
		if abs32(dd[0]-cur[0]) < 100 && abs32(dd[1]-cur[1]) < 100 && abs32(dd[2]-cur[2]) < 100 {
			return true, false
		}
	}
	if dirSustained {
		return true, false
	}
	return false, true
}

// poolAlive knownPool 是否仍有活副本：任一地址 12B 读有效（非零三元组）即认为
// 池活着。场景切换全池失效时返回 false → 状态机立即重锚（不等 invalidMax/30s）。
func (p *edenPlatform) poolAlive(h uintptr) bool {
	for _, ad := range p.knownPool {
		dd := edenDecodeBytes(readMem(h, ad, 12))
		if dd != nil {
			return true
		}
	}
	return false
}

// shrine 神庙/洞穴本地场景处理（红点停门口）：
//   - 进神庙瞬间记录入口大地图坐标（lastOverworld，独立于 prev——进神庙跳变
//     路径会 rescan+resetFollow 清空 prev），神庙内恒输出入口坐标（source
//     "shrine-hold"）；出神庙后自动恢复正常。
//   - 启动即在神庙（无大地图记录）时无入口记忆 → 返回 "shrine-no-anchor"，
//     状态机保持 ok=false（原样输出会把神庙本地坐标画到地图地下）。
func (p *edenPlatform) shrine(cur [3]float32) ([3]float32, string) {
	if isShrinePos(cur) {
		if !p.inShrine && p.lastOverworldSet {
			p.shrineEntry, p.shrineEntrySet = p.lastOverworld, true
			fmt.Printf("  [sm] shrine detected (%.0f, %.0f, %.0f) - holding entry (%.0f, %.0f, %.0f)\n",
				cur[0], cur[1], cur[2], p.lastOverworld[0], p.lastOverworld[1], p.lastOverworld[2])
		} else if !p.shrineEntrySet {
			return cur, "shrine-no-anchor"
		}
		if p.shrineEntrySet {
			p.inShrine = true
			return p.shrineEntry, "shrine-hold"
		}
		p.inShrine = true
		return cur, ""
	}
	p.inShrine = false
	p.lastOverworld, p.lastOverworldSet = cur, true
	return cur, ""
}

// stationaryConfirm 静止确认：玩家站桩时锁读数冻结属正常，但移动确认永不
// 触发 → 锁永远 verified=false → 30s 冻结共识把"不动候选"判死 → 全量重扫循环。
// 站桩但锁位置有副本簇（consensusCopy ≥3 一致成员且距本锁 <15m）= 锁是活槽 →
// 直接确认（但不写 known——站桩验证过但"没动过"的槽不值得记忆，靠传送跳变/
// 读失效/游戏重启兜底；写 known 是污染根源：神庙站桩会把神庙槽写进 known，
// 下次启动秒锁神庙槽输出神庙坐标当大地图坐标）。
func (p *edenPlatform) stationaryConfirm(h uintptr, a uintptr, cur [3]float32) bool {
	if _, v2, ok := p.consensusCopy(h, a); ok && dist3(v2, cur) < frozenConfirmNear {
		return true
	}
	return false
}

// onUnlocked 解锁后重扫冷却：Eden 下场景切换垃圾期（占位池/未初始化槽）反复
// scan 会锁垃圾 → invalid → 解锁 → 立即重扫 → 风暴（实测 ws 飙 2.6GB、一直
// locating）。冷却 20s：垃圾期跳过重扫（场景加载完成后已知地址/候选恢复），
// 真迁移靠 frozen → reLocate 重锚兜底（该路径 bypassKnown 强制重扫不受此冷却影响）。
func (p *edenPlatform) onUnlocked() {
	lastScanAt = time.Now().Add(20*time.Second - scanCooldown)
}

func (p *edenPlatform) onRescan() { p.bypassKnown = true }
func (p *edenPlatform) knownBypassed() bool { return p.bypassKnown }

// ---- 参数值（Eden = 2026-10-04 实测收敛值）----

func (p *edenPlatform) probeCopyKeep() float32 { return 0.1 } // 存档镜像簇 copies 可大于真槽
func (p *edenPlatform) consensusMoveNet() float32 { return moveNet }
func (p *edenPlatform) knownWatchMoveNet() float32 { return moveNet }
func (p *edenPlatform) knownWatchNear() float32 { return knownFallbackNear }
func (p *edenPlatform) knownWatchMax() time.Duration { return knownWatchMax }
func (p *edenPlatform) detectNewBlocks(blocks []MemBlock) []uintptr { return nil }

// ---- coords 校准（Eden 特有，/set-coords）----

type coordsResp struct {
	Ok     bool    `json:"ok"`
	Addr   string  `json:"addr,omitempty"`
	Gx     float64 `json:"gx,omitempty"` // hud 序（校准后的锁定坐标）
	Gy     float64 `json:"gy,omitempty"`
	Gz     float64 `json:"gz,omitempty"`
	Copies int     `json:"copies,omitempty"`
	Error  string  `json:"error,omitempty"`
	DurMs  int64   `json:"durMs"`
}

func (p *edenPlatform) coordsBusy() bool {
	p.coordsMu.Lock()
	defer p.coordsMu.Unlock()
	return p.coordsOn
}

// coordsPeek 状态机每 tick 轮询：坐标校准完成后返回锁定指令（清 busy 状态）。
func (p *edenPlatform) coordsPeek() (uintptr, [3]float32, int, bool) {
	p.coordsMu.Lock()
	defer p.coordsMu.Unlock()
	if p.coordsDone {
		a, pos, c := p.coordsAddr, p.coordsPos, p.coordsCopies
		p.coordsDone = false
		p.bypassKnown = false // coords 锁定后允许 known 快路径
		return a, pos, c, true
	}
	return 0, [3]float32{}, 0, false
}

// coordsLocate 坐标校准（同步，全 RAM 扫描约 10s；/set-coords HTTP 入口）。
// 游戏 HUD 坐标 → 内存三轴 (X, alt+105, -Y北) → 全 RAM 扫 float32 三元组
// （±1.5m）→ 命中即真槽（不需要窗口、不需要 copies 排序）。命中后经
// coordsDone 通知状态机接管 + 写 known_eden_totk.json（下次启动秒锁）。
func (p *edenPlatform) coordsLocate(gx, gy, gz float32) coordsResp {
	t0 := time.Now()
	elapsed := func() int64 { return time.Since(t0).Milliseconds() }
	p.coordsMu.Lock()
	if p.coordsOn {
		p.coordsMu.Unlock()
		return coordsResp{Error: "另一路坐标搜索进行中，请稍候", DurMs: 0}
	}
	p.coordsOn = true
	p.coordsDone = false
	p.coordsMu.Unlock()
	defer func() {
		p.coordsMu.Lock()
		p.coordsOn = false
		p.coordsMu.Unlock()
	}()

	h := p.Handle()
	if h == 0 {
		return coordsResp{Error: "Eden 进程未附加", DurMs: elapsed()}
	}
	target := [3]float32{gx, gz + elevBias, -gy}
	fmt.Printf("  [coords] HTTP calibration: game hud (%.1f, %.1f, %.1f) -> target mem (%.1f, %.1f, %.1f)\n",
		gx, gy, gz, target[0], target[1], target[2])

	blocks := blocksCached(p, edenMinBlockMB)
	var hits []Hit
	edenScanAll(h, blocks, [][3]float32{target}, 1.5, &hits)

	// 校验命中：结构有效（rotOK）优先；无 rotOK 时接受任意解码有效槽。
	var cands []uintptr
	for _, hit := range hits {
		if edenDecodeBytes(readMem(h, hit.Addr, 12)) != nil && rotOK(h, hit.Addr) {
			cands = append(cands, hit.Addr)
		}
	}
	if len(cands) == 0 {
		for _, hit := range hits {
			if edenDecodeBytes(readMem(h, hit.Addr, 12)) != nil {
				cands = append(cands, hit.Addr)
			}
		}
	}
	if len(cands) == 0 {
		return coordsResp{
			Error: fmt.Sprintf("未命中：目标内存坐标 (%.1f, %.1f, %.1f)，扫描 %d 个区域 0 匹配。请保持角色站桩后重试（游戏内坐标需与角色实际位置一致）",
				target[0], target[1], target[2], len(blocks)),
			DurMs: elapsed(),
		}
	}
	addr := cands[0]
	pos := edenDecodeBytes(readMem(h, addr, 12))

	p.coordsMu.Lock()
	p.coordsAddr = addr
	p.coordsPos = [3]float32{pos[0], pos[1], pos[2]}
	p.coordsCopies = len(cands)
	p.coordsDone = true
	p.coordsMu.Unlock()

	// 写 known：保存全部命中地址（副本簇，knownCap=10 截断）。副本轮换时
	// knownWatch/共识观察有活槽可换；神庙本地槽会被 knownSlotOK 过滤。
	edenSaveKnown(h, cands, 0)
	return coordsResp{
		Ok:     true,
		Addr:   fmt.Sprintf("0x%X", addr),
		Gx:     float64(pos[0]),
		Gy:     float64(pos[1]),
		Gz:     float64(pos[2]),
		Copies: len(cands),
		DurMs:  elapsed(),
	}
}

var _ locator = (*edenPlatform)(nil)
