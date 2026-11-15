// profile_pc.go — PC 版内存配置档案管理（自动定位与扩大范围扫描之间的唯一连接）。
//
// 设计原则：
//   - 内置「配置 1（默认 TotK-Recomp）」完整保留原有静态链与堆区间，作为默认快速路径。
//   - 若同目录存在「扩大范围扫描」生成的 pc_profile_local.json（且指纹匹配或未指定），
//     自动定位启动/重扫时优先加载，从而无需重复全盘扫描。
//   - 后续收集到用户回传的不同编译版/游戏版配置，可直接追加到 builtinProfiles。

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// HeapRange 堆扫描区间 [Lo, Hi)。
type HeapRange struct {
	Lo string `json:"lo"` // 十六进制，如 "0x100000000"
	Hi string `json:"hi"` // 十六进制，如 "0x180000000"
}

// StaticChainEntry 主模块静态指针链偏移。
type StaticChainEntry struct {
	PtrOffset    string `json:"ptrOffset"`    // 相对 mainBase 的偏移，如 "0x4726008"
	StructOffset string `json:"structOffset"` // 堆对象内坐标偏移，如 "0x10"
}

// ProfileFingerprint 进程指纹，用于匹配对应的游戏/重编译版本。
type ProfileFingerprint struct {
	ExeSize  uintptr `json:"exeSize,omitempty"`
	MainBase string  `json:"mainBase,omitempty"`
}

// MemoryProfile 一套完整的 PC 版内存定位配置档案。
type MemoryProfile struct {
	ID           string             `json:"id"`
	Name         string             `json:"name"`
	Fingerprint  ProfileFingerprint `json:"fingerprint"`
	MainBase     string             `json:"mainBase,omitempty"`
	HeapRanges   []HeapRange        `json:"heapRanges"`
	StaticChains []StaticChainEntry `json:"staticChains"`
}

// builtinProfiles 内置配置列表。
// 配置 1 为原版默认 TotK-Recomp 参数，完整保留；后续可根据用户回传追加配置 2、配置 3。
var builtinProfiles = []MemoryProfile{
	{
		ID:   "profile-1-default",
		Name: "配置1（默认 TotK-Recomp）",
		Fingerprint: ProfileFingerprint{
			MainBase: "0x7000000000",
		},
		MainBase: "0x7000000000",
		HeapRanges: []HeapRange{
			{Lo: "0x100000000", Hi: "0x180000000"},
		},
		StaticChains: []StaticChainEntry{
			{PtrOffset: "0x4726008", StructOffset: "0x10"},
			{PtrOffset: "0x4727978", StructOffset: "0x60"},
			{PtrOffset: "0x4723FF8", StructOffset: "0xA0"},
			{PtrOffset: "0x46992C8", StructOffset: "0x50"},
			{PtrOffset: "0x46CE048", StructOffset: "0x90"},
		},
	},
}

var (
	activeProfMu sync.RWMutex
	activeProf   *MemoryProfile
)

func parseHexPtr(s string) (uintptr, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseUint(s, 0, 64)
	if err != nil {
		return 0, false
	}
	return uintptr(v), true
}

func formatHexPtr(v uintptr) string {
	return fmt.Sprintf("0x%X", v)
}

// localProfilePath 返回与可执行文件同目录的本地校准配置路径。
func localProfilePath() string {
	exe, err := os.Executable()
	if err != nil {
		return "pc_profile_local.json"
	}
	return filepath.Join(filepath.Dir(exe), "pc_profile_local.json")
}

// loadLocalProfile 读取本地校准生成的 pc_profile_local.json（不存在或解析失败返回 nil）。
func loadLocalProfile() *MemoryProfile {
	buf, err := os.ReadFile(localProfilePath())
	if err != nil {
		return nil
	}
	var prof MemoryProfile
	if err := json.Unmarshal(buf, &prof); err != nil {
		return nil
	}
	if len(prof.HeapRanges) == 0 && len(prof.StaticChains) == 0 {
		return nil
	}
	if prof.ID == "" {
		prof.ID = "local-calibrated"
	}
	if prof.Name == "" {
		prof.Name = "本地校准配置"
	}
	return &prof
}

// saveLocalProfile 将扩大范围扫描得到的配置原子写入 pc_profile_local.json。
func saveLocalProfile(prof *MemoryProfile) error {
	if prof == nil {
		return fmt.Errorf("nil profile")
	}
	buf, err := json.MarshalIndent(prof, "", "  ")
	if err != nil {
		return err
	}
	p := localProfilePath()
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, buf, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// selectActiveProfile 按优先级选择当前生效的配置档案：
//  1. 本地 pc_profile_local.json（若 exeSize 匹配或未限定 exeSize）
//  2. builtinProfiles 中 exeSize 精确匹配的配置
//  3. 默认配置 1（builtinProfiles[0]）
func selectActiveProfile(exeSize uintptr) *MemoryProfile {
	if local := loadLocalProfile(); local != nil {
		if local.Fingerprint.ExeSize == 0 || exeSize == 0 || local.Fingerprint.ExeSize == exeSize {
			setActiveProfile(local)
			return local
		}
	}
	if exeSize != 0 {
		for i := range builtinProfiles {
			if builtinProfiles[i].Fingerprint.ExeSize == exeSize {
				p := builtinProfiles[i]
				setActiveProfile(&p)
				return &p
			}
		}
	}
	p := builtinProfiles[0]
	setActiveProfile(&p)
	return &p
}

func setActiveProfile(prof *MemoryProfile) {
	activeProfMu.Lock()
	activeProf = prof
	activeProfMu.Unlock()
}

func getActiveProfile() *MemoryProfile {
	activeProfMu.RLock()
	p := activeProf
	activeProfMu.RUnlock()
	if p != nil {
		return p
	}
	def := builtinProfiles[0]
	return &def
}

// activeHeapRanges 返回当前配置中的堆扫描区间（十六进制解析后）。
func activeHeapRanges() [][2]uintptr {
	prof := getActiveProfile()
	var out [][2]uintptr
	for _, r := range prof.HeapRanges {
		lo, ok1 := parseHexPtr(r.Lo)
		hi, ok2 := parseHexPtr(r.Hi)
		if ok1 && ok2 && hi > lo {
			out = append(out, [2]uintptr{lo, hi})
		}
	}
	if len(out) == 0 {
		out = append(out, [2]uintptr{totkPCScanHeapLo, totkPCScanHeapHi})
	}
	return out
}

// activeStaticChains 返回当前配置中的静态指针链列表。
func activeStaticChains() []staticPtrChain {
	prof := getActiveProfile()
	var out []staticPtrChain
	for _, c := range prof.StaticChains {
		po, ok1 := parseHexPtr(c.PtrOffset)
		so, ok2 := parseHexPtr(c.StructOffset)
		if ok1 && ok2 {
			out = append(out, staticPtrChain{ptrOffset: po, structOffset: so})
		}
	}
	if len(out) == 0 {
		return knownStaticChains
	}
	return out
}
