// mount_totk.go — TOTK 骑乘跟随（马 / 左纳乌摇杆挂载类载具）。
//
// 移植自 BOTW xnavi v3.1.2 生产实现（gameIsMountState + findMountActor +
// watch.go 骑乘状态机段），按 TOTK 内存序适配：
//   TOTK 内存序 = (X东, Z_stored=alt+105, Y北)，hud 序 = (gx, gy=-Y北, gz=alt)。
//
// 架构说明（对计划文档的一个有意简化）：计划原定"locator 接口 +2 方法"，
// 实现时发现两平台唯一差异（内存块枚举）已由 Platform.Blocks() 抽象、
// 字节序两平台同为小端 → 这两个函数是纯"游戏语义"，做包级函数由 watch.go
// 直接调用（BOTW 同款：checkMountState / findMountActor 就是包级函数）。
// 状态机依旧零平台分支，locator 接口不动。
//
// ★ 待实机确认（计划 §五 阶段 1 第一步）：TOTK 骑乘标志形态。
//   本文件按 BOTW 同款假设实现：上马后主槽 12B = X槽=0.0、Z_stored槽=1.0
//   （IsRiding=1）。实测不符时只改 totkMountFlag 判据，其余不动。
//   采样工具：tools/mount_probe_totk.py（上马前后各采几秒对比主槽 12B）。
//
// 铁律（BOTW 血泪固化，勿删）：
//   1. 捕获坐骑后绝不以"距上马点距离"设限——曾因 abs(dZ)<=8m 导致载具开出
//      8 米就被误丢、红点钉死在起点。只信坐标流 + 单拍位移合理性。
//   2. 坐骑地址不写 known（堆地址每会话变，写入只污染列表）。
//   3. 捕获失败保持上一帧位置等 1s 重试，绝不解锁触发全量重扫（防 Eden
//      重扫风暴）。
//   4. 高度范围不硬编码收窄（天空岛 Z+105=2404 曾被硬编码范围误滤的教训）。

package main

import (
	"fmt"
	"math"
	"time"
)

// ---- 骑乘参数（BOTW v3.1.2 实测值平移；调参须回填 Obsidian 手册）----

const (
	mountCaptureRadius = 25.0          // 上马点捕获半径（实测坐骑通常在 0.5~2m 内）
	mountSnapDist      = 1.0           // 距上马点 <1m 立即返回（贴合度极高）
	mountMaxStep       = 100.0         // 单拍（200ms）位移上限，防野指针突变
	mountRescanEvery   = 1 * time.Second // 坐骑丢失后的快速重捕获间隔
	mountChunkSize     = 32 << 20      // 扫描按 32MB 分块读
)

// totkMountFlag 判 12B 原始内存是否满足 TOTK 骑乘标志（小端）。
// 假设（待实测）：X槽 = 0.0（bit 全零）、Z_stored槽 = 1.0（bit=1，IsRiding）；
// 第三槽（Y北）可能残留上车前坐标，不作坐标源。
func totkMountFlag(raw []byte) (bool, float32) {
	if len(raw) < 12 {
		return false, 0
	}
	a := floats(raw)
	if math.Float32bits(a[0]) == 0 && math.Float32bits(a[1]) == 1 {
		yn := a[2]
		if !math.IsNaN(float64(yn)) && math.Abs(float64(yn)) > 10.0 {
			return true, yn
		}
		return true, 0 // 标志成立但第三槽未更新
	}
	return false, 0
}

// totkMountState 读主槽并判骑乘标志。返回 (是否骑乘, 第三槽残留值)。
func totkMountState(h uintptr, addr uintptr) (bool, float32) {
	return totkMountFlag(readMem(h, addr, 12))
}

// mountScanHud 扫描路径判据：内存序三元组 → hud 序 (gx, gy=-Y北, gz=alt)；
// 无效返回 nil。判据与 edenDecodeBytes 完全同口径（全零/NaN/Inf/近零/
// Z_stored 近零/denormal/地图范围），但不拒整数三元组（扫描场景宽松合适，
// 距离门限负责过滤垃圾）。独立成函数是因为扫描吃 float 切片，不宜反复
// 走字节路径；改判据时两处同步。
func mountScanHud(a []float32) []float32 {
	gx, zs, yn := a[0], a[1], a[2]
	if gx == 0 && zs == 0 && yn == 0 {
		return nil // 未初始化槽
	}
	gy, gz := -yn, zs-elevBias
	if math.IsNaN(float64(gx)) || math.IsNaN(float64(gy)) || math.IsNaN(float64(gz)) ||
		math.IsInf(float64(gx), 0) || math.IsInf(float64(gy), 0) || math.IsInf(float64(gz), 0) {
		return nil
	}
	if abs32(gx) < 5 && abs32(gy) < 5 {
		return nil // 近零残留
	}
	if abs32(zs) < 5 {
		return nil // Z_stored 近零（未初始化槽特征，Eden 实测口径）
	}
	if abs32(gx) < 1e-6 || abs32(gy) < 1e-6 || abs32(gz) < 1e-6 {
		return nil // denormal
	}
	if gx <= -6000 || gx >= 6000 || gy <= -6000 || gy >= 6000 ||
		gz <= -1300 || gz >= 3200 {
		return nil
	}
	return []float32{gx, gy, gz}
}

// totkMountFind 在平台内存块中捕获当前坐骑实体（马 / 左纳乌摇杆载具）。
// 约束（BOTW 真机实测固化）：
//   1. 坐骑必然在林克上马点 mountCaptureRadius 米内（实测 <2m）；
//   2. 候选须过 mountScanHud 合法坐标校验；
//   3. 择优 = 距上马点最近；距离 < mountSnapDist 立即返回。
// v1 已知限制：无上马点锚（启动时就在马上）不扫描——主槽是标志位时
// known/扫描/链都锁不上，该场景先不做（罕见：先下马再上即可），待实测补。
func totkMountFind(h uintptr, lastPos [3]float32, targetZ float32) (uintptr, [3]float32, bool) {
	_ = targetZ // v1 不用：场景 B（无锚初筛）待骑乘标志实测后按轴序补
	p := currentPlatform()
	if p == nil || p.Handle() == 0 || lastPos == ([3]float32{}) {
		return 0, [3]float32{}, false
	}
	blocks := p.Blocks(minBlockMB)
	var bestAddr uintptr
	var bestPos [3]float32
	bestDiff := float32(999.0)

	for _, b := range blocks {
		off := uintptr(0)
		for off < b.Size {
			n := uintptr(mountChunkSize)
			if b.Size-off < n {
				n = b.Size - off
			}
			buf := readMem(h, b.Base+off, int(n))
			if buf == nil {
				off += n
				continue
			}
			a := floats(buf)
			for i := 0; i+3 <= len(a); i++ {
				hud := mountScanHud(a[i : i+3 : i+3])
				if hud == nil {
					continue
				}
				d := dist3([3]float32{hud[0], hud[1], hud[2]}, lastPos)
				if d > mountCaptureRadius {
					continue
				}
				if d < bestDiff {
					bestDiff = d
					bestAddr = b.Base + off + uintptr(i)*4
					bestPos = [3]float32{hud[0], hud[1], hud[2]}
					if d < mountSnapDist {
						return bestAddr, bestPos, true
					}
				}
			}
			off += n
		}
	}
	if bestAddr != 0 {
		return bestAddr, bestPos, true
	}
	return 0, [3]float32{}, false
}

// mountStateBox 骑乘跟随的可变状态（stateMachine 局部状态，见 watch.go）。
type mountStateBox struct {
	active   bool
	addr     uintptr
	lastScan time.Time
	lastLog  time.Time
	linkPos  [3]float32 // 上马前林克最后的有效坐标（hud 序，捕获锚点）
}

// reset 清空骑乘状态（锁重置时随 resetFollow 调用）。
func (m *mountStateBox) reset() {
	m.active = false
	m.addr = 0
	m.lastScan = time.Time{}
}

// step 骑乘状态机的一拍。入参 v = 主槽 decode 结果（可为 nil），
// prev/hasPrev = 上一次有效读数；返回本拍应采用的坐标（nil = 骑乘路径未接管）。
// 返回值第二个布尔 = 是否处于"骑乘但搜索中"（保持上一帧位置）。
// 日志统一走 [mount] 前缀，便于实机排查。
func (m *mountStateBox) step(h uintptr, playerAddr uintptr, v []float32, prev [3]float32, hasPrev bool) ([]float32, bool) {
	if m.active {
		if v != nil {
			// 主槽恢复正常三维坐标 = 下马，坐标源切回林克（全程无感）
			fmt.Printf("  [mount] dismounted -> restored player tracking mem=(%.1f, %.1f, %.1f)\n",
				v[0], v[1], v[2])
			m.reset()
			return v, false
		}
		isM, tz := totkMountState(h, playerAddr)
		if !isM {
			// 既无正常坐标也非骑乘标志：骑乘态作废，走原 invalid 路径
			m.reset()
			return nil, false
		}
		// 持续骑乘：直接信任已捕获坐骑的坐标流（铁律 1：不设距离上限）
		if m.addr != 0 {
			var dM []float32
			if raw := readMem(h, m.addr, 12); len(raw) >= 12 {
				dM = mountScanHud(floats(raw))
			}
			if dM != nil && (!hasPrev || dist3([3]float32{dM[0], dM[1], dM[2]}, prev) <= mountMaxStep) {
				m.linkPos = [3]float32{dM[0], dM[1], dM[2]}
				return dM, false
			}
			m.addr = 0 // 读数失效或单拍 >mountMaxStep → 重捕获
		}
		if m.addr == 0 && time.Since(m.lastScan) >= mountRescanEvery {
			m.lastScan = time.Now()
			anchor := m.linkPos
			if anchor == ([3]float32{}) && hasPrev {
				anchor = prev
			}
			if mAddr, mPos, found := totkMountFind(h, anchor, tz); found {
				m.addr = mAddr
				m.linkPos = mPos
				fmt.Printf("  [mount] re-captured mount at 0x%X mem=(%.1f, %.1f, %.1f)\n",
					mAddr, mPos[0], mPos[1], mPos[2])
				return mPos[:], false
			}
			if time.Since(m.lastLog) >= 5*time.Second {
				m.lastLog = time.Now()
				fmt.Printf("  [mount] search pending anchor=(%.1f, %.1f, %.1f)\n",
					anchor[0], anchor[1], anchor[2])
			}
		}
		return nil, true // 骑乘但未捕获：保持上一帧位置
	}
	// 步行态：主槽读数失效 → 检查是否刚上马 / 上载具
	if v != nil {
		return nil, false
	}
	isM, tz := totkMountState(h, playerAddr)
	if !isM {
		return nil, false
	}
	m.active = true
	m.linkPos = prev
	m.lastScan = time.Now()
	fmt.Printf("  [mount] entered riding state near (%.1f, %.1f, %.1f)\n",
		prev[0], prev[1], prev[2])
	if !hasPrev {
		return nil, true // 无锚（刚锁上就上马）：等下一拍重试捕获
	}
	if mAddr, mPos, found := totkMountFind(h, prev, tz); found {
		m.addr = mAddr
		m.linkPos = mPos
		fmt.Printf("  [mount] captured mount at 0x%X mem=(%.1f, %.1f, %.1f) [following]\n",
			mAddr, mPos[0], mPos[1], mPos[2])
		return mPos[:], false
	}
	fmt.Printf("  [mount] search pending near (%.1f, %.1f, %.1f)\n", prev[0], prev[1], prev[2])
	return nil, true
}
