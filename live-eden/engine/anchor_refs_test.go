package main

import "testing"

// 2026-10-04 场景切换实验真实数据：
// slot_00 玩家门口 (709.3,1690.3,1380.9)；slot_05 神庙本地坐标 (56.4,-11.9,-42.7)。
func TestAnchorRefsCluster(t *testing.T) {
	anchors := []*SaveAnchor{
		{Path: `G:\YUZU\eden\user\nand\user\save\...\slot_00\progress.sav`, Pos: [3]float32{709.3, 1690.3, 1380.9}},
		{Path: `G:\YUZU\eden\user\nand\user\save\...\slot_01\progress.sav`, Pos: [3]float32{563.2, 1574.3, 1677.5}},
		{Path: `G:\YUZU\eden\user\nand\user\save\...\slot_02\progress.sav`, Pos: [3]float32{778.2, 1611.3, 1376.7}},
		{Path: `G:\YUZU\eden\user\nand\user\save\...\slot_03\progress.sav`, Pos: [3]float32{765.9, 1648.1, 1463.0}},
		{Path: `G:\YUZU\eden\user\nand\user\save\...\slot_05\progress.sav`, Pos: [3]float32{56.4, -11.9, -42.7}}, // 神庙坐标，必须剔除
	}
	refs := anchorRefs(anchors, 8, 4.0)
	// slot_01 (563,1574,1677) 距 slot_00 约 217m < 800m → 保留；slot_05 距 1603m → 剔除
	if len(refs) != 4 {
		t.Fatalf("want 4 refs (shrine dropped), got %d: %v", len(refs), refs)
	}
	for _, r := range refs {
		if abs32(r[0]-56.4) < 1 && abs32(r[1]+11.9) < 1 && abs32(r[2]+42.7) < 1 {
			t.Fatalf("shrine coord leaked into refs: %v", r)
		}
	}
}

// 无 slot_00 时退化为最大簇：2 个大地图点 + 1 个神庙点 → 只保留大地图簇。
func TestAnchorRefsNoSlot00(t *testing.T) {
	anchors := []*SaveAnchor{
		{Path: `...\slot_01\progress.sav`, Pos: [3]float32{563.2, 1574.3, 1677.5}},
		{Path: `...\slot_02\progress.sav`, Pos: [3]float32{778.2, 1611.3, 1376.7}},
		{Path: `...\slot_05\progress.sav`, Pos: [3]float32{56.4, -11.9, -42.7}},
	}
	refs := anchorRefs(anchors, 8, 4.0)
	if len(refs) != 2 {
		t.Fatalf("want 2 refs (largest cluster), got %d: %v", len(refs), refs)
	}
}

// 玩家在神庙内：slot_00 本身是神庙坐标（无污染风险，窗口=神庙本地窗口）。
func TestAnchorRefsShrineAuth(t *testing.T) {
	anchors := []*SaveAnchor{
		{Path: `...\slot_00\progress.sav`, Pos: [3]float32{56.4, -11.9, -42.7}}, // slot_00 神庙坐标
		{Path: `...\slot_01\progress.sav`, Pos: [3]float32{709.3, 1690.3, 1380.9}}, // 历史大地图
	}
	refs := anchorRefs(anchors, 8, 4.0)
	if len(refs) != 1 {
		t.Fatalf("want 1 ref (only shrine auth), got %d: %v", len(refs), refs)
	}
}

// junkGroup：2026-10-04 探针实测占位组 vs 玩家组（内存序 X, Z_stored, Y_north）。
func TestJunkGroup(t *testing.T) {
	cases := []struct {
		g    *Group
		want bool
		desc string
	}{
		{&Group{Copies: 110311, Struct: 0, X: -24.22, Y: -24.22, Z: -24.22}, true, "-24.22 同值占位池"},
		{&Group{Copies: 89415, Struct: 0, X: 8, Y: 8, Z: 8}, true, "8 同值占位"},
		{&Group{Copies: 15162, Struct: 0, X: 80, Y: 100, Z: 1}, true, "北轴近零占位 (80,100,1)"},
		{&Group{Copies: 20931, Struct: 0, X: 0, Y: 8, Z: 13.64}, true, "原点小值占位 (0,8,13.64) copies>18000"},
		{&Group{Copies: 15584, Struct: 1, X: 559.96, Y: 1552.85, Z: 1656.24}, false, "v5 玩家真槽 struct=1"},
		{&Group{Copies: 949, Struct: 3, X: 712.35, Y: 1689.88, Z: 1381.46}, false, "v6 玩家真槽 struct=3"},
		{&Group{Copies: 440, Struct: 0, X: 707.74, Y: 1691.69, Z: 1383.71}, false, "场景切换后玩家站桩 struct=0 copies=440"},
		{&Group{Copies: 3538, Struct: 0, X: 706.29, Y: 1694.70, Z: 1376.79}, false, "玩家站定整数坐标"},
	}
	for i, c := range cases {
		if got := junkGroup(c.g); got != c.want {
			t.Errorf("case %d [%s]: junkGroup(%+v) = %v, want %v", i, c.desc, c.g, got, c.want)
		}
	}
}
