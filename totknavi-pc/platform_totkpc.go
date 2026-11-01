// platform_totkpc.go — TotK-Recomp（PC 静态重编译版）平台驱动。
//
// 与模拟器版的根本差异（2026-10-31 实机确认）：
//   - 没有模拟器进程，游戏本体 = totk.exe 自己（PID 直接就是游戏）
//   - 主模块（Switch 的 main NSO）被 **静态翻译** 成 x86-64 并加载在
//     **固定地址 0x7000000000**（Recomp 硬编码，不走 ASLR），日志原文：
//     `loaded main at 0x7000000000 size 0x472b000: 510904 relocations, 675 imports`
//   - 段布局**被重排**（原版主模块约 100MB → 实测只映射 71MB），所以
//     Switch 侧的模块内偏移（0x53C9534 / 0x46704C8 …）**全部作废**，
//     必须靠结构特征重新扫描，不能平移。
//   - totk.exe 自身的 .data 段（虚拟 46MB）是活跃全局区，受 ASLR 影响，
//     基址每次启动都变 → 任何绝对地址都不能持久化，只能存"相对模块基址的偏移"。
//
// 因此本驱动提供两件事：
//   1. 进程/内存块枚举（Platform 接口）
//   2. 主模块基址定位 + 锚点校验（MainBase），供"地址持久化"换算用
//
// 存档：`<游戏目录>\profile\save\<账号hash>\slot_XX\progress.sav`，
// 格式与 Switch 版 v1.2.x **完全一致**（magic 0x01020304），可复用老解析器。

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// ---- 固定常量（Recomp 侧）----

const (
	// totkPCMainBase 主模块（guest main NSO）宿主加载基址。Recomp 硬编码，
	// 不随 ASLR 变化——这是 PC 版相对模拟器最大的优势：一次定位，永久有效。
	totkPCMainBase = uintptr(0x7000000000)

	// totkPCProcName 游戏进程名（全小写比较）。totk_xlate.exe 是构建期工具，
	// 运行时不存在；仍要显式排除，避免构建时误连。
	totkPCProcName = "totk.exe"
)

// mainAnchor 主模块镜像开头的 12 字节（NSO module header 前段，含 "MOD0" 魔数）。
// 用于确认 0x7000000000 处确实是主模块而不是别的映射（换 Recomp 版本时要靠它兜底）。
var mainAnchor = [12]byte{0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 'M', 'O', 'D', '0'}

type totkpcPlatform struct {
	h   uintptr
	pid uint32

	mu       sync.Mutex
	mainBase uintptr // 校验通过的主模块基址（0 = 未确认）
	exeBase  uintptr // totk.exe 加载基址（ASLR，每次启动变）
	exeSize  uintptr
}

func init() { registerPlatform(&totkpcPlatform{}) }

func (p *totkpcPlatform) Name() string       { return "TotK-PC" }
func (p *totkpcPlatform) Handle() uintptr    { return p.h }
func (p *totkpcPlatform) PID() uint32        { return p.pid }
func (p *totkpcPlatform) LittleEndian() bool { return true }
func (p *totkpcPlatform) IsAlive() bool      { return p.h != 0 && isProcessAlive(p.h) }

// Attach 附加到 totk.exe。进程退出后句柄失效时自动重开。
func (p *totkpcPlatform) Attach() bool {
	pid := totkPCFindPid()
	if pid == 0 {
		if p.h != 0 {
			closeHandle(p.h)
		}
		p.h, p.pid = 0, 0
		return false
	}
	if pid == p.pid && p.h != 0 && hLive(p.h) {
		return true
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

	// 附加后立即解析模块基址（一次，后面复用）
	p.mu.Lock()
	p.mainBase = 0
	p.exeBase, p.exeSize = totkPCExeModule(pid)
	p.mu.Unlock()
	return true
}

// MainBase 返回已校验的主模块基址；未确认返回 0。
// 校验方式：读 0x7000000000 前 12 字节比对 MOD0 锚。
func (p *totkpcPlatform) MainBase() uintptr {
	p.mu.Lock()
	cached := p.mainBase
	p.mu.Unlock()
	if cached != 0 {
		return cached
	}
	if p.h == 0 {
		return 0
	}
	buf := readMem(p.h, totkPCMainBase, 12)
	if len(buf) < 12 {
		return 0
	}
	for i := 0; i < 12; i++ {
		if buf[i] != mainAnchor[i] {
			return 0
		}
	}
	p.mu.Lock()
	p.mainBase = totkPCMainBase
	p.mu.Unlock()
	return totkPCMainBase
}

// ExeBase 返回 totk.exe 加载基址与镜像大小（ASLR 后实际值）。
func (p *totkpcPlatform) ExeBase() (uintptr, uintptr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exeBase, p.exeSize
}

// ---- 进程识别 ----

// totkPCFindPid 精确匹配 totk.exe（不前缀匹配：totk_xlate.exe 也以 totk 开头）。
func totkPCFindPid() uint32 {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapprocess, 0)
	if snap == 0 || snap == uintptr(^uintptr(0)) {
		return 0
	}
	defer closeHandle(snap)
	var e ProcessEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		name := strings.ToLower(utf16ToString(e.ExeFile[:]))
		if e.ProcessID != uint32(os.Getpid()) && name == totkPCProcName {
			return e.ProcessID
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
	return 0
}

var procQueryFullProcessImageNameW = syscall.NewLazyDLL("kernel32.dll").NewProc("QueryFullProcessImageNameW")

func totkPCProcessPath(h uintptr) string {
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

// ---- totk.exe 模块定位（ASLR 后基址）----

var (
	procModule32FirstW = kernel32.NewProc("Module32FirstW")
	procModule32NextW  = kernel32.NewProc("Module32NextW")
)

const (
	th32csSnapModule   = 0x00000008
	th32csSnapModule32 = 0x00000010
)

// ModuleEntry32W 与 Windows MODULEENTRY32W 布局一致（x64 = 1080 字节）。
type ModuleEntry32W struct {
	Size         uint32
	ModuleID     uint32
	ProcessID    uint32
	GlblcntUsage uint32
	ProccntUsage uint32
	ModBaseAddr  uintptr
	ModBaseSize  uint32
	HModule      uintptr
	SzModule     [256]uint16
	SzExePath    [260]uint16
}

func init() {
	if unsafe.Sizeof(ModuleEntry32W{}) != 1080 {
		panic("ModuleEntry32W size mismatch")
	}
}

// totkPCExeModule 取 totk.exe 自身模块基址/大小（ASLR 后）。失败返回 0。
// 注意：CreateToolhelp32Snapshot 的第二个参数是 **PID**，不是进程句柄
// （2026-10-31 踩坑：传句柄时调用直接失败，返回 0，导致 exe 数据段没被识别为高可疑区）。
func totkPCExeModule(pid uint32) (base uintptr, size uintptr) {
	if pid == 0 {
		return 0, 0
	}
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapModule|th32csSnapModule32, uintptr(pid))
	if snap == 0 || snap == uintptr(^uintptr(0)) {
		return 0, 0
	}
	defer closeHandle(snap)
	var me ModuleEntry32W
	me.Size = uint32(unsafe.Sizeof(me))
	r, _, _ := procModule32FirstW.Call(snap, uintptr(unsafe.Pointer(&me)))
	if r == 0 {
		return 0, 0
	}
	// 首个模块即主 exe
	return me.ModBaseAddr, uintptr(me.ModBaseSize)
}

// ---- 内存块枚举 ----

// ---- 扫描范围常量（对齐 totknavi 的 edenHeapBlocks：只扫"游戏数据区"，不扫全进程）----
//
// Eden 版靠 edenHeapBlocks 把 24GB 收口到 1.7GB。PC 版同理：
// 实测玩家槽只会落在下面三段（空岛/地表两次验证），其余 8.7GB 是纹理、GPU 缓冲、
// 着色器缓存——扫了纯属浪费。收敛后单次扫描约 0.7 秒。
const (
	totkPCScanMainLo = uintptr(0x7000000000) // 主模块镜像（guest main NSO 静态翻译后所在）
	totkPCScanMainHi = uintptr(0x7100000000) // +256MB 窗口（镜像仅 71MB，留裕量）
	totkPCScanHeapLo = uintptr(0x100000000)  // 主堆起点（私有分配）
	totkPCScanHeapHi = uintptr(0x180000000)  // 主堆上限（实测 1GB 已提交）
)

// Blocks 返回"游戏数据区"内存块（主模块 + exe 可写段 + 主堆），≥minMB。
//
// 与模拟器版的语义对齐：不返回全进程内存，只返回可能含 Actor 对象的区域。
func (p *totkpcPlatform) Blocks(minMB float64) []MemBlock {
	if p.h == 0 {
		return nil
	}
	minSize := uintptr(minMB * 1048576.0)
	const floor = uintptr(64 * 1024)
	if minSize < floor {
		minSize = floor
	}
	exeBase, exeSize := p.ExeBase()

	const limit = uintptr(0x7FFFFFFFFFFF)
	var out []MemBlock
	addr := uintptr(0)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(p.h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		if mbi.State == memCommit && size >= minSize {
			prot := mbi.Protect
			readable := prot&0x01 == 0 && prot&pageGuard == 0
			writable := prot&0xCC != 0
			if readable {
				inMain := base >= totkPCScanMainLo && base < totkPCScanMainHi
				inHeap := writable && base >= totkPCScanHeapLo && base < totkPCScanHeapHi
				inExe := writable && exeBase != 0 && base >= exeBase && base < exeBase+exeSize
				if inMain || inHeap || inExe {
					out = append(out, MemBlock{Base: base, Size: size, Writable: writable})
				}
			}
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

// LargestBlock 返回最大可读块（诊断用）。
func (p *totkpcPlatform) LargestBlock(minMB float64) (uintptr, uintptr) {
	var bb, bs uintptr
	for _, b := range p.Blocks(minMB) {
		if b.Size > bs {
			bb, bs = b.Base, b.Size
		}
	}
	return bb, bs
}

// ---- 存档根 ----

// SaveRoots PC 版存档根候选。
//
// 布局：<游戏目录>\profile\save\<账号hash>\slot_XX\progress.sav
// 关键差异：目录名是 32 位账号 hash，**没有 Switch 的标题 ID 层**
// （所以 totknavi 里 edenFindTotkSaveFiles 的标题 ID 过滤在这里会全杀，
//
//	必须走"无标题 ID 布局放行"分支）。
func (p *totkpcPlatform) SaveRoots() []string {
	var out []string
	if v := os.Getenv("TOTK_PC_SAVE_DIR"); v != "" {
		out = append(out, v)
	}
	// ① 进程路径推导（最可靠：游戏装在哪个盘都行）
	if p.h != 0 {
		if exe := totkPCProcessPath(p.h); exe != "" {
			base := filepath.Join(filepath.Dir(exe), "profile")
			// ★ 事务目录优先：游戏运行中的新存档先写 save-tx\work，退出或提交时才合并到
			// save\。实测 2026-10-31：save\slot_00 停留在 10-28 的旧档，而
			// save-tx\work\slot_00 是当前这一秒的存档。**必须优先读事务目录**，
			// 否则锚点永远是四天前的位置。
			out = append(out, filepath.Join(base, "save-tx", "work"))
			out = append(out, filepath.Join(base, "save"))
		}
	}
	// ② 常见盘符兜底（GUI 先起、游戏未启动时用）
	for _, drive := range []string{"C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", "I:\\", "J:\\", "K:\\", "L:\\"} {
		for _, sub := range []string{
			filepath.Join(drive, "TOTKPC", "profile", "save"),
			filepath.Join(drive, "TotKPC", "profile", "save"),
			filepath.Join(drive, "TOTK", "profile", "save"),
			filepath.Join(drive, "totk", "profile", "save"),
		} {
			if fi, err := os.Stat(sub); err == nil && fi.IsDir() {
				out = append(out, sub)
			}
		}
	}
	return out
}

// describe 诊断输出。
func (p *totkpcPlatform) describe() string {
	mb := p.MainBase()
	eb, es := p.ExeBase()
	return fmt.Sprintf("pid=%d main=0x%X exe=0x%X(+0x%X)", p.pid, mb, eb, es)
}
