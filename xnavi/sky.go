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

// dataDir 返回进度/层级参考数据目录（totk_save_hashes.js、explore_save_map.js、
// area_sky.js、markers.js 等）。按实际布局顺序探测（2026-10-09 两次修复）：
//   1. exe 同目录 app/data（发布布局：release/TOTKNavi-vX.Y.Z/app/data，
//      为 app 目录 junction → TOTKmap/app/data；此前漏此路径导致 release 版
//      进度/映射表全部 0）
//   2. exe 上一级 app/data（开发布局：E:\WorkSpace\TOTKmap\app\data）——实际存在
//   3. exe 同目录 data（发布布局：release/TOTKNavi-vX.Y.Z/data）
//   4. exe 上一级 data（live-go 原布局：TOTKmap/data，备未来）
//   5. cwd 上级 app/data、cwd 上级 data（开发时从任意目录启动）
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
			filepath.Join(wd, "..", "app", "data"),
			filepath.Join(wd, "..", "data"),
		} {
			if dirExists(p) {
				return p
			}
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
