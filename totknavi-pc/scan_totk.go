// scan_totk.go — 定位扫描原语（移植自 totknavi/probe_totk.go，判据一字未改）。
//
// 为什么可以原样复用：这套判据识别的是 **数据结构**（0x48 步长 3x4 旋转矩阵 +
// 坐标双缓冲槽 / 0x40 步长四元数刚体槽 + Run>=2 门禁），而不是地址。
// PC 重编译版虽然把所有全局变量重新 relocate 了（51 万条），但**结构本身是
// 游戏代码定义的，重编译不会改**——所以旧地址作废、旧判据依然成立。
//
// 差异只有两处：
//   1. elevBias 常量内联（不依赖 totknavi 的 savefile_totk.go）
//   2. 新增 ptkScanBlocksTiered：PC 版内存 9GB，全量扫描偏慢，先扫高可疑区
//      （主模块镜像 + exe 数据段），未命中再放大到全进程。

package main

import (
	"encoding/binary"
	"math"
	"sort"
	"sync"
	"time"
)

const (
	ptkRecStride       = 0x40 // 四元数刚体槽步长
	ptkRotRecStride    = 0x48
	ptkRing28Stride    = 28   // PC版专属：12B 坐标 + 16B 单位四元数 RingBuffer // TOTK 跨场景持久 3x4 旋转矩阵+坐标双缓冲槽步长
	ptkQuatWindowBytes = 0x0C + 16

	// ptkHitCap 候选总量硬上限（防病态内存下无限累积撑爆进程）。
	ptkHitCap = 200000

	// elevBias TOTK 内存高度 = HUD 高度 + 105（与 savefile_totk.go 同值）。
	elevBias = 105.0
)

func abs32(f float32) float32 {
	if f < 0 {
		return -f
	}
	return f
}

// dist3 三维距离。
func dist3(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// floats 把字节切为 float32 视图（原地，不拷贝）。
func floats(b []byte) []float32 {
	n := len(b) / 4
	out := make([]float32, n)
	for i := 0; i < n; i++ {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out
}

// ptkCoordOK TOTK 坐标校验（内存序 X, Z_stored, Y_north）。
func ptkCoordOK(x, zs, yn float32) bool {
	fx, fzs, fyn := float64(x), float64(zs), float64(yn)
	if math.IsNaN(fx) || math.IsNaN(fzs) || math.IsNaN(fyn) ||
		math.IsInf(fx, 0) || math.IsInf(fzs, 0) || math.IsInf(fyn, 0) {
		return false
	}
	if x == 0 && zs == 0 && yn == 0 {
		return false // 标题/加载画面，槽位未初始化
	}
	if (x != 0 && abs32(x) < 1e-6) || (zs != 0 && abs32(zs) < 1e-6) || (yn != 0 && abs32(yn) < 1e-6) {
		return false
	}
	if math.Abs(fx) < 0.001 && math.Abs(fyn) < 0.001 {
		return false
	}
	if math.Abs(fx) < 10 && math.Abs(fyn) < 10 && math.Abs(fzs) < 5 {
		return false
	}
	if (x == 0 || yn == 0 || math.Abs(fx-1.0) < 0.01 || math.Abs(fyn-1.0) < 0.01) && math.Abs(fzs-1.0) < 0.01 {
		return false
	}
	if (x == 0 || math.Abs(fx) < 0.001) && math.Abs(fzs) < 0.001 {
		return false
	}
	if (yn == 0 || math.Abs(fyn) < 0.001) && math.Abs(fzs) < 0.001 {
		return false
	}
	if x <= -6000 || x >= 6000 || yn <= -6000 || yn >= 6000 {
		return false
	}
	gz := zs - elevBias
	if gz <= -1300 || gz >= 3200 {
		return false
	}
	return true
}

// ptkIsQuatUnit 坐标后 0x0C 处 16 字节是否为单位四元数。
func ptkIsQuatUnit(buf []byte, off int) bool {
	if off < 0 || off+16 > len(buf) {
		return false
	}
	n := 0.0
	for i := 0; i < 4; i++ {
		v := float64(math.Float32frombits(binary.LittleEndian.Uint32(buf[off+i*4:])))
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
		n += v * v
	}
	return math.Abs(n-1.0) < 0.02
}

// ptkValidRec 合法记录 = 坐标合法 + 坐标后 0x0C 处单位四元数。
func ptkValidRec(buf []byte, off int) bool {
	if off < 0 || off+ptkQuatWindowBytes > len(buf) {
		return false
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(buf[off:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+4:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+8:]))
	if !ptkCoordOK(x, zs, yn) {
		return false
	}
	return ptkIsQuatUnit(buf, off+0x0C)
}

// ptkRunLength 以 0x40 步长向前后各延伸 16 跳，统计连续合法记录数。
func ptkRunLength(buf []byte, off int) int {
	if !ptkValidRec(buf, off) {
		return 0
	}
	n := 1
	for k := 1; k <= 16; k++ {
		if ptkValidRec(buf, off+k*ptkRecStride) {
			n++
		} else {
			break
		}
	}
	for k := 1; k <= 16; k++ {
		if off-k*ptkRecStride >= 0 && ptkValidRec(buf, off-k*ptkRecStride) {
			n++
		} else {
			break
		}
	}
	return n
}

// ptkIsAxisMatrix 9 元素轴对齐矩阵检测（缩放矩阵/标志位，不是真正的旋转）。
func ptkIsAxisMatrix(buf []byte, off int) bool {
	if off < 0 || off+36 > len(buf) {
		return false
	}
	nz, ones := 0, 0
	for i := 0; i < 9; i++ {
		v := math.Abs(float64(math.Float32frombits(binary.LittleEndian.Uint32(buf[off+i*4:]))))
		if v > 1e-6 {
			nz++
			if math.Abs(v-1.0) < 1e-4 {
				ones++
			}
		}
	}
	return nz == 3 && ones == 3
}

// ptkRot3OK 3x3 旋转矩阵校验（列归一 + 两两正交）。
func ptkRot3OK(buf []byte, off int) bool {
	if off < 0 || off+36 > len(buf) {
		return false
	}
	var m [9]float64
	for i := 0; i < 9; i++ {
		f := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+i*4:]))
		if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
			return false
		}
		m[i] = float64(f)
	}
	for c := 0; c < 3; c++ {
		n := m[c]*m[c] + m[3+c]*m[3+c] + m[6+c]*m[6+c]
		if math.Abs(n-1.0) > 0.05 {
			return false
		}
	}
	dot := func(a, b int) float64 {
		return m[a]*m[b] + m[3+a]*m[3+b] + m[6+a]*m[6+b]
	}
	if math.Abs(dot(0, 1)) > 0.05 || math.Abs(dot(0, 2)) > 0.05 || math.Abs(dot(1, 2)) > 0.05 {
		return false
	}
	return true
}

// ptkValidRotRec 校验 TOTK 跨场景持久 3x4 变换记录：
// 前 0x24（36 字节）为非轴对齐正交 3x3 旋转矩阵，当前 off 处为合法坐标。
func ptkValidRotRec(buf []byte, off int) bool {
	if off < 36 || off+12 > len(buf) {
		return false
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(buf[off:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+4:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+8:]))
	if !ptkCoordOK(x, zs, yn) {
		return false
	}
	return ptkRot3OK(buf, off-36) && !ptkIsAxisMatrix(buf, off-36)
}

// ptkRun48Length 以 0x48 步长统计连续合法的 3x4 旋转矩阵+坐标记录数（双缓冲 → Run>=2）。
func ptkRun48Length(buf []byte, off int) int {
	if !ptkValidRotRec(buf, off) {
		return 0
	}
	n := 1
	for k := 1; k <= 16; k++ {
		if ptkValidRotRec(buf, off+k*ptkRotRecStride) {
			n++
		} else {
			break
		}
	}
	for k := 1; k <= 16; k++ {
		if off-k*ptkRotRecStride >= 36 && ptkValidRotRec(buf, off-k*ptkRotRecStride) {
			n++
		} else {
			break
		}
	}
	return n
}

// ptkRun28Length 统计连续符合 28 字节 (12B 坐标 + 16B 单位四元数) 的 RingBuffer 帧数。
// PC 版实测该队列在林克真身上连续存在 4~10 帧，且全内存唯一，跨传送永不销毁。
func ptkRun28Length(buf []byte, off int) int {
	n := 0
	for k := 0; k < 10; k++ {
		o := off + k*ptkRing28Stride
		if o+ptkRing28Stride > len(buf) {
			break
		}
		x := math.Float32frombits(binary.LittleEndian.Uint32(buf[o:]))
		zs := math.Float32frombits(binary.LittleEndian.Uint32(buf[o+4:]))
		yn := math.Float32frombits(binary.LittleEndian.Uint32(buf[o+8:]))
		if !ptkCoordOK(x, zs, yn) {
			break
		}
		if !ptkIsQuatUnit(buf, o+12) {
			break
		}
		n++
	}
	return n
}

type ptkHit struct {
	Addr   uintptr
	P      [3]float32 // 内存序 X, Z_stored, Y_north
	Copies int
	Rot    bool
	Quat   bool
	Run    int
	Dist   float32
	Chunk  uintptr // 命中所在块基址（诊断用：判断落在哪个区）

	// 朝向（2026-10-31 实机确认）：来自坐标前 0x30 处的 3x4 变换矩阵。
	HasHeading bool
	Heading    float32 // 方位角：北=0°，东=90°（顺时针递增）
}

// ptkFindEdenTriples 滑动扫描：4 字节步进，坐标合法 → 结构判定 → 收集候选。
//
// 与 totknavi 原版的差异（2026-10-31 内存爆炸修复）：原版把**所有**合法三元组
// 都 append 进 hits，PC 版 8.4GB 内存下会积累上千万条（实测探针进程吃 1.4GB），
// 而其中裸坐标最终都会被 Run>=2 门禁丢掉。故此处提前只收"有结构"的：
//   - 0x48 步长 3x4 矩阵持久槽（run48>=2）：全局仅个位数，**不限距离**全收
//   - 四元数刚体槽（Run>=2）：数量较多，按 anchor 窗口过滤（anchor 为 nil 时不限）
//
// 其余裸坐标一律不收集 —— 不影响命中结果，只省内存和时间。
func ptkFindEdenTriples(buf []byte, base uintptr, anchor *[3]float32, radius float32) []ptkHit {
	var hits []ptkHit
	for off := 0; off+12+16 <= len(buf); off += 4 {
		x := math.Float32frombits(binary.LittleEndian.Uint32(buf[off:]))
		zs := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+4:]))
		yn := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+8:]))
		if !ptkCoordOK(x, zs, yn) {
			continue
		}
		p := [3]float32{x, zs, yn}
		d := float32(0)
		if anchor != nil {
			d = dist3(p, *anchor)
		}
		// 严格限定窗口半径：超出 radius 的任何对象一律拒绝（绝不将超出范围的物体拉进候选）
		if anchor != nil && radius > 0 && d > radius {
			continue
		}


		// ① ★ PC 版 28 字节物理运动 RingBuffer 队列（Quat 刚体，按距离排序，不赋予虚假 Rot 特权）
		if run28 := ptkRun28Length(buf, off); run28 >= 2 {
			hits = append(hits, ptkHit{
				Addr: base + uintptr(off), P: p, Dist: d,
				Quat: true, Run: run28, Chunk: base,
			})
			continue
		}
		if run48 := ptkRun48Length(buf, off); run48 >= 2 {
			hits = append(hits, ptkHit{
				Addr: base + uintptr(off), P: p, Dist: d,
				Rot: true, Run: run48, Chunk: base,
			})
			continue
		}
		// ② 次选：四元数刚体槽，需 Run>=2；按窗口过滤控量
		if !ptkIsQuatUnit(buf, off+0x0C) {
			continue
		}
		run := ptkRunLength(buf, off)
		if run < 2 {
			continue
		}
		if anchor != nil && radius > 0 && d > radius {
			continue
		}
		hits = append(hits, ptkHit{
			Addr: base + uintptr(off), P: p, Dist: d,
			Quat: true, Run: run, Chunk: base,
		})
	}
	return hits
}

// ptkGroupHits 按坐标 0.1m 聚合：Copies 累计、优先保留 0x48 持久旋转矩阵槽。
// 排序：Rot > 距锚点 > Quat > Run。
func ptkGroupHits(hits []ptkHit) []ptkHit {
	if len(hits) == 0 {
		return nil
	}
	type key struct{ x, y, z int32 }
	idx := make(map[key]int, len(hits))
	out := make([]ptkHit, 0, len(hits))
	for _, h := range hits {
		k := key{
			int32(math.Round(float64(h.P[0]) * 10)),
			int32(math.Round(float64(h.P[1]) * 10)),
			int32(math.Round(float64(h.P[2]) * 10)),
		}
		if i, ok := idx[k]; ok {
			out[i].Copies++
			if (h.Rot && !out[i].Rot) || (h.Rot == out[i].Rot && h.Run > out[i].Run) {
				out[i].Addr = h.Addr
				out[i].Run = h.Run
				out[i].Chunk = h.Chunk
				out[i].HasHeading = h.HasHeading
				out[i].Heading = h.Heading
			}
			out[i].Rot = out[i].Rot || h.Rot
			out[i].Quat = out[i].Quat || h.Quat
			continue
		}
		h.Copies = 1
		idx[k] = len(out)
		out = append(out, h)
	}
	isMain := func(a uintptr) bool {
		return a >= totkPCScanMainLo && a < totkPCScanMainHi
	}

	sort.SliceStable(out, func(i, j int) bool {
		// ① 先排除"副本爆炸"的静态表：局部空间骨骼/物件表排最后
		si := out[i].Copies > 24
		sj := out[j].Copies > 24
		if si != sj {
			return !si
		}
		// ② ★ 主模块 .bss 静态段优先（跨场景永不销毁）
		mi := isMain(out[i].Addr)
		mj := isMain(out[j].Addr)
		if mi != mj {
			return mi
		}
		// ③ ★ 结构类型优先：Rot（3x4 旋转矩阵持久槽）排最前，对齐技术手册 Rot > Quat > Dist
		if out[i].Rot != out[j].Rot {
			return out[i].Rot
		}
		// ④ 带实时有效朝向优先
		if out[i].HasHeading != out[j].HasHeading {
			return out[i].HasHeading
		}
		// ⑤ 同级按距锚点升序
		if math.Abs(float64(out[i].Dist-out[j].Dist)) > 1.0 {
			return out[i].Dist < out[j].Dist
		}
		// ⑥ 距离相近时：Run 动力学长度优先，其次副本数
		if out[i].Run != out[j].Run {
			return out[i].Run > out[j].Run
		}
		if out[i].Copies != out[j].Copies {
			return out[i].Copies > out[j].Copies
		}
		return out[i].Dist < out[j].Dist
	})
	return out
}

// ptkReadSlot 读取一个完整槽：HUD 坐标 + 朝向。
//
// 一次读 64 字节（矩阵起始 = 坐标 - 0x30，到坐标 + 0x10），比分开读两次快，
// 也保证坐标与朝向来自同一帧，不会出现「新坐标配旧朝向」的撕裂。
func ptkReadSlot(h uintptr, addr uintptr) (pos [3]float32, heading float32, hasHeading bool, ok bool) {
	if addr < 0x30 {
		return pos, 0, false, false
	}
	d := readMem(h, addr-0x30, 0x40)
	if len(d) < 0x3C {
		return pos, 0, false, false
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(d[0x30:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(d[0x34:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(d[0x38:]))
	if !ptkCoordOK(x, zs, yn) {
		return pos, 0, false, false
	}
	pos = [3]float32{x, -yn, zs - elevBias} // HUD 序
	return pos, 0, false, true
}

// ptkDecodeBytes 宽松解码（与扫描同口径）：12 字节 → HUD 序 (gx, gy, gz)。
func ptkDecodeBytes(d []byte) []float32 {
	if len(d) < 12 {
		return nil
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(d[0:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(d[4:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(d[8:]))
	if !ptkCoordOK(x, zs, yn) {
		return nil
	}
	return []float32{x, -yn, zs - elevBias}
}

// ---- 扫描调度 ----

// ptkScanBlocks 并行扫描给定块（4 worker × 8MB chunk，与 totknavi 同参数）。
// progress 非空时每完成一个 chunk 回调（已扫字节累计），用于长扫描进度提示。
func ptkScanBlocks(h uintptr, blks []MemBlock, anchor *[3]float32, radius float32, progress func(done, total uintptr)) []ptkHit {
	if len(blks) == 0 {
		return nil
	}
	const chunk = 8 << 20
	const overlap = 256
	const sleepPerChunk = 4 * time.Millisecond
	const workers = 6

	type scanJob struct {
		addr uintptr
		n    int
	}
	var jobs []scanJob
	total := uintptr(0)
	for _, b := range blks {
		if b.Size == 0 {
			continue
		}
		total += b.Size
		for off := uintptr(0); off < b.Size; off += uintptr(chunk) {
			n := chunk
			if remain := int(b.Size - off); remain < n {
				n = remain
			}
			if uintptr(n) < b.Size-off {
				n += overlap
			}
			jobs = append(jobs, scanJob{b.Base + off, n})
		}
	}
	if len(jobs) == 0 {
		return nil
	}

	var allHits []ptkHit
	var mu sync.Mutex
	var doneCount uintptr
	var dmu sync.Mutex

	ch := make(chan scanJob, workers*2)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				buf := readMem(h, j.addr, j.n)
				time.Sleep(sleepPerChunk) // 让出 CPU，避免拖慢游戏（实测 Eden 同款）
				dmu.Lock()
				doneCount += uintptr(j.n)
				dc := doneCount
				dmu.Unlock()
				if progress != nil {
					progress(dc, total)
				}
				if len(buf) < 12 {
					continue
				}
				hits := ptkFindEdenTriples(buf, j.addr, anchor, radius)
				if len(hits) == 0 {
					continue
				}
				mu.Lock()
				if len(allHits) < ptkHitCap {
					allHits = append(allHits, hits...)
				}
				mu.Unlock()
			}
		}()
	}
	for _, j := range jobs {
		ch <- j
	}
	close(ch)
	wg.Wait()
	return allHits
}

// ptkScanNear 锚点窗口扫描（对齐 totknavi/core_totk.go 的 scanNear）。
//
// 扫描范围由 Platform.Blocks() 决定（PC 版已收口到主模块 + exe 数据段 + 主堆，约 1.2GB），
// 这里不再做分级/分块优先级之类的额外逻辑 —— 用减法，和模拟器版一个形态。
func ptkScanNear(h uintptr, blks []MemBlock, anchor *[3]float32, radius float32) []ptkHit {
	return ptkScanBlocks(h, blks, anchor, radius, nil)
}
