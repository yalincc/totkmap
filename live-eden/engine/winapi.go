// Windows API 封装：进程快照、OpenProcess、VirtualQueryEx、ReadProcessMemory。
// 零第三方依赖，仅用标准库 syscall。

package main

import (
	"os"
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
	procSetConsoleTitleW         = kernel32.NewProc("SetConsoleTitleW")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	processQueryInformation = 0x0400
	processVMRead           = 0x0010
	th32csSnapprocess       = 0x00000002
	memCommit               = 0x1000
	memMapped               = 0x40000
	memPrivate              = 0x20000
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
// 排除自身与 core 进程（进程名含 "core"）：避免 "eden-core.exe" 以 "eden"
// 开头被误认成游戏进程（eden.exe），导致 core attach 到自己的句柄。
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
		if pid := e.ProcessID; pid != uint32(os.Getpid()) &&
			!strings.Contains(strings.ToLower(name), "core") &&
			strings.HasPrefix(strings.ToLower(name), strings.ToLower(prefix)) {
			return pid
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

// processPath 返回进程主模块（exe）完整路径，用于推导 Eden 便携存档目录。
func processPath(h uintptr) string {
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	r, _, _ := procQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 || size == 0 {
		return ""
	}
	return string(utf16.Decode(buf[:size]))
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

// ---- 块枚举缓存 ----
// guestBlocks 要 VirtualQueryEx 一路遍历到 0x7FFFFFFFFFFF；Ryujinx 进程里
// region 极多，实测一次 **6 秒**（Cemu 同样逻辑只要 42ms）。传送 / 场景切换后
// 每次重扫都要再付一次这个代价 —— 实测占"失效到重新锁定"总耗时的近一半。
// 块布局在秒级内不会变，这里做短期缓存；pid 变化立即失效（进程重启）。
// 注意：块世代检测（detectNewBlocks）需要新鲜数据，不要走这个缓存。

const blkCacheTTL = 5 * time.Second

var blkCache struct {
	mu    sync.Mutex
	pid   uint32
	minMB float64
	at    time.Time
	val   []struct{ Base, Size uintptr }
}

// guestBlocksCached 带 TTL 的 guestBlocks。pid 取自全局 procPID（进程重启自动失效）。
func guestBlocksCached(h uintptr, minMB float64) []struct{ Base, Size uintptr } {
	blkCache.mu.Lock()
	defer blkCache.mu.Unlock()
	if blkCache.val != nil && blkCache.pid == procPID && blkCache.minMB == minMB &&
		time.Since(blkCache.at) < blkCacheTTL {
		return blkCache.val
	}
	v := guestBlocks(h, minMB)
	blkCache.pid, blkCache.minMB, blkCache.at, blkCache.val = procPID, minMB, time.Now(), v
	return v
}

// guestBlocks 返回全部已提交 RW 区域（MEM_MAPPED + MEM_PRIVATE，≥64KB 去噪）。
// Eden 内存碎片化（实测 25082 区域 / 24.4GB），玩家槽落在 0.44MB 微型区域，
// 副本散落在多个小区域与 398MB 区域——必须扫全部区域。
// 不能沿用 Ryujinx 的"只取最大块"策略：旧策略在 Eden 上只扫 8GB DRAM 块，
// 玩家槽根本不在里面（0 命中，2026-10-04 实测）。
func guestBlocks(h uintptr, minMB float64) []struct{ Base, Size uintptr } {
	minSize := uintptr(minMB * 1048576.0)
	const floor = uintptr(64 * 1024)
	if minSize < floor {
		minSize = floor
	}
	const limit = uintptr(0x7FFFFFFFFFFF)
	var out []struct{ Base, Size uintptr }
	addr := uintptr(0)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		p := mbi.Protect & 0xFF
		if mbi.State == memCommit && (mbi.Type == memMapped || mbi.Type == memPrivate) &&
			(p == 0x02 || p == 0x04) && size >= minSize {
			out = append(out, struct{ Base, Size uintptr }{base, size})
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
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
