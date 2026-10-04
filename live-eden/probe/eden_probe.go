// eden_probe — 只读探查 Eden 模拟器进程的 guest DRAM 布局与已知偏移命中情况。
// 零写入：仅 OpenProcess(QUERY|VM_READ) + VirtualQueryEx + ReadProcessMemory。
package main

import (
	"fmt"
	"os"
	"strings"
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
	memMapped               = 0x40000
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

type blk struct{ base, size uintptr; typ, prot uint32 }

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
	fmt.Printf("attached pid=%d\n\n", pid)

	t0 := time.Now()
	var blocks []blk
	var largest blk
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
			b := blk{base, size, mbi.Type, p}
			if size >= 512*1048576 {
				blocks = append(blocks, b)
			}
			if size > largest.size {
				largest = b
			}
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	fmt.Printf("RW committed regions >=512MB: %d\n", len(blocks))
	var total uintptr
	for _, b := range blocks {
		total += b.size
		fmt.Printf("  base=0x%012X  size=%.0f MB  type=%s prot=0x%X\n",
			b.base, float64(b.size)/1048576.0, typName(b.typ), b.prot)
	}
	fmt.Printf("  total %.1f GB\n", float64(total)/(1<<30))
	fmt.Printf("largest RW region: base=0x%012X size=%.0f MB type=%s prot=0x%X\n\n",
		largest.base, float64(largest.size)/1048576.0, typName(largest.typ), largest.prot)

	// 在最大块上试读已知偏移（相对块基址）
	offs := []uint64{0xECB52A48, 0xEA24E3C0}
	for _, o := range offs {
		if largest.size < uintptr(o) {
			fmt.Printf("offset 0x%X exceeds block size\n", o)
			continue
		}
		d := readMem(h, largest.base+uintptr(o), 12)
		if d == nil {
			fmt.Printf("offset 0x%X @ block: unreadable\n", o)
			continue
		}
		f := floats(d)
		fmt.Printf("offset 0x%X @ block base+off: (%.3f, %.3f, %.3f)  raw=%08x %08x %08x  %s\n",
			o, f[0], f[1], f[2], d[0:4], d[4:8], d[8:12], verdict(f))
	}

	// 每个大块都试读一遍主偏移，看是否有其它块命中
	fmt.Println("\n--- try 0xECB52A48 on every big block ---")
	for _, b := range blocks {
		if b.size < uintptr(0xECB52A48) {
			continue
		}
		d := readMem(h, b.base+uintptr(0xECB52A48), 12)
		if d == nil {
			fmt.Printf("  base=0x%012X: unreadable\n", b.base)
			continue
		}
		f := floats(d)
		fmt.Printf("  base=0x%012X: (%.3f, %.3f, %.3f) %s\n", b.base, f[0], f[1], f[2], verdict(f))
	}
	fmt.Printf("\nelapsed %.1fs\n", time.Since(t0).Seconds())
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

func floats(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

func verdict(f []float32) string {
	if len(f) < 3 {
		return "?"
	}
	x, y, z := f[0], f[1], f[2]
	if x == 0 && y == 0 && z == 0 {
		return "all-zero (slot uninitialized or title screen)"
	}
	if isInf(x) || isInf(y) || isInf(z) || isNaN(x) || isNaN(y) || isNaN(z) {
		return "NaN/Inf"
	}
	if x < -6000 || x > 6000 || y < -6000 || y > 6000 || z < -1300 || z > 3200 {
		return fmt.Sprintf("out-of-range (x=%v,y=%v,z=%v)", x, y, z)
	}
	return "VALID coordinate range (player slot?)"
}

func isInf(f float32) bool { return f != f*0.5 }
func isNaN(f float32) bool { return f != f }
