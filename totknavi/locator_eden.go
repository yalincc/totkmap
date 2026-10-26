// locator_eden.go — Eden 保留资产（M1 第二步精简版）。
//
// 老路（v2.2.0）Eden 定位策略（known 绝对地址、knownPool、probe 监听、
// 冻结共识、传送判活、神庙 hold 状态机、静止确认等）随 locator 接口退役删除。
// 本文件只保留仍被新架构消费的资产：
//   - edenDecodeBytes：指针链（chain_eden.go 末端坐标校验）与 coords 校准解码
//   - 存档锚点三函数：edenFindTotkSaveFiles / edenReadAnchors / edenReadAnchorsCached
//     （2026-10-24 锚点 bug 修复保留：Ryujinx 布局 \bis\user\save 放行）
//   - coords 校准四件套：coordsResp / coordsBusy / coordsPeek / coordsLocate
//     （GUI /set-coords 与 HTTP 入口，全 RAM 三轴精确匹配）
//   - edenScanAll / edenScanBytes / edenScanRegion：coords 校准专用扫描链
//     （新定位管道扫描用 probe_totk.go 的 ptk* 动力学根原语，不共用本扫描）
//   - isShrinePos：神庙判定原始函数（新管道 isShrineScale 同判据内联）

package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ---- Eden 扫描常量（coords 校准专用：8MB 块读、64KB 区域下限）----

const (
	edenChunkSize  = 8 << 20 // 每次读取 8MB（内存受限环境防 OOM）
	edenMinBlockMB = 0.0625  // 64KB（edenGuestBlocks 内部 floor）
	edenHitCap     = 3000000 // 命中上限
)

// isShrinePos 判定神庙/洞穴本地场景（保留资产，口径与 tracker.go isShrineScale
// 一致）。TOTK 神庙为独立本地场景，玩家坐标切到以神庙原点为中心的本地坐标系，
// 三轴绝对值都小。实测样本：无尽洞窟（2026-10-04）X∈[0,32], gy∈[-87,-54],
// gz∈[-135,-117]；伊修达古恩神庙（2026-10-24 M1 真机）hud (20.5,54.5,12.0)
// —— gz 为正，老路 alt<0 判据漏判地表神庙。输入为 hud 序（X, -Y北, 高）。
func isShrinePos(p [3]float32) bool {
	return math.Abs(float64(p[0])) < 200 && math.Abs(float64(p[1])) < 200 && math.Abs(float64(p[2])) < 300
}

// edenDecodeBytes 12 字节内存 → hud 序 (gx=X东, gy=-Y北, gz=Z高)；无效返回 nil。
// 严格版（拒 Z_stored 近零）：指针链/coords 校准用；新定位管道统一用
// ptkDecodeBytes 宽松版（探针验证，见 probe_totk.go）。
func edenDecodeBytes(d []byte) []float32 {
	if len(d) < 12 {
		return nil
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(d[0:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(d[4:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(d[8:]))
	if math.IsNaN(float64(x)) || math.IsNaN(float64(zs)) || math.IsNaN(float64(yn)) ||
		math.IsInf(float64(x), 0) || math.IsInf(float64(zs), 0) || math.IsInf(float64(yn), 0) {
		return nil
	}
	if x == 0 && zs == 0 && yn == 0 {
		return nil // 标题/加载画面，槽位未初始化
	}
	// denormal 三轴全查
	if abs32(x) < 1e-6 || abs32(zs) < 1e-6 || abs32(yn) < 1e-6 {
		return nil
	}
	// 近零残留（对应 hud gx/gy）
	if abs32(x) < 5 && abs32(yn) < 5 {
		return nil
	}
	// 范围（对应 hud gx/gy ∈ (-6000,6000)）
	if x <= -6000 || x >= 6000 || yn <= -6000 || yn >= 6000 {
		return nil
	}
	// 高度（对应 hud gz ∈ (-1300,3200)，gz = Z_stored - elevBias）
	gz := zs - elevBias
	if gz <= -1300 || gz >= 3200 {
		return nil
	}
	// Z_stored 近零拒（未初始化槽；真槽 Z_stored>5 或为负数地底场景）
	if zs < 5 && zs > -5 {
		return nil
	}
	return []float32{x, -yn, zs - elevBias} // hud 序 (gx=X东, gy=-Y北, gz=Z高)
}

// ---- coords 校准扫描链（全 RAM 三轴精确匹配，/set-coords 专用）----

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
		// 占位池同值快速过滤
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
			// 占位 Actor 池过滤：近零三元组 / 同值三元组（占位池主特征）
			if (x < 5 && x > -5) && (y < 5 && y > -5) {
				continue
			}
			if z < 5 && z > -5 {
				continue
			}
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

// ---- 存档锚点（2026-10-24 锚点 bug 修复保留）----

// edenFindTotkSaveFiles 递归找所有 progress.sav / caption.sav（TOTK 标题过滤 +
// Ryujinx 布局放行）。用户存档在 Ryujinx 目录（slot_XX），按标题过滤会全杀
// → 锚点永远读空。Ryujinx 布局（\bis\user\save，无标题 ID 段）放行，靠固定
// 偏移 + totkSane + 位置去重兜底过滤 BOTW 污染。
func edenFindTotkSaveFiles(root string) []string {
	var out []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			n := strings.ToLower(d.Name())
			if n == "progress.sav" || n == "caption.sav" {
				if strings.Contains(p, totkTitleID) {
					out = append(out, p)
					return nil
				}
				if strings.Contains(p, "\\bis\\user\\save") {
					out = append(out, p) // Ryujinx 布局（无标题 ID 段）
				}
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
			// 可能读到"旧数据+新数据"混合，偏移处坐标变成垃圾。读后复查 mtime，
			// 变化 = 写入进行中 → 跳过。
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

// dist3f 两点距离（探针跟随验证用；新管道用 tracker.go dist3）。
func dist3f(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// ---- coords 校准（Eden 特有，/set-coords）----

type coordsResp struct {
	Ok     bool    `json:"ok"`
	Addr   string  `json:"addr,omitempty"`
	Gx     float64 `json:"gx,omitempty"` // hud 序（校准后的锁定坐标）
	Gy     float64 `json:"gy,omitempty"`
	Gz     float64 `json:"gz,omitempty"`
	Copies int     `json:"copies,omitempty"`
	Error  string  `json:"error,omitempty"`
	// ErrorEn：同一错误的英文版（GUI 英文界面优先取此字段，空则回退 Error）
	ErrorEn string `json:"errorEn,omitempty"`
	DurMs   int64  `json:"durMs"`
}

// coordsStarter 坐标校准入口（server /set-coords 用，同步全 RAM 扫描）。
type coordsStarter interface {
	coordsLocate(gx, gy, gz float32) coordsResp
}

func (p *edenPlatform) coordsBusy() bool {
	p.coordsMu.Lock()
	defer p.coordsMu.Unlock()
	return p.coordsOn
}

// coordsPeek 管道每 tick 轮询：坐标校准完成后返回锁定指令（清 done 状态）。
func (p *edenPlatform) coordsPeek() (uintptr, [3]float32, int, bool) {
	p.coordsMu.Lock()
	defer p.coordsMu.Unlock()
	if p.coordsDone {
		a, pos, c := p.coordsAddr, p.coordsPos, p.coordsCopies
		p.coordsDone = false
		return a, pos, c, true
	}
	return 0, [3]float32{}, 0, false
}

// coordsLocate 坐标校准（同步，全 RAM 扫描约 10s；/set-coords HTTP 入口）。
// 游戏 HUD 坐标 → 内存三轴 (X, alt+105, -Y北) → 全 RAM 扫 float32 三元组
// （±1.5m）→ 命中即真槽（不需要窗口、不需要 copies 排序）。命中后经
// coordsDone 通知管道接管（M1 第二步：不再写 known，known 持久化已退役）。
func (p *edenPlatform) coordsLocate(gx, gy, gz float32) coordsResp {
	t0 := time.Now()
	elapsed := func() int64 { return time.Since(t0).Milliseconds() }
	p.coordsMu.Lock()
	if p.coordsOn {
		p.coordsMu.Unlock()
		return coordsResp{Error: "另一路坐标搜索进行中，请稍候", ErrorEn: "Another coordinate search is in progress, please wait", DurMs: 0}
	}
	p.coordsOn = true
	p.coordsDone = false
	p.coordsMu.Unlock()
	defer func() {
		p.coordsMu.Lock()
		p.coordsOn = false
		p.coordsMu.Unlock()
	}()

	// 与管道扫描互斥（globalScanMu；校准先到先得，被占用时提示稍后重试）
	if !globalScanMu.TryLock() {
		return coordsResp{Error: "定位扫描进行中，请 10 秒后重试", ErrorEn: "A locating scan is in progress, retry in 10 seconds", DurMs: elapsed()}
	}
	defer globalScanMu.Unlock()

	h := p.Handle()
	if h == 0 {
		return coordsResp{Error: "Eden 进程未附加", ErrorEn: "Eden process not attached", DurMs: elapsed()}
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
			ErrorEn: fmt.Sprintf("No match: target memory coords (%.1f, %.1f, %.1f), scanned %d regions with 0 hits. Stay still in game and retry (in-game coords must match your actual position)",
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
