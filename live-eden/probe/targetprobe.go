// targetprobe — 锚点搜索（只读）：按 UltraCam/mod 坐标推导的内存三元组 (329, ~1544, -937)
// 搜索全部已提交 RW 内存。匹配规则：三轴幅值分别命中 {329, 1544, 937}（±tol，任意排列/符号），
// 再按副本数 + 旋转矩阵排序定位玩家槽。输出写文件防截断。
package main

import (
	"fmt"
	"math"
	"os"
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
	chunkSize               = 64 << 20
	tol                     = 20.0
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

func floats(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

type blk struct {
	base, size uintptr
	typ, prot  uint32
}

// targets: 幅值集合 {329, 1544, 937}，任意排列与符号
var tgts = [3]float64{329, 1544, 937}

func matchTrio(a, b, c float32) bool {
	vs := [3]float64{math.Abs(float64(a)), math.Abs(float64(b)), math.Abs(float64(c))}
	used := [3]bool{}
	for _, t := range tgts {
		hit := false
		for i, v := range vs {
			if !used[i] && v >= t-tol && v <= t+tol {
				used[i] = true
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

func main() {
	out, _ := os.Create("E:\\WorkSpace\\TOTKmap\\live-eden\\eden_target_hits.txt")
	defer out.Close()
	log := func(f string, a ...any) {
		line := fmt.Sprintf(f, a...)
		fmt.Print(line)
		fmt.Fprint(out, line)
	}

	pid := findPid(os.Args[1])
	if pid == 0 {
		log("no process matching %q\n", os.Args[1])
		return
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		log("OpenProcess failed: %v\n", err)
		return
	}
	defer procCloseHandle.Call(h)
	log("attached pid=%d, target magnitudes {%v %v %v} tol=±%.0f\n", pid, tgts[0], tgts[1], tgts[2], tol)

	var blocks []blk
	addr := uintptr(0)
	const limit = uintptr(0x7FFFFFFFFFFF)
	for addr < limit {
		var mbi MemoryBasicInformation
		if r, _, _ := procVirtualQueryEx.Call(h, addr, uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi)); r == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		p := mbi.Protect & 0xFF
		if mbi.State == memCommit && (p == 0x02 || p == 0x04) {
			blocks = append(blocks, blk{base, size, mbi.Type, p})
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	var total uintptr
	for _, b := range blocks {
		total += b.size
	}
	log("RW committed regions: %d, total %.1f GB\n", len(blocks), float64(total)/(1<<30))

	t0 := time.Now()
	type hit struct {
		addr uintptr
		x, y, z float32
	}
	var hits []hit
	var mu sync.Mutex
	var wg sync.WaitGroup
	jobs := make(chan struct{ base, size uintptr })
	workers := runtime.NumCPU()
	if workers > 12 {
		workers = 12
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []hit
			for j := range jobs {
				off := uintptr(0)
				for off < j.size {
					n := uintptr(chunkSize)
					if j.size-off < n {
						n = j.size - off
					}
					buf := readMem(h, j.base+off, int(n))
					if buf != nil {
						a := floats(buf)
						for i := 0; i+3 <= len(a); i++ {
							if !matchTrio(a[i], a[i+1], a[i+2]) {
								continue
							}
							local = append(local, hit{j.base + off + uintptr(i)*4, a[i], a[i+1], a[i+2]})
						}
					}
					off += n
				}
			}
			if len(local) > 0 {
				mu.Lock()
				hits = append(hits, local...)
				mu.Unlock()
			}
		}()
	}
	for _, b := range blocks {
		jobs <- struct{ base, size uintptr }{b.base, b.size}
	}
	close(jobs)
	wg.Wait()
	log("scan %.1f GB in %.1fs, %d anchor-matching triples\n", float64(total)/(1<<30), time.Since(t0).Seconds(), len(hits))
	if len(hits) == 0 {
		log("no matches - memory layout may differ (doubles? other order?)")
		return
	}

	type grp struct {
		x, y, z float32
		copies  int
		structN int
		addrs   []uintptr
	}
	groups := map[[3]int32]*grp{}
	for _, ht := range hits {
		k := [3]int32{
			int32(math.Round(float64(ht.x))),
			int32(math.Round(float64(ht.y))),
			int32(math.Round(float64(ht.z))),
		}
		g := groups[k]
		if g == nil {
			g = &grp{x: ht.x, y: ht.y, z: ht.z}
			groups[k] = g
		}
		g.copies++
		if len(g.addrs) < 64 {
			g.addrs = append(g.addrs, ht.addr)
		}
	}
	var list []*grp
	for _, g := range groups {
		for i := 0; i < len(g.addrs) && i < 16; i++ {
			if rotOK(h, g.addrs[i]) {
				g.structN++
			}
		}
		list = append(list, g)
	}
	sort.Slice(list, func(i, j int) bool {
		aLive, bLive := list[i].structN > 0, list[j].structN > 0
		if aLive != bLive {
			return aLive
		}
		if list[i].copies != list[j].copies {
			return list[i].copies > list[j].copies
		}
		return true
	})

	log("\ntop groups (raw mem triple order):\n")
	for i := 0; i < len(list) && i < 15; i++ {
		g := list[i]
		adr := g.addrs[0]
		var offs []string
		for _, b := range blocks {
			if adr >= b.base && adr < b.base+b.size {
				offs = append(offs, fmt.Sprintf("blk0x%012X+0x%X", b.base, adr-b.base))
			}
		}
		log("  #%d copies=%-6d struct=%-2d mem=(%.2f, %.2f, %.2f) addr=0x%012X %s\n",
			i+1, g.copies, g.structN, g.x, g.y, g.z, adr, strings.Join(offs, " "))
	}
	log("total %.1fs\n", time.Since(t0).Seconds())
}

func rotOK(h uintptr, addr uintptr) bool {
	buf := readMem(h, addr, 128)
	if len(buf) < 64 {
		return false
	}
	a := floats(buf)
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
