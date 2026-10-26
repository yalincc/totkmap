// locate.go — 内存定位公共类型与工具（M1 第二步精简版）。
//
// 老路（v2.2.0）locator 接口扫描链（Hit/Group/ShortlistEntry/LocateResult/
// minBlockMB/chunkSize）随 locator 接口退役删除；本文件只保留仍被消费的类型：
//   - Hit：coords 校准（locator_eden.go edenScanAll/edenScanBytes）命中类型
//   - floats：骑乘跟随（mount_totk.go mountScanHud）与扫描解码共用
//   - rotOKBytes/rotOK：coords 校准结构有效性校验（旋转矩阵特征）
//   - blocksCached：块枚举 TTL 缓存（coords 校准全 RAM 扫描用）
//
// 新定位管道（core_totk.go）扫描原语直接用 probe_totk.go 的 ptk* 系列
// （FindEdenTriples/RunLength/GroupHits/DecodeBytes，探针实机验证参数）。

package main

import (
	"math"
	"sync"
	"time"
	"unsafe"
)

// minBlockMB 骑乘跟随（mount_totk.go mountFind）块枚举下限（Ryujinx guest DRAM）。
const minBlockMB = 512.0

// Hit 扫描命中（X,Y,Z 为内存序；coords 校准专用，老路扫描已退役）。
type Hit struct {
	Addr     uintptr
	X, Y, Z  float32
	Ri       int
	Dist     float32
}

// floats 字节切片按小端重解释为 float32 切片。
func floats(b []byte) []float32 {
	if len(b) < 4 {
		return nil
	}
	return unsafe.Slice((*float32)(unsafe.Pointer(&b[0])), len(b)/4)
}

// rotOKBytes 检查缓冲区内是否存在正交 3x3 旋转矩阵（ActorBase 特征）。
// TOTK ActorBase：mPosition 后紧跟 mRotation（矩阵在 offset 12，float st=3）。
// 从 st=3 起检查（offset 12-56），保留 4..16 兼容其他布局。
func rotOKBytes(buf []byte) bool {
	if len(buf) < 64 {
		return false
	}
	a := floats(buf) // 128 字节 → 32 个 float
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

// ---- 块枚举缓存（coords 校准用：全 RAM 扫描每次 VirtualQueryEx 代价高）----
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
