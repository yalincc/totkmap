// tracker.go — 追踪循环（对齐 totknavi/core_totk.go 的管道语义，做减法）。
//
// 只保留模拟器版验证过的三条核心机制，不额外发挥：
//
//	① 存档锚点窄窗扫描：120m → 400m → 3000m 逐级放宽，扫到就锁
//	② 移动确认：锁定后，该槽坐标相对锁定时刻位移 0.5~150m → 判定真身（verified）
//	   若主锁没动而候选里有动的，走动仲裁切过去（防锁到静止 NPC）
//	③ 死守不退：锁定后读不到就重试 3 次（30ms），仍失败则 hold 上一帧，绝不主动掉锁
//
// 明确不做（之前加过，已删）：副本池、动态锚点、三级分级扫描、定期重扫。
// 依据：totknavi 没有这些，靠上面三条已经稳定；多出来的逻辑只会引入新的失败模式。

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// posLog 逐拍日志（--log 开启）。用于事后分析漂移/跳变。
// 每拍一行：时间 地址 坐标 朝向 verified source。
var posLog *os.File

func openPosLog(path string) error {
	if path == "" {
		path = "pos.log"
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		os.MkdirAll(dir, 0o755)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	posLog = f
	return nil
}

func logTick(addr uintptr, pos [3]float32, hd float32, hasH, verified bool, src string) {
	if posLog == nil {
		return
	}
	hs := "null"
	if hasH {
		hs = fmt.Sprintf("%.2f", hd)
	}
	fmt.Fprintf(posLog, "%s\t0x%X\t%.3f\t%.3f\t%.3f\t%s\t%v\t%s\n",
		time.Now().Format("15:04:05.000"), addr, pos[0], pos[1], pos[2], hs, verified, src)
}

const (
	tickInterval = 100 * time.Millisecond
	failRetry    = 3
	failRetryGap = 30 * time.Millisecond

	// 移动确认阈值。
	// BOTW 原版是 delta >= 0.5 连续 3 拍（10Hz）—— 那是按"跑步 5m/s"设计的
	// （100ms 位移 0.5m）；TOTK 里慢走只有 1.4m/s = 0.14m/拍，永远够不到 0.5，
	// 于是 moveN 被反复清零、永远确认不了（2026-10-31 实测：走了 12 米仍未 verified）。
	// 这里降到 0.1m/拍（相当于 1m/s 以上就算在移动），并保持连续 3 拍。
	moveMin = 0.1
	moveMax = 150.0

	// 传送判定：单拍位移超过此值视为传送/读档（core_totk.go 同值）
	warpDist = 50.0

	// 扫描窗口递进（对齐 core_totk.go：120 → 400 → 3000）
	scanRadius1 = 120.0
	scanRadius2 = 400.0
	scanRadius3 = 3000.0

	maxCands = 10 // 候选上限（移动确认用）
)

// tickFn 每拍回调。pos 为 HUD 序；source ∈ {player, hold, lost, no-anchor}
type tickFn func(pos [3]float32, heading float32, hasHeading bool, verified bool, source string)

// hudOf ptkHit 的内存序坐标 → HUD 序。
func hudOf(h ptkHit) [3]float32 {
	return [3]float32{h.P[0], -h.P[2], h.P[1] - elevBias}
}

// readWithRetry 读槽，失败重试 failRetry 次（模拟器版同款，抗过图黑屏的瞬态读空）。
func readWithRetry(h uintptr, addr uintptr) ([3]float32, float32, bool, bool) {
	for i := 0; i < failRetry; i++ {
		if i > 0 {
			time.Sleep(failRetryGap)
		}
		if pos, hd, hasH, ok := ptkReadSlot(h, addr); ok {
			return pos, hd, hasH, true
		}
	}
	return [3]float32{}, 0, false, false
}

// scanForPlayer 存档锚点窄窗扫描：120m → 400m → 3000m。
// 返回 (锁定地址, 候选列表)。候选列表供移动确认/走动仲裁使用。
func scanForPlayer(p Platform, plat *totkpcPlatform, anchor *[3]float32) (uintptr, []ptkHit, bool) {
	blks := p.Blocks(0.0625)
	if len(blks) == 0 {
		return 0, nil, false
	}
	h := p.Handle()
	// anchor == nil：不限窗口的全范围扫描（传送后最后位置与存档锚点都失效时的兜底）
	radii := []float32{scanRadius1, scanRadius2, scanRadius3}
	if anchor == nil {
		radii = []float32{0}
	}
	for _, radius := range radii {
		start := time.Now()
		hits := ptkScanNear(h, blks, anchor, radius)
		var ident []ptkHit
		for _, x := range hits {
			if x.Run >= 2 {
				ident = append(ident, x)
			}
		}
		groups := ptkGroupHits(ident)
		fmt.Printf("  [scan] 窗口 %.0fm → 命中 %d 组（%.2fs）\n", radius, len(groups), time.Since(start).Seconds())
		if len(groups) == 0 {
			continue
		}
		n := len(groups)
		if n > maxCands {
			n = maxCands
		}
		g := groups[0]
		fmt.Printf("  [scan] 锁定 0x%X hud=(%.1f, %.1f, %.1f) 距锚点 %.1fm\n",
			g.Addr, g.P[0], -g.P[2], g.P[1]-elevBias, g.Dist)
		return g.Addr, groups[:n], true
	}
	return 0, nil, false
}

// runTracker 追踪主循环（阻塞，直到 Ctrl+C 或调用方退出）。
func runTracker(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr, onTick tickFn) {
	h := p.Handle()

	lockedAddr := addr
	var cands []ptkHit
	verified := addr != 0
	moveN := 0
	lostWarned := false
	var prev [3]float32
	hasPrev := false

	if lockedAddr == 0 {
		var ok bool
		lockedAddr, cands, ok = scanForPlayer(p, plat, anchor)
		if !ok {
			fmt.Println("  [scan] 未命中 —— 请确认：① 已在 3D 世界中 ② 存档是最近 2 分钟内的")
			onTick([3]float32{}, 0, false, false, "no-anchor")
			return
		}
		verified = false
		fmt.Printf("  [lock] 候选 0x%X —— 【请在游戏内移动一下角色以完成验证】\n", lockedAddr)
	} else {
		fmt.Printf("  [lock] 直接锁定指定地址 0x%X\n", lockedAddr)
	}

	tick := time.NewTicker(tickInterval)
	defer tick.Stop()

	for range tick.C {
		pos, hd, hasH, ok := readWithRetry(h, lockedAddr)
		if !ok {
			// 读不到：保持上一帧 + 提示一次。**不重扫、不换锁**（老大 2026-10-31 定）。
			if !lostWarned {
				lostWarned = true
				fmt.Println("  [lost] 读不到角色数据（过图/传送中属正常现象）")
				fmt.Println("         若长时间不恢复，请重启本程序重新定位")
			}
			if hasPrev {
				logTick(lockedAddr, prev, 0, false, verified, "hold")
				onTick(prev, 0, false, verified, "hold")
			} else {
				logTick(lockedAddr, [3]float32{}, 0, false, false, "lost")
				onTick([3]float32{}, 0, false, false, "lost")
			}
			continue
		}
		lostWarned = false
		cur := pos

		// ② 移动确认（严格对齐 BOTW xnavi watch_eden.go:425-433）
		//
		// 判据是**单拍位移**，不是"距锁定时刻的累计位移"：
		//   连续 3 拍（300ms）每拍移动 >=0.5m → 这个槽在跟着玩家动 → 确认真身。
		//
		// 2026-10-31 踩坑：TOTKnavi/core_totk.go 把这里改成了
		//   dSelf = dist3(cur, cands[0].init)  // 累计位移
		//   if dSelf >= 0.5 && dSelf < 150 {}
		// 滑翔翼 30 秒能飞几百米，累计值一旦超过 150 就永远无法确认，
		// 于是每拍都跑走动仲裁 → 地址在几个候选之间乱跳（表现为"疯狂漂移"）。
		// BOTW 用单拍位移就没这问题（风弹飞得更快也正常）。
		if !verified {
			delta := float32(0)
			if hasPrev {
				delta = dist3(cur, prev)
			}
			if hasPrev && delta >= moveMin && delta < moveMax {
				moveN++
				if moveN >= 3 {
					verified = true
					cands = nil
					fmt.Printf("  [lock] 移动确认成功 → 真身锁定 0x%X (%.1f, %.1f, %.1f)\n",
						lockedAddr, cur[0], cur[1], cur[2])
				}
			} else {
				// 主锁没在动：若是刚锁定不久，看看候选里有没有在动的（防锁到静止 NPC）
				moveN = 0
				if hasPrev && len(cands) > 0 {
					for _, c := range cands {
						if c.Addr == lockedAddr {
							continue
						}
						cp, _, _, cok := ptkReadSlot(h, c.Addr)
						if !cok {
							continue
						}
						if dC := dist3(cp, hudOf(c)); dC >= moveMin && dC < moveMax {
							lockedAddr = c.Addr
							cur = cp
							moveN = 1
							fmt.Printf("  [lock] 走动仲裁 → 改用候选 0x%X (%.1f, %.1f, %.1f)\n",
								lockedAddr, cur[0], cur[1], cur[2])
							break
						}
					}
				}
			}
		}

		// 传送：只提示，地址照用（core_totk.go 同语义：零重扫接管）
		if hasPrev {
			if d := dist3(cur, prev); d >= warpDist {
				fmt.Printf("  [warp] 位移 %.0fm → (%.1f, %.1f, %.1f)（地址沿用）\n", d, cur[0], cur[1], cur[2])
			}
		}

		logTick(lockedAddr, cur, hd, hasH, verified, "player")
		onTick(cur, hd, hasH, verified, "player")
		prev = cur
		hasPrev = true
	}
}
