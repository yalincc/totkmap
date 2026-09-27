// savefile_totk.go — TOTK 存档锚点读取。
//
// 与 Python live-python/locate.py 的 read_save_triples 完全同口径：
//   - progress.sav 在固定偏移保存玩家坐标（两份副本），caption.sav 镜像一份；
//   - 存档存 (X_east, Z_stored, Y_north)，其中 Z_stored = 真实高度 + ELEV_BIAS(105)；
//     （注意：TOTK 第三轴是 +Y 北，与 BOTW 的 -Y 相反——不要取反！）
//   - 六个槽共用同一 mtime，按“位置去重”而不是信任 mtime 顺序。

package main

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"strings"
)

const (
	elevBias = 105.0
	// progress.sav 玩家坐标偏移（两份）；caption.sav 镜像偏移。验证于 1.2.1 / BID 9B4E43650501A4D4。
	progressOff1 = 0x532AC
	progressOff2 = 0x53324
	captionOff   = 0x1E0
)

func abs32(v float32) float32 {
	if v < 0 {
		return -v
	}
	return v
}

type SaveAnchor struct {
	Path string
	Pos  [3]float32 // 内存序 (X, Z_stored, Y_north)
}

func totkSaveRoot() string {
	appdata := os.Getenv("APPDATA")
	if appdata == "" {
		appdata = os.Getenv("USERPROFILE") + "\\AppData\\Roaming"
	}
	return filepath.Join(appdata, "Ryujinx", "bis", "user", "save")
}

// findTotkSaveFiles 递归找所有 progress.sav（含 caption.sav）。
func findTotkSaveFiles(root string) []string {
	var out []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			n := strings.ToLower(d.Name())
			if n == "progress.sav" || n == "caption.sav" {
				out = append(out, p)
			}
		}
		return nil
	})
	return out
}

func totkSane(gx, gy, gz float32) bool {
	return gx > -20000 && gx < 20000 && gy > -20000 && gy < 20000 &&
		gz > -2000 && gz < 5000 && (abs32(gx) > 1 || abs32(gy) > 1)
}

type cand struct {
	mt   int64
	path string
	pos  [3]float32
}

// readTotkAnchors 读所有存档锚点 → 内存序三元组，按位置去重（保留最新 mtime）。
func readTotkAnchors() []*SaveAnchor {
	var cands []cand
	seen := map[[3]int32]bool{}
	for _, p := range findTotkSaveFiles(totkSaveRoot()) {
		var offs []int
		n := strings.ToLower(filepath.Base(p))
		switch n {
		case "progress.sav":
			offs = []int{progressOff1, progressOff2}
		case "caption.sav":
			offs = []int{captionOff}
		default:
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		fi, _ := os.Stat(p)
		mt := int64(0)
		if fi != nil {
			mt = fi.ModTime().UnixNano()
		}
		for _, off := range offs {
			if off+12 > len(data) {
				continue
			}
			mx := math.Float32frombits(binary.LittleEndian.Uint32(data[off:]))
			mz := math.Float32frombits(binary.LittleEndian.Uint32(data[off+4:]))
			my := math.Float32frombits(binary.LittleEndian.Uint32(data[off+8:]))
			gx, gz, gy := mx, mz-elevBias, my
			if !totkSane(gx, gy, gz) {
				continue
			}
			mem := [3]float32{gx, mz, my} // 内存序 (X, Z_stored, Y_north)
			key := [3]int32{
				int32(math.Round(float64(gx) * 10)),
				int32(math.Round(float64(mz) * 10)),
				int32(math.Round(float64(my) * 10)),
			}
			if seen[key] {
				continue
			}
			seen[key] = true
			cands = append(cands, cand{mt, p, mem})
		}
	}
	// 优先 slot_00（用户实际使用的槽），其余按 mtime 降序。
	sortBySlot00ThenMtime(cands)
	var out []*SaveAnchor
	for _, c := range cands {
		out = append(out, &SaveAnchor{Path: c.path, Pos: c.pos})
	}
	return out
}

func sortBySlot00ThenMtime(cands []cand) {
	// 小集合冒泡：slot_00 优先，其次 mtime 降序。
	for i := 0; i < len(cands); i++ {
		for j := i + 1; j < len(cands); j++ {
			bi := slotRank(cands[i].path)
			bj := slotRank(cands[j].path)
			if bi > bj || (bi == bj && cands[i].mt < cands[j].mt) {
				cands[i], cands[j] = cands[j], cands[i]
			}
		}
	}
}

// slotRank: slot_00=0，其余槽=1（越小越优先）。
func slotRank(path string) int {
	if strings.Contains(path, "slot_00") {
		return 0
	}
	return 1
}

// anchorRefs 锚点去重合并（与 locate.py anchor_refs 同口径：merge=4 米内视为同一点）。
func anchorRefs(anchors []*SaveAnchor, limit int, merge float32) [][3]float32 {
	if limit <= 0 {
		limit = 8
	}
	if merge <= 0 {
		merge = 4.0
	}
	var out [][3]float32
	for _, a := range anchors {
		r := a.Pos
		dup := false
		for _, o := range out {
			if abs32(r[0]-o[0]) <= merge && abs32(r[1]-o[1]) <= merge && abs32(r[2]-o[2]) <= merge {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, r)
		}
		if len(out) >= limit {
			break
		}
	}
	return out
}
