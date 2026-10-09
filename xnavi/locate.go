// 内存定位公共类型与工具。
//
// 平台化：Ryujinx / Eden 两套扫描策略（窗口过滤、分组打分、junk 过滤、
// 解码校验）差异巨大（见 locator_ryujinx.go / locator_eden.go），全部移入
// 各自的 locator 实现。本文件只保留两版共用的类型、常量与工具函数。

package main

import (
	"math"
	"sync"
	"time"
	"unsafe"
)

const (
	chunkSize  = 64 << 20 // 每次读取 64MB（Ryujinx 版；Eden 用 edenChunkSize=8MB）
	hitCap     = 3000000  // 命中上限（防窗口过宽）
	minBlockMB = 512.0    // Ryujinx guest DRAM 下限；Eden 用 edenMinBlockMB=64KB
)

type Hit struct {
	Addr     uintptr
	X, Y, Z  float32 // (X, alt, Z) 内存顺序
	Ri       int
	Dist     float32
}

type Group struct {
	Addrs  []uintptr
	Ri     int
	Dist   float32
	Struct int
	Copies int
	X, Y, Z float32 // 组坐标（内存顺序）
}

type ShortlistEntry struct {
	Hud    [3]float32 // (X, -Y北, alt) 展示顺序
	Copies int
	Struct int
	Dist   float32
	Slot   int
	Addrs  []uintptr
}

type LocateResult struct {
	Addr      uintptr
	Copies    int
	Struct    int
	Hud       [3]float32
	Shortlist []ShortlistEntry
	Log       []string
}

func floats(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

// rotOKBytes 检查缓冲区内是否存在正交 3x3 旋转矩阵（ActorBase 特征）。
func rotOKBytes(buf []byte) bool {
	if len(buf) < 64 {
		return false
	}
	a := floats(buf) // 128 字节 → 32 个 float
	// TOTK ActorBase：mPosition 后紧跟 mRotation（矩阵在 offset 12，float st=3）。
	// live-python rot_ok 只查 st=4..16 会漏掉玩家槽 → struct=0 → 排序退化。
	// 这里从 st=3 起检查（offset 12-56），保留 4..16 兼容其他布局。
	for st := 3; st < 17 && st+9 <= len(a); st++ {
		m := a[st : st+9]
		cols := [3][3]float32{
			{m[0], m[3], m[6]},
			{m[1], m[4], m[7]},
			{m[2], m[5], m[8]},
		}
		ok := true
		for i := 0; i < 3; i++ {
			n := math.Sqrt(float64(cols[i][0]*cols[i][0] + cols[i][1]*cols[i][1] + cols[i][2]*cols[i][2]))
			if math.Abs(n-1.0) >= 0.05 {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		for i := 0; i < 3 && ok; i++ {
			for j := i + 1; j < 3; j++ {
				dot := cols[i][0]*cols[j][0] + cols[i][1]*cols[j][1] + cols[i][2]*cols[j][2]
				if math.Abs(float64(dot)) >= 0.08 {
					ok = false
					break
				}
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// rotOK 读进程内存后检查旋转矩阵特征。
func rotOK(h uintptr, addr uintptr) bool {
	return rotOKBytes(readMem(h, addr, 128))
}

// ---- 块枚举缓存（平台化：key = 平台名 + pid + minMB）----
// guestBlocks 要 VirtualQueryEx 一路遍历到 0x7FFFFFFFFFFF；Ryujinx 进程里
// region 极多，实测一次 6 秒。块布局在秒级内不会变，这里做短期缓存；
// pid 变化立即失效（进程重启）。

const blkCacheTTL = 5 * time.Second

var blkCache struct {
	mu    sync.Mutex
	plat  string
	pid   uint32
	minMB float64
	at    time.Time
	val   []MemBlock
}

// blocksCached 带 TTL 的平台块枚举缓存。
func blocksCached(p Platform, minMB float64) []MemBlock {
	blkCache.mu.Lock()
	defer blkCache.mu.Unlock()
	if blkCache.val != nil && blkCache.plat == p.Name() && blkCache.pid == p.PID() &&
		blkCache.minMB == minMB && time.Since(blkCache.at) < blkCacheTTL {
		return blkCache.val
	}
	v := p.Blocks(minMB)
	blkCache.plat, blkCache.pid, blkCache.minMB, blkCache.at, blkCache.val = p.Name(), p.PID(), minMB, time.Now(), v
	return v
}

func shortlistAddrs(sl []ShortlistEntry) int {
	n := 0
	for _, g := range sl {
		n += len(g.Addrs)
	}
	return n
}
