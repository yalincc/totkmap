// find_test.go — 移动搜寻候选筛选的单元测试（纯函数，不依赖游戏进程）。

package main

import "testing"

func hit(addr uintptr, x, zs, yn float32) ptkHit {
	return ptkHit{Addr: addr, P: [3]float32{x, zs, yn}}
}

func anchor(x, zs, yn float32) *SaveAnchor {
	return &SaveAnchor{Pos: [3]float32{x, zs, yn}}
}

func TestSelectMovedCandidate(t *testing.T) {
	anc := []*SaveAnchor{anchor(-1069, 24, -2689)}

	t.Run("static candidate rejected", func(t *testing.T) {
		g1 := []ptkHit{hit(0x1000, -1069, 24, -2689)}
		g2 := []ptkHit{hit(0x1000, -1069, 24, -2689)}
		if _, ok := selectMovedCandidate(g1, g2, anc); ok {
			t.Fatal("静止候选不应被选中")
		}
	})

	t.Run("moving candidate near anchor selected", func(t *testing.T) {
		g1 := []ptkHit{hit(0x1000, -1069, 24, -2689)}
		g2 := []ptkHit{hit(0x1000, -1069, 26, -2689)}
		got, ok := selectMovedCandidate(g1, g2, anc)
		if !ok || got.Addr != 0x1000 {
			t.Fatalf("应选中 0x1000，实际 ok=%v addr=0x%X", ok, got.Addr)
		}
	})

	t.Run("local-space candidate rejected", func(t *testing.T) {
		// HUD 贴近原点：x=0，y=0
		g1 := []ptkHit{hit(0x2000, 0, 0, 0)}
		g2 := []ptkHit{hit(0x2000, 0, 1, 0)}
		if _, ok := selectMovedCandidate(g1, g2, anc); ok {
			t.Fatal("本地坐标候选不应被选中")
		}
	})

	t.Run("candidate far from all anchors rejected", func(t *testing.T) {
		g1 := []ptkHit{hit(0x3000, 3000, 24, -3000)}
		g2 := []ptkHit{hit(0x3000, 3000, 26, -3000)}
		if _, ok := selectMovedCandidate(g1, g2, anc); ok {
			t.Fatal("离存档点超过 300m 的候选不应被选中")
		}
	})

	t.Run("teleport jump rejected", func(t *testing.T) {
		g1 := []ptkHit{hit(0x4000, -1069, 24, -2689)}
		g2 := []ptkHit{hit(0x4000, -1059, 24, -2689)} // 10m/0.7s，超出合理步速
		if _, ok := selectMovedCandidate(g1, g2, anc); ok {
			t.Fatal("瞬移候选不应被选中")
		}
	})

	t.Run("prefer candidate closest to anchor", func(t *testing.T) {
		g1 := []ptkHit{
			hit(0x5000, -1069, 24, -2689), // 距锚点 0m
			hit(0x6000, -1069, 24, -2500), // 距锚点 ~189m
		}
		g2 := []ptkHit{
			hit(0x5000, -1069, 26, -2689),
			hit(0x6000, -1069, 26, -2500),
		}
		got, ok := selectMovedCandidate(g1, g2, anc)
		if !ok || got.Addr != 0x5000 {
			t.Fatalf("应优先选距锚点最近的 0x5000，实际 ok=%v addr=0x%X", ok, got.Addr)
		}
	})

	t.Run("no anchors keeps far candidate", func(t *testing.T) {
		g1 := []ptkHit{hit(0x7000, 3000, 24, -3000)}
		g2 := []ptkHit{hit(0x7000, 3000, 26, -3000)}
		got, ok := selectMovedCandidate(g1, g2, nil)
		if !ok || got.Addr != 0x7000 {
			t.Fatalf("没有锚点时不应按距离过滤，实际 ok=%v addr=0x%X", ok, got.Addr)
		}
	})
}
