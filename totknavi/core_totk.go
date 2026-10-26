// core_totk.go — TOTK 动力学根定位管道体（M1 第二步）。
//
// 单一管道体，平台差异（块枚举下限 / chain 快路径 / coords 接管 / 日志名）经
// trackerOpts 注入；watch_ryujinx.go / watch_eden.go 各自装配成独立 Tracker
// （D2：双管道物理隔离，见 docs/TOTKnavi-对齐xnavi架构-重构技术方案.md §M1）。
//
// 蓝本：BOTW xnavi v3.2.1 watch_ryujinx.go / watch_eden.go（两管道 90% 相同，
// 此处合并为参数化管道体，减少重复且一次实现双平台复用）。
//
// 管道语义（与蓝本完全一致）：
//   - UNLOCKED：以最新存档锚点为中心 120m 窗口扫描（Run>=2 真身门禁），
//     失败扩 400m / 3000m；无锚点等待存档（不扫）；Eden 扫描前先试指针链快路径
//   - LOCKED：死守 lockedAddr，过图黑屏平滑保持（hold），绝不随意掉锁；
//     走动仲裁（防驿站等多 NPC 误锁静止 NPC）、移动确认（moveN>=3 → verified）、
//     大传送（>300m）零重扫直接接管、神庙进出（isShrineScale）钉入口锚定、
//     模拟器断开 [lost]
//   - TOTK 特有：骑乘跟随（mount_totk.go：主槽骑乘标志时 decode 恒 nil →
//     mount.step 转坐骑坐标流；searching 期间保持上一帧位置）
//
// 坐标语义（TOTK 特有）：扫描命中返回内存序 (X, Z_stored, Y_north)，锁定后立即
// 转 hud 序 (X, -Y北, Z_stored-elevBias) 计算与发布（与 decode 输出同序）。
// 坐标校验统一 ptkCoordOK 宽松版（探针实机验证：不做 isWhole32 整数拒 /
// Z_stored 近零拒，Run>=2 结构门禁 + 锚点窗口过滤足以锁定真身）。
//
// 老路防御全部退役（D6 做减法）：probe 多组监听、冻结共识、known 30s 确认窗口、
// 传送判活/场景垃圾判定、静止确认、known 快路径与持久化。保留：coords 校准
// （Eden，/set-coords）、指针链快路径（Eden，扫描失败兜底）、骑乘跟随。

package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"
)

// candSlot 走动仲裁候选槽（坐标 hud 序，与 readTotkActor 输出同序）。
type candSlot struct {
	addr uintptr
	init [3]float32
	rot  bool
}

// trackerOpts 管道平台差异注入。
type trackerOpts struct {
	name     string  // 日志名（Ryujinx / Eden）
	srcScan  string  // 扫描锁定 source 标记（ryujinx-scan / eden-scan）
	blkMB    float64 // 块枚举下限（Ryujinx 256 / Eden 0.0625）
	chainOn  bool    // Eden：UNLOCKED 扫描前先试指针链快路径
	coordsOn bool    // Eden：tick 检查 coords 校准结果并接管
}

// readTotkActor 直接按小端读取 12 字节并经 ptkDecodeBytes（ptkCoordOK）校验 → hud 序（对齐 BOTW readEdenActor）。
func readTotkActor(h uintptr, addr uintptr) ([3]float32, bool) {
	v := ptkDecodeBytes(readMem(h, addr, 12))
	if v == nil {
		return [3]float32{}, false
	}
	return [3]float32{v[0], v[1], v[2]}, true
}

// runTotkPipeline 共用管道主循环（阻塞；ctx 取消 / stopCh 关闭即停）。
func runTotkPipeline(p Platform, opts trackerOpts, rescanCh chan *RescanRequest, stopCh chan struct{}, ctx context.Context) {
	fmt.Printf("  [pipeline] %s 追踪管道已启动 (动力学根 Run>=2 门禁 / 零重扫传送) / %s pipeline started (Run>=2 gate, warp zero-rescan)\n", opts.name, opts.name)

	tick := time.NewTicker(100 * time.Millisecond) // 10Hz
	defer tick.Stop()

	var lockedAddr uintptr
	var lockedIsRot bool
	var cur, prev [3]float32
	hasPrev := false
	verified := false
	moveN := 0
	shrineMode := false
	var shrineEntrance [3]float32
	var cands []candSlot

	lastScanAt := time.Time{}
	holdLogged := false
	lockSince := time.Time{}
	lastUnverifiedHint := time.Time{}

	reset := func(reason string) {
		lockedAddr = 0
		lockedIsRot = false
		hasPrev = false
		verified = false
		moveN = 0
		shrineMode = false
		cands = nil
		holdLogged = false
		lockSince = time.Time{}
		lastUnverifiedHint = time.Time{}
		goUnlocked(reason)
	}

	// scanNear 锚点窗口扫描：块枚举 → 并行 FindEdenTriples（锚点内存序窗口）→
	// Run>=2 真身门禁 → 分组打分 → 锁定 top1（内存序 → hud 序）。
	// 与 coords 校准共用 globalScanMu 互斥（避免双全量扫描竞争，scan_mutex.go）。
	scanNear := func(center [3]float32, radius float32) bool {
		h := p.Handle()
		blks := p.Blocks(opts.blkMB)
		if len(blks) == 0 {
			return false
		}
		if !globalScanMu.TryLock() {
			return false // coords 校准扫描进行中，跳过本轮
		}
		defer globalScanMu.Unlock()

		var allHits []ptkHit
		var mu sync.Mutex

		const chunk = 8 << 20
		const overlap = 256
		const sleepPerChunk = 4 * time.Millisecond
		workers := 4

		type scanJob struct {
			addr uintptr
			n    int
		}
		var jobs []scanJob
		for _, b := range blks {
			if b.Size == 0 {
				continue
			}
			for off := uintptr(0); off < b.Size; off += uintptr(chunk) {
				n := chunk
				if remain := int(b.Size - off); remain < n {
					n = remain
				}
				if uintptr(n) < b.Size-off {
					n += overlap
				}
				jobs = append(jobs, scanJob{b.Base + off, n})
			}
		}
		if len(jobs) == 0 {
			return false
		}

		ch := make(chan scanJob, workers*2)
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := range ch {
					buf := readMem(h, j.addr, j.n)
					time.Sleep(sleepPerChunk)
					if len(buf) < 12 {
						continue
					}
					hits := ptkFindEdenTriples(buf, j.addr, &center, radius)
					if len(hits) == 0 {
						continue
					}
					mu.Lock()
					allHits = append(allHits, hits...)
					mu.Unlock()
				}
			}()
		}
		for _, j := range jobs {
			ch <- j
		}
		close(ch)
		wg.Wait()

		// 门禁：Run >= 2 真身门禁（动力学 RingBuffer 专属特征，排除静态数据/外观槽）
		var identHits []ptkHit
		for _, hit := range allHits {
			if hit.Run >= 2 {
				identHits = append(identHits, hit)
			}
		}
		if len(identHits) == 0 {
			return false
		}

		groups := ptkGroupHits(identHits)
		if len(groups) == 0 {
			return false
		}

		best := groups[0]
		lockedAddr = best.Addr
		lockedIsRot = best.Rot
		// 内存序 (X, Z_stored, Y_north) → hud 序 (X, -Y北, Z_stored-elevBias)
		cur = [3]float32{best.P[0], -best.P[2], best.P[1] - elevBias}
		prev = cur
		hasPrev = true
		verified = false
		moveN = 0
		shrineMode = false
		holdLogged = false
		lockSince = time.Now()
		lastUnverifiedHint = time.Time{}

		nCand := len(groups)
		if nCand > 10 {
			nCand = 10
		}
		cands = make([]candSlot, nCand)
		for i := 0; i < nCand; i++ {
			g := groups[i]
			cands[i] = candSlot{
				addr: g.Addr,
				init: [3]float32{g.P[0], -g.P[2], g.P[1] - elevBias},
				rot:  g.Rot,
			}
		}

		setLock(lockedAddr, false, len(groups), opts.srcScan)
		publishState(true, cur[0], cur[1], cur[2], false, len(groups), opts.srcScan)
		fmt.Printf("  [verify] %s 捕获动力学候选地址 Addr: 0x%X hud=(%.1f, %.1f, %.1f) -> 【请在游戏内移动角色以完成验证】 / Candidate locked: 0x%X -> [Please move in-game to verify]\n",
			opts.name, lockedAddr, cur[0], cur[1], cur[2], lockedAddr)
		return true
	}

	for {
		select {
		case <-ctx.Done():
			fmt.Printf("  [pipeline] %s 追踪管道已停止 (上下文取消) / %s pipeline stopped (context cancelled)\n", opts.name, opts.name)
			return
		case <-stopCh:
			fmt.Printf("  [pipeline] %s 追踪管道已停止 (请求停止) / %s pipeline stopped (stop requested)\n", opts.name, opts.name)
			return
		case <-rescanCh:
			reset(opts.name + " /rescan requested")
		case <-tick.C:
			// 1. 确保模拟器附加
			if !p.Attach() {
				if lockedAddr != 0 {
					fmt.Printf("  [lost] %s 模拟器进程断开或退出 / %s emulator process exited or detached\n", opts.name, opts.name)
					reset(opts.name + " lost")
				} else {
					state.mu.Lock()
					state.ok = false
					state.source = "waiting for " + opts.name
					state.mu.Unlock()
				}
				continue
			}

			h := p.Handle()

			// 1.5) coords 校准结果接管（Eden 特有；GUI /set-coords 全 RAM 三轴精确匹配）
			if ep, ok := p.(*edenPlatform); ok && opts.coordsOn {
				if a, v, c, ok2 := ep.coordsPeek(); ok2 {
					lockedAddr = a
					cur = v
					prev = cur
					hasPrev = true
					verified = false
					moveN = 0
					shrineMode = false
					cands = nil
					holdLogged = false
					lockSince = time.Now()
					lastUnverifiedHint = time.Time{}
					setLock(a, false, c, "coords")
					fmt.Printf("  [lock] %s coords calibration -> lock 0x%X copies=%d hud=(%.1f, %.1f, %.1f) [pending move confirm]\n",
						opts.name, a, c, v[0], v[1], v[2])
					continue
				}
			}

			// 2. UNLOCKED：锚点窗口动态扫描（带 Run>=2 门禁）
			if lockedAddr == 0 {
				if time.Since(lastScanAt) < 1*time.Second {
					continue
				}
				lastScanAt = time.Now()

				// coords 搜索进行中，等结果（双扫描竞争浪费 10s+）
				if ep, ok := p.(*edenPlatform); ok && opts.coordsOn && ep.coordsBusy() {
					continue
				}

				// ★ 指针链快路径（Eden；Ryujinx 恒 off）：有上次读数作参考时，
				// 走固定偏移链零扫描重锁（跑动掉锁后毫秒级恢复）。失败静默回退扫描。
				if ep, ok := p.(*edenPlatform); ok && opts.chainOn {
					var refPos *[3]float32
					if hasPrev {
						refPos = &prev
					}
					if a, v, ok2 := ep.chainTry(h, refPos); ok2 {
						lockedAddr = a
						lockedIsRot = true
						cur = v
						prev = cur
						hasPrev = true
						verified = false
						moveN = 0
						shrineMode = false
						cands = nil
						holdLogged = false
						lockSince = time.Now()
						lastUnverifiedHint = time.Time{}
						setLock(a, false, 0, "chain")
						fmt.Printf("  [lock] %s chain -> lock 0x%X hud=(%.1f, %.1f, %.1f) [pending move confirm]\n",
							opts.name, a, v[0], v[1], v[2])
						continue
					}
				}

				// 存档锚点（对齐 BOTW xnavi v3.2.2：检查磁盘新鲜存档 ModTime<=120s 与行动指引日志）
				anchors := edenReadAnchorsCached()
				var latestSaveAnchor *SaveAnchor
				saveIsFresh := false
				if len(anchors) > 0 {
					latestSaveAnchor = anchors[0]
					if fi, err := os.Stat(latestSaveAnchor.Path); err == nil {
						if time.Since(fi.ModTime()) <= 120*time.Second {
							saveIsFresh = true
						}
					}
				}
				if latestSaveAnchor == nil {
					state.mu.Lock()
					state.ok = false
					state.source = "waiting for save anchor (press [+] in game)"
					state.mu.Unlock()
					continue
				}

				scanCenter := latestSaveAnchor.Pos // 内存序
				radius := float32(120.0)
				if saveIsFresh {
					fmt.Printf("  [scan] %s 发现新鲜存档 (<=120s)，扫描 120m 锚点窗口 (%.1f, %.1f, %.1f)... / Fresh save detected, scanning window 120m...\n",
						opts.name, scanCenter[0], scanCenter[1], scanCenter[2])
				} else {
					fmt.Printf("  [scan] %s 扫描存档锚点 120m 窗口 (%.1f, %.1f, %.1f)... / Scanning save anchor window 120m...\n",
						opts.name, scanCenter[0], scanCenter[1], scanCenter[2])
				}
				found := scanNear(scanCenter, radius)
				if !found {
					found = scanNear(scanCenter, 400.0)
				}
				if !found {
					found = scanNear(scanCenter, 3000.0)
				}
				if !found {
					fmt.Println("  [scan] " + opts.name + " 扫描未发现活动玩家 (等待进入 3D 游戏世界)... / No live player found (waiting for 3D world)...")
				}
				continue
			}

			// 3. LOCKED：死守 lockedAddr，过图黑屏平滑保持，落地直接接管，绝不主动掉锁
			d, ok := readTotkActor(h, lockedAddr)
			if !ok {
				for i := 0; i < 3; i++ {
					time.Sleep(30 * time.Millisecond)
					if d, ok = readTotkActor(h, lockedAddr); ok {
						break
					}
				}
			}

			// 读不到标准三元组（过图黑屏 / 场景切换过渡期 / 瞬态读空）
			if !ok {
				if shrineMode {
					// 神庙内黑屏或瞬态：死死钉在神庙入口
					publishState(true, shrineEntrance[0], shrineEntrance[1], shrineEntrance[2], true, 0, "shrine")
					continue
				}

				if !holdLogged {
					fmt.Printf("  [hold] %s reading transient/loading -> holding position\n", opts.name)
					holdLogged = true
				}
				if hasPrev {
					publishState(true, prev[0], prev[1], prev[2], verified, len(cands), "hold")
				}
				continue
			}

			// 读出合法世界坐标
			holdLogged = false
			cur = d
			isShrine := isShrineScale(cur)

			// 神庙内部试炼场本地尺度挂起（对齐 BOTW xnavi watch_eden.go / watch_ryujinx.go）
			if shrineMode {
				curShrineName, _ := nearestShrine(cur)
				curTowerName, _ := nearestTower(cur)
				if !isShrine || dist3(cur, shrineEntrance) < 35.0 || curShrineName != "" || curTowerName != "" {
					// 出庙：脱离神庙本地尺度，或回到神庙大世界门口（含地图中心 400m 内的神庙如巧诺尼希乌神庙），或传送到鸟望台，恢复大世界跟踪
					shrineMode = false
					destName := formatDestName(cur)
					fmt.Printf("  [shrine] %s 角色离开试炼场 -> 恢复大世界追踪 (%.1f, %.1f, %.1f) [%s] / Left shrine -> Resumed world tracking\n",
						opts.name, cur[0], cur[1], cur[2], destName)
					publishState(true, cur[0], cur[1], cur[2], verified, len(cands), "player")
					prev = cur
					hasPrev = true
					continue
				}
				// 还在神庙内：死锁保护，红点死死钉在神庙入口！
				publishState(true, shrineEntrance[0], shrineEntrance[1], shrineEntrance[2], true, 0, "shrine")
				continue
			} else if isShrine && hasPrev && dist3(cur, prev) > 100.0 {
				if shrineName, _ := nearestShrine(prev); shrineName != "" {
					curShrine, _ := nearestShrine(cur)
					curTower, _ := nearestTower(cur)
					if curShrine == "" && curTower == "" {
						// 进庙：进入前 prev 在神庙入口（<30m）且当前跳入神庙内部本地坐标，且当前未跳到鸟望台等大世界地标，红点钉在门口 prev
						shrineMode = true
						shrineEntrance = prev
						destName := "神庙: " + shrineName
						fmt.Printf("  [shrine] %s 角色进入试炼场 [%s] -> 锚定神庙入口 (%.1f, %.1f, %.1f) / Entered shrine [%s] -> Holding entrance\n",
							opts.name, destName, shrineEntrance[0], shrineEntrance[1], shrineEntrance[2], destName)
						publishState(true, shrineEntrance[0], shrineEntrance[1], shrineEntrance[2], true, 0, "shrine")
						continue
					}
				}
			}

			// 走动确认与多候选走动仲裁：优先确认当前主锁自身累计位移 >=0.5m；
			// 铁律：主锁若已命中 0x48 主模块持久槽（lockedIsRot=true），其地址跨场景永不销毁，
			// 严禁仲裁切换给易被清零的临时堆副槽（锁定即永久锁定）。
			if !verified && len(cands) > 0 {
				dSelf := dist3(cur, cands[0].init)
				if cands[0].addr == lockedAddr && dSelf >= 0.5 && dSelf < 150.0 {
					verified = true
					cands = nil
					setLock(lockedAddr, true, 1, opts.name+"-live")
					fmt.Printf("  [lock] %s 角色移动确认成功！真身锁定 Addr: 0x%X (%.1f, %.1f, %.1f) -> 【已完全锁定】 / Movement confirmed! Live actor locked at 0x%X -> [Fully locked]\n",
						opts.name, lockedAddr, cur[0], cur[1], cur[2], lockedAddr)
				} else if !lockedIsRot {
					for _, c := range cands {
						if c.addr == lockedAddr {
							continue
						}
						if cd, okCd := readTotkActor(h, c.addr); okCd {
							dCand := dist3(cd, c.init)
							if dCand >= 0.5 && dCand < 150.0 {
								lockedAddr = c.addr
								lockedIsRot = c.rot
								cur = cd
								verified = true
								cands = nil
								setLock(lockedAddr, true, 1, opts.name+"-move-confirm")
								fmt.Printf("  [lock] %s 走动仲裁成功！真身锁定 Addr: 0x%X (%.1f, %.1f, %.1f) -> 【已完全锁定】 / Movement arbitration confirmed! Locked at 0x%X -> [Fully locked]\n",
									opts.name, lockedAddr, cur[0], cur[1], cur[2], lockedAddr)
								break
							}
						}
					}
				}
			}

			delta := dist3(cur, prev)

			// 传送判定（>=50m，覆盖大传送与近距离传送如鸟望台/神庙相邻点，保持 addr 直读更新并输出地标日志）
			if hasPrev && delta >= 50.0 {
				shrineMode = false
				cands = nil
				destName := formatDestName(cur)
				fmt.Printf("  [warp] %s 角色传送 (距离=%.1fm) -> %s (%.1f, %.1f, %.1f) [零重扫接管] / Fast travel (dist=%.1fm) -> %s [Direct takeover]\n",
					opts.name, delta, destName, cur[0], cur[1], cur[2], delta, destName)
				publishState(true, cur[0], cur[1], cur[2], verified, 1, "player")
				prev = cur
				continue
			}

			// 正常跟随与移动确认
			if hasPrev && delta >= 0.5 {
				moveN++
				if moveN >= 3 && !verified {
					verified = true
					cands = nil
					setLock(lockedAddr, true, 1, opts.name+"-live")
					fmt.Printf("  [lock] %s 角色移动确认成功！真身锁定 Addr: 0x%X -> 【已完全锁定】 / Movement confirmed! Live actor locked at 0x%X -> [Fully locked]\n",
						opts.name, lockedAddr, lockedAddr)
				}
			} else {
				moveN = 0
			}

			// 提示机制：若锁定后持续未确认走动，友好提醒用户
			if !verified && time.Since(lockSince) > 6*time.Second && time.Since(lastUnverifiedHint) > 15*time.Second {
				lastUnverifiedHint = time.Now()
				fmt.Println("  [hint] 主角未确认走动 (verified=false)。请在游戏内走动几步 / Link movement not confirmed. Please move a few steps in-game")
			}

			publishState(true, cur[0], cur[1], cur[2], verified, len(cands), "player")
			prev = cur
			hasPrev = true
		}
	}
}
