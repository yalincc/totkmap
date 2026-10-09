// platform_eden.go — Eden 平台驱动（live-eden engine 原逻辑平台化）。
//
// Eden = Yuzu fork（便携版/安装版布局差异大）。差异点：
//   - 进程：前缀匹配 "eden"，排除自身与 "core" 进程（eden-core.exe 以 eden 开头）
//   - 内存：碎片化（实测 25082 区域 / 24.4GB），全 RW 区域扫描（MEM_MAPPED +
//     MEM_PRIVATE，≥64KB 去噪），玩家槽落在 0.44MB 微型区域
//   - 字节序：Switch = 小端
//   - 存档：TOTK_SAVE_DIR → 进程路径推导便携目录 → 盘符枚举 → APPDATA；
//     必须按标题 ID 0100F2C0115B6000 过滤（防 BOTW 存档污染锚点）
//
// 定位策略差异（Eden 版大量 2026-10-04 实测修复）不在这里，全部在
// locator_eden.go（状态机经 locator 接口调用，本文件只负责内存访问能力）。

package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

type edenPlatform struct {
	h   uintptr
	pid uint32

	// locator 状态（状态机 goroutine 单写）
	knownPool   []uintptr // 最近一次扫描 shortlist 全地址池（冻结共识成员来源）
	bypassKnown bool      // /rescan 或观察超时有活动置位，强制跳过 known 快路径

	// coords 校准状态（后台搜索 goroutine 写 / 状态机 coordsPeek 读，互斥锁保护）
	coordsMu     sync.Mutex
	coordsOn     bool // busy
	coordsDone   bool
	coordsAddr   uintptr
	coordsPos    [3]float32
	coordsCopies int

	// shrine 状态（状态机 goroutine 单写）
	shrineEntry      [3]float32
	shrineEntrySet   bool
	inShrine         bool
	lastOverworld    [3]float32
	lastOverworldSet bool
}

func init() {
	registerPlatform(&edenPlatform{})
}

func (p *edenPlatform) Name() string { return "Eden" }

func (p *edenPlatform) Attach() bool {
	pid := edenFindPid()
	if pid == 0 {
		if p.h != 0 {
			closeHandle(p.h)
		}
		p.h, p.pid = 0, 0
		return false
	}
	if pid == p.pid && p.h != 0 {
		if hLive(p.h) {
			return true
		}
		closeHandle(p.h)
		p.h = 0
	}
	if p.h != 0 {
		closeHandle(p.h)
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		p.h, p.pid = 0, 0
		return false
	}
	p.h, p.pid = h, pid
	return true
}

func (p *edenPlatform) Handle() uintptr     { return p.h }
func (p *edenPlatform) PID() uint32        { return p.pid }
func (p *edenPlatform) LittleEndian() bool { return true }

// Blocks 全部已提交 RW 区域（MEM_MAPPED + MEM_PRIVATE，≥64KB 去噪）。
func (p *edenPlatform) Blocks(minMB float64) []MemBlock {
	return edenGuestBlocks(p.h, minMB)
}

// LargestBlock 最大 MEM_MAPPED 块（仅诊断；Eden known 快路径不依赖块锚点）。
func (p *edenPlatform) LargestBlock(minMB float64) (uintptr, uintptr) {
	return ryuLargestGuestBlock(p.h, minMB)
}

// SaveRoots Eden 存档根候选（按优先级返回，均会按标题 ID 过滤）。
func (p *edenPlatform) SaveRoots() []string {
	return edenSaveRoots(p.h)
}

// ---- 进程识别 ----

// edenFindPid 按 "eden" 前缀查找游戏进程，排除自身与进程名含 "core" 的
// （避免 "eden-core.exe" 以 "eden" 开头被误认成游戏进程）。
func edenFindPid() uint32 {
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
			strings.HasPrefix(strings.ToLower(name), "eden") {
			return pid
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
	return 0
}

var procQueryFullProcessImageNameW = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

// edenProcessPath 返回进程主模块（exe）完整路径，用于推导 Eden 便携存档目录。
func edenProcessPath(h uintptr) string {
	if h == 0 {
		return ""
	}
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	r, _, _ := procQueryFullProcessImageNameW.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 || size == 0 {
		return ""
	}
	return string(utf16.Decode(buf[:size]))
}

// ---- 内存枚举 ----

// edenGuestBlocks 返回全部已提交 RW 区域（MEM_MAPPED + MEM_PRIVATE，≥64KB 去噪）。
// Eden 内存碎片化，玩家槽落在 0.44MB 微型区域——必须扫全部区域，不能只取最大块。
func edenGuestBlocks(h uintptr, minMB float64) []MemBlock {
	if h == 0 {
		return nil
	}
	minSize := uintptr(minMB * 1048576.0)
	const floor = uintptr(64 * 1024)
	if minSize < floor {
		minSize = floor
	}
	const limit = uintptr(0x7FFFFFFFFFFF)
	var out []MemBlock
	addr := uintptr(0)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		prot := mbi.Protect & 0xFF
		if mbi.State == memCommit && (mbi.Type == memMapped || mbi.Type == memPrivate) &&
			(prot == 0x02 || prot == 0x04) && size >= minSize {
			out = append(out, MemBlock{base, size})
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

// ---- 存档根 ----

// totkTitleID 是《王国之泪》存档目录的标题 ID 段。Eden 的存档根下同时存在
// BOTW（01007EF00011E000）与 TOTK（0100F2C0115B6000）——扫描必须按标题 ID
// 过滤，否则 BOTW 的 progress.sav（不同布局、偏移无效）会污染锚点。
const totkTitleID = "0100F2C0115B6000"

// edenSaveRoots 返回 TOTK 存档根候选（Eden 版推导，按优先级）。
// TOTK_SAVE_DIR_EDEN（GUI 存档设置 v2.1.0）> 旧 TOTK_SAVE_DIR（兼容）> 进程目录推导。
func edenSaveRoots(h uintptr) []string {
	var out []string
	if v := os.Getenv("TOTK_SAVE_DIR_EDEN"); v != "" {
		out = append(out, v)
	}
	if v := os.Getenv("TOTK_SAVE_DIR"); v != "" {
		out = append(out, v)
	}
	if h != 0 {
		if p := edenProcessPath(h); p != "" {
			out = append(out, filepath.Join(filepath.Dir(p), "user", "nand", "user", "save"))
		}
	}
	// 便携 Eden 常见根探测：枚举常见盘符下的 YUZU\eden（Eden 便携版布局，
	// 进程未启动时也能找到存档根；GUI 先开、游戏后开场景依赖此路径）。
	for _, drive := range []string{"C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", "I:\\", "J:\\", "K:\\", "L:\\"} {
		for _, sub := range []string{
			filepath.Join(drive, "YUZU", "eden", "user", "nand", "user", "save"),
			filepath.Join(drive, "yuzu", "eden", "user", "nand", "user", "save"),
			filepath.Join(drive, "YUZU", "user", "nand", "user", "save"),
		} {
			if fi, err := os.Stat(sub); err == nil && fi.IsDir() {
				out = append(out, sub)
			}
		}
	}
	// APPDATA 安装布局（Eden/yuzu 优先；Ryujinx 是历史残留目录，最后兜底）。
	appdata := os.Getenv("APPDATA")
	if appdata != "" {
		out = append(out,
			filepath.Join(appdata, "Eden", "user", "nand", "user", "save"),
			filepath.Join(appdata, "yuzu", "user", "nand", "user", "save"),
			filepath.Join(appdata, "Ryujinx", "bis", "user", "save"),
		)
	}
	return out
}
