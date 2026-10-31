// find.go — 变化检测定位（--find）。
//
// 解决的问题：PC 版玩家槽的地址每次扫描都不完全一样，而"离锚点最近"并不可靠
// （玩家从地图上读到的坐标和内存值常有几米偏差），"副本数最多"也不可靠
// （场景里存在 copies=20~32 的局部坐标表，x=0、高度恰好 -105）。
//
// 唯一不会骗人的特征：**玩家在走的时候，只有他那一个槽的坐标在持续变化**。
// 所以这里扫两次（中间留时间让玩家走动），只报告「同一地址、坐标变了」的候选。

package main

import (
	"fmt"
	"time"
)

// scanGroups 扫描 + 结构门禁 + 按坐标聚合，返回排序后的候选组。
func scanGroups(p Platform, plat *totkpcPlatform, blks []MemBlock, anchor *[3]float32) ([]ptkHit, bool) {
	hits := ptkScanNear(p.Handle(), blks, anchor, 0)
	var ident []ptkHit
	for _, x := range hits {
		if x.Run >= 2 {
			ident = append(ident, x)
		}
	}
	return ptkGroupHits(ident), true
}

// findMoving --find 主流程。
func findMoving(p Platform, plat *totkpcPlatform, anchor *[3]float32, gap time.Duration) {
	blks := p.Blocks(0.0625)
	if len(blks) == 0 {
		fmt.Println("  [find] 无可扫内存块，确认游戏是否在运行。")
		return
	}

	fmt.Println("  [find] 第 1 次扫描…（这一步请**站着别动**）")
	t0 := time.Now()
	g1, _ := scanGroups(p, plat, blks, anchor)
	fmt.Printf("  [find] 第 1 次完成：%d 组（%.2fs）\n", len(g1), time.Since(t0).Seconds())

	fmt.Printf("  [find] 现在请**走两步**（%v 后自动扫第 2 次）…\n", gap)
	time.Sleep(gap)

	fmt.Println("  [find] 第 2 次扫描…")
	t1 := time.Now()
	g2, _ := scanGroups(p, plat, blks, anchor)
	fmt.Printf("  [find] 第 2 次完成：%d 组（%.2fs）\n", len(g2), time.Since(t1).Seconds())

	// 按地址关联：同一地址在两次扫描里坐标变了 = 会动的对象
	prev := make(map[uintptr]ptkHit, len(g1))
	for _, g := range g1 {
		prev[g.Addr] = g
	}
	type mov struct {
		h    ptkHit
		dist float32
		from [3]float32
	}
	var moved []mov
	for _, g := range g2 {
		o, ok := prev[g.Addr]
		if !ok {
			continue
		}
		d := dist3(o.P, g.P)
		// 物理约束：人走路/跑步 3 秒最多约 40m；超过就是数值跳变或对象池复用（噪声），
		// 小于 0.5m 是站定或微小抖动。实测未过滤时 576 个"在动"，过滤后只剩个位数量级。
		if d <= 0.5 || d > 60 {
			continue
		}
		// 排除局部坐标系（神庙/物件内部空间）：x≈0 且高度≈0
		gz := g.P[1] - elevBias
		if abs32(g.P[0]) < 20 && abs32(gz) < 20 {
			continue
		}
		moved = append(moved, mov{h: g, dist: d, from: o.P})
	}

	fmt.Println()
	if len(moved) == 0 {
		fmt.Println("  [!] 没有检测到移动的槽。可能：")
		fmt.Println("      · 这两次扫描之间角色没移动（或移动幅度 <0.5m）")
		fmt.Println("      · 玩家槽在两轮之间换了地址（对象重建）")
		fmt.Println("      建议：确认走动后重试，或加大等待时间 --gap 5")
		return
	}

	// 排序：带朝向（完整变换槽）优先 → 副本多（玩家被多处引用）优先 → 位移大优先
	for i := 0; i < len(moved); i++ {
		for j := i + 1; j < len(moved); j++ {
			a, b := moved[i], moved[j]
			better := false
			if a.h.HasHeading != b.h.HasHeading {
				better = b.h.HasHeading
			} else if a.h.Copies != b.h.Copies {
				better = b.h.Copies > a.h.Copies
			} else {
				better = b.dist > a.dist
			}
			if better {
				moved[i], moved[j] = moved[j], moved[i]
			}
		}
	}

	fmt.Printf("  ★ 检测到 %d 个槽在合理移动（已过滤跳变/局部坐标）\n", len(moved))
	fmt.Println("  ------------------------------------------------------------------")
	n := len(moved)
	if n > 12 {
		n = 12
	}
	for i := 0; i < n; i++ {
		m := moved[i]
		hd := "--"
		if m.h.HasHeading {
			hd = fmt.Sprintf("%.1f°", m.h.Heading)
		}
		fmt.Printf("  #%-2d addr=0x%-12X 位移=%-7.1fm copies=%-3d 朝向=%-8s hud=(%.1f, %.1f, %.1f)\n",
			i+1, m.h.Addr, m.dist, m.h.Copies, hd,
			m.h.P[0], -m.h.P[2], m.h.P[1]-elevBias)
	}
	fmt.Println("  ------------------------------------------------------------------")
	if len(moved) > 0 {
		best := moved[0]
		fmt.Printf("\n  最可能是玩家：0x%X（位移最大 %.1fm，copies=%d）\n",
			best.h.Addr, best.dist, best.h.Copies)
		fmt.Printf("  直接追踪它：totknavi-pc.exe --watch --addr 0x%X\n", best.h.Addr)
		fmt.Printf("  或者起服务：totknavi-pc.exe --serve --addr 0x%X\n", best.h.Addr)
	}
}
