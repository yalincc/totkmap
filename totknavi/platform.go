// platform.go — 平台适配层（合并 Ryujinx / Eden 的 TOTK 定位核心）。
//
// 把模拟器差异（进程识别、内存枚举、端序、存档发现）全部隔离在平台驱动里，
// 定位状态机、扫描、进度、服务端均只面向 Platform 接口编程。
// 游戏层差异（坐标语义/层级判定/已知偏移）在 game_totk.go，与平台解耦。
//
// 架构蓝本：BOTW xnavi v3.0.2 platform.go（Cemu/Ryujinx/Eden 三平台合并模板）。
// 铁律（BOTW 踩坑固化）：Eden 特有能力（锚点窗口扫描/绝对地址缓存/coords 校准）
// 走 edenLocator 可选接口 + 类型断言隔离，多套定位策略互不干扰——
// 禁止在状态机里写平台分支堆叠。

package main

import (
	"fmt"
	"strings"
	"sync"
)

// MemBlock 一块已提交的可读写内存区域。
type MemBlock struct {
	Base uintptr
	Size uintptr
}

// Platform 描述一个模拟器平台的只读访问能力。
// 实现必须保证：只读、不注入、不修改游戏内存。
// 平台：Ryujinx / Eden（Eden = Yuzu fork）。
type Platform interface {
	Name() string // "Ryujinx" / "Eden"

	// Attach 确保已附加到"正在运行游戏"的模拟器实例；未运行返回 false。
	// 失败时内部不应持有半开句柄（可重试）。
	Attach() bool
	// Handle 返回当前进程句柄（Attach 成功后有效；0 = 未附加）。
	Handle() uintptr
	// PID 返回当前附加的进程 ID。
	PID() uint32

	// Blocks 返回 ≥minMB 的已提交可读写内存块（游戏内存所在区域）。
	// Eden 与 Ryujinx 语义不同：Ryujinx 只取大块（guest DRAM），
	// Eden 全扫微型区域（碎片化），由各平台驱动自行实现。
	Blocks(minMB float64) []MemBlock
	// LargestBlock 返回最大的一块（known 偏移重定位的稳定锚点；
	// Eden 快路径走绝对地址缓存，不依赖此接口）。
	LargestBlock(minMB float64) (uintptr, uintptr)

	// LittleEndian 返回平台内存字节序是否小端（Switch 系=小端）。
	LittleEndian() bool

	// SaveRoots 存档根候选目录（递归找 progress.sav / caption.sav 的起点）。
	SaveRoots() []string
}

// ---- 当前平台管理 ----

var (
	platMu    sync.Mutex
	curPlat   Platform
	probeList []Platform

	// autoPlatform 是否允许平台自动切换（--emu=auto 时 true；显式指定则不切换）。
	autoPlatform bool
)

// registerPlatform 注册一个平台驱动（init 阶段调用）。
func registerPlatform(p Platform) {
	probeList = append(probeList, p)
}

// setPlatform 固定当前平台（main 解析 --emu 参数后调用）。
func setPlatform(p Platform) {
	platMu.Lock()
	curPlat = p
	platMu.Unlock()
	if p != nil {
		fmt.Printf("  [platform] selected: %s\n", p.Name())
	}
}

// currentPlatform 返回当前平台；nil 表示尚未确定。
func currentPlatform() Platform {
	platMu.Lock()
	defer platMu.Unlock()
	return curPlat
}

// probePlatform 自动探测：按注册顺序找第一个"模拟器进程在运行"的平台。
// 都不在运行则保持当前选择（若未选择则固定第一个注册的平台，等状态机追上来）。
// 双模拟器同时在跑时（2026-10-09 实测：Ryujinx+Eden 双开，注册序 eden 先），
// auto 会选第一个在跑的（Eden）；打印警告提示用户可显式 --emu 指定。
func probePlatform() Platform {
	platMu.Lock()
	defer platMu.Unlock()
	running := make([]string, 0, len(probeList))
	var first Platform
	for _, p := range probeList {
		if p.Attach() {
			running = append(running, p.Name())
			if first == nil {
				first = p
			}
		}
	}
	if len(running) > 1 {
		fmt.Printf("  [platform] WARNING: %d emulators running (%s) - auto picks %s, use --emu=... to force\n",
			len(running), strings.Join(running, ", "), first.Name())
	}
	if first != nil {
		if curPlat == nil || curPlat.Name() != first.Name() {
			fmt.Printf("  [platform] auto-detected: %s\n", first.Name())
		}
		curPlat = first
		return first
	}
	if curPlat == nil && len(probeList) > 0 {
		fmt.Printf("  [platform] no emulator running yet, defaulting to %s (will keep looking)\n", probeList[0].Name())
		curPlat = probeList[0]
	}
	return curPlat
}

// ensureAttach 确保当前平台已附加；未附加则重试探测。
// 句柄存在但已失效（进程退出后句柄作废）时也会重开，防止死句柄 0 块卡死。
// auto 模式：当前平台附加失败（模拟器未启动/已退出）时重新探测所有平台，
// 自动切换到"进程在跑"的平台（Ryujinx ↔ Eden 互切）。
func ensureAttach() bool {
	p := currentPlatform()
	if p != nil && p.Handle() != 0 && hLive(p.Handle()) {
		return true
	}
	if autoPlatform || p == nil {
		np := probePlatform()
		if np == nil {
			return false
		}
		return np.Attach()
	}
	return p.Attach()
}

// platformWithGame 找"进程在跑且已加载游戏大块内存（≥256MB）"的注册平台，
// 用于当前平台 0 块卡死（游戏未加载/切换模拟器）时的自动切换。
// 按名字排除当前平台（curPlat 与 probeList 里的实例可能是不同指针）。
func platformWithGame(exclude Platform) Platform {
	exName := ""
	if exclude != nil {
		exName = exclude.Name()
	}
	for _, p := range probeList {
		if p.Name() == exName {
			continue
		}
		if !p.Attach() {
			continue
		}
		if len(p.Blocks(256.0)) > 0 {
			fmt.Printf("  [platform] %s has game memory (>=256MB block)\n", p.Name())
			return p
		}
	}
	return nil
}

// hLive 句柄是否仍有效（进程存在）。
func hLive(h uintptr) bool {
	if h == 0 {
		return false
	}
	var mbi MemoryBasicInformation
	return virtualQueryEx(h, 0, &mbi) != 0
}
