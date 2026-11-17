package main

import (
	"encoding/binary"
	"math"
	"testing"
)

func putF32(b []byte, off int, v float32) {
	binary.LittleEndian.PutUint32(b[off:], math.Float32bits(v))
}

func TestMatchCoordOffsets(t *testing.T) {
	// 目标 HUD 坐标 (-2573.7, 3352.1, 243.1) -> 内存序 (-2573.7, 348.1, -3352.1)
	targetHud := [3]float32{-2573.7, 3352.1, 243.1}
	memX := float32(-2573.7)
	memZs := float32(243.1) + elevBias
	memYn := float32(-3352.1)

	t.Run("actor offset preferred over 28B ring offset", func(t *testing.T) {
		buf := make([]byte, 0x100)
		// 0x10: 非 28B 队列的 Actor 坐标槽
		putF32(buf, 0x10, memX)
		putF32(buf, 0x14, memZs)
		putF32(buf, 0x18, memYn)

		// 0x80 & 0x80+28: 模拟 2 帧连续 28B 队列（含单位四元数 w=1）
		for _, base := range []int{0x80, 0x80 + ptkRing28Stride} {
			putF32(buf, base, memX)
			putF32(buf, base+4, memZs)
			putF32(buf, base+8, memYn)
			putF32(buf, base+24, 1.0)
		}

		actorOffs, ringOffs := matchCoordOffsets(buf, targetHud, 0.5)
		if len(actorOffs) != 1 || actorOffs[0] != 0x10 {
			t.Fatalf("actorOffs = %v, want [0x10]", actorOffs)
		}
		if len(ringOffs) == 0 {
			t.Fatalf("expected 28B ringOffs to be captured as fallback")
		}
	})

	t.Run("far coordinate rejected", func(t *testing.T) {
		buf := make([]byte, 0x40)
		putF32(buf, 0x10, memX+2.0)
		putF32(buf, 0x14, memZs)
		putF32(buf, 0x18, memYn)

		actorOffs, ringOffs := matchCoordOffsets(buf, targetHud, 0.5)
		if len(actorOffs) != 0 || len(ringOffs) != 0 {
			t.Fatalf("expected no match, got actor=%v ring=%v", actorOffs, ringOffs)
		}
	})
}
