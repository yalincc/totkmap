// shrine.go — TOTK 神庙入口坐标表与神庙副本挂起（Shrine Hold）
// 
// TOTK 神庙为独立副本空间，进入神庙后林克坐标会切换到以神庙内部为原点的本地坐标系 (|X|<400, |Y|<400, |Z|<800)。
// 若无神庙入口锁定，坐标会瞬间漂移到大世界原点（海拉鲁城堡/监视堡垒）附近。
// 规则：
// 1. 进庙识别：上一帧在某神庙门口 (<30m)，当前帧坐标跳入神庙本地微小尺度，且当前非大世界地标 → 触发 shrineMode，红点死死钉在神庙门口。
// 2. 出庙恢复：脱离微小尺度，或回到神庙大世界门口，或传送到鸟望台/其他神庙 → 解除 shrineMode，恢复大世界跟踪。

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
)

type shrineEntrance struct {
	Name  string   `json:"name"`
	Cat   int      `json:"cat"`
	Layer int      `json:"layer"`
	WX    float32  `json:"wx"` // X 东
	WY    *float32 `json:"wy"` // 海拔
	WZ    float32  `json:"wz"` // Z 北
}

type shrineEntrancesFile struct {
	Entrances []shrineEntrance `json:"entrances"`
}

var (
	shrineMu     sync.RWMutex
	shrineList   []shrineEntrance
	shrineLoaded bool
)

const shrineMatchRadius = 30.0

// loadShrineEntrances 加载神庙入口表
func loadShrineEntrances() {
	var paths []string
	dDir := dataDir()
	if dDir != "" {
		paths = append(paths, filepath.Join(dDir, "shrine_entrances.json"))
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		paths = append(paths,
			filepath.Join(dir, "data", "shrine_entrances.json"),
			filepath.Join(dir, "..", "data", "shrine_entrances.json"),
			filepath.Join(dir, "..", "app", "data", "shrine_entrances.json"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		paths = append(paths, filepath.Join(wd, "data", "shrine_entrances.json"))
	}

	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var f shrineEntrancesFile
		if err := json.Unmarshal(b, &f); err != nil || len(f.Entrances) == 0 {
			continue
		}
		shrineMu.Lock()
		shrineList = f.Entrances
		shrineLoaded = true
		shrineMu.Unlock()
		fmt.Printf("  [shrine-table] 神庙入口坐标表已加载（%d 座，%s）\n", len(f.Entrances), p)
		return
	}
	fmt.Println("  [shrine-table] 警告：神庙入口坐标表加载失败，进庙入口锁定不可用")
}

// nearestShrine 返回玩家 HUD 坐标水平最近的神庙入口；< shrineMatchRadius 时返回名字与距离
func nearestShrine(pos [3]float32) (string, float32) {
	shrineMu.RLock()
	defer shrineMu.RUnlock()
	if !shrineLoaded {
		return "", 0
	}
	best := float32(math.MaxFloat32)
	bname := ""
	for _, e := range shrineList {
		dx := pos[0] - e.WX
		dz := -pos[1] - e.WZ // hud gy = -Y北 → Y北 = -gy = Z北
		d := float32(math.Sqrt(float64(dx*dx + dz*dz)))
		if d < best {
			best = d
			bname = e.Name
		}
	}
	if best < shrineMatchRadius {
		return bname, best
	}
	return "", best
}

// 15 座鸟望台官方坐标（HUD 坐标：X 东西，Y 南北）
var towerList = []struct {
	Name string
	X    float32
	Y    float32
}{
	{"拉贝拉湿地带鸟望台", 2420.00, -2754.89},
	{"拉聂尔山鸟望台", 3847.64, -1314.91},
	{"撒哈斯拉平原鸟望台", 1341.11, -1177.86},
	{"泡泡拉高地鸟望台", 604.84, -2126.88},
	{"格鲁德峡谷鸟望台", -2438.85, -2182.76},
	{"格鲁德高地鸟望台", -3960.88, -1305.60},
	{"海拉鲁平原鸟望台", -761.28, -1019.23},
	{"监视堡垒鸟望台", -298.85, 142.85},
	{"卓拉台地鸟望台", 2866.06, 581.19},
	{"乌尔利山鸟望台", 3499.00, 2026.00},
	{"奥尔汀峡谷鸟望台", 1641.81, 1190.82},
	{"德依布朗遗迹鸟望台", 343.67, 3141.65},
	{"拉布拉山鸟望台", -1909.59, 1245.30},
	{"茨茨齐齐雪原鸟望台", -2311.49, 3062.49},
	{"卡尔加玲鸟望台", -3679.58, 2346.40},
}

// nearestTower 匹配最近鸟望台（半径 60m）
func nearestTower(pos [3]float32) (string, float32) {
	best := float32(math.MaxFloat32)
	bname := ""
	for _, t := range towerList {
		dx := pos[0] - t.X
		dy := pos[1] - t.Y
		d := float32(math.Sqrt(float64(dx*dx + dy*dy)))
		if d < best {
			best = d
			bname = t.Name
		}
	}
	if best < 60.0 {
		return bname, best
	}
	return "", best
}

// isShrineScale 判断是否落入神庙内部微小尺度
func isShrineScale(pos [3]float32) bool {
	return math.Abs(float64(pos[0])) < 400.0 &&
		math.Abs(float64(pos[1])) < 400.0 &&
		math.Abs(float64(pos[2])) < 800.0
}

