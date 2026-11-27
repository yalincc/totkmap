// camera_pc.go — TotK-Recomp PC 版相机视野朝向（camFacing）独立追踪器。
//
// 原理：
//   在主模块静态区（mainBase + 0..128MB）扫描指向 sead::LookAtCamera 对象的指针槽：
//     [+0x00] mPos (X, Y_up, Z_south) : 相机世界坐标（距林克 1.2m ~ 22m）
//     [+0x0C] mAt  (X, Y_up, Z_south) : 镜头注视点（距林克 <= 4.5m）
//     [+0x18] mUp  (ux, uy, uz)       : 上方向单位向量（uy > 0.85, |u| ≈ 1）
//   锁定后每拍仅读 1 次静态指针 + 36 字节，计算相机看向方向罗盘角（北=0°、东=90°顺时针）。
//   完全独立于 L1 角色定位：扫描或读取失败时返回 ok=false，绝不影响玩家坐标追踪。

package main

import (
	"encoding/binary"
	"math"
	"time"
)

type pcCamTracker struct {
	pid        uint32
	mainBase   uintptr
	slotOff    uintptr
	posOff     uintptr
	locked     bool
	failStreak int
	lastScan   time.Time
}

var pcCam = &pcCamTracker{}

func (c *pcCamTracker) reset() {
	c.slotOff = 0
	c.posOff = 0
	c.locked = false
	c.failStreak = 0
}

func readF32LE(b []byte, off int) float32 {
	return math.Float32frombits(binary.LittleEndian.Uint32(b[off:]))
}

func dist3F32(ax, ay, az, bx, by, bz float32) float64 {
	dx, dy, dz := float64(ax-bx), float64(ay-by), float64(az-bz)
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

func lookAtValid(buf []byte, off int) (cx, cy, cz, ax, ay, az float32, ok bool) {
	if off < 0 || off+36 > len(buf) {
		return 0, 0, 0, 0, 0, 0, false
	}
	ux, uy, uz := readF32LE(buf, off+24), readF32LE(buf, off+28), readF32LE(buf, off+32)
	if math.IsNaN(float64(uy)) || uy < 0.80 || uy > 1.02 || math.Abs(float64(ux)) > 0.6 || math.Abs(float64(uz)) > 0.6 {
		return 0, 0, 0, 0, 0, 0, false
	}
	uLen := math.Sqrt(float64(ux*ux + uy*uy + uz*uz))
	if math.Abs(uLen-1.0) > 0.04 {
		return 0, 0, 0, 0, 0, 0, false
	}
	cx, cy, cz = readF32LE(buf, off), readF32LE(buf, off+4), readF32LE(buf, off+8)
	ax, ay, az = readF32LE(buf, off+12), readF32LE(buf, off+16), readF32LE(buf, off+20)
	if !ptkCoordOK(cx, cy, cz) || !ptkCoordOK(ax, ay, az) {
		return 0, 0, 0, 0, 0, 0, false
	}
	return cx, cy, cz, ax, ay, az, true
}

func (c *pcCamTracker) resolve(h uintptr, mainBase uintptr, playerMem [3]float32) bool {
	if h == 0 || mainBase == 0 {
		return false
	}
	const mainSpan = uintptr(0x8000000)
	refs := make(map[uintptr]uintptr, 1<<15)
	addr := mainBase
	for addr < mainBase+mainSpan {
		var mbi MemoryBasicInformation
		if virtualQueryEx(h, addr, &mbi) == 0 {
			break
		}
		if mbi.State == memCommit && mbi.Protect&0x01 == 0 && mbi.Protect&pageGuard == 0 && mbi.Protect&0xCC != 0 {
			sz := mbi.RegionSize
			if mbi.BaseAddress+sz > mainBase+mainSpan {
				sz = mainBase + mainSpan - mbi.BaseAddress
			}
			for off := uintptr(0); off < sz; off += 1 << 20 {
				n := 1 << 20
				if off+uintptr(n) > sz {
					n = int(sz - off)
				}
				buf := readMem(h, mbi.BaseAddress+off, n)
				if len(buf) < 8 {
					continue
				}
				for i := 0; i+8 <= len(buf); i += 8 {
					v := uintptr(binary.LittleEndian.Uint64(buf[i:]))
					if v >= 0x100000000 && v < 0x8000000000 && v%8 == 0 {
						if _, exists := refs[v]; !exists {
							refs[v] = mbi.BaseAddress + off + uintptr(i) - mainBase
						}
					}
				}
			}
		}
		nxt := mbi.BaseAddress + mbi.RegionSize
		if nxt <= addr {
			break
		}
		addr = nxt
	}

	px, py, pz := playerMem[0], playerMem[1], playerMem[2]
	var bestSlot, bestOff uintptr
	bestScore := math.MaxFloat64
	found := false

	for obj, sOff := range refs {
		buf := readMem(h, obj, 0x800)
		if len(buf) < 36 {
			continue
		}
		for off := 0; off+36 <= len(buf); off += 4 {
			cx, cy, cz, ax, ay, az, ok := lookAtValid(buf, off)
			if !ok {
				continue
			}
			dCam := dist3F32(cx, cy, cz, px, py, pz)
			dAt := dist3F32(ax, ay, az, px, py, pz)
			if dCam >= 1.2 && dCam <= 22.0 && dAt <= 4.5 {
				// 优先选偏移小、at 最贴近玩家躯干的静态槽
				score := dAt + float64(off)*0.0005
				if score < bestScore {
					bestScore = score
					bestSlot = sOff
					bestOff = uintptr(off)
					found = true
				}
				break
			}
		}
	}
	if !found {
		return false
	}
	c.slotOff = bestSlot
	c.posOff = bestOff
	c.locked = true
	c.failStreak = 0
	logEvent("  [OK] 相机视野已锁定：main+0x%X +0x%X", bestSlot, bestOff)
	return true
}

// sample 读取相机视野罗盘角（北=0°、东=90° 顺时针）。
func (c *pcCamTracker) sample(h uintptr, pid uint32, mainBase uintptr, hudPos [3]float32) (float32, bool) {
	if h == 0 || pid == 0 || mainBase == 0 {
		return 0, false
	}
	if c.pid != pid || c.mainBase != mainBase {
		c.pid = pid
		c.mainBase = mainBase
		c.reset()
	}
	// HUD (gx, gy, gz) → 内存序 (X, Z_stored=gz+elevBias, Y_north=-gy)
	playerMem := [3]float32{hudPos[0], hudPos[2] + elevBias, -hudPos[1]}

	if !c.locked {
		if time.Since(c.lastScan) < 3*time.Second {
			return 0, false
		}
		c.lastScan = time.Now()
		if !c.resolve(h, mainBase, playerMem) {
			return 0, false
		}
	}

	pbuf := readMem(h, mainBase+c.slotOff, 8)
	if len(pbuf) < 8 {
		c.failStreak++
		if c.failStreak >= 10 {
			c.reset()
		}
		return 0, false
	}
	obj := uintptr(binary.LittleEndian.Uint64(pbuf))
	if obj < 0x100000000 || obj >= 0x8000000000 {
		c.failStreak++
		if c.failStreak >= 10 {
			c.reset()
		}
		return 0, false
	}
	buf := readMem(h, obj+c.posOff, 36)
	cx, _, cz, ax, _, az, ok := lookAtValid(buf, 0)
	if !ok {
		c.failStreak++
		if c.failStreak >= 10 {
			c.reset()
		}
		return 0, false
	}
	dE := float64(ax - cx)
	dN := float64(cz - az) // 内存 Z 北负南正 → 北向增量 = -(az - cz)
	if dE*dE+dN*dN < 0.04 {
		return 0, false
	}
	c.failStreak = 0
	deg := math.Mod(math.Atan2(dE, dN)*180.0/math.Pi+360.0, 360.0)
	return float32(math.Round(deg*10) / 10), true
}
