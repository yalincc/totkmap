// watch.go — TOTK 统一分发调度器（Dispatcher，M1 第二步）。
//
// 对齐 BOTW xnavi v3.2.x watch.go：
//   - 识别运行中的模拟器（Ryujinx / Eden，auto 模式可自动切换）；
//   - 管理专属管道（RyujinxTracker / EdenTracker）生命周期
//     （300ms tick 探测，平台变化 → 停旧启新）；
//   - 统一分发 /rescan 请求与全局状态发布。
//
// 定位逻辑不在本文件：各平台管道经 core_totk.go 共用管道体自闭环
// （tracker.go 定义 Tracker 接口；watch_ryujinx.go / watch_eden.go 装配）。
//
// 老路退役（M1 第二步）：单一状态机（stateMachine v2.2.0）、locator 策略接口、
// known 快路径与持久化、冻结共识、probe 监听、块世代检测（detectNewBlocks /
// currentSessionBase / knownBlocks / guestRamBase 一并删除）。

package main

import (
	"context"
	"fmt"
	"time"
)

// createTrackerForPlatform 为给定平台创建专属管道。
func createTrackerForPlatform(p Platform) Tracker {
	if p == nil {
		return nil
	}
	switch p.Name() {
	case "Ryujinx":
		if rp, ok := p.(*ryujinxPlatform); ok {
			return NewRyujinxTracker(rp)
		}
	case "Eden":
		if ep, ok := p.(*edenPlatform); ok {
			return NewEdenTracker(ep)
		}
	}
	return nil
}

// stateMachine 统一调度分发器（main.go 以 goroutine 启动）。
func stateMachine() {
	fmt.Println("  [sm] dispatcher started, routing platforms to dedicated pipelines")

	var activeTracker Tracker
	var activeCancel context.CancelFunc
	var currentPlatName string

	stopActive := func() {
		if activeCancel != nil {
			activeCancel()
			activeCancel = nil
		}
		if activeTracker != nil {
			activeTracker.Stop()
			activeTracker = nil
		}
	}

	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()

	tickN := 0
	zeroBlockN := 0
	lastZeroProbe := time.Now()
	lastWaitLog := time.Time{}

	for {
		select {
		case req := <-rescanReqCh:
			if activeTracker != nil {
				activeTracker.Rescan(req)
			}
		case <-tick.C:
			tickN++

			// 1. 检查当前平台附加（auto 模式由 ensureAttach 自动切换平台）
			if !ensureAttach() {
				if activeTracker != nil {
					stopActive()
					currentPlatName = ""
					goUnlocked("emulator lost")
				}
				state.mu.Lock()
				state.ok = false
				state.source = "waiting for emulator"
				state.mu.Unlock()
				// 对齐 BOTW v3.2.2 诊断：模拟器未启动时每 10s 输出一次指路提示
				if time.Since(lastWaitLog) >= 10*time.Second {
					lastWaitLog = time.Now()
					fmt.Println("  [wait] 未检测到模拟器 —— 请先启动 Ryujinx/Eden 并进入游戏（10 秒后重试）/ No emulator detected — start Ryujinx/Eden and enter the game")
				}
				continue
			}

			p := currentPlatform()
			procPID = p.PID()

			// 2. 自动平台切换（--emu=auto）：当前平台无游戏内存块（游戏未加载/
			// 切换模拟器）持续 ~5s 且另有平台有块 → 切换（platformWithGame）。
			if autoPlatform && tickN%5 == 0 {
				if len(p.Blocks(256.0)) == 0 {
					if zeroBlockN < 5 {
						zeroBlockN++
					}
					if zeroBlockN >= 5 && time.Since(lastZeroProbe) >= 15*time.Second {
						lastZeroProbe = time.Now()
						if alt := platformWithGame(p); alt != nil {
							fmt.Printf("  [platform] %s 0 blocks for ~%ds, auto-switching to %s\n",
								p.Name(), zeroBlockN, alt.Name())
							setPlatform(alt)
							p = alt
							zeroBlockN = 0
							stopActive()
							currentPlatName = ""
							goUnlocked("platform auto-switched")
						}
					}
				} else {
					zeroBlockN = 0
				}
			}

			// 3. 管道实例化与生命周期管理
			platName := p.Name()
			if platName != currentPlatName || activeTracker == nil {
				stopActive()
				currentPlatName = platName
				tracker := createTrackerForPlatform(p)
				if tracker != nil {
					activeTracker = tracker
					var ctx context.Context
					ctx, activeCancel = context.WithCancel(context.Background())
					fmt.Printf("  [dispatcher] launching tracker pipeline: %s\n", tracker.Name())
					go tracker.Start(ctx)
				} else {
					fmt.Printf("  [dispatcher] no tracker found for platform: %s\n", platName)
				}
			}
		}
	}
}
