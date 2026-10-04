// progress_totk2.go — CompletismHashes/explore_save_map 解析 + 计数 + watcher。
package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// parseCompletismHashes 解析 data/totk_save_hashes.js 的 CompletismHashes。
func parseCompletismHashes() map[string][]string {
	out := map[string][]string{}
	dir := dataDir()
	buf, err := os.ReadFile(filepath.Join(dir, "totk_save_hashes.js"))
	if err != nil {
		return out
	}
	re := regexp.MustCompile(`(?s)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*?)\n\s*\],?`)
	ms := re.FindAllStringSubmatch(string(buf), -1)
	for _, m := range ms {
		if len(m) < 3 {
			continue
		}
		key, body := m[1], m[2]
		var arr []string
		itemRe := regexp.MustCompile(`0x([0-9a-fA-F]+)|'([^']+)'|"([^"]+)"`)
		for _, im := range itemRe.FindAllStringSubmatch(body, -1) {
			if im[1] != "" {
				arr = append(arr, "0x"+im[1])
			} else if im[2] != "" {
				arr = append(arr, im[2])
			} else if im[3] != "" {
				arr = append(arr, im[3])
			}
		}
		out[key] = arr
	}
	return out
}

// parseExploreMap 解析 data/explore_save_map.js。
type exploreMap struct {
	Towers  map[string]string `json:"towers"`
	Tears   map[string]string `json:"tears"`
	Bubbuls map[string]string `json:"bubbuls"`
}

func parseExploreMap() *exploreMap {
	dir := dataDir()
	buf, err := os.ReadFile(filepath.Join(dir, "explore_save_map.js"))
	if err != nil {
		return &exploreMap{}
	}
	re := regexp.MustCompile(`(?s)window\.TOTK_EXPLORE_MAP\s*=\s*(\{.*?\});`)
	m := re.FindStringSubmatch(string(buf))
	if m == nil {
		return &exploreMap{}
	}
	var em exploreMap
	if json.Unmarshal([]byte(m[1]), &em) != nil {
		return &exploreMap{}
	}
	return &em
}

// hval 读 hash 表对应值（与 js hval 同口径）。
func (p *parsedSave) hval(hashInt uint32) (uint32, bool) {
	off, ok := p.OffByHash[hashInt]
	if !ok {
		return 0, false
	}
	return binary.LittleEndian.Uint32(p.Data[off:]), true
}

// progressCount 值为 val 的 hash 个数（val 为空表示 1）。
func (p *parsedSave) progressCount(lst []string, val string) int {
	target := uint32(1)
	if val != "" {
		target = murmur3_32(val, 0)
	}
	n := 0
	for _, h := range lst {
		hv, err := strconv.ParseUint(strings.TrimPrefix(h, "0x"), 16, 32)
		if err != nil {
			continue
		}
		if v, ok := p.hval(uint32(hv)); ok && v == target {
			n++
		}
	}
	return n
}

func (p *parsedSave) progressCountGuids(lst []string) int {
	n := 0
	for _, g := range lst {
		for _, gs := range p.Guids {
			if gs == g {
				n++
				break
			}
		}
	}
	return n
}

var dragonTears = []uint32{
	0x95eaf7f7, 0xd8f6148f, 0xea112a5c, 0x0ba4de99, 0x5a630ce5, 0x2146bc12,
	0x9061714b, 0x7cc0375a, 0xa14c6ed1, 0x587df5b0, 0x5279d33f, 0xc595c991,
}

// progressCount JSON 输出 done/total 小写（与 live-python 前端口径一致）。
type progressCount struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// progressCounts 与 js collect() / server.py _progress_counts() 完全同口径。
func progressCounts(p *parsedSave, C map[string][]string) map[string]progressCount {
	out := map[string]progressCount{}
	cnt := func(name string, lst []string, val string) {
		out[name] = progressCount{p.progressCount(lst, val), len(lst)}
	}
	cg := func(name string, lst []string) {
		out[name] = progressCount{p.progressCountGuids(lst), len(lst)}
	}
	tears := make([]string, 0, len(dragonTears))
	for _, t := range dragonTears {
		tears = append(tears, fmt.Sprintf("0x%08x", t))
	}
	cnt("鸟望台", C["TOWERS_FOUND"], "")
	cnt("龙之泪", tears, "")
	cnt("神庙", C["SHRINES_STATUS"], "Clear")
	cnt("树根", C["LIGHTROOTS_STATUS"], "Open")
	cnt("克洛格", C["KOROKS_HIDDEN"], "")
	cnt("双倍克洛格", C["KOROKS_CARRY"], "Clear")
	cg("魔犹伊遗失物", C["BUBBULS_GUIDS"])
	cnt("残旧的地图", C["TREASURE_MAPS_FOUND"], "")
	cg("贤者的遗志", C["SAGE_WILLS_FOUND"])
	sc := append(append([]string{}, C["SCHEMATICS_STONE_FOUND"]...), C["SCHEMATICS_YIGA_FOUND"]...)
	cnt("设计图石板", sc, "")
	cg("卡邦达立牌", C["ADDISON_COMPLETED"])
	for zh, key := range map[string]string{
		"独眼巨人":   "BOSSES_HINOXES_DEFEATED", "岩石巨人": "BOSSES_TALUSES_DEFEATED",
		"莫尔德拉吉克": "BOSSES_MOLDUGAS_DEFEATED", "方块魔像": "BOSSES_FLUX_CONSTRUCT_DEFEATED",
		"巨霸伽马":   "BOSSES_FROXS_DEFEATED", "古栗欧克": "BOSSES_GLEEOKS_DEFEATED",
		"地洞入口":   "LOCATION_CHASMS_VISITED", "洞穴入口": "LOCATION_CAVES_VISITED",
		"井":      "LOCATION_WELLS_VISITED",
	} {
		cnt(zh, C[key], "")
	}
	return out
}

// buildDoneIds towers/tears hash==1、bubbuls guid 存在（与 server.py 同口径）。
func buildDoneIds(p *parsedSave, em *exploreMap) ([]int, int) {
	var ids []int
	mapped := 0
	for _, tbl := range []map[string]string{em.Towers, em.Tears} {
		for mid, hv := range tbl {
			mapped++
			hvInt, err := strconv.ParseUint(strings.TrimPrefix(hv, "0x"), 16, 32)
			if err != nil {
				continue
			}
			if v, ok := p.hval(uint32(hvInt)); ok && v == 1 {
				if id, err := strconv.Atoi(mid); err == nil {
					ids = append(ids, id)
				}
			}
		}
	}
	for mid, guid := range em.Bubbuls {
		mapped++
		for _, gs := range p.Guids {
			if gs == guid {
				if id, err := strconv.Atoi(mid); err == nil {
					ids = append(ids, id)
				}
				break
			}
		}
	}
	sort.Ints(ids)
	return ids, mapped
}

// ---- watcher ----

type progressWatcher struct {
	mu         sync.RWMutex
	ok         bool
	body       []byte
	gen        string
	save       string
	mtime      float64
	init       bool
	completism map[string][]string
	emap       *exploreMap
}

var progress *progressWatcher

func newProgressWatcher() *progressWatcher {
	w := &progressWatcher{}
	w.completism = parseCompletismHashes()
	w.emap = parseExploreMap()
	w.refresh()
	return w
}

func (w *progressWatcher) refresh() {
	w.mu.Lock()
	defer w.mu.Unlock()
	mt, path := findLatestProgress()
	if path == "" {
		if !w.init {
			fmt.Println("  [progress] no progress.sav yet - will watch for it")
		}
		w.ok = false
		w.init = true
		return
	}
	p := parseProgressSave(path)
	if !p.Ok {
		if !w.init {
			fmt.Printf("  [progress] parse failed: %s\n", p.Error)
		}
		w.ok = false
		w.init = true
		return
	}
	ids, mapped := buildDoneIds(p, w.emap)
	counts := progressCounts(p, w.completism)
	obj := map[string]any{
		"ok":      true,
		"version": p.Version,
		"save":    path,
		"doneIds": ids,
		"mapped":  mapped,
		"counts":  counts,
		"mtime":   mt,
	}
	buf, _ := json.Marshal(obj)
	w.body = buf
	w.save = path
	w.mtime = mt
	w.gen = fmt.Sprintf("%s:%d", path, int64(math.Round(mt)))
	w.ok = true
	if !w.init {
		fmt.Printf("  [progress] save=%s\n", path)
		fmt.Printf("  [progress] doneIds=%d  towers/tears/bubbuls mapped=%d\n", len(ids), mapped)
		for _, k := range []string{"鸟望台", "神庙", "树根", "克洛格", "魔犹伊遗失物", "卡邦达立牌"} {
			if c, ok := counts[k]; ok {
				fmt.Printf("    %s %d/%d\n", k, c.Done, c.Total)
			}
		}
	}
	w.init = true
}

func (w *progressWatcher) loop() {
	for {
		time.Sleep(2 * time.Second)
		mt, path := findLatestProgress()
		w.mu.RLock()
		changed := path != w.save || mt != w.mtime
		w.mu.RUnlock()
		if changed {
			w.refresh()
		}
	}
}

func (w *progressWatcher) snapshot() (bool, []byte, string) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.ok, w.body, w.gen
}
