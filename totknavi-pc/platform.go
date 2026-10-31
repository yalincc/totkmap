// platform.go — 平台适配层（PC 重编译版专用，结构对齐 totknavi/platform.go）。
//
// 与模拟器版（Eden / Ryujinx）的根本差异：TotK-Recomp 把 ARM64 主模块静态
// 翻译成原生 x86-64，**没有模拟器进程**，游戏本体就是 totk.exe 自己。
// 因此本层只需要描述"如何读一个普通 Windows 进程的内存"。
//
// 保留 Platform 接口而不直接写死，是为了：
//   1. 以后 Recomp 若分裂出别的分支/别的 PC 移植版（NotRexed 等），加驱动即可；
//   2. 与 totknavi 的定位管道（扫描原语 / Run>=2 门禁 / 骑乘跟随）保持同构，
//      管道层只面向 Platform 编程，不感知"这是 PC 版还是模拟器"。

package main

import (
	"fmt"
	"sync"
)

// MemBlock 一块已提交的可读内存区域。
type MemBlock struct {
	Base uintptr
	Size uintptr
	// Writable 是否可写（数据段/堆 = true，代码段 = false）。
	// PC 版分级扫描用它把 exe 的 233MB 代码段排除在高可疑区之外。
	Writable bool
}

// BlockKind 内存块来源分类（扫描优先级用，不影响判据）。
type BlockKind int

const (
	KindOther   BlockKind = iota // 普通私有/映射块
	KindModule                   // 主模块镜像区（0x7000000000 起，基址固定）
	KindExeData                  // totk.exe 自身数据段（活跃全局变量区，含 ASLR）
)

// Platform 描述一个平台的只读访问能力。实现必须保证：只读、不注入、不修改游戏内存。
type Platform interface {
	Name() string
	Attach() bool
	Handle() uintptr
	PID() uint32
	Blocks(minMB float64) []MemBlock
	LittleEndian() bool
	SaveRoots() []string
}

// ---- 平台管理（单平台注册，保留多驱动扩展位）----

var (
	platMu    sync.Mutex
	curPlat   Platform
	probeList []Platform
)

func registerPlatform(p Platform) { probeList = append(probeList, p) }

func setPlatform(p Platform) {
	platMu.Lock()
	curPlat = p
	platMu.Unlock()
	if p != nil {
		fmt.Printf("  [platform] selected: %s\n", p.Name())
	}
}

func currentPlatform() Platform {
	platMu.Lock()
	defer platMu.Unlock()
	return curPlat
}

// probePlatform 按注册顺序找第一个"进程在运行"的平台。
func probePlatform() Platform {
	platMu.Lock()
	defer platMu.Unlock()
	for _, p := range probeList {
		if p.Attach() {
			if curPlat == nil || curPlat.Name() != p.Name() {
				fmt.Printf("  [platform] auto-detected: %s\n", p.Name())
			}
			curPlat = p
			return p
		}
	}
	if curPlat == nil && len(probeList) > 0 {
		curPlat = probeList[0]
	}
	return curPlat
}

// hLive 句柄是否仍有效（进程存在）。
func hLive(h uintptr) bool {
	if h == 0 {
		return false
	}
	var mbi MemoryBasicInformation
	return virtualQueryEx(h, 0, &mbi) != 0
}
