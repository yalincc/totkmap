// chain_eden.go — Eden 指针链快路径（2026-10-11 三关验证通过后的落地实现）。
//
// 模型（手册 §7.1）：解析主模块宿主基址 H → 反解换算常数 K（host = K + guest_va）
// → 沿固定偏移链解引用读坐标。**完全不碰会轮换的裸地址** → 模型级解掉 §5.1 副本轮换，
// 把"跑动掉锁后重扫 20~30s"变成"毫秒级重锁"。
//
// 为什么可行：TOTK 玩家坐标的"活跃槽"位于主模块数据段的一个注册表数组
// （模块偏移跨重启稳定，实测 0x46704C8 / 0x4670508，两者仅差 0x40）；槽指向的
// 动态对象地址每会话变，但由固定偏移链可达。
//
// 回退：初始化失败 / 读失败 / 无参考位置 → chainTry 返回 false，状态机走原路径
// （known → 全量扫描 → 坐标校准），本文件不修改任何现有判据。
//
// 性能：初始化**异步**（不阻塞 200ms/拍的状态机），且按"窄窗口 → 整个 arena →
// 全宿主"三档搜索（主模块 guest VA 实测稳定在 0x80000000±64MB：命中最快档约 0.1~1s；
// 首版扫全宿主 19GB 需 34s，见 2026-10-11 实机记录）。
//
// 依据：归档/开发计划/TOTKnavi-V2.2.0-指针链落地-技术方案-完成.md
//      归档/开发计划/TOTKnavi-V2.2.0-定位逆向-指针链实验记录-进行中.md

package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// ---- 主模块内容锚点（跨重启不变；实测数据，见 定位逆向脚本/module_anchor.txt）----
// 用前 16 字节做搜索键（足够独特 + bytes.Index 快），命中后校验完整 64 字节 + 第二个锚点。

var chainAnchors = []struct {
	Off uintptr
	Pat []byte
}{
	{0x0, chainMustHex("00000000080000004d4f4430e8546104b8036704a8a2720408ae8703fcd1a503b8036704000000000000000000000000ff4302d1fd7b07a9fdc30191f44f08a9")},
	{0x400000, chainMustHex("4368a33c822240f9833241396108019b218400fc2180004d41f7ff54e01980f9f0c10391e03980f9e05980f9efc100919cffff17f0031faa80030491800180f9")},
}

func chainMustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic("chain anchor hex: " + err.Error())
	}
	return b
}

// ---- 候选链（实测偏移；换游戏版本 / BID 需按手册 §7.1 ⑤ 三关重验）----
//
// 形态：coord = *( *( main_base + Slot ) + D1 ) + D2     （两跳）
// 多槽并存：注册表数组里的不同槽对应不同场景容器（地表 / 天空…），按参考位置挑活跃槽。

type chainDef struct {
	Name string
	Slot uintptr // 模块全局槽偏移（相对 main_base）
	D1   uintptr // 第一跳指针偏移
	D2   uintptr // 最终坐标偏移
}

var edenChains = []chainDef{
	{"sky  *( *(main+0x46704C8)+0x3038)+0x2FFC0", 0x46704C8, 0x3038, 0x2FFC0},
	{"surf *( *(main+0x4670508)+0x8   )+0x14510", 0x4670508, 0x8, 0x14510},
}

// ---- 常量（已回填手册 §3.4；每条含"为什么 / 边界"）----

const (
	// chainPickNear 挑活跃槽的距离门限(m)。200 = 给跑动留足余量：预热后掉锁首拍即可
	// 读链（位移本应 <2m），200m 纯属防御闸门；实测"错误候选"（另一场景容器的旧位置）
	// 距正确位置 ~931m，仍能被拒。
	// 2026-10-11 实战教训：初值 50m 太严 —— 走动中掉锁时参考位置距链读值已超 50m → 被拒。
	chainPickNear = 200.0
	// chainAnchorGate 首次定位（以存档锚点为参考）的距离闸门(m)。刚读档时玩家位置与
	// 存档位置差通常 <10m；用 30m 严门限，保证锚点过期（玩家已走远）时果断放弃 → 回退扫描。
	chainAnchorGate = 30.0
	// chainInitRetry 初始化失败重试节流（游戏未加载完等场景）。
	chainInitRetry = 30 * time.Second
	// chainKRange / chainKStep K 反解枚举范围（相对 arena_low）与步长。
	// 实测 δ 很小（0 / 0x30000 / 0x110000），4MB 留足。
	chainKRange = 0x400000
	chainKStep  = 0x1000
	// chainKAnchor K 反解用的模块槽（一个"槽→对象"全局，实测稳定存在）。
	chainKAnchor = 0x46CBCF8
	// chainModRange 模块宿主范围长度（虚表判据）：主模块 text 45MB + rodata 23MB + data，留裕量。
	chainModRange = 0xA000000
	// chainScanStop 单档搜索收集到多少个候选就停（控时）。
	chainScanStop = 8
	// chainReadChunk 扫锚点分块读大小。4MB：单次 ReadProcessMemory 会短暂挂起 Eden，
	// 块越小停顿越短（窄窗口 256MB → 64 块，总耗时仍 <1s）。初版 32MB 单笔挂起偏长。
	chainReadChunk = 4 << 20
	// chainWinLo / chainWinHi 窄窗口（相对 arena_low）：主模块 guest VA 实测稳定在
	// 0x80000000±64MB（三会话 0x805D8000 / 0x80A89000 / 0x80C08000）→ 256MB 窗口即可命中。
	// 越界时自动降级到"整个 arena → 全宿主"。
	chainWinLo = 0x78000000
	chainWinHi = 0x88000000
)

// ---- 初始化状态机（异步；mu 保护）----

const (
	chainStateIdle = iota
	chainStateInit
	chainStateReady
	chainStateFail
)

var chainSt struct {
	mu       sync.Mutex
	pid      uint32
	state    int
	H        uintptr
	K        uintptr
	arenaLow uintptr
	initAt   time.Time
	failAt   time.Time
}

// chainTry 指针链快路径入口。
// refPos=nil（无参考位置）时不启用 —— 避免多槽歧义误锁（保守，交给 known/扫描）。
// 返回 (坐标宿主地址, 坐标, 是否成功)；坐标宿主地址可被状态机逐拍 decode。
func (p *edenPlatform) chainTry(h uintptr, refPos *[3]float32) (uintptr, [3]float32, bool) {
	if h == 0 {
		return 0, [3]float32{}, false
	}
	// refPos=nil 时只推进初始化（预热），不读链 —— 状态机在锁定期间也会调用本函数，
	// 使链在"掉锁那一刻"就已就绪，避免被全量扫描抢先（2026-10-11 实战暴露的缺陷 1）。
	H, K, ok := chainEnsure(h, p.pid)
	if !ok {
		return 0, [3]float32{}, false
	}
	ref := refPos
	gate := float32(chainPickNear)
	if ref == nil {
		// 首次定位（无实时参考）：用**存档锚点位置**（≈刚读档位置）当参考，让首次也能走链
		// → 免掉 11s 全量扫描（= 卡顿主因）。用更严的 chainAnchorGate 兜底：锚点过期
		// （玩家已走远）时不采纳 → 自动回退全量扫描。
		if as := edenReadAnchorsCached(); len(as) > 0 {
			hud := [3]float32{as[0].Pos[0], -as[0].Pos[2], as[0].Pos[1] - elevBias}
			ref = &hud
			gate = chainAnchorGate
		}
	}
	if ref == nil {
		return 0, [3]float32{}, false
	}
	return chainRead(h, H, K, ref, gate)
}

// chainEnsure 取得 (H,K)：已就绪直接返回；否则**异步**触发初始化（不阻塞状态机），
// 本次返回 false。pid 变化即重置。失败按 chainInitRetry 节流。
func chainEnsure(h uintptr, pid uint32) (uintptr, uintptr, bool) {
	chainSt.mu.Lock()
	defer chainSt.mu.Unlock()
	if chainSt.pid != pid {
		chainSt.pid = pid
		chainSt.state = chainStateIdle
		chainSt.failAt = time.Time{}
	}
	switch chainSt.state {
	case chainStateReady:
		return chainSt.H, chainSt.K, true
	case chainStateInit:
		return 0, 0, false // 初始化进行中，等下一拍
	case chainStateFail:
		if time.Since(chainSt.failAt) < chainInitRetry {
			return 0, 0, false
		}
	}
	chainSt.state = chainStateInit
	chainSt.initAt = time.Now()
	go chainInitAsync(h, pid)
	return 0, 0, false
}

// chainInitAsync 后台完成初始化（扫 H + 反解 K），结果写入 chainSt。
func chainInitAsync(h uintptr, pid uint32) {
	H, K, arenaLow, err := chainInit(h)
	elapsed := time.Since(chainSt.initAt).Seconds()
	chainSt.mu.Lock()
	defer chainSt.mu.Unlock()
	if chainSt.pid != pid {
		return // 进程已换，丢弃结果
	}
	if err != nil {
		chainSt.state = chainStateFail
		chainSt.failAt = time.Now()
		fmt.Printf("  [chain] init failed: %v (took %.1fs, retry in %.0fs)\n",
			err, elapsed, chainInitRetry.Seconds())
		return
	}
	chainSt.H, chainSt.K, chainSt.arenaLow = H, K, arenaLow
	chainSt.state = chainStateReady
	fmt.Printf("  [chain] init ok: H=0x%X K=0x%X main_base=0x%X (K-arena_low=0x%X) [took %.1fs]\n",
		H, K, H-K, K-arenaLow, elapsed)
}

// chainInit 扫主模块宿主基址 H + 反解换算常数 K（host = K + guest_va）。
func chainInit(h uintptr) (H, K, arenaLow uintptr, err error) {
	H, arenaLow = chainScanModuleBase(h)
	if H == 0 || arenaLow == 0 {
		return 0, 0, 0, fmt.Errorf("module base not found (H=0x%X arena=0x%X)", H, arenaLow)
	}
	solved, ok := chainSolveK(h, H, arenaLow)
	if !ok {
		return 0, 0, 0, fmt.Errorf("K not solved (H=0x%X)", H)
	}
	return H, solved, arenaLow, nil
}

// chainReg 宿主已提交 RW 区。
type chainReg struct{ base, size uintptr }

// chainScanModuleBase 定位主模块宿主基址 H 与 arena_low（= 4GB MAPPED DRAM 基址 + 4GiB）。
// 三档搜索（由快到慢）：① 窄窗口（相对 arena_low 的 256MB）② 整个 arena ③ 全宿主。
func chainScanModuleBase(h uintptr) (H, arenaLow uintptr) {
	var regs []chainReg
	const limit = uintptr(0x7FFFFFFFFFFF)
	addr := uintptr(0)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		prot := mbi.Protect & 0xFF
		if mbi.State == memCommit && (prot == 0x02 || prot == 0x04) && size >= 16 {
			if arenaLow == 0 && mbi.Type == memMapped && size == (1<<32) {
				arenaLow = base + (1 << 32)
			}
			regs = append(regs, chainReg{base, size})
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	if arenaLow == 0 {
		return 0, 0
	}
	key := chainAnchors[0].Pat[:16]
	// ① 窄窗口（最快，正常都命中这一档）
	if c := chainScanRegs(h, regs, arenaLow+chainWinLo, arenaLow+chainWinHi, key); c != 0 {
		return c, arenaLow
	}
	// ② 整个 arena 窗口
	if c := chainScanRegs(h, regs, arenaLow, 0, key); c != 0 {
		return c, arenaLow
	}
	// ③ 全宿主兜底
	if c := chainScanRegs(h, regs, 0, 0, key); c != 0 {
		return c, arenaLow
	}
	return 0, arenaLow
}

// chainScanRegs 在 [lo, hi) 宿主地址范围内扫各区域找模块基址候选并校验（hi=0 表示无上界）。
// 区域按地址升序，超出 hi 即提前结束。
func chainScanRegs(h uintptr, regs []chainReg, lo, hi uintptr, key []byte) uintptr {
	var cands []uintptr
	for _, r := range regs {
		s, e := r.base, r.base+r.size
		if hi != 0 && s >= hi {
			break
		}
		if e <= lo {
			continue
		}
		if s < lo {
			s = lo
		}
		if hi != 0 && e > hi {
			e = hi
		}
		if e <= s {
			continue
		}
		cands = append(cands, chainScanRange(h, s, e-s, key)...)
		if len(cands) >= chainScanStop {
			break
		}
	}
	// 优先返回"*(H+槽) 是合法堆指针"的候选（更强的佐证）
	for _, c := range cands {
		if !chainVerifyAnchors(h, c) {
			continue
		}
		if v := chainRU64(h, c+chainKAnchor); v > 0x100000 && v < (1<<39) {
			return c
		}
	}
	for _, c := range cands {
		if chainVerifyAnchors(h, c) {
			return c
		}
	}
	return 0
}

// chainScanRange 在一段连续宿主地址内分块读 + bytes.Index 搜 16 字节特征码，
// 返回候选模块基址（命中位置 − 锚点偏移）。
func chainScanRange(h uintptr, start, size uintptr, key []byte) []uintptr {
	var out []uintptr
	o0 := chainAnchors[0].Off
	off := uintptr(0)
	for off < size {
		n := uintptr(chainReadChunk)
		if size-off < n {
			n = size - off
		}
		raw := readMem(h, start+off, int(n))
		if len(raw) >= len(key) {
			pos := 0
			for pos < len(raw) {
				i := bytes.Index(raw[pos:], key)
				if i < 0 {
					break
				}
				p := pos + i
				out = append(out, start+off+uintptr(p)-o0)
				pos = p + 1
				if len(out) >= chainScanStop {
					return out
				}
			}
		}
		if n <= uintptr(len(key)) {
			break
		}
		off += n - uintptr(len(key)) // 块间重叠，防特征码跨块边界
	}
	return out
}

// chainVerifyAnchors 校验候选基址处两处锚点内容完全一致。
func chainVerifyAnchors(h uintptr, base uintptr) bool {
	for _, a := range chainAnchors {
		if got := readMem(h, base+a.Off, len(a.Pat)); !bytes.Equal(got, a.Pat) {
			return false
		}
	}
	return true
}

// slotV 预读的"模块槽 → guest 指针"。
type slotV struct {
	def chainDef
	v0  uintptr
}

// chainSolveK 反解换算常数 K（host = K + guest_va）。
//
// 判据（多锚点交叉验证）：对每个候选 K，逐条链验证
//
//	① *(K+v0)（对象虚表，guest 指针）落在模块宿主范围 [H, H+chainModRange]
//	② 第一跳指针 p1 是合法 guest 指针（0x100000 < p1 < 2³⁹）
//	③ 末端 12 字节是量级合理的坐标（复用 edenDecodeBytes）
//
// 取"满足链数最多"的 K；并列时取坐标量级最大者（真坐标量级大）。
func chainSolveK(h uintptr, H, arenaLow uintptr) (uintptr, bool) {
	var svs []slotV
	for _, c := range edenChains {
		if v0 := chainRU64(h, H+c.Slot); v0 != 0 {
			svs = append(svs, slotV{c, v0})
		}
	}
	if len(svs) == 0 {
		return 0, false
	}
	start := arenaLow &^ 0xFFF
	bestK := uintptr(0)
	bestScore := -1
	bestMag := float32(-1)
	for k := start; k < arenaLow+chainKRange; k += chainKStep {
		score := 0
		var mag float32
		for _, s := range svs {
			vt := chainRU64(h, k+s.v0) // 对象头（应为模块内 guest 虚表指针）
			if vt == 0 || k+vt < H || k+vt > H+chainModRange {
				continue
			}
			p1 := chainRU64(h, k+s.v0+s.def.D1)
			if p1 == 0 || p1 <= 0x100000 || p1 >= (1<<39) {
				continue
			}
			d := edenDecodeBytes(readMem(h, k+p1+s.def.D2, 12))
			if d == nil {
				continue
			}
			score++
			if m := abs32(d[0]) + abs32(d[1]) + abs32(d[2]); m > mag {
				mag = m
			}
		}
		if score == 0 {
			continue
		}
		if score > bestScore || (score == bestScore && mag > bestMag) {
			bestK, bestScore, bestMag = k, score, mag
		}
	}
	return bestK, bestScore > 0
}

// chainRead 走候选链读坐标，按参考位置挑活跃槽（距 refPos 最近且 < gate）。
// gate 是距离闸门：实时参考用 chainPickNear（宽松 200m）；首次用存档锚点用
// chainAnchorGate（严 30m，防锚点过期时锁到"恰好接近锚点的错误槽"）。
func chainRead(h uintptr, H, K uintptr, refPos *[3]float32, gate float32) (uintptr, [3]float32, bool) {
	type cand struct {
		addr uintptr
		pos  [3]float32
		dist float32
	}
	var cands []cand
	for _, c := range edenChains {
		v0 := chainRU64(h, H+c.Slot)
		if v0 == 0 {
			continue
		}
		p1 := chainRU64(h, K+v0+c.D1)
		if p1 == 0 {
			continue
		}
		coordHost := K + p1 + c.D2
		d := edenDecodeBytes(readMem(h, coordHost, 12))
		if d == nil {
			continue
		}
		pos := [3]float32{d[0], d[1], d[2]}
		cands = append(cands, cand{coordHost, pos, dist3(pos, *refPos)})
	}
	if len(cands) == 0 {
		return 0, [3]float32{}, false
	}
	best := cands[0]
	for _, cd := range cands[1:] {
		if cd.dist < best.dist {
			best = cd
		}
	}
	if best.dist >= gate {
		// 最近的候选都超出闸门 → 不锁（交给已知路径），避免锁到"另一场景容器的旧位置"
		return 0, [3]float32{}, false
	}
	return best.addr, best.pos, true
}

// chainRU64 读 8 字节小端无符号整数（失败返回 0）。
func chainRU64(h uintptr, addr uintptr) uintptr {
	b := readMem(h, addr, 8)
	if len(b) != 8 {
		return 0
	}
	return uintptr(b[0]) | uintptr(b[1])<<8 | uintptr(b[2])<<16 | uintptr(b[3])<<24 |
		uintptr(b[4])<<32 | uintptr(b[5])<<40 | uintptr(b[6])<<48 | uintptr(b[7])<<56
}
