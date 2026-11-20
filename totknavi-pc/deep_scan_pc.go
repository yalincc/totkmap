// deep_scan_pc.go — PC 版「校准适配」核心：主模块 L1 静态指针链直接反算 + 全进程扩大范围兜底扫描。
//
// 设计原则：
//   - 优先路径（<0.3s）：按目标 HUD 坐标直接反扫 mainBase 静态区，收集候选 L1 指针链，
//     待用户走动 3 秒筛选出真正随角色移动的真身链，立刻升级为 LEVEL-1 并写入 profiles/*.json。
//   - 自动兜底路径（10~15s）：若主模块直扫未命中，自动转入全进程可读可写内存扫描，
//     命中并验证后同样反算 L1 并持久化配置。

package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"path/filepath"
	"time"
)

const (
	deepScanMinBlockSize  = uintptr(64 * 1024)
	deepScanMainWindow    = uintptr(0x8000000) // 主模块指针反扫窗口 128MB
	deepScanMaxStructOff  = uintptr(0x200)     // 结构体偏移反推上限
	deepScanMaxChains     = 12                 // 写入配置最多保留的 L1 链数
	deepScanCandChainCap  = 512                // 走动筛选阶段最多收集的候选链数（覆盖主模块完整 .bss 高偏移区）
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
	logEvent("  [WAIT] 正在全进程扩大范围扫描（%.0fMB，预计 10~15 秒，若超时未响应请重新开始定位）...", totalMB)

	var radii []float32
	if anchor != nil {
		radii = []float32{scanRadius1, scanRadius2, scanRadius3, 0}
	} else {
		radii = []float32{0}
	}

	for _, radius := range radii {
		hits := ptkScanBlocks(h, blks, anchor, radius, nil)
		var ident []ptkHit
		for _, x := range hits {
			if x.Run >= 2 {
				ident = append(ident, x)
			}
		}
		groups := ptkGroupHits(ident)
		if len(groups) == 0 {
			continue
		}
		n := len(groups)
		if n > maxCands {
			n = maxCands
		}
		return groups[0].Addr, groups[:n], true
	}
	return 0, nil, false
}

// matchCoordOffsets 在堆对象切片内查找与 targetHud 坐标距离 <= maxDist 的 4 字节对齐偏移，
// 返回 (非28B队列偏移列表, 28B队列兜底偏移列表)，优先使用真正的 Actor 实体坐标槽（载具飞行不冻结）。
func matchCoordOffsets(heapBuf []byte, targetHud [3]float32, maxDist float32) (actorOffs, ringOffs []uintptr) {
	for sOff := uintptr(0); sOff+12 <= uintptr(len(heapBuf)); sOff += 4 {
		cx := math.Float32frombits(binary.LittleEndian.Uint32(heapBuf[sOff:]))
		czs := math.Float32frombits(binary.LittleEndian.Uint32(heapBuf[sOff+4:]))
		cyn := math.Float32frombits(binary.LittleEndian.Uint32(heapBuf[sOff+8:]))
		if !ptkCoordOK(cx, czs, cyn) {
			continue
		}
		cHud := [3]float32{cx, -cyn, czs - elevBias}
		if dist3(cHud, targetHud) > maxDist {
			continue
		}
		if ptkRun28Length(heapBuf, int(sOff)) >= 2 {
			ringOffs = append(ringOffs, sOff)
		} else {
			actorOffs = append(actorOffs, sOff)
		}
	}
	return actorOffs, ringOffs
}

// readStaticChainEntry 读取单条静态指针链候选的当前 HUD 坐标与堆内坐标地址。
func readStaticChainEntry(h, mainBase uintptr, c StaticChainEntry) ([3]float32, uintptr, bool) {
	var zero [3]float32
	if h == 0 || mainBase == 0 {
		return zero, 0, false
	}
	po, ok1 := parseHexPtr(c.PtrOffset)
	so, ok2 := parseHexPtr(c.StructOffset)
	if !ok1 || !ok2 {
		return zero, 0, false
	}
	pBytes := readMem(h, mainBase+po, 8)
	if len(pBytes) < 8 {
		return zero, 0, false
	}
	heapPtr := uintptr(binary.LittleEndian.Uint64(pBytes))
	if heapPtr < 0x100000000 || heapPtr >= 0x7FFFFFFFFFFF {
		return zero, 0, false
	}
	addr := heapPtr + so
	cBytes := readMem(h, addr, 12)
	if len(cBytes) < 12 {
		return zero, 0, false
	}
	x := math.Float32frombits(binary.LittleEndian.Uint32(cBytes[0:]))
	zs := math.Float32frombits(binary.LittleEndian.Uint32(cBytes[4:]))
	yn := math.Float32frombits(binary.LittleEndian.Uint32(cBytes[8:]))
	if !ptkCoordOK(x, zs, yn) {
		return zero, 0, false
	}
	return [3]float32{x, -yn, zs - elevBias}, addr, true
}

// deepReverseStaticChainsByCoord 按 HUD 坐标直接反扫 mainBase 静态区，找出所有指向 targetHud 附近
// （距离 <= maxCoordDiff）的 64 位一级静态指针链。不依赖固定堆区间、不依赖 28B 队列结构，耗时 <0.3s。
func deepReverseStaticChainsByCoord(h, mainBase uintptr, targetHud [3]float32, maxCoordDiff float32, capLimit int) []StaticChainEntry {
	if h == 0 || mainBase == 0 {
		return nil
	}
	if capLimit <= 0 {
		capLimit = deepScanMaxChains
	}

	var actorChains, ringChains []StaticChainEntry
	seen := make(map[string]bool)
	checkedPtr := make(map[uintptr]bool)
	const chunk = uintptr(4 * 1024 * 1024)

	for off := uintptr(0); off < deepScanMainWindow && len(actorChains) < capLimit; {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, mainBase+off, &mbi) == 0 {
			break
		}
		regEnd := mbi.BaseAddress + mbi.RegionSize
		nextOff := off + 0x1000
		if regEnd > mainBase+off {
			nextOff = regEnd - mainBase
		}

		readable := mbi.State == memCommit && mbi.Protect&0x01 == 0 && mbi.Protect&pageGuard == 0 && mbi.Protect&0xCC != 0
		if !readable {
			off = nextOff
			continue
		}

		regLimit := nextOff
		if regLimit > deepScanMainWindow {
			regLimit = deepScanMainWindow
		}
		for curOff := off; curOff < regLimit && len(actorChains) < capLimit; curOff += chunk {
			readLen := regLimit - curOff
			if readLen > chunk {
				readLen = chunk
			}
			buf := readMem(h, mainBase+curOff, int(readLen))
			for i := 0; i+8 <= len(buf); i += 8 {
				ptr := uintptr(binary.LittleEndian.Uint64(buf[i : i+8]))
				if ptr < 0x100000000 || ptr >= 0x7FFFFFFFFFFF || ptr%4 != 0 {
					continue
				}
				if ptr >= mainBase && ptr < mainBase+deepScanMainWindow {
					continue
				}
				if checkedPtr[ptr] {
					continue
				}
				checkedPtr[ptr] = true

				heapBuf := readMem(h, ptr, int(deepScanMaxStructOff))
				if len(heapBuf) < 12 {
					continue
				}
				actorOffs, ringOffs := matchCoordOffsets(heapBuf, targetHud, maxCoordDiff)
				pOff := curOff + uintptr(i)
				for _, sOff := range actorOffs {
					key := fmt.Sprintf("%X:%X", pOff, sOff)
					if seen[key] {
						continue
					}
					seen[key] = true
					actorChains = append(actorChains, StaticChainEntry{
						PtrOffset:    formatHexPtr(pOff),
						StructOffset: formatHexPtr(sOff),
					})
					if len(actorChains) >= capLimit {
						break
					}
				}
				if len(actorChains) < capLimit {
					for _, sOff := range ringOffs {
						key := fmt.Sprintf("%X:%X", pOff, sOff)
						if seen[key] {
							continue
						}
						seen[key] = true
						ringChains = append(ringChains, StaticChainEntry{
							PtrOffset:    formatHexPtr(pOff),
							StructOffset: formatHexPtr(sOff),
						})
					}
				}
			}
		}
		off = nextOff
	}

	out := append(actorChains, ringChains...)
	if len(out) > capLimit {
		out = out[:capLimit]
	}
	return out
}

// deepReverseStaticChains 读取已锁定真身地址的当前坐标，反扫 mainBase 中的 L1 静态指针链。
func deepReverseStaticChains(h, mainBase, targetAddr uintptr) []StaticChainEntry {
	if h == 0 || mainBase == 0 || targetAddr == 0 {
		return nil
	}
	tBytes := readMem(h, targetAddr, 12)
	if len(tBytes) < 12 {
		return nil
	}
	tx := math.Float32frombits(binary.LittleEndian.Uint32(tBytes[0:]))
	tzs := math.Float32frombits(binary.LittleEndian.Uint32(tBytes[4:]))
	tyn := math.Float32frombits(binary.LittleEndian.Uint32(tBytes[8:]))
	if !ptkCoordOK(tx, tzs, tyn) {
		return nil
	}
	targetHud := [3]float32{tx, -tyn, tzs - elevBias}
	return deepReverseStaticChainsByCoord(h, mainBase, targetHud, 0.5, deepScanMaxChains)
}

// buildAndSaveLocalProfile 根据已验证的真身地址与 L1 静态指针链，生成并写入 profiles/*.json，
// 同时切换当前活跃配置单，实现「校准一次，后续启动自动秒锁」。
func buildAndSaveLocalProfile(p Platform, plat *totkpcPlatform, lockedAddr uintptr, chains []StaticChainEntry) (*MemoryProfile, string) {
	if p == nil || plat == nil || (lockedAddr == 0 && len(chains) == 0) {
		return nil, ""
	}
	h := p.Handle()
	mainBase := plat.MainBase()
	_, exeSize := plat.ExeBase()
	ramGB := systemRamGB()

	if len(chains) > deepScanMaxChains {
		chains = chains[:deepScanMaxChains]
	}

	// 1. 确定命中地址所在的堆块区间（向上下对齐 64MB）
	var heapRanges []HeapRange
	if lockedAddr != 0 {
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
		heapRanges = append(heapRanges, HeapRange{Lo: formatHexPtr(lo), Hi: formatHexPtr(hi)})
	}
	heapRanges = append(heapRanges, HeapRange{Lo: formatHexPtr(totkPCScanHeapLo), Hi: formatHexPtr(totkPCScanHeapHi)})

	sizeMB := float64(exeSize) / 1048576.0
	recompVer, gameVer := detectGameVersions(p.PID(), h)
	profID := "local-calibrated"
	profName := fmt.Sprintf("本地校准 (%s)", time.Now().Format("01-02 15:04"))
	if exeSize > 0 {
		profID = fmt.Sprintf("local-%dmb", int(math.Round(sizeMB)))
		if recompVer != "" {
			if gameVer != "" {
				profName = fmt.Sprintf("%s (%s · %.1fMB)", recompVer, gameVer, sizeMB)
			} else {
				profName = fmt.Sprintf("%s (%.1fMB)", recompVer, sizeMB)
			}
		} else if ramGB > 0 {
			profName = fmt.Sprintf("本地校准 (%.1fMB · %dGB)", sizeMB, ramGB)
		} else {
			profName = fmt.Sprintf("本地校准 (%.1fMB)", sizeMB)
		}
	}

	prof := &MemoryProfile{
		ID:            profID,
		Name:          profName,
		RecompVersion: recompVer,
		GameVersion:   gameVer,
		Note:          "由校准适配自动生成，可分享给同 PC 编译版与同游戏版本玩家",
		RamGB:         ramGB,
		Verified:      true,
		Fingerprint: ProfileFingerprint{
			ExeSize:  exeSize,
			MainBase: formatHexPtr(mainBase),
		},
		MainBase:     formatHexPtr(mainBase),
		HeapRanges:   heapRanges,
		StaticChains: chains,
	}

	savedPath, err := saveLocalProfile(prof)
	if err != nil {
		logEvent("  [WARN] 本地配置写入失败：%v（本次会话仍生效，重启后需重新校准）", err)
	} else {
		logEvent("  [OK] 已保存本机配置：%s（L1 静态链 %d 条），下次启动自动秒锁；欢迎点【↑ 分享配置】造福同版本玩家",
			filepath.Join("profiles", filepath.Base(savedPath)), len(chains))
	}
	setActiveProfile(prof)
	return prof, savedPath
}

// deepCalibrateAndSave 根据已验证真身地址反推 L1 静态指针链并保存本地配置。
func deepCalibrateAndSave(p Platform, plat *totkpcPlatform, lockedAddr uintptr) *MemoryProfile {
	if p == nil || plat == nil || lockedAddr == 0 {
		return nil
	}
	chains := deepReverseStaticChains(p.Handle(), plat.MainBase(), lockedAddr)
	prof, _ := buildAndSaveLocalProfile(p, plat, lockedAddr, chains)
	return prof
}
