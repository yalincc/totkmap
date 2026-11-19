// save_anchor_test.go — 存档锚点合理性过滤的单元测试。

package main

import (
	"encoding/binary"
	"testing"
	"time"
)

func buildMockCaption(year, month, day, hour, minute, second uint32) []byte {
	buf := make([]byte, 0x1c0)
	binary.LittleEndian.PutUint32(buf[0:4], captionMagic)
	binary.LittleEndian.PutUint32(buf[8:12], 0x1c0)
	entries := [][2]uint32{
		{hashSaveSecond, second},
		{hashSaveYear, year},
		{hashSaveMinute, minute},
		{hashSaveHour, hour},
		{hashSaveMonth, month},
		{hashSaveDay, day},
	}
	off := captionTableStart
	for _, e := range entries {
		binary.LittleEndian.PutUint32(buf[off:off+4], e[0])
		binary.LittleEndian.PutUint32(buf[off+4:off+8], e[1])
		off += 8
	}
	return buf
}

func TestParseCaptionSaveTime(t *testing.T) {
	t.Run("valid caption timestamp", func(t *testing.T) {
		got, ok := parseCaptionSaveTime(buildMockCaption(2026, 11, 17, 21, 25, 57))
		if !ok {
			t.Fatalf("expected ok=true")
		}
		want := time.Date(2026, 11, 17, 21, 25, 57, 0, time.Local)
		if !got.Equal(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("invalid magic rejected", func(t *testing.T) {
		buf := buildMockCaption(2026, 11, 17, 21, 25, 57)
		buf[0] = 0
		if _, ok := parseCaptionSaveTime(buf); ok {
			t.Fatalf("expected ok=false for bad magic")
		}
	})

	t.Run("out-of-range date rejected", func(t *testing.T) {
		if _, ok := parseCaptionSaveTime(buildMockCaption(1999, 13, 32, 0, 0, 0)); ok {
			t.Fatalf("expected ok=false for invalid date")
		}
	})
}

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
