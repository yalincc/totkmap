// shrine_entrances.go — TOTK 神庙入口坐标表（v3.4）。
//
// 数据：xnavi/data/shrine_entrances.json（app 地图数据 + romfs 交叉验证，152 神庙：
// cat=63 地表 120 + cat=109 天空 32；90 座与 romfs 入口 0.0m 级互证）。
// 用途（2026-10-24 用户拍板方案）：
//   - 进庙双条件判定：①入口匹配（进庙前一帧距入口 <30m，必要判据）
//     ②本地尺度信号（isShrineScale，量级骤降确认）——入口匹配防深穴/原点区域误判
//   - 传送目的地命名（传送到神庙 X）
// 坐标口径：表项 wx=X(东), wz=Z(北), wy=海拔(部分项)；玩家 hud (gx, gy)：
//   水平距离 = sqrt((gx-wx)^2 + ((-gy)-wz)^2)（伊修达古恩验证：2.73m vs 真机 2.4m）
//
// 加载失败不致命：进庙入口匹配禁用（只记"本地尺度无入口匹配"日志，不钉、不误判）。

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
)

// shrineEntrance 单座神庙入口（与 shrine_entrances.json 字段对应）。
type shrineEntrance struct {
	Name  string   `json:"name"`
	Cat   int      `json:"cat"`
	Layer int      `json:"layer"`
	WX    float32  `json:"wx"` // X 东
	WY    *float32 `json:"wy"` // 海拔（部分项 None）
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

// shrineMatchRadius 入口匹配半径（用户拍板：30m）。取最近入口，<30m 判定匹配。
const shrineMatchRadius = 30.0

// loadShrineEntrances 加载入口表（可执行文件目录 data/ → 回退 cwd data/）。
func loadShrineEntrances() {
	var paths []string
	if exe, err := os.Executable(); err == nil {
		paths = append(paths, filepath.Join(filepath.Dir(exe), "data", "shrine_entrances.json"))
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
		if err := json.Unmarshal(b, &f); err != nil {
			continue
		}
		if len(f.Entrances) == 0 {
			continue
		}
		shrineMu.Lock()
		shrineList = f.Entrances
		shrineLoaded = true
		shrineMu.Unlock()
		fmt.Printf("  [shrine-table] 神庙入口坐标表已加载（%d 座，%s）/ Shrine entrance table loaded (%d)\n", len(f.Entrances), p, len(f.Entrances))
		return
	}
	fmt.Println("  [shrine-table] 警告：神庙入口坐标表加载失败（data/shrine_entrances.json），进庙入口匹配不可用")
}

// nearestShrine 返回玩家 hud 坐标水平最近的神庙入口；< shrineMatchRadius 时返回名字。
func nearestShrine(pos [3]float32) (name string, dist float32) {
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
