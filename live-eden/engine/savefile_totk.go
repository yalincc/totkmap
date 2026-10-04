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
	"time"
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

// totkTitleID 是《王国之泪》存档目录的标题 ID 段。Eden 的存档根下同时存在
// BOTW（01007EF00011E000）与 TOTK（0100F2C0115B6000）——扫描必须按标题 ID
// 过滤，否则 BOTW 的 progress.sav（不同布局、偏移无效）会污染锚点。
const totkTitleID = "0100F2C0115B6000"

// totkSaveRoot 返回 TOTK 存档根目录（Eden 版）。
// 优先级：环境变量 TOTK_SAVE_DIR → 正在运行的 eden.exe 所在目录推导
// （Eden 可移植模式：<exe 目录>\user\nand\user\save，实测 G:\YUZU\eden）→
// 常见安装路径候选。
func totkSaveRoot() string {
	if v := os.Getenv("TOTK_SAVE_DIR"); v != "" {
		return v
	}
	if h := procHandleNow(); h != 0 {
		if p := processPath(h); p != "" {
			cand := filepath.Join(filepath.Dir(p), "user", "nand", "user", "save")
			if fi, err := os.Stat(cand); err == nil && fi.IsDir() {
				return cand
			}
		}
	}
	// 便携 Eden 常见根探测：枚举常见盘符下的 YUZU\eden（Eden 便携版布局，
	// 进程未启动时也能找到存档根；GUI 先开、游戏后开场景依赖此路径）。
	// 注意：盘符必须带尾分隔符（filepath.Join("G:", "YUZU") 会产生
	// "G:YUZU" 这种盘符相对路径，os.Stat 必然失败）。
	for _, drive := range []string{"C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "H:\\", "I:\\", "J:\\", "K:\\", "L:\\"} {
		for _, sub := range []string{
			filepath.Join(drive, "YUZU", "eden", "user", "nand", "user", "save"),
			filepath.Join(drive, "yuzu", "eden", "user", "nand", "user", "save"),
			filepath.Join(drive, "YUZU", "user", "nand", "user", "save"),
		} {
			if fi, err := os.Stat(sub); err == nil && fi.IsDir() {
				return sub
			}
		}
	}
	// APPDATA 安装布局（Eden/yuzu 优先；Ryujinx 是历史残留目录，最后兜底，
	// 避免旧的 %APPDATA%\Ryujinx\bis\user\save 抢先命中却无 Eden 存档）。
	for _, c := range []string{
		filepath.Join(os.Getenv("APPDATA"), "Eden", "user", "nand", "user", "save"),
		filepath.Join(os.Getenv("APPDATA"), "yuzu", "user", "nand", "user", "save"),
		filepath.Join(os.Getenv("APPDATA"), "Ryujinx", "bis", "user", "save"),
	} {
		if fi, err := os.Stat(c); err == nil && fi.IsDir() {
			return c
		}
	}
	return filepath.Join(os.Getenv("APPDATA"), "Eden", "user", "nand", "user", "save")
}

// findTotkSaveFiles 递归找 TOTK 标题目录下所有 progress.sav（含 caption.sav）。
func findTotkSaveFiles(root string) []string {
	var out []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			n := strings.ToLower(d.Name())
			if n == "progress.sav" || n == "caption.sav" {
				if !strings.Contains(p, totkTitleID) {
					return nil // 非 TOTK 存档（如 BOTW），跳过防锚点污染
				}
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

// ---- 锚点缓存 ----
// 场景切换（进神庙/传送）触发游戏自动存档时 progress.sav/caption.sav 可能
// 被独占写入，readTotkAnchors 瞬时读空（实测 2026-10-04：进神庙后窗口扫描
// 爆炸为 114 万组，锚点读空 + 窗口过滤失效）。缓存最近一次成功锚点，
// 读取全空时回退缓存，避免定位入口被瞬态文件锁击穿。
var (
	anchorCache   []*SaveAnchor
	anchorCacheAt time.Time
)

const anchorCacheTTL = 10 * time.Minute

func readTotkAnchorsCached() []*SaveAnchor {
	a := readTotkAnchors()
	if len(a) > 0 {
		anchorCache = a
		anchorCacheAt = time.Now()
		return a
	}
	if len(anchorCache) > 0 && time.Since(anchorCacheAt) < anchorCacheTTL {
		return anchorCache
	}
	return nil
}

// slotRank: slot_00=0，其余槽=1（越小越优先）。
func slotRank(path string) int {
	if strings.Contains(path, "slot_00") {
		return 0
	}
	return 1
}

// anchorClusterRadius 锚点聚类半径（米）：
// 大地图历史存档点彼此通常 <300m（实测 217m），而神庙/洞穴本地坐标
// 与大地图锚点相距 >1500m（实测 progress.sav slot_05 = (56.4,-11.9,-42.7)，
// 距 slot_00 = (709.3,1690.3,1380.9) 约 1603m）。以 slot_00 为圆心、
// 半径 800m 可以完整收下同区域历史锚点、同时剔除神庙本地坐标。
// 见 2026-10-04 场景切换实验：神庙坐标混入 refs 后窗口过滤罩住全内存
// 小数值占位区，窗口组数 2万 → 114万 爆炸，玩家真坐标被淹没。
const anchorClusterRadius = 800.0

func dist3f(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// anchorRefs 锚点去重合并 + 离群剔除（与 locate.py anchor_refs 同口径：
// merge=4 米内视为同一点）。修复：**以 slot_00（最新自动存档）为权威圆心，
// 只保留与其距离 ≤ anchorClusterRadius 的锚点**。神庙/洞穴本地坐标
// （进神庙时自动存档写入旧槽）距权威圆心 >1500m，必然被剔除，杜绝
// 窗口过滤被小数值占位区污染。slot_00 缺失时退化为"最大簇"兜底。
func anchorRefs(anchors []*SaveAnchor, limit int, merge float32) [][3]float32 {
	if limit <= 0 {
		limit = 8
	}
	if merge <= 0 {
		merge = 4.0
	}

	// 1) 权威锚点 = slot_00（用户实际使用的最新自动存档槽）
	var auth *SaveAnchor
	for _, a := range anchors {
		if strings.Contains(a.Path, "slot_00") {
			auth = a
			break
		}
	}

	// 2) 收集权威圆心半径内的锚点（同区域簇）
	var cluster []*SaveAnchor
	if auth != nil {
		cluster = append(cluster, auth)
		for _, a := range anchors {
			if a == auth {
				continue
			}
			if dist3f(a.Pos, auth.Pos) <= anchorClusterRadius {
				cluster = append(cluster, a)
			}
		}
	} else {
		// 无 slot_00（文件缺失/命名异常）→ 最大簇兜底
		best := []*SaveAnchor{}
		for i, a := range anchors {
			c := []*SaveAnchor{a}
			for j, b := range anchors {
				if i != j && dist3f(a.Pos, b.Pos) <= anchorClusterRadius {
					c = append(c, b)
				}
			}
			if len(c) > len(best) {
				best = c
			}
		}
		cluster = best
	}

	// 3) merge 去重（4 米内视为同一点）+ 上限
	var out [][3]float32
	for _, a := range cluster {
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
