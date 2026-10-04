// probe_6gb_v5 — 6GB 布局定位探针 v5（只读）：
//   1. 输出 known 地址的 VirtualQueryEx 状态（判断 8GB→6GB 映射变化）
//   2. 扩展 protect 过滤（0x02/0x04/0x40）重枚举
//   3. 读存档锚点（内联，progress.sav/caption.sav 偏移）
//   4. 锚点窗口扫描：float32 + double 双类型（±120m）
//   5. 全区域扫描（扩展 protect）作对照
//   6. 对 top 候选活性采样
// 零写入：仅 OpenProcess(QUERY|VM_READ) + VirtualQueryEx + ReadProcessMemory。
// 用法：probe_6gb.exe <procname前缀> > probe_6gb_v5_out.txt
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
	maxGroupAddrs           = 64
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

func floats64(b []byte) []float64 {
	if len(b) < 8 {
		return nil
	}
	return unsafe.Slice((*float64)(unsafe.Pointer(&b[0])), len(b)/8)
}

type blk struct {
	base, size uintptr
	typ, prot  uint32
}

// enumBlocks 枚举全部已提交区域；protect 扩展至 0x02/0x04/0x40。
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

func typName(t uint32) string {
	switch t {
	case 0x20000:
		return "MEM_PRIVATE"
	case 0x40000:
		return "MEM_MAPPED"
	case 0x1000000:
		return "MEM_IMAGE"
	}
	return fmt.Sprintf("0x%X", t)
}

func bucketName(size uintptr) string {
	switch {
	case size >= 1<<30:
		return "1GB+"
	case size >= 512<<20:
		return "512MB+"
	case size >= 64<<20:
		return "64MB+"
	case size >= 8<<20:
		return "8MB+"
	default:
		return "<8MB"
	}
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

// inWindow 是否在锚点窗口内（内存序 X, Z_stored, Y_north）。
func inWindow(x, zs, yn float64, refs [][3]float64, win float64) bool {
	for _, r := range refs {
		if absv(x-r[0]) <= win && absv(zs-r[1]) <= win && absv(yn-r[2]) <= win {
			return true
		}
	}
	return false
}

type grp struct {
	key        [3]int64
	x, zs, yn  float64
	copies     int
	whole      int
	structN    int
	addrs      []uintptr
}

type groupScanner struct {
	mu     sync.Mutex
	groups map[[3]int64]*grp
	step   int
	refs   [][3]float64 // 非空时启用窗口过滤
	win    float64
}

func newGroupScanner(step int, refs [][3]float64, win float64) *groupScanner {
	return &groupScanner{groups: map[[3]int64]*grp{}, step: step, refs: refs, win: win}
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
		t.whole += g.whole
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
						if s.step == 4 {
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
								if isWhole(x) && isWhole(zs) && isWhole(yn) {
									g.whole++
								}
								if len(g.addrs) < maxGroupAddrs {
									g.addrs = append(g.addrs, j.base+off+uintptr(i)*4)
								}
							}
						} else {
							a := floats64(buf)
							for i := 0; i+3 <= len(a); i++ {
								x, zs, yn := a[i], a[i+1], a[i+2]
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
								if isWhole(x) && isWhole(zs) && isWhole(yn) {
									g.whole++
								}
								if len(g.addrs) < maxGroupAddrs {
									g.addrs = append(g.addrs, j.base+off+uintptr(i)*8)
								}
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

func isWhole(v float64) bool {
	if v > 4e9 || v < -4e9 {
		return false
	}
	return v == math.Trunc(v)
}

func (s *groupScanner) ranked() []*grp {
	s.mu.Lock()
	list := make([]*grp, 0, len(s.groups))
	for _, g := range s.groups {
		list = append(list, g)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		aLive, bLive := list[i].structN > 0, list[j].structN > 0
		if s.step == 4 && aLive != bLive {
			return aLive
		}
		if list[i].copies != list[j].copies {
			return list[i].copies > list[j].copies
		}
		return true
	})
	return list
}

func rotOK32(h uintptr, addr uintptr) bool {
	buf := readMem(h, addr, 128)
	if len(buf) < 64 {
		return false
	}
	a := floats32(buf)
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

func regionOf(blocks []blk, addr uintptr) string {
	for _, b := range blocks {
		if addr >= b.base && addr < b.base+b.size {
			return fmt.Sprintf("blk0x%012X(+0x%X, %s)", b.base, addr-b.base, bucketName(b.size))
		}
	}
	return "??"
}

// ---- 存档锚点（内联简化版）----

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

// readAnchors 递归找 progress.sav/caption.sav（路径含 TOTK 标题 ID），读坐标。
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

// ---- 活性采样 ----

type samp struct {
	tag  string
	step int
	addr uintptr
}

func rd3(h uintptr, addr uintptr, step int) ([3]float64, bool) {
	if step == 8 {
		var b [24]byte
		var n uintptr
		r, _, _ := procReadProcessMemory.Call(h, addr, uintptr(unsafe.Pointer(&b[0])), 24, uintptr(unsafe.Pointer(&n)))
		if r == 0 || n < 24 {
			return [3]float64{}, false
		}
		a := unsafe.Slice((*float64)(unsafe.Pointer(&b[0])), 3)
		return [3]float64{a[0], a[1], a[2]}, true
	}
	var b [12]byte
	var n uintptr
	r, _, _ := procReadProcessMemory.Call(h, addr, uintptr(unsafe.Pointer(&b[0])), 12, uintptr(unsafe.Pointer(&n)))
	if r == 0 || n < 12 {
		return [3]float64{}, false
	}
	a := unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), 3)
	return [3]float64{float64(a[0]), float64(a[1]), float64(a[2])}, true
}

func liveness(h uintptr, samps []samp) {
	bases := make([][3]float64, len(samps))
	valid := make([]bool, len(samps))
	for i, s := range samps {
		if v, ok := rd3(h, s.addr, s.step); ok {
			bases[i], valid[i] = v, true
		}
	}
	fmt.Printf("sampling %d addresses\n", len(samps))
	for tick := 1; tick <= 20; tick++ {
		time.Sleep(500 * time.Millisecond)
		for i, s := range samps {
			v, ok := rd3(h, s.addr, s.step)
			if !ok {
				if valid[i] {
					fmt.Printf("  t%02d: %s 0x%012X UNREADABLE\n", tick, s.tag, s.addr)
					valid[i] = false
				}
				continue
			}
			if valid[i] {
				dx, dy, dz := v[0]-bases[i][0], v[1]-bases[i][1], v[2]-bases[i][2]
				d := math.Sqrt(dx*dx + dy*dy + dz*dz)
				if d > 0.4 {
					fmt.Printf("  t%02d: %s 0x%012X MOVED %.1fm cur=(%.2f, %.2f, %.2f)\n",
						tick, s.tag, s.addr, d, v[0], v[1], v[2])
				}
			}
			bases[i], valid[i] = v, true
		}
	}
	fmt.Println()
}

func printTop(groups []*grp, h uintptr, blocks []blk, n int, step int, title string) {
	fmt.Printf("%s: %d groups\n", title, len(groups))
	for i := 0; i < len(groups) && i < n; i++ {
		g := groups[i]
		if step == 4 && g.structN == 0 && len(g.addrs) > 0 {
			for j := 0; j < len(g.addrs) && j < 16; j++ {
				if rotOK32(h, g.addrs[j]) {
					g.structN++
				}
			}
		}
		v, _ := rd3(h, g.addrs[0], step)
		wholePct := 0.0
		if g.copies > 0 {
			wholePct = 100 * float64(g.whole) / float64(g.copies)
		}
		fmt.Printf("  #%d copies=%-7d whole=%-5.0f%% struct=%d cur=(%.2f, %.2f, %.2f) alt=%.2f addr=0x%012X %s\n",
			i+1, g.copies, wholePct, g.structN, v[0], v[1], v[2], v[1]-105, g.addrs[0], regionOf(blocks, g.addrs[0]))
	}
	fmt.Println()
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: probe_6gb.exe <procname-prefix>")
		os.Exit(1)
	}
	pid := findPid(os.Args[1])
	if pid == 0 {
		fmt.Printf("no process matching %q\n", os.Args[1])
		os.Exit(1)
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		fmt.Printf("OpenProcess failed: %v\n", err)
		os.Exit(1)
	}
	defer procCloseHandle.Call(h)
	fmt.Printf("attached pid=%d  %s\n\n", pid, time.Now().Format("15:04:05"))

	// ---- 0. known 地址 VQM 状态 ----
	fmt.Println("--- known addr VirtualQueryEx status ---")
	for _, a := range []uintptr{0x022C52D5D534, 0x022BDDFEB4B8, 0x022C53C985E0, 0x022C4F97CC80, 0x024DF6B37000, 0x024E9782F0F0, 0x024E79F03970} {
		mbi, ok := vqm(h, a)
		if !ok {
			fmt.Printf("  0x%012X: VQM failed\n", a)
			continue
		}
		fmt.Printf("  0x%012X: base=0x%012X size=%.1fMB state=0x%X protect=0x%X type=%s\n",
			a, mbi.BaseAddress, float64(mbi.RegionSize)/1048576.0, mbi.State, mbi.Protect, typName(mbi.Type))
	}
	fmt.Println()

	// ---- 1. 区域枚举（扩展 protect）----
	t0 := time.Now()
	blocks := enumBlocks(h)
	var total uintptr
	bucket := map[string]int{}
	for _, b := range blocks {
		total += b.size
		bucket[bucketName(b.size)]++
	}
	fmt.Printf("RW regions (incl EXEC_RW): %d, total %.1f GB\n", len(blocks), float64(total)/(1<<30))
	for _, k := range []string{"1GB+", "512MB+", "64MB+", "8MB+", "<8MB"} {
		fmt.Printf("  %-8s %d\n", k, bucket[k])
	}
	fmt.Printf("enum %.1fs\n\n", time.Since(t0).Seconds())

	// ---- 2. 锚点 ----
	refs := readAnchors()
	fmt.Printf("save anchors: %d\n", len(refs))
	for i, r := range refs {
		fmt.Printf("  #%d mem=(%.1f, %.1f, %.1f)  alt=%.1f\n", i, r[0], r[1], r[2], r[1]-105)
	}
	fmt.Println()

	// ---- 3. 锚点窗口扫描 ----
	if len(refs) > 0 {
		win := 120.0
		ta := time.Now()
		sw := newGroupScanner(4, refs, win)
		sw.scan(h, blocks)
		printTop(sw.ranked(), h, blocks, 10, 4, fmt.Sprintf("WINDOW float32 (+/-%.0fm) %.1fs", win, time.Since(ta).Seconds()))
		tb := time.Now()
		sd := newGroupScanner(8, refs, win)
		sd.scan(h, blocks)
		printTop(sd.ranked(), h, blocks, 10, 8, fmt.Sprintf("WINDOW double (+/-%.0fm) %.1fs", win, time.Since(tb).Seconds()))
	}

	// ---- 4. 全区域扫描（扩展 protect）----
	ta := time.Now()
	sa := newGroupScanner(4, nil, 0)
	sa.scan(h, blocks)
	printTop(sa.ranked(), h, blocks, 12, 4, fmt.Sprintf("FULL float32 %.1fs", time.Since(ta).Seconds()))
	tb := time.Now()
	sb := newGroupScanner(8, nil, 0)
	sb.scan(h, blocks)
	printTop(sb.ranked(), h, blocks, 12, 8, fmt.Sprintf("FULL double %.1fs", time.Since(tb).Seconds()))

	// ---- 5. 活性采样 ----
	fmt.Println("--- liveness sampling (20 ticks x 500ms) ---")
	var samps []samp
	if len(refs) > 0 {
		sw := newGroupScanner(4, refs, 120)
		sw.scan(h, blocks)
		for i := 0; i < len(sw.ranked()) && i < 3; i++ {
			for j := 0; j < len(sw.ranked()[i].addrs) && j < 8; j++ {
				samps = append(samps, samp{fmt.Sprintf("W32#%d-%d", i+1, j+1), 4, sw.ranked()[i].addrs[j]})
			}
		}
	}
	liveness(h, samps)
	fmt.Printf("done %s\n", time.Now().Format("15:04:05"))
}
