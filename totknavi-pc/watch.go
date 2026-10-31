// watch.go — 控制台追踪（--watch）。薄封装，逻辑全在 tracker.go 的 runTracker。

package main

import (
	"fmt"
	"time"
)

const watchPrintEvery = 500 * time.Millisecond

// watchRun 控制台实时输出坐标 + 朝向。
func watchRun(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr) {
	start := time.Now()
	var last [3]float32
	haveLast := false
	travel := 0.0
	lastPrint := time.Now().Add(-watchPrintEvery)

	fmt.Println("  ------------------------------------------------------------------")
	runTracker(p, plat, anchor, addr, func(pos [3]float32, hd float32, hasH, verified bool, src string) {
		if src == "lost" || src == "no-anchor" {
			if time.Since(lastPrint) >= watchPrintEvery {
				lastPrint = time.Now()
				fmt.Printf("  [%s] <%s>\n", time.Now().Format("15:04:05"), src)
			}
			return
		}
		// 累计实际走过的距离（传送/大跳不计入）
		if haveLast {
			if d := float64(dist3(pos, last)); d < warpDist {
				travel += d
			}
		}
		last = pos
		haveLast = true

		if time.Since(lastPrint) < watchPrintEvery {
			return
		}
		lastPrint = time.Now()
		hdStr := "朝向  --"
		if hasH {
			hdStr = fmt.Sprintf("朝向 %6.1f°", hd)
		}
		vStr := ""
		if verified {
			vStr = " ✓"
		}
		fmt.Printf("  [%s] X=%8.1f  Y=%8.1f  Z=%8.1f  %s%s  已走 %.0fm  运行 %s\n",
			time.Now().Format("15:04:05"),
			pos[0], pos[1], pos[2], hdStr, vStr, travel,
			time.Since(start).Truncate(time.Second))
	})
}
