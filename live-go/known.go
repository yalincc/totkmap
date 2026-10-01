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

// maxKnownOff 允许的块内偏移上限。旧值是 0x100000000（4GB），但 Ryujinx 实测
// guest DRAM 有 6088MB，玩家槽相对块基址的偏移可达 5.5GB，被这条上限直接拒掉
// → known_addrs.json 写成 offsets:null，快路径永久失效、每次都得重新扫描。
const maxKnownOff = 0x10000000000 // 1TB，远超任何实际块大小

// sessionBaseForKnown 返回写 known_addrs.json 用的锚块基址。
// currentSessionBase 在"未检测到新块"时恒为 0（启动常态），拿 0 当基址会让偏移
// 退化成绝对地址（3.4TB 量级）从而必被拒绝。这里依次兜底：
// 会话块 → 最大 guest 块 → 上次记录的块。
func sessionBaseForKnown() uintptr {
	if currentSessionBase != 0 {
		return currentSessionBase
	}
	if h := procHandleNow(); h != 0 {
		if base, size := largestGuestBlock(h, minBlockMB); base != 0 && size > 0 {
			return base
		}
	}
	return loadKnownBlock()
}

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

// loadKnownBlock 返回 known_addrs.json 记录的块基址（上次会话块，重启参照用）。
func loadKnownBlock() uintptr {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	return parseHex(d.Block)
}

func loadOffsets() []uintptr {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	var out []uintptr
	add := func(v uintptr) {
		if v > 0 && v < maxKnownOff {
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
		if o > 0 && o < maxKnownOff && !seen[o] {
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
