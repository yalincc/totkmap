// eden_known.go — known_eden_totk.json 持久化（Eden 版）：记住坐标槽的绝对地址，
// 重启秒开。Eden 无固定 guest DRAM 块锚点（内存碎片化，25082 区域 / 24.4GB），
// 块+偏移方案在 Eden 上无意义（旧偏移 0xECB52A48 读全零）。改为记忆
// "验证过的绝对地址"。与 Ryujinx 的 known_addrs.json 严格分文件隔离（铁律 2：
// 块偏移 vs 绝对地址混写必锁错）。

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const edenKnownFile = "known_eden_totk.json"

// maxKnownAddr 允许的绝对地址上限。Eden 玩家槽实测 0x01DA6E65C0A0（约 32TB
// 量级），旧 maxKnownOff=1TB 会把合法地址直接拒掉 → known 永久失效。
// 取 Windows 用户态上限。
const maxKnownAddr = uintptr(0x7FFFFFFFFFFF)

// edenKnownData known_eden_totk.json 结构（Eden 版：绝对地址列表 + fails）。
type edenKnownData struct {
	Block   string         `json:"block"`
	Offsets []string       `json:"offsets"` // 兼容旧格式，Eden 下不再写入
	Addrs   []string       `json:"addrs,omitempty"`
	Fails   map[string]int `json:"fails,omitempty"` // 绝对地址 -> 失败次数
	Updated string         `json:"updated"`
}

// edenKnownFails 绝对地址失败计数（hex -> count）。只由状态机 goroutine 读写。
var edenKnownFails map[string]int

func init() {
	var d edenKnownData
	if data, err := os.ReadFile(edenKnownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	edenKnownFails = d.Fails
	if edenKnownFails == nil {
		edenKnownFails = map[string]int{}
	}
}

func edenFailReached(a uintptr) bool {
	return edenKnownFails[hex8(a)] >= knownEvictFail
}

// edenKnownFailInc 给绝对地址记一次失败；达到 knownEvictFail 次则移出文件。
func edenKnownFailInc(a uintptr) {
	key := hex8(a)
	edenKnownFails[key]++
	var d edenKnownData
	if data, err := os.ReadFile(edenKnownPath()); err == nil {
		json.Unmarshal(data, &d)
	}
	var addrs []string
	for _, v := range d.Addrs {
		if !edenFailReached(parseHex(v)) {
			addrs = append(addrs, v)
		}
	}
	d.Addrs = addrs
	d.Fails = edenKnownFails
	d.Updated = time.Now().Format("2006-01-02 15:04:05")
	buf, _ := json.MarshalIndent(d, "", "  ")
	os.WriteFile(edenKnownPath(), buf, 0644)
	fmt.Printf("  [known] addr %s fail=%d (evict>=%d)\n", key, edenKnownFails[key], knownEvictFail)
}

func edenKnownPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), edenKnownFile)
}

// edenLoadAddrs 返回已验证绝对地址列表（Eden 快路径）。
func edenLoadAddrs() []uintptr {
	var d edenKnownData
	if data, err := os.ReadFile(edenKnownPath()); err == nil {
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

// edenKnownSlotOK 判定地址能否写入 known 记忆：排除内部场景（神庙/洞穴）
// 本地坐标槽——玩家在神庙里移动确认时若把神庙槽写进 known，下次启动秒锁
// 神庙槽 → 输出神庙本地坐标被当大地图坐标（红点画地下）。
func edenKnownSlotOK(h uintptr, a uintptr) bool {
	if d := edenDecodeBytes(readMem(h, a, 12)); d != nil {
		if isShrinePos([3]float32{d[0], d[1], d[2]}) {
			return false
		}
	}
	return true
}

// edenSaveKnown 写 known_eden_totk.json（绝对地址，knownSlotOK 过滤神庙槽）。
func edenSaveKnown(h uintptr, addrs []uintptr, block uintptr) {
	if block == 0 {
		block = sessionBaseForKnown()
	}
	seen := map[uintptr]bool{}
	var list []string
	for _, a := range addrs {
		if a > 0x10000 && a < maxKnownAddr && !seen[a] && edenKnownSlotOK(h, a) {
			seen[a] = true
			list = append(list, hex8(a))
		}
	}
	for _, a := range edenLoadAddrs() {
		if !seen[a] && !edenFailReached(a) && edenKnownSlotOK(h, a) {
			seen[a] = true
			list = append(list, hex8(a))
		}
	}
	if len(list) > knownCap {
		list = list[:knownCap]
	}
	d := edenKnownData{
		Block:   hex12(block),
		Offsets: nil,
		Addrs:   list,
		Fails:   edenKnownFails,
		Updated: time.Now().Format("2006-01-02 15:04:05"),
	}
	buf, _ := json.MarshalIndent(d, "", "  ")
	os.WriteFile(edenKnownPath(), buf, 0644)
}
