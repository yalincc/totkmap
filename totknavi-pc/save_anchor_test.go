// save_anchor_test.go — 存档锚点合理性过滤的单元测试。

package main

import "testing"

func TestTotkSane(t *testing.T) {
	cases := []struct {
		name   string
		gx, gy float32
		gz     float32
		want   bool
	}{
		{"normal ground position", -1172.3, 2585.0, -83.9, true},
		{"normal sky position", 448, 1535, 1200, true},
		{"zero placeholder", 0, 0, -105, false},
		{"near-origin local space", 10, 10, -105, false},
		{"progress.sav placeholder", 32.3, 0, -105, true}, // 由调用方跳过 progress.sav，此处仅校验范围
		{"out of world x", 6001, 1000, 0, false},
		{"out of world y", 100, -6001, 0, false},
		{"out of world z", 100, 1000, -1400, false},
		{"x zero but valid north", 0, 1000, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := totkSane(tc.gx, tc.gy, tc.gz); got != tc.want {
				t.Fatalf("totkSane(%v, %v, %v) = %v, want %v", tc.gx, tc.gy, tc.gz, got, tc.want)
			}
		})
	}
}
