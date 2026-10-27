// sky.go — TOTK 层级判定（天空 20 / 地上 18 / 地底 19）。
//
// 2026-10-27 重构：
//   - 引入官方精简高度图与天空栅格数据 (heightmap_downsampled.bin，58.6KB)
//   - 四级漏斗判定体系：
//     1. gz >= 400m（天空交叠区）：200m 天空栅格命中 OR 离地 dG > 400m OR 3D 最近 marker 为天空 → 20
//     2. gz <= -150m（地底交叠区）：离地底地形 dU < 150m OR 3D 最近 marker 为地底 OR gz < -250m → 19
//     3. 安全带 (-150m < gz < 400m)：普通地表、井底（最低-99m）、绝大多数洞穴稳稳归为地上 18（彻底解决进洞下井误切 Bug！）

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
)

type skyPoly struct {
	Rings      [][][2]float64
	Xmin, Xmax float64
	Ymin, Ymax float64
}

type marker3D struct {
	X, Z, H float32
	Layer   int
}

var (
	skyPolys         []skyPoly
	allMarkers3D     []marker3D
	heightmapLoaded  bool
	heightmapDataG   [100 * 120]int16
	heightmapDataU   [100 * 120]int16
	heightmapDataS0  [50 * 60]int16
	heightmapDataS1  [50 * 60]int16
	skyDataInit      bool
)

const (
	hmX0     = -6000.0
	hmZ0     = -5000.0
	hmNoData = -9999
)

func dataDir() string {
	dirExists := func(p string) bool {
		fi, e := os.Stat(p)
		return e == nil && fi.IsDir()
	}
	exe, err := os.Executable()
	if err == nil {
		exeDir := filepath.Dir(exe)
		for _, p := range []string{
			filepath.Join(exeDir, "app", "data"),
			filepath.Join(exeDir, "..", "app", "data"),
			filepath.Join(exeDir, "data"),
			filepath.Join(exeDir, "..", "data"),
		} {
			if dirExists(p) {
				return p
			}
		}
	}
	if wd, err := os.Getwd(); err == nil {
		for _, p := range []string{
			filepath.Join(wd, "app", "data"),
			filepath.Join(wd, "..", "app", "data"),
			filepath.Join(wd, "data"),
			filepath.Join(wd, "..", "data"),
		} {
			if dirExists(p) {
				return p
			}
		}
	}
	return "data"
}

func extractJSON(text, pattern string) string {
	re := regexp.MustCompile(pattern)
	m := re.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	return m[1]
}

func loadSkyData() {
	if skyDataInit {
		return
	}
	skyDataInit = true
	dir := dataDir()

	// 1. 加载精简高度图 heightmap_downsampled.bin (58.66 KB)
	hmPath := filepath.Join(dir, "heightmap_downsampled.bin")
	if buf, err := os.ReadFile(hmPath); err == nil && len(buf) >= 60064 {
		if string(buf[:8]) == "TOTKHM01" {
			r := bytes.NewReader(buf[64:])
			_ = binary.Read(r, binary.LittleEndian, &heightmapDataG)
			_ = binary.Read(r, binary.LittleEndian, &heightmapDataU)
			_ = binary.Read(r, binary.LittleEndian, &heightmapDataS0)
			_ = binary.Read(r, binary.LittleEndian, &heightmapDataS1)
			heightmapLoaded = true
		}
	}

	// 2. area_sky.js: window.TOTK_AREA_SKY=[{group, rings:[[[x,y],...]]}]
	if buf, err := os.ReadFile(filepath.Join(dir, "area_sky.js")); err == nil {
		js := string(buf)
		body := extractJSON(js, `window\.TOTK_AREA_SKY\s*=\s*(\[.*?\]);`)
		if body != "" {
			var polys []struct {
				Rings [][][2]float64 `json:"rings"`
			}
			if json.Unmarshal([]byte(body), &polys) == nil {
				for _, p := range polys {
					sp := skyPoly{Rings: p.Rings}
					sp.Xmin, sp.Xmax, sp.Ymin, sp.Ymax = 1e18, -1e18, 1e18, -1e18
					for _, r := range p.Rings {
						for _, pt := range r {
							if pt[0] < sp.Xmin {
								sp.Xmin = pt[0]
							}
							if pt[0] > sp.Xmax {
								sp.Xmax = pt[0]
							}
							if pt[1] < sp.Ymin {
								sp.Ymin = pt[1]
							}
							if pt[1] > sp.Ymax {
								sp.Ymax = pt[1]
							}
						}
					}
					skyPolys = append(skyPolys, sp)
				}
			}
		}
	}

	// 3. markers.js: 全量三维标点注入 (注意: m.x=世界Z北为负, m.y=世界X东为正, m.z=高度)
	if buf, err := os.ReadFile(filepath.Join(dir, "markers.js")); err == nil {
		js := string(buf)
		body := extractJSON(js, `window\.TOTK_MARKERS\s*=\s*(\[.*?\]);`)
		if body != "" {
			var mks []struct {
				Layer int      `json:"layer"`
				X     float64  `json:"x"`
				Y     float64  `json:"y"`
				Z     *float64 `json:"z"`
			}
			if json.Unmarshal([]byte(body), &mks) == nil {
				for _, m := range mks {
					h := float32(0)
					if m.Z != nil {
						h = float32(*m.Z)
					}
					allMarkers3D = append(allMarkers3D, marker3D{
						X:     float32(m.Y), // 真实 X (东为正)
						Z:     float32(m.X), // 真实 Z (北为负)
						H:     h,
						Layer: m.Layer,
					})
				}
			}
		}
	}
}

func sampleHeightmap(wx, wz float32) (gVal, uVal, sMin, sMax int16, valid bool) {
	if !heightmapLoaded {
		return hmNoData, hmNoData, hmNoData, hmNoData, false
	}
	col100 := int((wx - hmX0) / 100.0)
	row100 := int((wz - hmZ0) / 100.0)
	gVal = hmNoData
	uVal = hmNoData
	if col100 >= 0 && col100 < 120 && row100 >= 0 && row100 < 100 {
		idx := row100*120 + col100
		gVal = heightmapDataG[idx]
		uVal = heightmapDataU[idx]
	}

	col200 := int((wx - hmX0) / 200.0)
	row200 := int((wz - hmZ0) / 200.0)
	sMin = hmNoData
	sMax = hmNoData
	if col200 >= 0 && col200 < 60 && row200 >= 0 && row200 < 50 {
		idx := row200*60 + col200
		sMin = heightmapDataS0[idx]
		sMax = heightmapDataS1[idx]
	}

	return gVal, uVal, sMin, sMax, true
}

func nearestMarker3D(wx, wz, h float32) (bestLayer int, bestDist float32) {
	if len(allMarkers3D) == 0 {
		return 18, 99999.0
	}
	var bestD2 float32 = 1e18
	bestLayer = 18
	for i := range allMarkers3D {
		m := &allMarkers3D[i]
		dx := m.X - wx
		dz := m.Z - wz
		dh := m.H - h
		d2 := dx*dx + dz*dz + dh*dh
		if d2 < bestD2 {
			bestD2 = d2
			bestLayer = m.Layer
		}
	}
	return bestLayer, float32(math.Sqrt(float64(bestD2)))
}

// pip 射线法：点在多边形内。
func pip(x, y float64, pts [][2]float64) bool {
	inside := false
	j := len(pts) - 1
	for i := 0; i < len(pts); i++ {
		xi, yi := pts[i][0], pts[i][1]
		xj, yj := pts[j][0], pts[j][1]
		if ((yi > y) != (yj > y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi) {
			inside = !inside
		}
		j = i
	}
	return inside
}

func inSkyPoly(x, y float64) bool {
	if len(skyPolys) == 0 {
		return false
	}
	for _, p := range skyPolys {
		if x < p.Xmin || x > p.Xmax || y < p.Ymin || y > p.Ymax {
			continue
		}
		for _, r := range p.Rings {
			if pip(x, y, r) {
				return true
			}
		}
	}
	return false
}

// layerOf 玩家位置 (gx=X东, gy=Y北, gz=真实高度) → 数据层 (18地上 / 19地底 / 20天空)。
func layerOf(gx, gy, gz float32) int {
	loadSkyData()

	wx := gx  // 游戏世界 X (东为正)
	wz := -gy // 游戏世界 Z (北为负)
	h := gz   // 真实高度

	gVal, uVal, sMin, sMax, hasHM := sampleHeightmap(wx, wz)

	// 1. 天空交叠区 (h >= 400.0)
	if h >= 400.0 {
		// A. 命中 200m 天空栅格区间 [sMin - 150, sMax + 300]
		if hasHM && sMin != hmNoData && (float32(sMin)-150.0 <= h && h <= float32(sMax)+300.0) {
			return 20
		}
		// B. 离地高度 dG > 400 (高空滑翔 / 跳伞)
		if hasHM && gVal != hmNoData && (h-float32(gVal) > 400.0) {
			return 20
		}
		// C. 3D 最近 marker 属于天空 (距离 <= 300m)
		bestLayer, bestDist := nearestMarker3D(wx, wz, h)
		if bestDist <= 300.0 && bestLayer == 20 {
			return 20
		}
		// D. 兜底保留：历史空岛多边形判定 (如果 polygon 命中且 h >= 400)
		if inSkyPoly(float64(wx), float64(gy)) {
			return 20
		}
		return 18
	}

	// 2. 地底交叠区 (h <= -150.0)
	if h <= -150.0 {
		// A. U 层高度图有效且 dU < 150 (紧贴地底地形)
		if hasHM && uVal != hmNoData && (h-float32(uVal) < 150.0) {
			return 19
		}
		// B. 3D 最近 marker 属于地底 (距离 <= 300m)
		bestLayer, bestDist := nearestMarker3D(wx, wz, h)
		if bestDist <= 300.0 && bestLayer == 19 {
			return 19
		}
		// C. 极深绝对兜底
		if h < -250.0 {
			return 19
		}
		return 18
	}

	// 3. 安全带 (-150 < h < 400): 普通地表、井底 (最低-99m)、绝大多数洞穴
	// 额外保护：如果离地底地形非常近 (dU < 100) 且有 U 高度图有效
	if hasHM && uVal != hmNoData && (h-float32(uVal) < 100.0) {
		return 19
	}

	return 18
}
