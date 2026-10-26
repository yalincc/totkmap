// platform_ryujinx.go — Ryujinx 平台驱动（TOTK live-go 原逻辑平台化）。
//
// 基线：TOTKmap live-go（V1.8.7 稳定版）。差异点：
//   - 进程：前缀匹配 "ryujinx"（进程名多变：Ryujinx / Ryujinx.Ava）
//   - 内存：guest DRAM 表现为 MEM_MAPPED 提交区（有 32GB 高的镜像块需剔除）
//   - 字节序：Switch = 小端
//   - 存档：%APPDATA%\Ryujinx\bis\user\save
//
// 与 live-go 行为完全一致：优先返回最大 RW MEM_MAPPED 提交块（≥512MB 时只扫它），
// 否则退回所有 ≥minMB 的去镜像块；known 偏移相对块基址（重启后基址变化，偏移不变）。

package main

import (
	"os"
	"path/filepath"
)

type ryujinxPlatform struct {
	h   uintptr
	pid uint32
}

func init() {
	registerPlatform(&ryujinxPlatform{})
}

func (p *ryujinxPlatform) Name() string { return "Ryujinx" }

func (p *ryujinxPlatform) Attach() bool {
	pid := findPid("ryujinx")
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
		p.h = 0 // 句柄已失效（进程曾退出/被替换），继续走重开
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

func (p *ryujinxPlatform) Handle() uintptr     { return p.h }
func (p *ryujinxPlatform) PID() uint32        { return p.pid }
func (p *ryujinxPlatform) LittleEndian() bool { return true }

// Blocks guest DRAM：优先最大 RW MEM_MAPPED 提交块（≥512MB 只扫它），
// 否则退回所有 ≥minMB 的去镜像块（live-go guestBlocks 原逻辑）。
func (p *ryujinxPlatform) Blocks(minMB float64) []MemBlock {
	return ryuGuestBlocks(p.h, minMB)
}

// LargestBlock 最大 guest DRAM（known 偏移重定位锚点）。
func (p *ryujinxPlatform) LargestBlock(minMB float64) (uintptr, uintptr) {
	return ryuLargestGuestBlock(p.h, minMB)
}

// SaveRoots Ryujinx 存档根候选。TOTK_SAVE_DIR_RYUJINX（GUI 存档设置 v2.1.0，
// 检测不到时的手动兜底）优先；默认 %APPDATA%\Ryujinx\bis\user\save 兜底。
// 候选列表由 findTotkSaveFiles 逐项探测，手动路径不存在时自动回退 APPDATA。
func (p *ryujinxPlatform) SaveRoots() []string {
	var out []string
	if v := os.Getenv("TOTK_SAVE_DIR_RYUJINX"); v != "" {
		out = append(out, v)
	}
	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		appdata = os.Getenv("USERPROFILE") + "\\AppData\\Roaming"
	}
	out = append(out, filepath.Join(appdata, "Ryujinx", "bis", "user", "save"))
	return out
}

// ---- 内存枚举（原 live-go winapi.go guestBlocks / largestGuestBlock）----

// ryuGuestBlocks 与 live-go guestBlocks 同口径：优先返回最大的 RW MEM_MAPPED
// 提交块（Ryujinx 的 guest DRAM），仅当它 >=512MB 时只扫它——避免把其他区域的
// 无矩阵坐标副本混进玩家组（struct 签名采样失真）。否则退回所有 >=minMB 的去镜像块。
func ryuGuestBlocks(h uintptr, minMB float64) []MemBlock {
	if h == 0 {
		return nil
	}
	minSize := uintptr(minMB * 1048576.0)
	const limit = uintptr(0x7FFFFFFFFFFF)
	const mirrorStep = uintptr(0x800000000)
	var dram MemBlock
	var raw []MemBlock
	baseSet := map[uintptr]bool{}
	addr := uintptr(0)
	for addr < limit {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		base, size := mbi.BaseAddress, mbi.RegionSize
		prot := mbi.Protect & 0xFF
		if mbi.State == memCommit && mbi.Type == memMapped &&
			(prot == 0x02 || prot == 0x04) {
			if size >= minSize {
				raw = append(raw, MemBlock{base, size})
				baseSet[base] = true
			}
			if size > dram.Size {
				dram = MemBlock{base, size}
			}
		}
		nxt := base + size
		if nxt > addr {
			addr = nxt
		} else {
			addr += 0x1000
		}
	}
	if dram.Size >= 512*1048576 {
		return []MemBlock{dram}
	}
	var out []MemBlock
	for _, b := range raw {
		if !baseSet[b.Base+mirrorStep] {
			out = append(out, b)
		}
	}
	return out
}

// ryuLargestGuestBlock 最大 guest DRAM（known 偏移重定位；去镜像块）。
func ryuLargestGuestBlock(h uintptr, minMB float64) (uintptr, uintptr) {
	if h == 0 {
		return 0, 0
	}
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
