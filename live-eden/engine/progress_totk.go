// progress_totk.go — TOTK progress.sav 解析 → /progress（doneIds + counts）。
//
// 与前端 js/save-parser.js + 服务端 live-python/server.py 逐字段同口径：
//   - 版本表 / HASH_TABLE_END(0x03c800) / 0xa3db7114 哨兵 / GUID 表；
//   - murmur3 x86 32-bit（'Clear'/'Open' 等字符串 hash，与 murmurHash3.x86.hash32 一致）；
//   - 参考表 data/totk_save_hashes.js（CompletismHashes）与 data/explore_save_map.js；
//   - /progress: {ok, version, save, doneIds, mapped, counts, mtime}；gen = save:seconds(mtime)。

package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"sort"
	"strings"
)

const (
	hashTableEnd    = 0x03c800
	guidSentinel    = 0xa3db7114
	progressCacheS  = 2.0
)

var saveGameVersions = []struct {
	Header, Meta uint32
	Size         int
	Version      string
}{
	{0x0046c3c8, 0x0003c050, 2307552, "v1.0"},
	{0x0047e0f4, 0x0003c088, 2307656, "v1.1.x/v1.2.x"},
	{0x0049e946, 0x0003c138, 2307856, "v1.4.x"},
}

type parsedSave struct {
	Ok          bool
	Version     string
	Error       string
	OffByHash   map[uint32]int    // hash -> 字节偏移（数据表定位）
	Guids       []string
	Data        []byte
}

// findLatestProgress 返回 (mtime_sec, path)：先按 mtime 降序，再优先 slot_00
// （与 live-python _find_save 同口径：Ryujinx 保存时所有槽 mtime 可能同刻）。
func findLatestProgress() (float64, string) {
	root := totkSaveRoot()
	type cand struct {
		mt   float64
		path string
	}
	var cands []cand
	for _, p := range findTotkSaveFiles(root) {
		if !strings.HasSuffix(strings.ToLower(p), "progress.sav") {
			continue
		}
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		cands = append(cands, cand{float64(fi.ModTime().UnixNano()) / 1e9, p})
	}
	if len(cands) == 0 {
		return 0, ""
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].mt > cands[j].mt })
	for _, c := range cands {
		if strings.Contains(c.path, "slot_00") {
			return c.mt, c.path
		}
	}
	return cands[0].mt, cands[0].path
}

// parseProgressSave 解析 progress.sav（与 js parse() 同口径）。
func parseProgressSave(path string) *parsedSave {
	data, err := os.ReadFile(path)
	if err != nil {
		return &parsedSave{Ok: false, Error: "read: " + err.Error()}
	}
	if len(data) < 8 || binary.LittleEndian.Uint32(data[0:4]) != 0x01020304 {
		return &parsedSave{Ok: false, Error: "bad header"}
	}
	header := binary.LittleEndian.Uint32(data[4:8])
	meta := binary.LittleEndian.Uint32(data[8:12])
	version := ""
	for _, v := range saveGameVersions {
		if len(data) == v.Size && header == v.Header && meta == v.Meta {
			version = v.Version
			break
		}
	}
	if version == "" {
		return &parsedSave{Ok: false, Error: "unsupported version"}
	}
	offByHash := map[uint32]int{}
	guidsOffset := -1
	end := hashTableEnd
	if end > len(data) {
		end = len(data)
	}
	for j := 0x28; j < end-7; j += 8 {
		h := binary.LittleEndian.Uint32(data[j:])
		if h == guidSentinel {
			guidsOffset = int(binary.LittleEndian.Uint32(data[j+4:]))
			break
		}
		offByHash[h] = j + 4
	}
	if guidsOffset <= 0 || guidsOffset >= len(data) {
		return &parsedSave{Ok: false, Error: "no guid table"}
	}
	guids := []string{}
	k := guidsOffset
	for k < len(data)-8 {
		lo := binary.LittleEndian.Uint32(data[k:])
		up := binary.LittleEndian.Uint32(data[k+4:])
		if lo == 0 && up == 0 {
			break
		}
		guids = append(guids, fmt.Sprintf("0x%08x%08x", up, lo))
		k += 8
	}
	return &parsedSave{Ok: true, Version: version, OffByHash: offByHash,
		Guids: guids, Data: data}
}

// murmur3_32 MurmurHash3 x86 32-bit（与 murmurHash3.x86.hash32 完全一致）。
func murmur3_32(key string, seed uint32) uint32 {
	data := []byte(key)
	n := len(data)
	h := seed & 0xFFFFFFFF
	i := 0
	for ; i+4 <= n; i += 4 {
		k := binary.LittleEndian.Uint32(data[i:])
		k = (k * 0xCC9E2D51) & 0xFFFFFFFF
		k = ((k<<15 | k>>17) & 0xFFFFFFFF) * 0x1B873593 & 0xFFFFFFFF
		h ^= k
		h = (((h<<13 | h>>19) & 0xFFFFFFFF) * 5 + 0xE6546B64) & 0xFFFFFFFF
	}
	var k uint32
	tail := data[i:]
	switch len(tail) {
	case 3:
		k ^= uint32(tail[2]) << 16
		fallthrough
	case 2:
		k ^= uint32(tail[1]) << 8
		fallthrough
	case 1:
		k ^= uint32(tail[0])
		k = (k * 0xCC9E2D51) & 0xFFFFFFFF
		k = ((k<<15 | k>>17) & 0xFFFFFFFF) * 0x1B873593 & 0xFFFFFFFF
		h ^= k
	}
	h ^= uint32(n)
	h ^= h >> 16
	h = (h * 0x85EBCA6B) & 0xFFFFFFFF
	h ^= h >> 13
	h = (h * 0xC2B2AE35) & 0xFFFFFFFF
	h ^= h >> 16
	return h
}
