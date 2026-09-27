// Windows API 封装：进程快照、OpenProcess、VirtualQueryEx、ReadProcessMemory。
// 零第三方依赖，仅用标准库 syscall。

package main

import (
	"strings"
	"syscall"
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
	procSetConsoleTitleW         = kernel32.NewProc("SetConsoleTitleW")
)

const (
	processQueryInformation = 0x0400
	processVMRead           = 0x0010
	th32csSnapprocess       = 0x00000002
	memCommit               = 0x1000
	memMapped               = 0x40000
	pageGuard               = 0x100
)

// MemoryBasicInformation 与 Windows MEMORY_BASIC_INFORMATION 布局一致（x64 = 48 字节）。
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

// ProcessEntry32W 与 Windows PROCESSENTRY32W 布局一致。
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

func init() {
	if unsafe.Sizeof(MemoryBasicInformation{}) != 48 {
		panic("MemoryBasicInformation size mismatch")
	}
}

func closeHandle(h uintptr) {
	if h != 0 {
		procCloseHandle.Call(h)
	}
}

func openProcess(pid uint32) (uintptr, error) {
	r, _, e := procOpenProcess.Call(processQueryInformation|processVMRead, 0, uintptr(pid))
	if r == 0 {
		return 0, e
	}
	return r, nil
}

// findPid 按进程名前缀查找（不区分大小写），返回第一个匹配的 pid。
func findPid(prefix string) uint32 {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapprocess, 0)
	if snap == 0 || snap == uintptr(^uintptr(0)) {
		return 0
	}
	defer closeHandle(snap)

	var e ProcessEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		name := utf16ToString(e.ExeFile[:])
		if strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			return e.ProcessID
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
	return 0
}

func utf16ToString(u []uint16) string {
	n := 0
	for n < len(u) && u[n] != 0 {
		n++
	}
	return string(utf16.Decode(u[:n]))
}

func virtualQueryEx(h uintptr, addr uintptr, mbi *MemoryBasicInformation) uintptr {
	r, _, _ := procVirtualQueryEx.Call(h, addr, uintptr(unsafe.Pointer(mbi)), unsafe.Sizeof(*mbi))
	return r
}

// readMem 读取进程内存，成功返回实际读到的字节，失败返回 nil。
func readMem(h uintptr, addr uintptr, size int) []byte {
	buf := make([]byte, size)
	var got uintptr
	r, _, _ := procReadProcessMemory.Call(h, addr, uintptr(unsafe.Pointer(&buf[0])), uintptr(size), uintptr(unsafe.Pointer(&got)))
	if r == 0 {
		return nil
	}
	return buf[:got]
}

// guestBlocks 枚举所有足够大的 RW MEM_MAPPED 提交区域（去掉 32GB 高的镜像块）。
func guestBlocks(h uintptr, minMB float64) []struct{ Base, Size uintptr } {
	minSize := uintptr(minMB * 1048576.0)
	var raw []struct{ Base, Size uintptr }
	baseSet := map[uintptr]bool{}
	addr := uintptr(0)
	const limit = uintptr(0x7FFFFFFFFFFF)
	const mirrorStep = uintptr(0x800000000)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		p := mbi.Protect & 0xFF
		if mbi.State == memCommit && mbi.Type == memMapped &&
			(p == 0x02 || p == 0x04) {
			if size >= minSize {
				raw = append(raw, struct{ Base, Size uintptr }{base, size})
				baseSet[base] = true
			}
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	var out []struct{ Base, Size uintptr }
	for _, b := range raw {
		if !baseSet[b.Base+mirrorStep] {
			out = append(out, b)
		}
	}
	return out
}

// largestGuestBlock 返回最大的一块 guest DRAM（供 known offsets 重定位）。
func largestGuestBlock(h uintptr, minMB float64) (uintptr, uintptr) {
	best, bestSize := uintptr(0), uintptr(0)
	addr := uintptr(0)
	const limit = uintptr(0x7FFFFFFFFFFF)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		if mbi.State == memCommit && mbi.Type == memMapped &&
			((mbi.Protect&0xFF) == 0x02 || (mbi.Protect&0xFF) == 0x04) &&
			(mbi.Protect&pageGuard) == 0 && size > bestSize {
			best, bestSize = base, size
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	if bestSize < uintptr(minMB*1048576.0) {
		return 0, 0
	}
	return best, bestSize
}

func setConsoleTitle(title string) {
	p, _ := syscall.UTF16PtrFromString(title)
	procSetConsoleTitleW.Call(uintptr(unsafe.Pointer(p)))
}
