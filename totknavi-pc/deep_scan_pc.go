// deep_scan_pc.go — 独立「扩大范围 / 全进程兜底扫描」与配置校准模块。
//
// 设计原则：
//   - 与自动定位（scan_totk.go / platform_totkpc.go）完全解耦，不共享窄窗筛选逻辑。
//   - 唯一输出产物是 pc_profile_local.json（通过 profile_pc.go 写入），
//     供自动定位模块直接加载，实现「手工兜底一次 → 后续自动秒锁」。

package main

import (
	"encoding/binary"
	"fmt"
	"time"
)

const (
	deepScanMinBlockSize = uintptr(64 * 1024)
	deepScanMainWindow   = uintptr(0x8000000) // 主模块指针反扫窗口 128MB
	deepScanMaxStructOff = uintptr(0x200)     // 结构体偏移反推上限
	deepScanMaxChains    = 12
)

// deepScanAllRWBlocks 枚举进程内全部可读可写已提交内存块（不限固定堆上下界）。
func deepScanAllRWBlocks(h uintptr) []MemBlock {
	if h == 0 {
		return nil
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
		if mbi.State == memCommit && size >= deepScanMinBlockSize {
			prot := mbi.Protect
			readable := prot&0x01 == 0 && prot&pageGuard == 0
			writable := prot&0xCC != 0
			if readable && writable {
				out = append(out, MemBlock{Base: base, Size: size, Writable: true})
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

// deepScanForPlayer 在全进程可读可写块中按「锚点窄窗 → 放宽 → 无锚全图」逐级兜底扫描。
func deepScanForPlayer(p Platform, anchor *[3]float32) (uintptr, []ptkHit, bool) {
	h := p.Handle()
	blks := deepScanAllRWBlocks(h)
	if len(blks) == 0 {
		return 0, nil, false
	}
	var totalMB float64
	for _, b := range blks {
		totalMB += float64(b.Size) / 1048576.0
	}
	logEvent("  [deep-scan] 启动全进程扩大范围扫描：%d 块 / %.1fMB", len(blks), totalMB)

	var radii []float32
	if anchor != nil {
		radii = []float32{scanRadius1, scanRadius2, scanRadius3, 0}
	} else {
		radii = []float32{0}
	}

	for _, radius := range radii {
		start := time.Now()
		hits := ptkScanBlocks(h, blks, anchor, radius, nil)
		var ident []ptkHit
		for _, x := range hits {
			if x.Run >= 2 {
				ident = append(ident, x)
			}
		}
		groups := ptkGroupHits(ident)
		label := fmt.Sprintf("%.0fm", radius)
		if radius == 0 {
			label = "全图无锚"
		}
		logEvent("  [deep-scan] 窗口 %s → 命中 %d 组（%.2fs）", label, len(groups), time.Since(start).Seconds())
		if len(groups) == 0 {
			continue
		}
		n := len(groups)
		if n > maxCands {
			n = maxCands
		}
		g := groups[0]
		logEvent("  [deep-scan] 锁定候选 0x%X hud=(%.1f, %.1f, %.1f)", g.Addr, g.P[0], -g.P[2], g.P[1]-elevBias)
		return g.Addr, groups[:n], true
	}
	return 0, nil, false
}

// deepReverseStaticChains 在 mainBase 静态区中反扫指向 targetAddr 的 64 位指针链。
func deepReverseStaticChains(h, mainBase, targetAddr uintptr) []StaticChainEntry {
	if h == 0 || mainBase == 0 || targetAddr < deepScanMaxStructOff {
		return nil
	}
	var chains []StaticChainEntry
	seen := make(map[string]bool)
	const chunk = uintptr(4 * 1024 * 1024)

	for off := uintptr(0); off < deepScanMainWindow && len(chains) < deepScanMaxChains; off += chunk {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, mainBase+off, &mbi) == 0 {
			break
		}
		if mbi.State != memCommit || mbi.Protect&0x01 != 0 || mbi.Protect&pageGuard != 0 {
			continue
		}
		readLen := mbi.RegionSize
		if readLen > chunk {
			readLen = chunk
		}
		buf := readMem(h, mainBase+off, int(readLen))
		for i := 0; i+8 <= len(buf); i += 8 {
			ptr := uintptr(binary.LittleEndian.Uint64(buf[i : i+8]))
			if ptr <= targetAddr && targetAddr-ptr <= deepScanMaxStructOff {
				sOff := targetAddr - ptr
				if sOff%4 != 0 {
					continue
				}
				pOff := off + uintptr(i)
				key := fmt.Sprintf("%X:%X", pOff, sOff)
				if seen[key] {
					continue
				}
				seen[key] = true
				chains = append(chains, StaticChainEntry{
					PtrOffset:    formatHexPtr(pOff),
					StructOffset: formatHexPtr(sOff),
				})
				if len(chains) >= deepScanMaxChains {
					break
				}
			}
		}
	}
	return chains
}

// deepCalibrateAndSave 根据深度扫描命中的真身地址，生成并保存 pc_profile_local.json，
// 同时切换当前活跃配置档案，实现后续自动定位直接复用。
func deepCalibrateAndSave(p Platform, plat *totkpcPlatform, lockedAddr uintptr) *MemoryProfile {
	if p == nil || plat == nil || lockedAddr == 0 {
		return nil
	}
	h := p.Handle()
	mainBase := plat.MainBase()
	_, exeSize := plat.ExeBase()

	// 1. 确定命中地址所在的堆块区间（向上下对齐 64MB，确保覆盖同区动态分配）
	const align = uintptr(64 * 1024 * 1024)
	lo := (lockedAddr / align) * align
	hi := lo + align
	var mbi MemoryBasicInformation
	if virtualQueryEx(h, lockedAddr, &mbi) != 0 && mbi.RegionSize > 0 {
		bLo := (mbi.BaseAddress / align) * align
		bHi := ((mbi.BaseAddress + mbi.RegionSize + align - 1) / align) * align
		if bLo < lo {
			lo = bLo
		}
		if bHi > hi {
			hi = bHi
		}
	}

	// 2. 反推主模块静态指针链
	chains := deepReverseStaticChains(h, mainBase, lockedAddr)

	prof := &MemoryProfile{
		ID:       "local-calibrated",
		Name:     fmt.Sprintf("本地校准配置 (%s)", time.Now().Format("01-02 15:04")),
		Verified: true,
		Fingerprint: ProfileFingerprint{
			ExeSize:  exeSize,
			MainBase: formatHexPtr(mainBase),
		},
		MainBase: formatHexPtr(mainBase),
		HeapRanges: []HeapRange{
			{Lo: formatHexPtr(lo), Hi: formatHexPtr(hi)},
			{Lo: formatHexPtr(totkPCScanHeapLo), Hi: formatHexPtr(totkPCScanHeapHi)},
		},
		StaticChains: chains,
	}

	if err := saveLocalProfile(prof); err != nil {
		logEvent("  [deep-scan] 写入校准配置失败: %v", err)
	} else {
		logEvent("  [deep-scan] ★ 已生成校准配置 %s（堆区间 %s~%s，静态链 %d 条）",
			localProfilePath(), formatHexPtr(lo), formatHexPtr(hi), len(chains))
	}
	setActiveProfile(prof)
	return prof
}
