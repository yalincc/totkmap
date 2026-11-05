// save_anchor.go — 存档锚点（PC 版）。
//
// 沿用 totknavi/savefile_totk.go 的固定偏移口径（1.2.1 验证）：
//   progress.sav 0x532AC 与 0x53324 各存一份玩家坐标，caption.sav 0x1E0 镜像一份。
//   存档存 (X_east, Z_stored, Y_north)，Z_stored = 真实高度 + elevBias(105)。
//
// PC 版差异（2026-10-31 实测）：路径是 <游戏目录>\profile\save\<账号hash>\slot_XX\，
// **没有 Switch 的标题 ID 段**，所以不能照搬"按 0100F2C0115B6000 过滤"的逻辑
// （那样会一条都匹配不到）。改为：默认信任 SaveRoots 给出的根，
// 靠 totkSane 坐标合理性 + 位置去重来兜底。

package main

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	progressOff1 = 0x532AC
	progressOff2 = 0x53324
	captionOff   = 0x1E0
)

type SaveAnchor struct {
	Path string
	Pos  [3]float32 // 内存序 (X, Z_stored, Y_north)
	Mod  time.Time
}

// totkSane 存档坐标合理性（HUD 序：gx 东 / gy 北 / gz 高）。
func totkSane(gx, gy, gz float32) bool {
	if math.IsNaN(float64(gx)) || math.IsNaN(float64(gy)) || math.IsNaN(float64(gz)) {
		return false
	}
	if gx <= -6000 || gx >= 6000 || gy <= -6000 || gy >= 6000 {
		return false
	}
	if gz <= -1300 || gz >= 3200 {
		return false
	}
	if gx == 0 && gy == 0 {
		return false
	}
	return true
}

// findTotkSaveFiles PC 版布局：直接收 progress.sav / caption.sav，不做标题 ID 过滤。
func findTotkSaveFiles(root string) []string {
	var out []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		n := strings.ToLower(d.Name())
		if n == "progress.sav" || n == "caption.sav" {
			out = append(out, p)
		}
		return nil
	})
	return out
}

// readAnchors 读全部存档锚点（按位置去重，slot_00 优先，其次 mtime 新）。
func readAnchors(p Platform) []*SaveAnchor {
	type candA struct {
		mt   time.Time
		path string
		pos  [3]float32
		slot int
	}
	var cands []candA
	seen := map[[3]int32]bool{}
	if p == nil {
		return nil
	}
	for _, root := range p.SaveRoots() {
		for _, path := range findTotkSaveFiles(root) {
			var offs []int
			switch strings.ToLower(filepath.Base(path)) {
			case "progress.sav":
				offs = []int{progressOff1, progressOff2}
			case "caption.sav":
				offs = []int{captionOff}
			default:
				continue
			}
			fi0, err := os.Stat(path)
			if err != nil {
				continue
			}
			mt0 := fi0.ModTime()
			data, err := readFileShared(path) // ★ 必须完全共享，否则会挡住游戏提交存档
			if err != nil {
				continue
			}
			// 防半写垃圾锚点：读后复查 mtime，变化 = 正在写入 → 跳过
			if fi1, err := os.Stat(path); err == nil && !fi1.ModTime().Equal(mt0) {
				continue
			}
			slot := 99
			if i := strings.Index(strings.ToLower(path), "slot_"); i >= 0 && i+7 <= len(path) {
				if v, err := strconv.Atoi(path[i+5 : i+7]); err == nil {
					slot = v
				}
			}
			for _, off := range offs {
				if off+12 > len(data) {
					continue
				}
				mx := math.Float32frombits(binary.LittleEndian.Uint32(data[off:]))
				mz := math.Float32frombits(binary.LittleEndian.Uint32(data[off+4:]))
				my := math.Float32frombits(binary.LittleEndian.Uint32(data[off+8:]))
				// 存档是 (X, Z_stored, Y_north)；totsSane 要 HUD 序 (gx, gy, gz)
				gx, gz, gy := mx, mz-elevBias, -my
				if !totkSane(gx, gy, gz) {
					continue
				}
				mem := [3]float32{gx, mz, my}
				key := [3]int32{
					int32(math.Round(float64(gx) * 10)),
					int32(math.Round(float64(mz) * 10)),
					int32(math.Round(float64(my) * 10)),
				}
				if seen[key] {
					continue
				}
				seen[key] = true
				cands = append(cands, candA{mt0, path, mem, slot})
			}
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		// mtime 修改时间最新降序优先（权威圆心），同刻写入时 slot_00 手动存档优先兜底
		if !cands[i].mt.Equal(cands[j].mt) {
			return cands[i].mt.After(cands[j].mt)
		}
		isManualI := cands[i].slot == 0
		isManualJ := cands[j].slot == 0
		if isManualI != isManualJ {
			return isManualI
		}
		return cands[i].slot < cands[j].slot
	})
	out := make([]*SaveAnchor, 0, len(cands))
	for _, c := range cands {
		out = append(out, &SaveAnchor{Path: c.path, Pos: c.pos, Mod: c.mt})
	}
	return out
}
