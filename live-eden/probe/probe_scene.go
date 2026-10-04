// probe_scene — 场景切换压力监控探针（只读）：
//   每 2 秒扫"已知相关块"（锚点窗口过滤 float32），报告窗口内命中 top5；
//   每 30 秒做一次全区域窗口扫描刷新候选块（防场景切换后槽地址迁移漏检）。
// 用法: probe_scene.exe <pid> <duration_sec>
// 零写入：仅 OpenProcess(QUERY|VM_READ) + VirtualQueryEx + ReadProcessMemory。
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
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procVirtualQueryEx           = kernel32.NewProc("VirtualQueryEx")
	procReadProcessMemory        = kernel32.NewProc("ReadProcessMemory")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
)

const (
	processQueryInformation = 0x0400
	processVMRead           = 0x0010
	th32csSnapprocess       = 0x00000002
	memCommit               = 0x1000
	chunkSize               = 8 << 20
	addrLimit               = uintptr(0x7FFFFFFFFFFF)
	maxGroupAddrs           = 16
	elevBias                = 105.0
)

type MemoryBasicInformation struct {
	BaseAddress       uintptr
	AllocationBase    uintptr
	AllocationProtect uint32
	PartitionId       uint16
	RegionSize        uintptr
	State             uint32
	Protect           uint32
	Type              uint32
}

type ProcessEntry32W struct {
	Size            uint32
	Usage           uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	Threads         uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

func findPid(prefix string) uint32 {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapprocess, 0)
	if snap == 0 || snap == uintptr(^uintptr(0)) {
		return 0
	}
	defer procCloseHandle.Call(snap)
	var e ProcessEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		name := utf16Str(e.ExeFile[:])
		if strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			return e.ProcessID
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
	return 0
}

func utf16Str(u []uint16) string {
	n := 0
	for n < len(u) && u[n] != 0 {
		n++
	}
	runes := make([]uint16, n)
	copy(runes, u[:n])
	return string(utf16.Decode(runes))
}

func openProcess(pid uint32) (uintptr, error) {
	r, _, e := procOpenProcess.Call(processQueryInformation|processVMRead, 0, uintptr(pid))
	if r == 0 {
		return 0, e
	}
	return r, nil
}

func readMem(h uintptr, addr uintptr, size int) []byte {
	buf := make([]byte, size)
	var got uintptr
	r, _, _ := procReadProcessMemory.Call(h, addr, uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&got)))
	if r == 0 {
		return nil
	}
	return buf[:got]
}

func vqm(h uintptr, addr uintptr) (MemoryBasicInformation, bool) {
	var mbi MemoryBasicInformation
	r, _, _ := procVirtualQueryEx.Call(h, addr, uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi))
	if r == 0 {
		return mbi, false
	}
	return mbi, true
}

func floats32(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

type blk struct {
	base, size uintptr
	typ, prot  uint32
}

func enumBlocks(h uintptr) []blk {
	var blocks []blk
	addr := uintptr(0)
	for addr < addrLimit {
		mbi, ok := vqm(h, addr)
		if !ok {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		p := mbi.Protect & 0xFF
		if mbi.State == memCommit && (p == 0x02 || p == 0x04 || p == 0x40) {
			blocks = append(blocks, blk{base, size, mbi.Type, p})
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	return blocks
}

func absv(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func validPos(x, zs, yn float64) bool {
	if x == 0 && zs == 0 && yn == 0 {
		return false
	}
	if x != x || zs != zs || yn != yn {
		return false
	}
	if math.IsInf(x, 0) || math.IsInf(zs, 0) || math.IsInf(yn, 0) {
		return false
	}
	if absv(x) < 5 && absv(yn) < 5 {
		return false
	}
	if absv(zs) < 5 {
		return false
	}
	if x <= -6000 || x >= 6000 || yn <= -6000 || yn >= 6000 {
		return false
	}
	if zs <= -1195 || zs >= 3305 {
		return false
	}
	return true
}

func inWindow(x, zs, yn float64, refs [][3]float64, win float64) bool {
	for _, r := range refs {
		if absv(x-r[0]) <= win && absv(zs-r[1]) <= win && absv(yn-r[2]) <= win {
			return true
		}
	}
	return false
}

type grp struct {
	key       [3]int64
	x, zs, yn float64
	copies    int
	addrs     []uintptr
}

type groupScanner struct {
	mu     sync.Mutex
	groups map[[3]int64]*grp
	refs   [][3]float64
	win    float64
}

func newGroupScanner(refs [][3]float64, win float64) *groupScanner {
	return &groupScanner{groups: map[[3]int64]*grp{}, refs: refs, win: win}
}

func (s *groupScanner) mergeLocal(local map[[3]int64]*grp) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, g := range local {
		t := s.groups[k]
		if t == nil {
			t = &grp{key: k, x: g.x, zs: g.zs, yn: g.yn}
			s.groups[k] = t
		}
		t.copies += g.copies
		if len(t.addrs) < maxGroupAddrs {
			n := maxGroupAddrs - len(t.addrs)
			if n > len(g.addrs) {
				n = len(g.addrs)
			}
			t.addrs = append(t.addrs, g.addrs[:n]...)
		}
	}
}

func (s *groupScanner) scan(h uintptr, blocks []blk) {
	workers := runtime.NumCPU()
	if workers > 12 {
		workers = 12
	}
	jobs := make(chan blk)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			local := map[[3]int64]*grp{}
			for j := range jobs {
				off := uintptr(0)
				for off < j.size {
					n := uintptr(chunkSize)
					if j.size-off < n {
						n = j.size - off
					}
					buf := readMem(h, j.base+off, int(n))
					if buf != nil && len(buf) >= 12 {
						a := floats32(buf)
						for i := 0; i+3 <= len(a); i++ {
							x, zs, yn := float64(a[i]), float64(a[i+1]), float64(a[i+2])
							if !validPos(x, zs, yn) {
								continue
							}
							if len(s.refs) > 0 && !inWindow(x, zs, yn, s.refs, s.win) {
								continue
							}
							k := [3]int64{int64(math.Round(x * 10)), int64(math.Round(zs * 10)), int64(math.Round(yn * 10))}
							g := local[k]
							if g == nil {
								g = &grp{key: k, x: x, zs: zs, yn: yn}
								local[k] = g
							}
							g.copies++
							if len(g.addrs) < maxGroupAddrs {
								g.addrs = append(g.addrs, j.base+off+uintptr(i)*4)
							}
						}
					}
					off += n
				}
			}
			s.mergeLocal(local)
		}()
	}
	for _, b := range blocks {
		jobs <- b
	}
	close(jobs)
	wg.Wait()
}

func (s *groupScanner) ranked() []*grp {
	s.mu.Lock()
	list := make([]*grp, 0, len(s.groups))
	for _, g := range s.groups {
		list = append(list, g)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].copies != list[j].copies {
			return list[i].copies > list[j].copies
		}
		return true
	})
	return list
}

// ---- 存档锚点（同 v5）----

func totkSaveRootCandidates() []string {
	var out []string
	if v := os.Getenv("TOTK_SAVE_DIR"); v != "" {
		out = append(out, v)
	}
	for _, c := range []string{
		`G:\YUZU\eden\user\nand\user\save`,
		filepath.Join(os.Getenv("APPDATA"), "Eden", "user", "nand", "user", "save"),
		filepath.Join(os.Getenv("APPDATA"), "yuzu", "user", "nand", "user", "save"),
	} {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			out = append(out, c)
		}
	}
	return out
}

func readAnchors() [][3]float64 {
	const titleID = "0100F2C0115B6000"
	var refs [][3]float64
	seen := map[[3]int64]bool{}
	var walk func(dir string)
	walk = func(dir string) {
		ents, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			p := filepath.Join(dir, e.Name())
			if e.IsDir() {
				walk(p)
				continue
			}
			n := strings.ToLower(e.Name())
			var off int
			switch n {
			case "progress.sav":
				off = 0x532AC
			case "caption.sav":
				off = 0x1E0
			default:
				continue
			}
			if !strings.Contains(p, titleID) {
				continue
			}
			data, err := os.ReadFile(p)
			if err != nil || off+12 > len(data) {
				continue
			}
			mx := math.Float32frombits(binary.LittleEndian.Uint32(data[off:]))
			mz := math.Float32frombits(binary.LittleEndian.Uint32(data[off+4:]))
			my := math.Float32frombits(binary.LittleEndian.Uint32(data[off+8:]))
			gx, gz, gy := float64(mx), float64(mz-elevBias), float64(my)
			if gx < -20000 || gx > 20000 || gy < -20000 || gy > 20000 || gz < -2000 || gz > 5000 {
				continue
			}
			k := [3]int64{int64(math.Round(gx * 10)), int64(math.Round(gz * 10)), int64(math.Round(gy * 10))}
			if seen[k] {
				continue
			}
			seen[k] = true
			refs = append(refs, [3]float64{gx, float64(mz), gy})
		}
	}
	for _, root := range totkSaveRootCandidates() {
		walk(root)
	}
	return refs
}

// ---- 候选块管理 ----

// 初始候选块：两次基线窗口扫描命中过的块。
var seedBases = []uintptr{
	0x02C3D690E000, // 本次真槽 0x02C3D6984CD0
	0x02D462E71000, // 本次窗口 top1/top2
	0x02D47EC1E000, // double 槽区
	0x02D4B1820000, // v5 真槽（可能已废，保留）
	0x022DEBD40000, // 占位/闪变槽区
	0x02D464AC0000, // v5 double 槽 0x02D464ACAB30 附近
}

func pickCandidates(blocks []blk, seeds []uintptr) []blk {
	var out []blk
	seen := map[uintptr]bool{}
	for _, b := range blocks {
		if b.size < 64<<20 {
			continue // 候选只挑大块？不对——真槽常在 <8MB 微块。
		}
		for _, s := range seeds {
			if s >= b.base && s < b.base+b.size && !seen[b.base] {
				out = append(out, b)
				seen[b.base] = true
				break
			}
		}
	}
	// 微块：种子所在 <8MB 块也要
	for _, b := range blocks {
		if b.size >= 64<<20 {
			continue
		}
		for _, s := range seeds {
			if s >= b.base && s < b.base+b.size && !seen[b.base] {
				out = append(out, b)
				seen[b.base] = true
				break
			}
		}
	}
	return out
}

func printTop5(groups []*grp) {
	for i := 0; i < len(groups) && i < 5; i++ {
		g := groups[i]
		fmt.Printf("   #%d c=%-6d (%.2f, %.2f, %.2f) alt=%.2f @0x%012X\n",
			i+1, g.copies, g.x, g.zs, g.yn, g.zs-105, g.addrs[0])
	}
}

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: probe_scene.exe <pid> <duration_sec>")
		os.Exit(1)
	}
	var pid uint32
	fmt.Sscanf(os.Args[1], "%d", &pid)
	dur, _ := time.ParseDuration(os.Args[2] + "s")
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		// fallback: 按名称找
		pid = findPid("eden")
		h, err = openProcess(pid)
		if err != nil || h == 0 {
			fmt.Printf("OpenProcess failed: %v\n", err)
			os.Exit(1)
		}
	}
	defer procCloseHandle.Call(h)
	fmt.Printf("attached pid=%d  %s  dur=%s\n\n", pid, time.Now().Format("15:04:05"), dur)

	// 初始：全区域窗口扫描一次（拿初始候选 + 玩家位置）
	fmt.Println("--- initial full window scan (float32, +/-120m) ---")
	t0 := time.Now()
	blocks := enumBlocks(h)
	fmt.Printf("blocks=%d enum=%.1fs\n", len(blocks), time.Since(t0).Seconds())
	refs := readAnchors()
	fmt.Printf("anchors=%d\n", len(refs))
	if len(refs) == 0 {
		fmt.Println("NO ANCHORS")
		return
	}
	sw := newGroupScanner(refs, 120)
	sw.scan(h, blocks)
	fmt.Printf("full window scan: %d groups in %.1fs\n", len(sw.ranked()), time.Since(t0).Seconds())
	printTop5(sw.ranked())

	// 候选块初始化：从本轮命中 top5 的地址所在块 + 种子
	var cands []blk
	for i := 0; i < len(sw.ranked()) && i < 5; i++ {
		a := sw.ranked()[i].addrs[0]
		for _, b := range blocks {
			if a >= b.base && a < b.base+b.size {
				cands = append(cands, b)
				break
			}
		}
	}
	cands = append(cands, pickCandidates(blocks, seedBases)...)
	seen := map[uintptr]bool{}
	var uniq []blk
	for _, b := range cands {
		if !seen[b.base] {
			seen[b.base] = true
			uniq = append(uniq, b)
		}
	}
	cands = uniq
	fmt.Printf("candidate blocks: %d (total %.1f MB)\n", len(cands), float64(func() uintptr {
		var t uintptr
		for _, b := range cands {
			t += b.size
		}
		return t
	}())/1048576.0)
	for _, b := range cands {
		fmt.Printf("  0x%012X +%.1fMB\n", b.base, float64(b.size)/1048576.0)
	}
	fmt.Println()

	// 主循环
	deadline := time.Now().Add(dur)
	tick := 0
	lastFull := time.Now()
	for time.Now().Before(deadline) {
		cycleStart := time.Now()
		tick++

		// 每 ~25s 全区域窗口扫描刷新
		if time.Since(lastFull) >= 25*time.Second {
			lastFull = time.Now()
			fmt.Printf("--- [t%02d %s] refresh full window scan ---\n", tick, time.Now().Format("15:04:05"))
			blocks = enumBlocks(h)
			refs = readAnchors()
			sw = newGroupScanner(refs, 120)
			sw.scan(h, blocks)
			top := sw.ranked()
			fmt.Printf("  full window: %d groups\n", len(top))
			printTop5(top)
			// 更新候选块：本轮 top5 所在块 + 种子
			var nc []blk
			for i := 0; i < len(top) && i < 5; i++ {
				a := top[i].addrs[0]
				for _, b := range blocks {
					if a >= b.base && a < b.base+b.size {
						nc = append(nc, b)
						break
					}
				}
			}
			nc = append(nc, pickCandidates(blocks, seedBases)...)
			seen := map[uintptr]bool{}
			cands = cands[:0]
			for _, b := range nc {
				if !seen[b.base] {
					seen[b.base] = true
					cands = append(cands, b)
				}
			}
			fmt.Printf("  updated candidate blocks: %d\n\n", len(cands))
			continue
		}

		// 常规轮：扫候选块
		sw2 := newGroupScanner(refs, 120)
		sw2.scan(h, cands)
		top := sw2.ranked()
		n := len(top)
		line := fmt.Sprintf("t=%03d %s win=%d", tick, time.Now().Format("15:04:05"), n)
		if n > 0 {
			g := top[0]
			line += fmt.Sprintf(" TOP=(%.2f, %.2f, %.2f) alt=%.2f c=%d @0x%012X", g.x, g.zs, g.yn, g.zs-105, g.copies, g.addrs[0])
			if n > 1 {
				g2 := top[1]
				line += fmt.Sprintf(" | 2nd=(%.2f, %.2f, %.2f) c=%d", g2.x, g2.zs, g2.yn, g2.copies)
			}
		} else {
			line += " NO-PLAYER-MATCH"
		}
		fmt.Println(line)
		_ = cycleStart
		// 保持 ~2s 一轮
		el := time.Since(cycleStart)
		if el < 2*time.Second {
			time.Sleep(2*time.Second - el)
		}
	}
	fmt.Printf("\ndone %s\n", time.Now().Format("15:04:05"))
}
