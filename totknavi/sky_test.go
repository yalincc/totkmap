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

	// 5. 格鲁德雪山高海拔攀爬 (X=-3900, Z=1200, gz=650 -> gx=-3900, gy=-1200, gz=650)
	// 原 Bug: 爬雪山未到山顶误切天空 20；修复后必须稳定留在地上 18
	l5 := layerOf(-3900, -1200, 650)
	if l5 != 18 {
		t.Errorf("Gerudo snow mountain climbing (gz=650) expected 18, got %d", l5)
	}

	// 6. 海布拉雪山高海拔攀爬 (X=-3500, Z=-3100, gz=550 -> gx=-3500, gy=3100, gz=550)
	l6 := layerOf(-3500, 3100, 550)
	if l6 != 18 {
		t.Errorf("Hebra snow mountain climbing (gz=550) expected 18, got %d", l6)
	}
}

