// sky.go — TOTK 层级判定（天空 20 / 地上 18 / 地底 19）。
//
// 与 Python live-python/server.py 的 layer_of 完全同口径：
//   - 解析 data/area_sky.js（64 个大岛多边形）与 data/markers.js（layer=20 标记点）；
//   - gz<0 → 地底；gz≥900 → 天空（地面最高约 650）；多边形命中 → 天空；
//     gz≥300 且 600 内存在天空标记 → 天空；其余 → 地上。
//
// data 目录位于 exe 的上一级（TOTKmap/data/），开发时 cwd=live-go，均可用
// ../data 解析。

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
)

type skyPoly struct {
	Rings       [][][2]float64
	Xmin, Xmax  float64
	Ymin, Ymax  float64
}

var (
	skyPolys    []skyPoly
	skyMarkers  [][2]float64 // (x, y)
	skyDataInit bool
)

func dataDir() string {
	wd, err := os.Getwd()
	if err == nil {
		if fi, e := os.Stat(filepath.Join(wd, "..", "data")); e == nil && fi.IsDir() {
			return filepath.Join(wd, "..", "data")
		}
	}
	exe, err := os.Executable()
	if err == nil {
		// 发布包布局：data 与 exe 同级（release\TOTKNavi-x\data\）
		if fi, e := os.Stat(filepath.Join(filepath.Dir(exe), "data")); e == nil && fi.IsDir() {
			return filepath.Join(filepath.Dir(exe), "data")
		}
		// 开发布局：data 在 exe 上级（engine\..\data）
		if fi, e := os.Stat(filepath.Join(filepath.Dir(exe), "..", "data")); e == nil && fi.IsDir() {
			return filepath.Join(filepath.Dir(exe), "..", "data")
		}
	}
	return "data"
}

// extractJSON 用正则从 JS 文件提取 window.X = [...] / var X = {...} 的 JSON 文本。
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

	// area_sky.js: window.TOTK_AREA_SKY=[{group, rings:[[[x,y],...]]}]
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

	// markers.js: window.TOTK_MARKERS=[{id,layer,cat,name,x,y,...}]
	if buf, err := os.ReadFile(filepath.Join(dir, "markers.js")); err == nil {
		js := string(buf)
		body := extractJSON(js, `window\.TOTK_MARKERS\s*=\s*(\[.*?\]);`)
		if body != "" {
			var mks []struct {
				Layer int     `json:"layer"`
				X     float64 `json:"x"`
				Y     float64 `json:"y"`
			}
			if json.Unmarshal([]byte(body), &mks) == nil {
				for _, m := range mks {
					if m.Layer == 20 {
						skyMarkers = append(skyMarkers, [2]float64{m.X, m.Y})
					}
				}
			}
		}
	}
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

func nearSkyMarker(x, y, rad float64) bool {
	if len(skyMarkers) == 0 {
		return false
	}
	r2 := rad * rad
	for _, m := range skyMarkers {
		dx, dy := m[0]-x, m[1]-y
		if dx*dx+dy*dy <= r2 {
			return true
		}
	}
	return false
}

// layerOf 玩家位置 (gx=X东, gy=Y北, gz=真实高度) → 数据层。
func layerOf(gx, gy, gz float32) int {
	if gz < 0.0 {
		return 19 // 地底：海平面 0 以下
	}
	if gz >= 900.0 {
		return 20 // 高空必然天空（地面最高约 650）
	}
	if inSkyPoly(float64(gx), float64(gy)) {
		return 20
	}
	if gz >= 300.0 && nearSkyMarker(float64(gx), float64(gy), 600.0) {
		return 20
	}
	return 18
}
