// tracker.go — PC 版追踪主循环（L1 静态直读优先 + 校准适配反算 L1 + 自动扩大扫描兜底）。

package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// posLog 逐拍日志（--log 开启）。用于事后分析漂移/跳变。
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

	// 移动确认阈值（水平与垂直解耦）
	moveMin  = 0.1
	moveHMax = 8.0
	moveVMax = 50.0

	// 锚点范围门禁：走动仲裁距初始锚点水平距离必须 <= 120m
	maxAnchorDist = 120.0

	// 传送判定：单拍水平位移超过此值视为传送/读档
	warpDist = 50.0

	// 扫描窗口递进
	scanRadius1 = 120.0
	scanRadius2 = 400.0
	scanRadius3 = 3000.0

	maxCands = 10
)

// dist2DHud HUD 序下的水平距离 (X, Y)
func dist2DHud(a, b [3]float32) float32 {
	dx, dy := a[0]-b[0], a[1]-b[1]
	return float32(math.Sqrt(float64(dx*dx + dy*dy)))
}

// isPhysicsMove 检查位移是否符合角色运动特征（水平与垂直解耦）。
func isPhysicsMove(cur, prev [3]float32) bool {
	dx, dy, dz := cur[0]-prev[0], cur[1]-prev[1], cur[2]-prev[2]
	dh := float32(math.Sqrt(float64(dx*dx + dy*dy)))
	dv := float32(math.Abs(float64(dz)))
	return dh >= moveMin && dh <= moveHMax && dv <= moveVMax
}

// tickFn 每拍回调。pos 为 HUD 序；source ∈ {chain, scan, hold, lost, no-anchor, shrine, disconnected}
type tickFn func(pos [3]float32, heading float32, hasHeading bool, verified bool, source string)

// hudOf ptkHit 的内存序坐标 → HUD 序。
func hudOf(h ptkHit) [3]float32 {
	return [3]float32{h.P[0], -h.P[2], h.P[1] - elevBias}
}

// readWithRetry 读槽，失败重试 failRetry 次（抗过图黑屏瞬态读空）。
func readWithRetry(h uintptr, addr uintptr) ([3]float32, float32, bool, bool) {
	if addr == 0 {
		return [3]float32{}, 0, false, false
	}
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
func scanForPlayer(p Platform, plat *totkpcPlatform, anchor *[3]float32) (uintptr, []ptkHit, bool) {
	blks := p.Blocks(0.0625)
	if len(blks) == 0 {
		return 0, nil, false
	}
	h := p.Handle()
	radii := []float32{scanRadius1, scanRadius2, scanRadius3}
	if anchor == nil {
		radii = []float32{0}
	}
	for _, radius := range radii {
		hits := ptkScanNear(h, blks, anchor, radius)
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

type deepScanReq struct {
	hasHUD bool
	hud    [3]float32
}

type pendingChainCand struct {
	entry    StaticChainEntry
	initPos  [3]float32
	prevPos  [3]float32
	lastAddr uintptr
	moveN    int
}

var (
	reqRescanChan   = make(chan struct{}, 1)
	reqCoordChan    = make(chan [3]float32, 1)
	reqDeepScanChan = make(chan deepScanReq, 1)
)

// RequestRescan 请求重扫。
func RequestRescan() {
	select {
	case reqRescanChan <- struct{}{}:
	default:
	}
}

// RequestDeepScan 请求「校准适配」（先直扫 L1 静态链，未命中自动扩大范围全进程扫描）。
func RequestDeepScan(hasHUD bool, hud [3]float32) {
	select {
	case reqDeepScanChan <- deepScanReq{hasHUD: hasHUD, hud: hud}:
	default:
	}
}

// RequestSetCoords 请求以给定 HUD 坐标校准重锁（PC 版统一走「校准适配」L1 反算主链路）。
func RequestSetCoords(hud [3]float32) {
	select {
	case reqCoordChan <- hud:
	default:
	}
}

// runTracker 追踪主循环（阻塞，直到进程退出）。
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
	guideLogged := false

	usingStaticChain := false
	var pendingChains []pendingChainCand
	var pendingChainDeadline time.Time
	var pendingFallbackAnchor *[3]float32

	var mainBase uintptr
	var exeSizeMB float64
	if plat != nil {
		mainBase = plat.MainBase()
		_, es := plat.ExeBase()
		exeSizeMB = float64(es) / 1048576.0
	}

	// 神庙副本锁定（Shrine Hold）状态
	shrineMode := false
	var shrineEntrance [3]float32
	var shrineName string

	// runDeepFallback 执行全进程扩大范围兜底扫描。
	runDeepFallback := func(ref *[3]float32) {
		if newAddr, newCands, ok := deepScanForPlayer(p, ref); ok {
			lockedAddr = newAddr
			cands = newCands
			usingStaticChain = false
			verified = len(newCands) > 0 && newCands[0].Rot
			moveN = 0
			lostTicks = 0
			oscCount = 0
			stallTicks = 0
			pstate.setGameStatus(true, p.PID(), lockedAddr)
			pstate.bumpLock()
			pstate.bumpRescan()
			if verified {
				prof := deepCalibrateAndSave(p, plat, lockedAddr)
				if prof != nil && len(prof.StaticChains) > 0 {
					if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
						usingStaticChain = true
						lockedAddr = sAddr
						pstate.setGameStatus(true, p.PID(), lockedAddr)
						logEvent("  [OK] ★ 校准适配成功！已切换 [L1 静态直读] (%.1f, %.1f, %.1f)，地图实时同步中", sPos[0], sPos[1], sPos[2])
						return
					}
				}
				logEvent("  [OK] ★ 扩大范围扫描已锁定真身 0x%X，地图实时同步中", lockedAddr)
			} else {
				logEvent("  [WAIT] 已找到候选位置，请切回游戏【走动 3 秒】以确认真身并保存配置...")
			}
		} else {
			logEvent("  [ERR] 校准未命中 —— 请确认：① 林克已在大世界（非神庙/菜单）② 填入的是游戏右下角实时坐标 X / Y / Z ③ 站稳后重试")
		}
	}

	// startCalibration 统一「校准适配」入口：优先 <0.3s 直扫主模块 L1 静态链 + 走动验证；未命中自动全进程扩大扫描兜底。
	startCalibration := func(hasHUD bool, hud [3]float32) {
		pendingChains = nil

		var targetHud [3]float32
		var hasTarget bool
		var tol float32 = 3.5
		var refMem *[3]float32

		if hasHUD {
			targetHud = hud
			hasTarget = true
			tol = 3.5
			mem := [3]float32{hud[0], hud[2] + elevBias, -hud[1]}
			refMem = &mem
			logEvent("  [WAIT] 正在按坐标 (%.1f, %.1f, %.1f) 适配当前版本 L1 指针链...", hud[0], hud[1], hud[2])
		} else if hasPrev && verified {
			targetHud = prev
			hasTarget = true
			tol = 2.0
			mem := [3]float32{prev[0], prev[2] + elevBias, -prev[1]}
			refMem = &mem
			logEvent("  [WAIT] 正在按当前位置 (%.1f, %.1f, %.1f) 适配本机 L1 指针链...", prev[0], prev[1], prev[2])
		} else if anchor != nil {
			targetHud = [3]float32{anchor[0], -anchor[2], anchor[1] - elevBias}
			hasTarget = true
			tol = 5.0
			refMem = anchor
			logEvent("  [WAIT] 正在按最新存档坐标 (%.1f, %.1f, %.1f) 适配当前版本 L1 指针链...", targetHud[0], targetHud[1], targetHud[2])
		} else {
			logEvent("  [WAIT] 未提供坐标且无存档锚点，直接启动全进程扩大范围扫描...")
		}

		if hasTarget && mainBase != 0 {
			rawChains := deepReverseStaticChainsByCoord(h, mainBase, targetHud, tol, deepScanCandChainCap)
			if len(rawChains) > 0 {
				var cList []pendingChainCand
				for _, entry := range rawChains {
					if pos, cAddr, ok := readStaticChainEntry(h, mainBase, entry); ok {
						cList = append(cList, pendingChainCand{
							entry:    entry,
							initPos:  pos,
							prevPos:  pos,
							lastAddr: cAddr,
						})
					}
				}
				if len(cList) > 0 {
					pendingChains = cList
					pendingChainDeadline = time.Now().Add(15 * time.Second)
					pendingFallbackAnchor = refMem
					logEvent("  [WAIT] 已匹配到 %d 条候选 L1 指针链，请切回游戏【走动 3 秒】完成验证（15 秒内未移动将自动扩大扫描）...", len(cList))
					return
				}
			}
			logEvent("  [INFO] 主模块静态链未直接命中，自动转为全进程扩大范围扫描...")
		}

		runDeepFallback(refMem)
	}

	if lockedAddr == 0 {
		// ① 主路径：静态指针链直读秒锁
		if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
			lockedAddr = sAddr
			verified = true
			usingStaticChain = true
			pstate.setGameStatus(true, p.PID(), lockedAddr)
			logEvent("  [OK] ★ 已锁定林克真身 [L1 静态直读] (%.1f, %.1f, %.1f)，网页地图实时同步中", sPos[0], sPos[1], sPos[2])
		} else {
			// ② 降级前直接给预期和解决步骤，不让用户干等猜测
			guideLogged = true
			logEvent("  [WARN] 未命中当前配置的 L1 偏移（当前镜像 %.1fMB），正在自动扫描（预计 3~5 秒）；若未锁定或位置有误，请在上方填入游戏右下角小地图 X/Y/Z，点击【校准适配】并走动 3 秒即可完成本版本一次性适配。", exeSizeMB)
			var ok bool
			lockedAddr, cands, ok = scanForPlayer(p, plat, anchor)
			if !ok {
				logEvent("  [WARN] 自动扫描未命中 —— 请确认已进入大世界 3D 画面，或直接在上方填入小地图 X/Y/Z 后点【校准适配】。")
				onTick([3]float32{}, 0, false, false, "no-anchor")
				pstate.setGameStatus(p.IsAlive(), p.PID(), 0)
			} else {
				pstate.setGameStatus(true, p.PID(), lockedAddr)
				if len(cands) > 0 && cands[0].Rot {
					verified = true
					logEvent("  [OK] ★ 自动扫描已锁定真身 0x%X，网页地图实时同步中", lockedAddr)
					// 后台静默反推一次 L1 并持久化
					if prof := deepCalibrateAndSave(p, plat, lockedAddr); prof != nil && len(prof.StaticChains) > 0 {
						if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
							usingStaticChain = true
							lockedAddr = sAddr
							pstate.setGameStatus(true, p.PID(), lockedAddr)
							logEvent("  [OK] ★ 已自动升阶至 [L1 静态直读] (%.1f, %.1f, %.1f)", sPos[0], sPos[1], sPos[2])
						}
					}
				} else {
					verified = false
					logEvent("  [WAIT] 已找到候选位置 0x%X，请切回游戏【走动几步】以确认真身（若无反应请使用上方【校准适配】）...", lockedAddr)
				}
			}
		}
	} else {
		pstate.setGameStatus(true, p.PID(), lockedAddr)
		logEvent("  [OK] 直接锁定指定地址 0x%X", lockedAddr)
	}

	tickCount := 0
	tick := time.NewTicker(tickInterval)
	defer tick.Stop()

	for {
		select {
		case <-reqRescanChan:
			logEvent("  [WAIT] 正在重新探测角色位置...")
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
				logEvent("  [OK] ★ 已重新锁定 [L1 静态直读] (%.1f, %.1f, %.1f)", sPos[0], sPos[1], sPos[2])
			} else {
				var ref *[3]float32
				if hasPrev && verified {
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
					if verified {
						logEvent("  [OK] ★ 重扫锁定真身 0x%X", lockedAddr)
					} else {
						logEvent("  [WAIT] 重扫命中候选 0x%X，请在游戏内【走动几步】确认...", lockedAddr)
					}
				} else {
					logEvent("  [WARN] 重扫未命中 —— 请填入游戏右下角小地图 X/Y/Z 后点击【校准适配】。")
				}
			}

		case dsReq := <-reqDeepScanChan:
			startCalibration(dsReq.hasHUD, dsReq.hud)

		case hud := <-reqCoordChan:
			startCalibration(true, hud)

		case <-tick.C:
			if !isProcessAlive(h) {
				logEvent("  [ERR] 检测到游戏已退出，定位已停止。请重新启动游戏后再开始定位。")
				pstate.setGameStatus(false, 0, 0)
				onTick([3]float32{}, 0, false, false, "disconnected")
				return
			}

			// 0. 若正在进行「候选 L1 指针链走动筛选」，优先推进验证
			if len(pendingChains) > 0 {
				var ready []pendingChainCand
				for i := range pendingChains {
					c := &pendingChains[i]
					curP, curA, ok := readStaticChainEntry(h, mainBase, c.entry)
					if !ok {
						continue
					}
					if isPhysicsMove(curP, c.prevPos) {
						c.moveN++
						c.lastAddr = curA
					}
					c.prevPos = curP
					if c.moveN >= 2 && dist3(curP, c.initPos) >= 0.8 && dist3(curP, c.initPos) <= 60.0 {
						ready = append(ready, *c)
					}
				}
				if len(ready) > 0 {
					// 收集所有真正随林克移动的候选链
					var confirmed []pendingChainCand
					for _, c := range pendingChains {
						if c.moveN >= 1 && dist3(c.prevPos, c.initPos) >= 0.5 && dist3(c.prevPos, c.initPos) <= 60.0 {
							confirmed = append(confirmed, c)
						}
					}
					sort.SliceStable(confirmed, func(i, j int) bool {
						return confirmed[i].moveN > confirmed[j].moveN
					})
					entries := make([]StaticChainEntry, 0, len(confirmed))
					for _, c := range confirmed {
						entries = append(entries, c.entry)
					}
					best := confirmed[0]
					pendingChains = nil
					usingStaticChain = true
					lockedAddr = best.lastAddr
					verified = true
					cands = nil
					lostTicks = 0
					stallTicks = 0
					oscCount = 0
					prev = best.prevPos
					hasPrev = true
					pstate.setGameStatus(true, p.PID(), lockedAddr)
					pstate.bumpLock()
					buildAndSaveLocalProfile(p, plat, best.lastAddr, entries)
					logEvent("  [OK] ★ 校准适配成功！已切换 [L1 静态直读] (%.1f, %.1f, %.1f)，网页地图实时同步中",
						best.prevPos[0], best.prevPos[1], best.prevPos[2])
					onTick(best.prevPos, 0, false, true, "chain")
					continue
				}
				if time.Now().After(pendingChainDeadline) {
					pendingChains = nil
					logEvent("  [WARN] 15 秒内未检测到候选 L1 链移动，自动转为全进程扩大范围扫描...")
					runDeepFallback(pendingFallbackAnchor)
					continue
				}
			}

			var pos [3]float32
			var ok bool
			if usingStaticChain {
				pos, lockedAddr, ok = ptkReadStaticChain(h, mainBase)
				if ok {
					verified = true
				}
			} else if lockedAddr != 0 {
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
								logEvent("  [OK] ★ 已自动升阶至 [L1 静态直读] (%.1f, %.1f, %.1f)", sPos[0], sPos[1], sPos[2])
							}
						}
					}
				}
			}

			if !ok {
				lostTicks++
				if shrineMode {
					onTick(shrineEntrance, 0, false, true, "shrine")
					continue
				}
				// 未验证的临时槽连续读空 1 秒 → 直接判定为坏缓存槽并静默丢弃，绝不刷屏 [hold]
				if !verified && lockedAddr != 0 && lostTicks >= 10 {
					lockedAddr = 0
					cands = nil
					hasPrev = false
					lostTicks = 0
					pstate.setGameStatus(true, p.PID(), 0)
					if !guideLogged {
						guideLogged = true
						logEvent("  [WARN] 候选地址不稳定（疑似临时缓存），请在上方填入游戏右下角小地图 X/Y/Z 后点击【校准适配】并走动 3 秒。")
					}
					onTick([3]float32{}, 0, false, false, "lost")
					continue
				}
				// 已验证真身槽过图/读取读空：仅首次提示 1 次，保持上一帧
				if verified && lostTicks == 1 {
					logEvent("  [INFO] 过图/读取中，暂保持上一帧位置...")
				}
				if hasPrev && verified {
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
					shrineMode = false
					logEvent("  [INFO] 离开神庙，恢复大世界追踪 (%.1f, %.1f, %.1f)", cur[0], cur[1], cur[2])
					logTick(lockedAddr, cur, 0, false, verified, "player")
					onTick(cur, 0, false, verified, "player")
					prev = cur
					hasPrev = true
					continue
				}
				logTick(lockedAddr, shrineEntrance, 0, false, true, "shrine")
				onTick(shrineEntrance, 0, false, true, "shrine")
				continue
			} else if isShrine && hasPrev && dist3(cur, prev) > 100.0 {
				if sName, _ := nearestShrine(prev); sName != "" {
					curShrine, _ := nearestShrine(cur)
					curTower, _ := nearestTower(cur)
					if curShrine == "" && curTower == "" {
						shrineMode = true
						shrineEntrance = prev
						shrineName = sName
						logEvent("  [INFO] 进入神庙 [%s]，大世界坐标锁定在入口 (%.1f, %.1f, %.1f)",
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
						logEvent("  [OK] ★ 移动验证通过！已锁定真身 (%.1f, %.1f, %.1f)，网页地图实时同步中",
							cur[0], cur[1], cur[2])
						// 非 L1 模式验证通过 → 自动反算一次 L1 指针链并持久化
						if !usingStaticChain {
							if prof := deepCalibrateAndSave(p, plat, lockedAddr); prof != nil && len(prof.StaticChains) > 0 {
								if sPos, sAddr, sOk := ptkReadStaticChain(h, mainBase); sOk {
									usingStaticChain = true
									lockedAddr = sAddr
									pstate.setGameStatus(true, p.PID(), lockedAddr)
									logEvent("  [OK] ★ 已自动升阶至 [L1 静态直读] (%.1f, %.1f, %.1f)", sPos[0], sPos[1], sPos[2])
								}
							}
						}
					}
				} else {
					moveN = 0
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
							if anchor != nil {
								ancHud := [3]float32{anchor[0], -anchor[2], anchor[1] - elevBias}
								if dist2DHud(cp, ancHud) > maxAnchorDist {
									continue
								}
							}
							if isPhysicsMove(cp, hudOf(c)) {
								lockedAddr = c.Addr
								cur = cp
								moveN = 1
								stallTicks = 0
								break
							}
						}
					}
				}
			}

			// ②.5 卡死自愈：候选持续静止 2s，静默触发一次移动搜寻（不刷屏）
			if !verified && stallTicks >= 20 {
				cool := 5 * time.Second
				if huntFails >= 2 {
					cool = 20 * time.Second
				}
				if time.Since(lastHunt) >= cool {
					lastHunt = time.Now()
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
						logEvent("  [WAIT] 已捕捉到移动角色 (%.1f, %.1f, %.1f)，请继续走动两步完成确认...", newPos[0], newPos[1], newPos[2])
						prev = newPos
						hasPrev = true
						onTick(newPos, 0, false, false, "scan")
						continue
					}
					huntFails++
					if huntFails == 2 && !guideLogged {
						guideLogged = true
						logEvent("  [WARN] 自动搜寻未找到移动真身 —— 请在上方填入游戏右下角小地图 X/Y/Z 后点击【校准适配】并走动 3 秒。")
					}
				}
			}

			// ③ 传送与振荡自愈
			if hasPrev {
				if dH := dist2DHud(cur, prev); dH >= warpDist {
					if !usingStaticChain && hasPrevPrev && dist2DHud(cur, prevPrev) < 10.0 {
						oscCount++
						if oscCount >= 2 {
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
						if verified {
							logEvent("  [INFO] 传送/瞬移 %.0fm → (%.1f, %.1f, %.1f)", dH, cur[0], cur[1], cur[2])
						}
					}
					moveN = 0
				} else {
					oscCount = 0
				}
			}

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
