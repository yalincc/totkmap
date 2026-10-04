// verifyprobe — 只读：① 打印玩家槽所在区域属性；② 重读玩家槽当前值（验证锚点）。
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

func main() {
	pid := findPid(os.Args[1])
	if pid == 0 {
		fmt.Printf("no process matching %q\n", os.Args[1])
		return
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		fmt.Printf("OpenProcess failed: %v\n", err)
		return
	}
	defer procCloseHandle.Call(h)

	// 玩家槽地址（上一次锚点搜索命中）
	targets := []uintptr{
		0x01DA6E65C0A0, // #1 copies=719
		0x01DA6E69D168, // #2
		0x01DB0967876C, // #4 (426MB 区域里的副本)
	}

	// 查询每个地址所在区域属性
	for _, a := range targets {
		var mbi MemoryBasicInformation
		if r, _, _ := procVirtualQueryEx.Call(h, a, uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi)); r != 0 {
			fmt.Printf("addr 0x%012X -> region base=0x%012X size=%.2f MB type=%s prot=0x%X offset_in_region=0x%X\n",
				a, mbi.BaseAddress, float64(mbi.RegionSize)/1048576.0, typName(mbi.Type), mbi.Protect&0xFF, a-mbi.BaseAddress)
		} else {
			fmt.Printf("addr 0x%012X: VirtualQueryEx failed\n", a)
		}
	}

	// 重读玩家槽值（两次，间隔 2s，看是否稳定/在动）
	fmt.Println("\nre-read player slot (2 samples, 2s apart):")
	for _, a := range targets {
		d1 := readMem(h, a, 12)
		time.Sleep(2 * time.Second)
		d2 := readMem(h, a, 12)
		f1, f2 := floats(d1), floats(d2)
		if f1 == nil || f2 == nil {
			fmt.Printf("  addr 0x%012X: unreadable\n", a)
			continue
		}
		moved := ""
		if abs(f1[0]-f2[0]) > 0.1 || abs(f1[1]-f2[1]) > 0.1 || abs(f1[2]-f2[2]) > 0.1 {
			moved = "  <-- MOVING"
		}
		fmt.Printf("  addr 0x%012X: t0=(%.2f, %.2f, %.2f) t1=(%.2f, %.2f, %.2f)%s\n",
			a, f1[0], f1[1], f1[2], f2[0], f2[1], f2[2], moved)
	}
}

func abs(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
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
