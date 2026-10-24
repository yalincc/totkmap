// probe_totk.go — --probe 探针：验证 xnavi 动力学根方案（FindEdenTriples + Run>=2）
// 是否适用于 TOTK。
//
// 移植自 BOTW xnavi v3.2.1 platform_eden.go 的扫描原语（原样搬）：
//   FindEdenTriples / isValidRec / IsQuatUnit / RunLength / IsAxisMatrix / Rot3OK / GroupEdenHits
// 坐标校验换为 TOTK 宽松版（ptkCoordOK，三层范围）：
//   - 只做基础合法性（NaN/Inf/全零/近零/范围）
//   - 不做老路策略性拒绝（isWhole32 整数拒 / Z_stored 近零拒）——
//     动力学根真槽坐标可能是整数，探针只依赖结构特征（Run>=2 + 单位四元数）区分真身
//
// 探针只扫描、锁定 top1 连续读取验证跟随，不接管正式定位、不写 known、不动现有逻辑。
// 用法：xnavi.exe --probe [--emu=auto|ryujinx|eden]

package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"sort"
	"sync"
	"time"
)

// ---- 扫描原语（xnavi v3.2.1 原样移植）----

const (
	ptkRecStride       = 0x40 // 64 字节步长（四元数刚体槽）
	ptkRotRecStride    = 0x48 // 72 字节步长（TOTK 跨场景持久 3x4 旋转矩阵+坐标双缓冲槽）
	ptkQuatWindowBytes = 0x0C + 16
)

// ptkCoordOK TOTK 坐标校验（内存序 X, Z_stored, Y_north；对齐 BOTW xnavi v3.2.2 WorldCoordOK）。
// 严格剔除退化标志位向量（如 (0,1,Y) / (1,1,Y) / 近零噪声），同时放行神庙中轴线 X=0 的合法本地坐标。
func ptkCoordOK(x, zs, yn float32) bool {
	fx, fzs, fyn := float64(x), float64(zs), float64(yn)
	if math.IsNaN(fx) || math.IsNaN(fzs) || math.IsNaN(fyn) ||
		math.IsInf(fx, 0) || math.IsInf(fzs, 0) || math.IsInf(fyn, 0) {
		return false
	}
	if x == 0 && zs == 0 && yn == 0 {
		return false // 标题/加载画面，槽位未初始化
	}
	// 非零 denormal 剔除（允许神庙对称轴 x==0 或 yn==0，但拒绝非零极小 subnormal 垃圾浮点）
	if (x != 0 && abs32(x) < 1e-6) || (zs != 0 && abs32(zs) < 1e-6) || (yn != 0 && abs32(yn) < 1e-6) {
		return false
	}
	// ① 近零向量与原点退化噪声剔除（对齐 WorldCoordOK：X 与 Y 不能同时为 0）
	if math.Abs(fx) < 0.001 && math.Abs(fyn) < 0.001 {
		return false
	}
	if math.Abs(fx) < 10 && math.Abs(fyn) < 10 && math.Abs(fzs) < 5 {
		return false
	}
	// ② 排除轴上退化坐标与单位缩放/标志位特征（如 X≈0/1 且 Z_stored≈1 -> 曾致 (1.0,-20,-104) 跳地底）
	if (x == 0 || yn == 0 || math.Abs(fx-1.0) < 0.01 || math.Abs(fyn-1.0) < 0.01) && math.Abs(fzs-1.0) < 0.01 {
		return false
	}
	// ③ 排除 (0, 0, Y) 或 (X, 0, 0) 等退化向量
	if (x == 0 || math.Abs(fx) < 0.001) && math.Abs(fzs) < 0.001 {
		return false
	}
	if (yn == 0 || math.Abs(fyn) < 0.001) && math.Abs(fzs) < 0.001 {
		return false
	}
	// 范围（对应 hud gx/gy ∈ (-6000,6000)）
	if x <= -6000 || x >= 6000 || yn <= -6000 || yn >= 6000 {
		return false
	}
	// 高度（对应 hud gz ∈ (-1300,3200)，gz = Z_stored - elevBias）
	gz := zs - elevBias
	if gz <= -1300 || gz >= 3200 {
		return false
	}
	return true
}

// ptkIsQuatUnit 坐标后 0x0C 处 16 字节是否为单位四元数（xnavi IsQuatUnit 原样）。
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

// ptkValidRec 合法记录 = 坐标合法 + 坐标后 0x0C 处单位四元数（xnavi isValidRec 原样）。
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

// ptkRunLength 以 0x40 步长向前后各延伸 16 跳，统计连续合法记录数（xnavi RunLength 原样）。
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

// ptkIsAxisMatrix 9 元素轴对齐矩阵检测（xnavi IsAxisMatrix 原样）。
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

// ptkRot3OK 3x3 旋转矩阵校验（xnavi Rot3OK 原样）。
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

// ptkValidRotRec 校验 TOTK 跨场景持久 3x4 变换记录：前 0x24（36 字节）为非轴对齐正交 3x3 旋转矩阵，
// 当前 off 处为合法坐标。实测主模块 .bss 全局槽（如 0x208D2FDF534 / 0x207EA70D534）以 0x48（72 字节）
// 步长双缓冲此结构，跨大传送与进出神庙永不销毁。
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

// ptkRun48Length 以 0x48（72 字节）步长统计连续合法的 3x4 旋转矩阵+坐标记录数。
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

type ptkHit struct {
	Addr   uintptr
	P      [3]float32 // 内存序 X, Z_stored, Y_north
	Copies int
	Rot    bool
	Quat   bool
	Run    int
	Dist   float32
}

// ptkFindEdenTriples 滑动扫描：4 字节步进，坐标合法 → 锚点窗口过滤 →
// 优先提取 0x48 步长 3x4 旋转矩阵持久槽（Rot=true, Run>=2），次选 0x40 步长四元数刚体槽。
func ptkFindEdenTriples(buf []byte, base uintptr, anchor *[3]float32, radius float32) []ptkHit {
	var hits []ptkHit
	for off := 0; off+12+16 <= len(buf); off += 4 {
		x := math.Float32frombits(binary.LittleEndian.Uint32(buf[off:]))
		zs := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+4:]))
		yn := math.Float32frombits(binary.LittleEndian.Uint32(buf[off+8:]))
		if !ptkCoordOK(x, zs, yn) {
			continue
		}
		d := float32(0)
		if anchor != nil {
			d = dist3([3]float32{x, zs, yn}, *anchor)
			if radius > 0 && d > radius {
				continue
			}
		}
		h := ptkHit{
			Addr: base + uintptr(off),
			P:    [3]float32{x, zs, yn},
			Dist: d,
		}
		if run48 := ptkRun48Length(buf, off); run48 >= 2 {
			h.Rot = true
			h.Run = run48
		} else {
			h.Quat = ptkIsQuatUnit(buf, off+0x0C)
			if h.Quat {
				h.Run = ptkRunLength(buf, off)
			}
		}
		hits = append(hits, h)
	}
	return hits
}

// ptkGroupHits 按坐标 0.1m 聚合：Copies 累计、优先保留 0x48 持久旋转矩阵槽（Rot=true）。
// 排序：0x48 旋转矩阵持久槽（Rot） > 四元数槽（Quat） > 距存档锚点距离（Dist）。
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
			}
			out[i].Rot = out[i].Rot || h.Rot
			out[i].Quat = out[i].Quat || h.Quat
			continue
		}
		h.Copies = 1
		idx[k] = len(out)
		out = append(out, h)
	}
	sort.SliceStable(out, func(i, j int) bool {
		// ① 有连续 Run 的优先
		if (out[i].Run > 0) != (out[j].Run > 0) {
			return out[i].Run > 0
		}
		// ② 0x48 步长 3x3 旋转矩阵持久槽最优先（跨传送/跨神庙永不销毁）
		if out[i].Rot != out[j].Rot {
			return out[i].Rot
		}
		// ③ 四元数指纹次之
		if out[i].Quat != out[j].Quat {
			return out[i].Quat
		}
		// ④ 距锚点越近越优先
		return out[i].Dist < out[j].Dist
	})
	return out
}

// ---- 探针主流程 ----

// ptkPrintf 探针输出。走 os.Stdout（已被 enableLogTimestamps 换成管道写端），
// 后台转发协程实时读到并带时间戳写出，无需也不可调 flushLog()——
// flushLog 会关闭管道写端并停掉转发协程，此后所有输出全部丢失（2026-10-23 实测踩坑）。
func ptkPrintf(format string, a ...any) {
	fmt.Printf(format, a...)
}

// ptkScanBlocks 并行扫描全部块（照搬 xnavi scanNear 结构：4 worker × 8MB chunk）。
func ptkScanBlocks(h uintptr, blks []MemBlock, anchor *[3]float32, radius float32) []ptkHit {
	if len(blks) == 0 {
		return nil
	}
	var allHits []ptkHit
	var mu sync.Mutex

	const chunk = 8 << 20
	const overlap = 256
	const sleepPerChunk = 4 * time.Millisecond
	workers := 4

	type scanJob struct {
		addr uintptr
		n    int
	}
	var jobs []scanJob
	for _, b := range blks {
		if b.Size == 0 {
			continue
		}
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

	ch := make(chan scanJob, workers*2)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				buf := readMem(h, j.addr, j.n)
				time.Sleep(sleepPerChunk)
				if len(buf) < 12 {
					continue
				}
				hits := ptkFindEdenTriples(buf, j.addr, anchor, radius)
				if len(hits) == 0 {
					continue
				}
				mu.Lock()
				allHits = append(allHits, hits...)
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

// ptkDecodeBytes 宽松版解码（与扫描同口径）：12 字节 → hud 序 (gx, gy, gz)。
// 不做 edenDecodeBytes 的 Z_stored 近零拒等严格策略——探针验证必须与扫描判据一致，
// 否则锁定后 decode 判 invalid 无法验证跟随（2026-10-24 实测：Run=33 候选 Zs=3.3
// 被严格版拒死，10 秒连读全 invalid，其实地址数据正常）。
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
	return []float32{x, -yn, zs - elevBias} // hud 序 (gx=X东, gy=-Y北, gz=Z高)
}

// probeRun --probe 主流程：扫描命中 → 锁定 top1 连续读 10s 验证跟随 → 按回车再扫。
func probeRun() {
	// 平台选择：优先显式指定，否则自动探测；确保已 Attach（Handle != 0）
	p := currentPlatform()
	if p == nil || p.Handle() == 0 {
		p = probePlatform()
	}
	if p == nil {
		ptkPrintf("[probe] 无可用平台驱动。\n")
		return
	}
	if !p.Attach() {
		ptkPrintf("[probe] 未检测到模拟器进程（Ryujinx/Eden）。请先启动游戏，再运行探针。\n")
		return
	}
	h := p.Handle()
	ptkPrintf("[probe] 平台: %s pid=%d 小端=%v\n", p.Name(), p.PID(), p.LittleEndian())

	rd := bufio.NewReader(os.Stdin)
	var prevTop *ptkHit
	round := 0
	for {
		round++
		ptkPrintf("[probe] === 第 %d 轮扫描 ===\n", round)

		// 存档锚点（复用 TOTK 老路解析：progress.sav/caption.sav 按标题过滤）
		anchors := edenReadAnchorsCached()
		var anchor *[3]float32
		if len(anchors) > 0 {
			a := anchors[0].Pos
			anchor = &a
			ptkPrintf("[probe] 存档锚点(内存序 X,Z_stored,Y_north)=(%.1f, %.1f, %.1f) 文件=%s\n",
				a[0], a[1], a[2], anchors[0].Path)
		} else {
			ptkPrintf("[probe] 未读到存档锚点 → 全量扫描不过滤窗口（可能命中较多）\n")
		}

		// 块枚举：Eden 全 RW 区域 / Ryujinx 最大 guest DRAM 优先
		blks := p.Blocks(0.0625)
		total := uintptr(0)
		for _, b := range blks {
			total += b.Size
		}
		ptkPrintf("[probe] 扫描块数=%d 总大小=%.1fMB（全量扫描约 %d 秒）\n",
			len(blks), float64(total)/1048576.0, 8+int(float64(total)/1048576.0/426.0))

		t0 := time.Now()
		var radius float32 = 120.0
		allHits := ptkScanBlocks(h, blks, anchor, radius)
		// Run>=2 真身门禁（xnavi 同款）
		var identHits []ptkHit
		for _, hit := range allHits {
			if hit.Run >= 2 {
				identHits = append(identHits, hit)
			}
		}
		groups := ptkGroupHits(identHits)
		elapsed := time.Since(t0)

		ptkPrintf("[probe] 原始命中=%d → Run>=2 门禁后=%d 组=%d（耗时 %.1fs）\n",
			len(allHits), len(identHits), len(groups), elapsed.Seconds())

		if len(groups) == 0 {
			ptkPrintf("[probe] 未命中 Run>=2 动力学根。可能原因：结构参数不同（stride/四元数偏移）、游戏未进 3D 世界、或锚点窗口太小。\n")
		} else {
			show := groups
			if len(show) > 10 {
				show = groups[:10]
			}
			for i, g := range show {
				// 内存序 → hud 序（gx=X东, gy=-Y北, gz=Z高）
				ptkPrintf("[probe]   #%d addr=0x%X run=%d copies=%d rot=%v 内存序(X,Zs,Yn)=(%.1f, %.1f, %.1f) hud=(%.1f, %.1f, %.1f) 距锚点=%.1fm\n",
					i+1, g.Addr, g.Run, g.Copies, g.Rot, g.P[0], g.P[1], g.P[2],
					g.P[0], -g.P[2], g.P[1]-elevBias, g.Dist)
			}

			// 与上一轮对比：top1 地址是否延续
			if prevTop != nil {
				if prevTop.Addr == groups[0].Addr {
					ptkPrintf("[probe] 对比上轮：top1 地址 0x%X 延续 ✓（动力学根地址跨轮稳定）\n", prevTop.Addr)
				} else {
					ptkPrintf("[probe] 对比上轮：top1 地址从 0x%X 变为 0x%X（候选轮换）\n", prevTop.Addr, groups[0].Addr)
				}
			}
			prevTop = &groups[0]

			// 锁定 top1 连续读 10 秒验证跟随（请玩家走动）
			ptkPrintf("[probe] 锁定 top1 连续读取 10 秒验证跟随 —— 请在这 10 秒内【走动几步】…\n")
			top := groups[0]
			last := [3]float32{}
			haveLast := false
			for t := 0; t < 20; t++ {
				d := ptkDecodeBytes(readMem(h, top.Addr, 12))
				if d != nil {
					line := fmt.Sprintf("[probe]   %s addr=0x%X hud=(%.1f, %.1f, %.1f)", time.Now().Format("15:04:05"), top.Addr, d[0], d[1], d[2])
					if haveLast {
						delta := dist3f([3]float32{d[0], d[1], d[2]}, last)
						line += fmt.Sprintf(" 位移=%.1fm", delta)
					}
					last = [3]float32{d[0], d[1], d[2]}
					haveLast = true
					ptkPrintf("%s\n", line)
				} else {
					ptkPrintf("[probe]   %s addr=0x%X <invalid>\n", time.Now().Format("15:04:05"), top.Addr)
				}
				time.Sleep(500 * time.Millisecond)
			}
			ptkPrintf("[probe] 10 秒跟随验证结束。\n")
		}

		ptkPrintf("[probe] 按回车扫下一轮（可验证传送/切层后地址是否延续）；Ctrl+C 退出\n> ")
		rd.ReadString('\n')
	}
}
