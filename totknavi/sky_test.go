package main

import (
	"testing"
)

func TestLayerOf(t *testing.T) {
	loadSkyData()
	if !heightmapLoaded {
		t.Logf("Warning: heightmap_downsampled.bin not loaded (check path)")
	} else {
		t.Logf("heightmap_downsampled.bin loaded successfully")
	}

	// 1. 普通海拉鲁平原 (监视堡垒附近: X=-250, Z=-150 -> gx=-250, gy=150, gz=120)
	l1 := layerOf(-250, 150, 120)
	if l1 != 18 {
		t.Errorf("Surface plain expected 18, got %d", l1)
	}

	// 2. 井底测试 (负海拔: X=-250, Z=-150, gz=-95.0 -> gx=-250, gy=150, gz=-95)
	l2 := layerOf(-250, 150, -95)
	if l2 != 18 {
		t.Errorf("Well bottom (gz=-95) expected 18, got %d (BUG REGRESSION!)", l2)
	}

	// 3. 地底中央大废矿 (X=-800, Z=1900, gz=-480 -> gx=-800, gy=-1900, gz=-480)
	l3 := layerOf(-800, -1900, -480)
	if l3 != 19 {
		t.Errorf("Depths mine expected 19, got %d", l3)
	}

	// 4. 天空初始空岛 (X=450, Z=1400, gz=1500 -> gx=450, gy=-1400, gz=1500)
	l4 := layerOf(450, -1400, 1500)
	if l4 != 20 {
		t.Errorf("Sky island expected 20, got %d", l4)
	}
}

