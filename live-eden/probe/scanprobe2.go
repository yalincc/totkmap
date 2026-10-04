// scanprobe2 — 全 RW 已提交区域扫描（只读）：修正轴边界 + 不限块大小。
// 内存序 (X, Z_stored, Y_north)：X∈(-6000,6000)，Z_stored∈(-1195,3305)，Y_north∈(-6000,6000)。
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

func main() {
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
	fmt.Printf("attached pid=%d\n", pid)

	// 枚举全部已提交 RW 区域
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
	sort.Slice(blocks, func(i, j int) bool { return blocks[i].size > blocks[j].size })
	var total uintptr
	bucket := map[string]int{}
	for _, b := range blocks {
		total += b.size
		switch {
		case b.size >= 1<<30:
			bucket["1GB+"]++
		case b.size >= 512<<20:
			bucket["512MB+"]++
		case b.size >= 64<<20:
			bucket["64MB+"]++
		case b.size >= 8<<20:
			bucket["8MB+"]++
		default:
			bucket["<8MB"]++
		}
	}
	fmt.Printf("RW committed regions: %d, total %.1f GB\n", len(blocks), float64(total)/(1<<30))
	for _, k := range []string{"1GB+", "512MB+", "64MB+", "8MB+", "<8MB"} {
		fmt.Printf("  %-8s %d\n", k, bucket[k])
	}
	fmt.Println("  top 12 regions:")
	for i := 0; i < len(blocks) && i < 12; i++ {
		b := blocks[i]
		fmt.Printf("    base=0x%012X size=%.0f MB type=%s prot=0x%X\n",
			b.base, float64(b.size)/1048576.0, typName(b.typ), b.prot)
	}

	// 8GB 块内容密度抽查（前 16MB）
	if len(blocks) > 0 {
		buf := readMem(h, blocks[0].base, 16<<20)
		nz := 0
		if buf != nil {
			for _, c := range buf {
				if c != 0 {
					nz++
				}
			}
		}
		fmt.Printf("\nsample 16MB at largest block 0x%012X: nonzero bytes=%d (%.1f%%)\n",
			blocks[0].base, nz, 100*float64(nz)/float64(len(buf)))
	}

	// 全区域扫描（修正轴边界）
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
							x, zs, yn := a[i], a[i+1], a[i+2]
							if !valid(x, zs, yn) {
								continue
							}
							local = append(local, hit{j.base + off + uintptr(i)*4, x, zs, yn})
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
	scanSec := time.Since(t0).Seconds()
	fmt.Printf("\nscan %d regions %.1f GB in %.1fs, %d valid triples\n", len(blocks), float64(total)/(1<<30), scanSec, len(hits))
	if len(hits) == 0 {
		fmt.Println("no valid triple found")
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
			int32(math.Round(float64(ht.x) * 10)),
			int32(math.Round(float64(ht.y) * 10)),
			int32(math.Round(float64(ht.z) * 10)),
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

	fmt.Println("\ntop candidate groups (raw mem X, Z_stored, Y_north; alt=Z_stored-105):")
	for i := 0; i < len(list) && i < 10; i++ {
		g := list[i]
		adr := g.addrs[0]
		var offs []string
		for _, b := range blocks {
			if adr >= b.base && adr < b.base+b.size {
				offs = append(offs, fmt.Sprintf("blk0x%012X+0x%X", b.base, adr-b.base))
			}
		}
		fmt.Printf("  #%d copies=%-6d struct=%-2d mem=(%.2f, %.2f, %.2f) alt=%.2f addr=0x%012X %s\n",
			i+1, g.copies, g.structN, g.x, g.y, g.z, g.y-105, adr, strings.Join(offs, " "))
	}
	fmt.Printf("\nelapsed %.1fs total\n", time.Since(t0).Seconds())
}

// 内存序 (X, Z_stored, Y_north)
func valid(x, zs, yn float32) bool {
	if x == 0 && zs == 0 && yn == 0 {
		return false
	}
	if x != x || zs != zs || yn != yn {
		return false
	}
	if x != x*0.5 || zs != zs*0.5 || yn != yn*0.5 {
		return false
	}
	if isWhole32(x) && isWhole32(zs) && isWhole32(yn) {
		return false
	}
	if abs32(x) < 5 && abs32(yn) < 5 {
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

func isWhole32(v float32) bool {
	if v > 4e9 || v < -4e9 {
		return false
	}
	return v == float32(int64(v))
}

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
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
