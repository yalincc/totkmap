// known_addrs.json 持久化（Eden 版）：记住坐标槽的绝对地址，重启秒开。
// Eden 无固定 guest DRAM 块锚点（内存碎片化，25082 区域 / 24.4GB），
// 旧 Ryujinx 方案"块基址 + 偏移"在 Eden 上无意义（旧偏移 0xECB52A48
// 读全零，2026-10-04 实测）。改为记忆"验证过的绝对地址"。
// 绝对地址跨会话是否稳定由重启实测决定：稳定 → 秒锁；不稳定 → 回退存档锚点全扫描。

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const knownFile = "known_addrs.json"

// 偏移记忆条数上限——旧版无限追加会积累垃圾偏移污染快路径。只保留最近 knownCap 条。
const knownCap = 10

// knownEvictFail 绝对地址连续失败次数达到该值 → 移出 known_addrs.json。
const knownEvictFail = 3

// maxKnownAddr 允许的绝对地址上限。Eden 玩家槽实测 0x01DA6E65C0A0（约 32TB 量级），
// 旧 maxKnownOff=1TB 会把合法地址直接拒掉 → known 永久失效。取 Windows 用户态上限。
const maxKnownAddr = uintptr(0x7FFFFFFFFFFF)

// sessionBaseForKnown 返回写 known_addrs.json 用的锚块基址（仅诊断/兼容字段；
// Eden 快路径已不依赖块）。当前会话块 → 最大 guest 块 → 上次记录的块。
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
	Block   string         `json:"block"`
	Offsets []string       `json:"offsets"` // 兼容旧格式（Ryujinx 期），Eden 下不再写入
	Addrs   []string       `json:"addrs,omitempty"`
	Fails   map[string]int `json:"fails,omitempty"` // 绝对地址 -> 失败次数（连续 knownEvictFail 次移出）
	Updated string         `json:"updated"`
}

// knownFails 绝对地址失败计数（hex -> count）。只由状态机 goroutine 读写。
var knownFails map[string]int

func init() {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	knownFails = d.Fails
	if knownFails == nil {
		knownFails = map[string]int{}
	}
}

func failReached(a uintptr) bool {
	return knownFails[hex8(a)] >= knownEvictFail
}

// knownFailInc 给绝对地址记一次失败；达到 knownEvictFail 次则把该地址移出
// known_addrs.json（重写文件，其余地址与 fails 状态保留）。
func knownFailInc(a uintptr) {
	key := hex8(a)
	knownFails[key]++
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	var addrs []string
	for _, v := range d.Addrs {
		if !failReached(parseHex(v)) {
			addrs = append(addrs, v)
		}
	}
	d.Addrs = addrs
	d.Fails = knownFails
	d.Updated = time.Now().Format("2006-01-02 15:04:05")
	buf, _ := json.MarshalIndent(d, "", "  ")
	os.WriteFile(knownPath(), buf, 0644)
	fmt.Printf("  [known] addr %s fail=%d (evict>=%d)\n", key, knownFails[key], knownEvictFail)
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

// loadKnownBlock 返回 known_addrs.json 记录的块基址（上次会话块，重启参照用，
// 兼容旧格式；Eden 下主要作诊断，非快路径依赖）。
func loadKnownBlock() uintptr {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	return parseHex(d.Block)
}

// loadAddrs 返回 known_addrs.json 记录的已验证绝对地址（Eden 快路径）。
func loadAddrs() []uintptr {
	var d knownData
	if data, err := os.ReadFile(knownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	var out []uintptr
	add := func(v uintptr) {
		if v > 0x10000 && v < maxKnownAddr {
			for _, x := range out {
				if x == v {
					return
				}
			}
			out = append(out, v)
		}
	}
	for _, v := range d.Addrs {
		add(parseHex(v))
	}
	return out
}

func saveKnown(addrs []uintptr, block uintptr) {
	if block == 0 {
		block = sessionBaseForKnown()
	}
	seen := map[uintptr]bool{}
	var list []string
	for _, a := range addrs {
		if a > 0x10000 && a < maxKnownAddr && !seen[a] {
			seen[a] = true
			list = append(list, hex8(a))
		}
	}
	for _, a := range loadAddrs() {
		if !seen[a] && !failReached(a) {
			seen[a] = true
			list = append(list, hex8(a))
		}
	}
	if len(list) > knownCap {
		list = list[:knownCap]
	}
	d := knownData{
		Block:   hex12(block),
		Offsets: nil,
		Addrs:   list,
		Fails:   knownFails,
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
