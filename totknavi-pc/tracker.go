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
	"math"
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

	// 移动确认阈值（水平与垂直解耦）：
	// 水平方向：慢走 0.1m/拍 ~ 跑步/滑翔 8.0m/拍（时速 288km/h，包容地面跑动、风弹、滑翔伞）
	// 垂直方向：鸟望台冲天弹射/高空俯冲单拍可达数十米，垂直上限放宽到 50.0m/拍
	moveMin  = 0.1
	moveHMax = 8.0
	moveVMax = 50.0

	// 锚点范围门禁：走动仲裁与候选锁定距初始锚点水平距离必须 <= 120m
	maxAnchorDist = 120.0

	// 传送判定：单拍水平位移超过此值视为传送/读档（core_totk.go 同值）
	warpDist = 50.0

	// 扫描窗口递进（对齐 core_totk.go：120 → 400 → 3000）
	scanRadius1 = 120.0
	scanRadius2 = 400.0
	scanRadius3 = 3000.0

	maxCands = 10 // 候选上限（移动确认用）
)

// dist2DHud HUD 序下的水平距离 (X, Y)
func dist2DHud(a, b [3]float32) float32 {
	dx, dy := a[0]-b[0], a[1]-b[1]
	return float32(math.Sqrt(float64(dx*dx + dy*dy)))
}

// isPhysicsMove 检查位移是否符合角色运动特征（水平与垂直解耦）：
// 水平位移在 [moveMin, moveHMax] 且垂直位移 <= moveVMax 为合法移动；
// 单拍水平位移 > moveHMax 的直接视为全图飞行的视锥体/射线噪声，坚决剔除。
func isPhysicsMove(cur, prev [3]float32) bool {
	dx, dy, dz := cur[0]-prev[0], cur[1]-prev[1], cur[2]-prev[2]
	dh := float32(math.Sqrt(float64(dx*dx + dy*dy)))
	dv := float32(math.Abs(float64(dz)))
	return dh >= moveMin && dh <= moveHMax && dv <= moveVMax
}

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

var (
	reqRescanChan = make(chan struct{}, 1)
	reqCoordChan  = make(chan [3]float32, 1)
)

// RequestRescan 请求重扫。
func RequestRescan() {
	select {
	case reqRescanChan <- struct{}{}:
	default:
	}
}

// RequestSetCoords 请求以给定 HUD 坐标校准重锁。
func RequestSetCoords(hud [3]float32) {
	select {
	case reqCoordChan <- hud:
	default:
	}
}

// runTracker 追踪主循环（阻塞，直到 Ctrl+C 或调用方退出）。
func runTracker(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr, onTick tickFn) {
	h := p.Handle()

	lockedAddr := addr
	var cands []ptkHit
	verified := addr != 0
	moveN := 0
	lostTicks := 0
	stallTicks := 0
	huntFails := 0
	var lastHunt time.Time
	var prev [3]float32
	hasPrev := false
	var prevPrev [3]float32
	hasPrevPrev := false
	oscCount := 0

	usingStaticChain := false
	var mainBase uintptr
	if plat != nil {
		mainBase = plat.MainBase()
	}

	// 神庙副本锁定（Shrine Hold）状态
	shrineMode := false
	var shrineEntrance [3]float32
	var shrineName string

	if lockedAddr == 0 {
		// ① 主路径：静态指针链直读秒锁（零扫描、无需存档锚点，开局秒锁）
		if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
			lockedAddr = sAddr
			verified = true
			usingStaticChain = true
			pstate.setGameStatus(true, p.PID(), lockedAddr)
			logEvent("  [lock] ★ [LEVEL-1 静态直读] 命中主模块静态真身指针链 0x%X，开局秒锁直读 (%.1f, %.1f, %.1f) · 载具飞行完美跟随", lockedAddr, sPos[0], sPos[1], sPos[2])
		} else {
			// ② 兜底路径：存档锚点滑动扫描
			var ok bool
			lockedAddr, cands, ok = scanForPlayer(p, plat, anchor)
			if !ok {
				logEvent("  [scan] 未命中 —— 请确认：① 已在 3D 世界中 ② 存档是最近 2 分钟内的")
				onTick([3]float32{}, 0, false, false, "no-anchor")
				pstate.setGameStatus(p.IsAlive(), p.PID(), 0)
			} else {
				pstate.setGameStatus(true, p.PID(), lockedAddr)
				if len(cands) > 0 && cands[0].Rot {
					verified = true
					logEvent("  [lock] ★ [LEVEL-2 扫描降级] 命中 28B 物理真身槽 0x%X (Run=%d) · 驾驶载具期间可能暂缓刷新", lockedAddr, cands[0].Run)
				} else {
					verified = false
					logEvent("  [lock] 候选 0x%X (LEVEL-2 扫描降级) —— 【请在游戏内移动一下角色以完成验证】", lockedAddr)
				}
			}
		}
	} else {
		pstate.setGameStatus(true, p.PID(), lockedAddr)
		logEvent("  [lock] 直接锁定指定地址 0x%X", lockedAddr)
	}

	tickCount := 0
	tick := time.NewTicker(tickInterval)
	defer tick.Stop()

	for {
		select {
		case <-reqRescanChan:
			fmt.Println("  [rescan] 收到重扫请求，正在重新探测...")
			if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
				lockedAddr = sAddr
				verified = true
				usingStaticChain = true
				lostTicks = 0
				moveN = 0
				cands = nil
				oscCount = 0
				pstate.setGameStatus(true, p.PID(), lockedAddr)
				pstate.bumpLock()
				pstate.bumpRescan()
				fmt.Printf("  [rescan] 静态指针重锁成功 → 0x%X (%.1f, %.1f, %.1f)\n", lockedAddr, sPos[0], sPos[1], sPos[2])
			} else {
				var ref *[3]float32
				if hasPrev {
					mem := [3]float32{prev[0], prev[2] + elevBias, -prev[1]}
					ref = &mem
				} else {
					ref = anchor
				}
				if newAddr, newCands, ok := scanForPlayer(p, plat, ref); ok {
					lockedAddr = newAddr
					cands = newCands
					usingStaticChain = false
					verified = len(newCands) > 0 && newCands[0].Rot
					moveN = 0
					lostTicks = 0
					oscCount = 0
					pstate.setGameStatus(true, p.PID(), lockedAddr)
					pstate.bumpLock()
					pstate.bumpRescan()
					fmt.Printf("  [rescan] 扫描重锁成功 → 0x%X\n", lockedAddr)
				}
			}
		case hud := <-reqCoordChan:
			fmt.Printf("  [coords] 收到手动校准坐标 (%.1f, %.1f, %.1f)，立即校准...\n", hud[0], hud[1], hud[2])
			if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk && dist3(sPos, hud) < 5.0 {
				lockedAddr = sAddr
				usingStaticChain = true
				verified = true
				moveN = 0
				lostTicks = 0
				oscCount = 0
				cands = nil
				pstate.setGameStatus(true, p.PID(), lockedAddr)
				pstate.bumpLock()
				logEvent("  [coords] ★ 手动校准成功直通 [LEVEL-1 黄金真身] -> 0x%X (MK2/载具飞行完美跟随)", sAddr)
				continue
			}
			mem := [3]float32{hud[0], hud[2] + elevBias, -hud[1]}
			if newAddr, newCands, ok := scanForPlayer(p, plat, &mem); ok {
				lockedAddr = newAddr
				cands = newCands
				usingStaticChain = false
				// 严格门禁：只有 Run>=4 的长队列真身才直接 verified，否则必须走移动确认，避免锁死在鸟望台等静态槽上
				verified = len(newCands) > 0 && newCands[0].Rot
				moveN = 0
				lostTicks = 0
				oscCount = 0
				pstate.setGameStatus(true, p.PID(), lockedAddr)
				pstate.bumpLock()
				logEvent("  [coords] 📍 [LEVEL-3 手动校准] 校准成功 → 0x%X (verified=%v)", lockedAddr, verified)
			}
		case <-tick.C:
			if !isProcessAlive(h) {
				logEvent("  [game] 检测到游戏已退出，定位已停止。请重新启动游戏后再运行定位。")
				pstate.setGameStatus(false, 0, 0)
				onTick([3]float32{}, 0, false, false, "disconnected")
				return
			}
			var pos [3]float32
			var ok bool
			if usingStaticChain {
				pos, lockedAddr, ok = ptkReadStaticChain(h, mainBase)
				if ok {
					verified = true
				}
			} else {
				pos, _, _, ok = readWithRetry(h, lockedAddr)
				if ok {
					tickCount++
					if tickCount%10 == 0 {
						if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
							if dist3(sPos, pos) < 3.0 {
								usingStaticChain = true
								lockedAddr = sAddr
								verified = true
								cands = nil
								logEvent("  [upgrade] ★ 恭喜！当前位置与主模块静态指针完全对齐，成功升阶至 [LEVEL-1 黄金真身] 0x%X！(载具飞行/MK2全面激活)", sAddr)
							}
						}
					}
				}
			}
			if !ok {
				lostTicks++
				if shrineMode {
					// 庙内过图/黑屏：保持神庙入口
					onTick(shrineEntrance, 0, false, true, "shrine")
					continue
				}
				if lostTicks == 1 {
					logEvent("  [hold] 读不到角色数据（过图/传送中属正常现象，正在保持上一帧）")
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

			lostTicks = 0
			cur := pos

			// ① 神庙副本锁定判定（Shrine Hold）
			isShrine := isShrineScale(cur)
			if shrineMode {
				curShrineName, _ := nearestShrine(cur)
				curTowerName, _ := nearestTower(cur)
				if !isShrine || dist3(cur, shrineEntrance) < 35.0 || curShrineName != "" || curTowerName != "" {
					// 出庙：脱离神庙本地微小尺度，或回到大世界神庙门口，或传送到其他地标
					shrineMode = false
					logEvent("  [shrine] 离开神庙试炼场 -> 恢复大世界追踪 (%.1f, %.1f, %.1f)", cur[0], cur[1], cur[2])
					logTick(lockedAddr, cur, 0, false, verified, "player")
					onTick(cur, 0, false, verified, "player")
					prev = cur
					hasPrev = true
					continue
				}
				// 还在神庙内：死锁保护，对外坐标死死钉在神庙大门入口！
				logTick(lockedAddr, shrineEntrance, 0, false, true, "shrine")
				onTick(shrineEntrance, 0, false, true, "shrine")
				continue
			} else if isShrine && hasPrev && dist3(cur, prev) > 100.0 {
				if sName, _ := nearestShrine(prev); sName != "" {
					curShrine, _ := nearestShrine(cur)
					curTower, _ := nearestTower(cur)
					if curShrine == "" && curTower == "" {
						// 进庙：进入前 prev 在大世界某神庙门口（<30m），当前跳入神庙内部本地坐标，且当前非大世界原点附近的鸟望台/神庙
						shrineMode = true
						shrineEntrance = prev
						shrineName = sName
						logEvent("  [shrine] 进入神庙 [%s] -> 锁定大门入口 (%.1f, %.1f, %.1f)",
							shrineName, shrineEntrance[0], shrineEntrance[1], shrineEntrance[2])
						logTick(lockedAddr, shrineEntrance, 0, false, true, "shrine")
						onTick(shrineEntrance, 0, false, true, "shrine")
						continue
					}
				}
			}

			// ② 移动确认（水平与垂直解耦）
			if !verified {
				if hasPrev && isPhysicsMove(cur, prev) {
					moveN++
					stallTicks = 0
					if moveN >= 3 {
						verified = true
						cands = nil
						fmt.Printf("  [lock] 移动确认成功 → 真身锁定 0x%X (%.1f, %.1f, %.1f)\n",
							lockedAddr, cur[0], cur[1], cur[2])
					}
				} else {
					moveN = 0
					// 静止判定：候选槽连续不动，可能是存档残影/静态副本，而非玩家真身
					if hasPrev && dist3(cur, prev) < 0.05 {
						stallTicks++
					} else {
						stallTicks = 0
					}
					if hasPrev && len(cands) > 0 {
						for _, c := range cands {
							if c.Addr == lockedAddr {
								continue
							}
							cp, _, _, cok := ptkReadSlot(h, c.Addr)
							if !cok {
								continue
							}
							// 门禁 1：距初始锚点水平距离必须 <= 120m！绝不锁定超出范围的物体
							if anchor != nil {
								ancHud := [3]float32{anchor[0], -anchor[2], anchor[1] - elevBias}
								if dist2DHud(cp, ancHud) > maxAnchorDist {
									continue
								}
							}
							// 门禁 2：解耦运动特征（水平 <= 8m/拍，垂直 <= 50m/拍）
							if isPhysicsMove(cp, hudOf(c)) {
								lockedAddr = c.Addr
								cur = cp
								moveN = 1
								stallTicks = 0
								fmt.Printf("  [lock] 走动仲裁 → 改用候选 0x%X (%.1f, %.1f, %.1f)\n",
									lockedAddr, cur[0], cur[1], cur[2])
								break
							}
						}
					}
				}
			}

			// ②.5 卡死自愈：候选持续静止 1.5s，且没有可仲裁的候选 → 判定锁错，
			// 启动"移动搜寻"（两次全范围差分），把真正在动的玩家槽找回来。
			// 玩家站着不动时差分同样无命中，不会误锁，只是安静退避。
			if !verified && stallTicks >= 15 {
				cool := 3 * time.Second
				if huntFails >= 3 {
					cool = 15 * time.Second
				}
				if time.Since(lastHunt) >= cool {
					lastHunt = time.Now()
					logEvent("  [hunt] 候选 0x%X 连续 1.5s 静止，疑似存档残影/静态副本，启动移动搜寻...", lockedAddr)
					if newAddr, newPos, ok := huntMoving(p); ok {
						lockedAddr = newAddr
						cands = nil
						usingStaticChain = false
						moveN = 0
						verified = false
						stallTicks = 0
						huntFails = 0
						pstate.setGameStatus(true, p.PID(), lockedAddr)
						pstate.bumpLock()
						logEvent("  [hunt] 找到移动槽 0x%X hud=(%.1f, %.1f, %.1f)，等待移动确认", newAddr, newPos[0], newPos[1], newPos[2])
						prev = newPos
						hasPrev = true
						onTick(newPos, 0, false, false, "scan")
						continue
					}
					huntFails++
					logEvent("  [hunt] 未找到移动槽（角色未移动或仍在读取），稍后重试")
				}
			}

			// 传送与读档：单拍水平位移 >= 50m 判定为传送
			if hasPrev {
				if dH := dist2DHud(cur, prev); dH >= warpDist {
					// 乒乓振荡检测：连续两拍位移超大，且当前坐标跳回前前拍附近（在两点间反复横跳）
					if !usingStaticChain && hasPrevPrev && dist2DHud(cur, prevPrev) < 10.0 {
						oscCount++
						if oscCount >= 2 {
							logEvent("  [warp] 检测到坐标在两点间反复振荡（错锁交替复用槽），丢弃坏地址 0x%X，自动自愈重锁...", lockedAddr)
							oscCount = 0
							moveN = 0
							verified = false
							lockedAddr = 0
							usingStaticChain = false
							RequestRescan()
							if hasPrev {
								onTick(prev, 0, false, false, "hold")
							}
							continue
						}
					} else {
						oscCount = 0
						logEvent("  [warp] 传送/瞬移 %.0fm → (%.1f, %.1f, %.1f)（地址沿用）", dH, cur[0], cur[1], cur[2])
					}
					moveN = 0 // 发生瞬移坚决重置移动验证！
				} else {
					oscCount = 0
				}
			}

			// 减法：朝向由前端 live.js 原生位移平滑推算，后端不输出抽搐的内存矩阵朝向
			srcTag := "scan"
			if usingStaticChain {
				srcTag = "chain"
			}
			logTick(lockedAddr, cur, 0, false, verified, srcTag)
			onTick(cur, 0, false, verified, srcTag)
			prevPrev = prev
			hasPrevPrev = hasPrev
			prev = cur
			hasPrev = true
		}
	}
}
