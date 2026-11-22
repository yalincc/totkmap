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
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

	mu          sync.Mutex
	mainBase    uintptr // 校验通过的主模块基址（0 = 未确认）
	mainChecked bool    // 是否已完成过自适应探测（防止未命中时重复全盘扫描）
	exeBase     uintptr // totk.exe 加载基址（ASLR，每次启动变）
	exeSize     uintptr
	deniedPid   uint32  // 已提示过权限不足的 PID，避免刷屏
}

func init() { registerPlatform(&totkpcPlatform{}) }

func (p *totkpcPlatform) Name() string       { return "TotK-PC" }
func (p *totkpcPlatform) Handle() uintptr    { return p.h }
func (p *totkpcPlatform) PID() uint32        { return p.pid }
func (p *totkpcPlatform) LittleEndian() bool { return true }
func (p *totkpcPlatform) IsAlive() bool      { return p.h != 0 && isProcessAlive(p.h) }

// Attach 附加到游戏进程。进程退出后句柄失效时自动重开。
func (p *totkpcPlatform) Attach() bool {
	pid, procName := totkPCFindTarget()
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
		if p.deniedPid != pid {
			p.deniedPid = pid
			logEvent("  [ERR] 检测到进程 %s (pid=%d) 但无权读取内存 —— 请右键以【管理员身份】重新运行本程序。", procName, pid)
		}
		p.h, p.pid = 0, 0
		return false
	}
	p.deniedPid = 0
	p.h, p.pid = h, pid

	// 附加后立即解析模块基址（一次，后面复用）
	p.mu.Lock()
	p.mainBase = 0
	p.mainChecked = false
	p.exeBase, p.exeSize = totkPCExeModule(pid)
	exeSz := p.exeSize
	p.mu.Unlock()
	if rv, gv := detectGameVersions(pid, h); rv != "" || gv != "" {
		setDetectedVersions(rv, gv)
	}
	selectActiveProfile(exeSz)
	return true
}

// MainBase 返回已校验的主模块基址；未确认返回 0。
// 采用三级自适应探测机制（单次执行带强缓存，绝对不重复枚举）：
//   1. 优先校验默认基址 0x7000000000（宽松校验：头 64 字节含 MOD0 魔数）；
//   2. 动态扫描分配区 AllocationBase（0.01s，按块首地址找 MOD0，不限单段大小）；
//   3. 从游戏目录 logs/totk.log 辅助匹配 "loaded main at 0x..."。
func (p *totkpcPlatform) MainBase() uintptr {
	p.mu.Lock()
	if p.mainChecked && p.mainBase != 0 {
		res := p.mainBase
		p.mu.Unlock()
		return res
	}
	p.mu.Unlock()

	if p.h == 0 {
		return 0
	}

	var foundBase uintptr

	// 1. 优先校验默认基址 0x7000000000（校验头 64 字节含 MOD0 魔数，避免误判后跳过 totk.log 自适应）
	if buf := readMem(p.h, totkPCMainBase, 64); len(buf) >= 16 && bytes.Contains(buf, []byte("MOD0")) {
		foundBase = totkPCMainBase
	}

	// 2. 备选：从游戏目录 logs/totk.log 容错匹配 "loaded main at 0x..."
	if foundBase == 0 {
		if exePath := totkPCProcessPath(p.h); exePath != "" {
			for _, logName := range []string{"totk.log", "totk.1.log"} {
				logPath := filepath.Join(filepath.Dir(exePath), "logs", logName)
				if data, err := os.ReadFile(logPath); err == nil {
					re := regexp.MustCompile(`loaded\s+main\s+at\s+(0x[0-9a-fA-F]+)`)
					if m := re.FindSubmatch(data); len(m) > 1 {
						if parsed, err := strconv.ParseUint(string(m[1]), 0, 64); err == nil && parsed != 0 {
							base := uintptr(parsed)
							if buf := readMem(p.h, base, 16); len(buf) >= 8 {
								foundBase = base
								break
							}
						}
					}
				}
			}
		}
	}

	p.mu.Lock()
	p.mainBase = foundBase
	if foundBase != 0 {
		p.mainChecked = true
	}
	p.mu.Unlock()

	return foundBase
}

// ExeBase 返回 totk.exe 加载基址与镜像大小（ASLR 后实际值）。
func (p *totkpcPlatform) ExeBase() (uintptr, uintptr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exeBase, p.exeSize
}

// ---- 进程识别 ----

// totkPCFindTarget 按优先级查找目标游戏进程：
//  1. 环境变量 TOTK_PC_PROCESS（支持精确 exe 名或数字 PID）
//  2. 精确匹配 totk.exe
//  3. 模糊匹配含 totk / tears / zelda 的进程（排除 totknavi* / totk_xlate* / xnavi*）
func totkPCFindTarget() (uint32, string) {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(th32csSnapprocess, 0)
	if snap == 0 || snap == uintptr(^uintptr(0)) {
		return 0, ""
	}
	defer closeHandle(snap)

	custom := strings.TrimSpace(strings.ToLower(os.Getenv("TOTK_PC_PROCESS")))
	var customPid uint32
	if custom != "" {
		if v, err := strconv.ParseUint(custom, 10, 32); err == nil && v > 0 {
			customPid = uint32(v)
		}
	}

	selfPid := uint32(os.Getpid())
	var exactPid, fuzzyPid uint32
	var exactName, fuzzyName string

	var e ProcessEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		if e.ProcessID != selfPid && e.ProcessID != 0 {
			rawName := utf16ToString(e.ExeFile[:])
			name := strings.ToLower(rawName)
			if custom != "" {
				if (customPid != 0 && e.ProcessID == customPid) || (customPid == 0 && name == custom) {
					return e.ProcessID, rawName
				}
			} else {
				if name == totkPCProcName {
					exactPid, exactName = e.ProcessID, rawName
					break
				}
				if fuzzyPid == 0 &&
					!strings.Contains(name, "navi") &&
					!strings.Contains(name, "xlate") &&
					(strings.Contains(name, "totk") || strings.Contains(name, "tears") || strings.Contains(name, "zelda")) {
					fuzzyPid, fuzzyName = e.ProcessID, rawName
				}
			}
		}
		r, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
	if custom != "" {
		return 0, ""
	}
	if exactPid != 0 {
		return exactPid, exactName
	}
	return fuzzyPid, fuzzyName
}

// totkPCFindPid 兼容旧调用，返回目标进程 PID。
func totkPCFindPid() uint32 {
	pid, _ := totkPCFindTarget()
	return pid
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
	mb := p.MainBase() // 必须在循环外部单次获取，严禁在迭代中重复调用！
	heapRanges := activeHeapRanges()

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
				inMain := false
				if mb != 0 {
					inMain = base >= mb && base < mb+0x10000000
				} else {
					inMain = base >= totkPCScanMainLo && base < totkPCScanMainHi
				}
				inHeap := false
				if writable {
					for _, hr := range heapRanges {
						if base >= hr[0] && base < hr[1] {
							inHeap = true
							break
						}
					}
				}
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

// detectGameVersions 尝试从游戏窗口标题或 logs/totk.log 提取 PC 编译版本（如 TotK Recomp 0.4.0 +7a37fc3c）与游戏版本（如 1.2.1）。
func detectGameVersions(pid uint32, h uintptr) (recompVer, gameVer string) {
	reRecomp := regexp.MustCompile(`(?i)(totk[\s\-_]*recomp(?:\s+v?\d+\.\d+(?:\.\d+)?(?:\s*\+[0-9a-fA-F]+)?)?)`)
	reGameVer := regexp.MustCompile(`(?i)\b(1\.\d\.\d)\b`)

	if title := getProcessWindowTitle(pid); title != "" {
		if m := reRecomp.FindStringSubmatch(title); len(m) > 1 {
			recompVer = strings.TrimSpace(m[1])
		}
		if m := reGameVer.FindStringSubmatch(title); len(m) > 1 {
			gameVer = m[1]
		}
	}

	if (recompVer == "" || gameVer == "") && h != 0 {
		if exePath := totkPCProcessPath(h); exePath != "" {
			for _, logName := range []string{"totk.log", "totk.1.log"} {
				logPath := filepath.Join(filepath.Dir(exePath), "logs", logName)
				data, err := os.ReadFile(logPath)
				if err != nil {
					continue
				}
				// 只扫前 8KB 头部即可，避免大日志耗时
				if len(data) > 8192 {
					data = data[:8192]
				}
				head := string(data)
				if recompVer == "" {
					if m := reRecomp.FindStringSubmatch(head); len(m) > 1 {
						recompVer = strings.TrimSpace(m[1])
					}
				}
				if gameVer == "" {
					if m := reGameVer.FindStringSubmatch(head); len(m) > 1 {
						gameVer = m[1]
					}
				}
				if recompVer != "" && gameVer != "" {
					break
				}
			}
		}
	}
	return recompVer, gameVer
}
