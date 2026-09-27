// known_addrs.json 持久化：记住坐标槽相对 guest DRAM 块的偏移，重启秒开。
// 偏移相对块基址（Ryujinx 重启后基址变化，偏移不变）。

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const knownFile = "known_addrs.json"

// Fix 4：偏移记忆条数上限——旧版无限追加，实测积累 40+ 条垃圾偏移，
// 快路径投票被污染、启动锁错槽。只保留最近 knownCap 条。
const knownCap = 10

type knownData struct {
	Block   string   `json:"block"`
	Offsets []string `json:"offsets"`
	Updated string   `json:"updated"`
}

func knownPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), knownFile)
}

func parseHex(v string) uintptr {
	s := strings.TrimPrefix(strings.TrimSpace(v), "0x")
	s = strings.TrimPrefix(s, "0X")
	n, err := strconv.ParseUint(s, 16, 64)
	if err != nil {
		return 0
	}
	return uintptr(n)
}

func loadOffsets() []uintptr {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	var out []uintptr
	add := func(v uintptr) {
		if v > 0 && v < 0x100000000 {
			for _, x := range out {
				if x == v {
					return
				}
			}
			out = append(out, v)
		}
	}
	blk := parseHex(d.Block)
	for _, v := range d.Offsets {
		add(parseHex(v))
	}
	for _, v := range d.Offsets { // 兼容旧格式：绝对地址转偏移
		a := parseHex(v)
		if a > blk {
			add(a - blk)
		}
	}
	return out
}

func saveKnown(addrs []uintptr, block uintptr) {
	seen := map[uintptr]bool{}
	var offs []string
	for _, a := range addrs {
		o := a
		if block != 0 && a > block {
			o = a - block
		}
		if o > 0 && o < 0x100000000 && !seen[o] {
			seen[o] = true
			offs = append(offs, hex8(o))
		}
	}
	for _, o := range loadOffsets() {
		if !seen[o] {
			seen[o] = true
			offs = append(offs, hex8(o))
		}
	}
	if len(offs) > knownCap {
		offs = offs[:knownCap]
	}
	d := knownData{
		Block:   hex12(block),
		Offsets: offs,
		Updated: time.Now().Format("2006-01-02 15:04:05"),
	}
	buf, _ := json.MarshalIndent(d, "", "  ")
	os.WriteFile(knownPath(), buf, 0644)
}

func hex8(v uintptr) string {
	return "0x" + strings.ToUpper(strconv.FormatUint(uint64(v), 16))
}

func hex12(v uintptr) string {
	s := "0x" + strings.ToUpper(strconv.FormatUint(uint64(v), 16))
	for len(s) < 14 {
		s = "0x0" + s[2:]
	}
	return s
}
