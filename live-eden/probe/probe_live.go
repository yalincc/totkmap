// probe_live — 只读诊断：连续采样指定地址（候选槽 + 旧真槽），判断数据形态。
// 目的：解释"扫描命中 100K+ 三元组、但锁定瞬间读 (0,0,0)" 的现象。
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

	// 诊断目标：最近候选 + 旧真槽 + 弱候选
	targets := []uintptr{
		0x02AEC75ED1D0, // 最近候选 copies=4661 struct=63
		0x02AEC7B153D0, // 候选 copies=1578 struct=42
		0x024E7A0B7F70, // 候选 copies=1898 struct=66
		0x022BDDFEB4B8, // 12:05 稳定真槽（30653 copies）
		0x022D5B26BF6C, // 12:08 弱候选死槽（copies=2）
	}

	// 区域属性
	for _, a := range targets {
		var mbi MemoryBasicInformation
		if r, _, _ := procVirtualQueryEx.Call(h, a, uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi)); r != 0 {
			fmt.Printf("addr 0x%012X -> region base=0x%012X size=%.2f MB type=%s prot=0x%X off=0x%X\n",
				a, mbi.BaseAddress, float64(mbi.RegionSize)/1048576.0, typName(mbi.Type), mbi.Protect&0xFF, a-mbi.BaseAddress)
		} else {
			fmt.Printf("addr 0x%012X: VirtualQueryEx FAILED\n", a)
		}
	}

	// 连续采样（5 次，间隔 800ms），打印每个地址的 float 三元组 + 前 16 字节 hex
	fmt.Println("\nlive sampling (5 x 800ms):")
	for s := 0; s < 5; s++ {
		fmt.Printf("-- sample %d --\n", s)
		for _, a := range targets {
			d := readMem(h, a, 16)
			if d == nil {
				fmt.Printf("  addr 0x%012X: unreadable\n", a)
				continue
			}
			f := floats(d)
			hexs := ""
			for _, b := range d[:min(16, len(d))] {
				hexs += fmt.Sprintf("%02X", b)
			}
			if len(f) >= 3 {
				fmt.Printf("  addr 0x%012X: f=(%.2f, %.2f, %.2f)  raw=%s\n", a, f[0], f[1], f[2], hexs)
			} else {
				fmt.Printf("  addr 0x%012X: raw=%s\n", a, hexs)
			}
		}
		time.Sleep(800 * time.Millisecond)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
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
