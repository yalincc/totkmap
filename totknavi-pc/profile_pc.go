// profile_pc.go — PC 版内存配置单管理（支持内置配置单 + profiles/*.json 外部配置 + 兼容旧 pc_profile_local.json）。
//
// 设计原则：
//   - 内置「默认配置 (TotK-Recomp 295MB)」完整保留原有静态链与堆区间，作为默认快速路径。
//   - 外部配置放于可执行文件同目录 profiles/*.json（并兼容旧版 pc_profile_local.json），
//     启动时按 totk.exe 镜像大小（exeSize）自动精确匹配；也可通过环境变量 TOTK_PC_PROFILE 手动指定。
//   - ramGB / note 仅作可读标签展示（便于玩家间分享识别），不参与硬过滤（同编译版 16G/32G 通用）。

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	RecompVersion string             `json:"recompVersion,omitempty"`
	GameVersion   string             `json:"gameVersion,omitempty"`
	Note          string             `json:"note,omitempty"`
	RamGB         int                `json:"ramGB,omitempty"`
	Verified      bool               `json:"verified,omitempty"`
	Fingerprint   ProfileFingerprint `json:"fingerprint"`
	MainBase      string             `json:"mainBase,omitempty"`
	HeapRanges    []HeapRange        `json:"heapRanges"`
	StaticChains  []StaticChainEntry `json:"staticChains"`
}

// builtinProfiles 内置配置单。
// 后续可根据社区回传的不同编译版配置直接追加。
var builtinProfiles = []MemoryProfile{
	{
		ID:            "profile-1-default",
		Name:          "默认配置 (TotK-Recomp · 1.2.1)",
		RecompVersion: "TotK-Recomp (默认)",
		GameVersion:   "1.2.1",
		Note:          "内置默认偏移，适用于 TotK-Recomp 1.2.1 主流编译版",
		Verified:      true,
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
	{
		ID:            "profile-2-143",
		Name:          "默认配置 (TotK-Recomp · 1.4.3)",
		RecompVersion: "TotK-Recomp (默认)",
		GameVersion:   "1.4.3",
		Note:          "内置 1.4.3 全系通用偏移（经 285MB/302MB/330MB 多构建实机交叉验证）",
		Verified:      true,
		Fingerprint: ProfileFingerprint{
			MainBase: "0x7000000000",
		},
		MainBase: "0x7000000000",
		HeapRanges: []HeapRange{
			{Lo: "0x100000000", Hi: "0x1A0000000"},
		},
		StaticChains: []StaticChainEntry{
			{PtrOffset: "0x3A4CF60", StructOffset: "0x98"},
			{PtrOffset: "0x3A4CF68", StructOffset: "0x118"},
			{PtrOffset: "0x3A4E6E0", StructOffset: "0x50"},
			{PtrOffset: "0x3A4EC80", StructOffset: "0x118"},
			{PtrOffset: "0x3A4EC80", StructOffset: "0x178"},
			{PtrOffset: "0x3A4FC48", StructOffset: "0xF0"},
			{PtrOffset: "0x3A4FC48", StructOffset: "0xFC"},
			{PtrOffset: "0x3A5E9A0", StructOffset: "0x150"},
			{PtrOffset: "0x3A608C8", StructOffset: "0x1C0"},
			{PtrOffset: "0x3A62ED8", StructOffset: "0xC0"},
			{PtrOffset: "0x3A63410", StructOffset: "0x58"},
			{PtrOffset: "0x3A64660", StructOffset: "0x1E0"},
		},
	},
}

var (
	activeProfMu      sync.RWMutex
	activeProf        *MemoryProfile
	activeProfExact   bool
	activeProfForced  bool
	detectedRecompVer string
	detectedGameVer   string
)

func setDetectedVersions(recompVer, gameVer string) {
	activeProfMu.Lock()
	detectedRecompVer = recompVer
	detectedGameVer = gameVer
	activeProfMu.Unlock()
}

func getDetectedVersions() (string, string) {
	activeProfMu.RLock()
	defer activeProfMu.RUnlock()
	return detectedRecompVer, detectedGameVer
}

func isActiveProfileExact() bool {
	activeProfMu.RLock()
	defer activeProfMu.RUnlock()
	return activeProfExact || activeProfForced
}

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

func exeBaseDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// profilesDir 返回配置单目录路径（可执行文件同级 profiles/）。
func profilesDir() string {
	return filepath.Join(exeBaseDir(), "profiles")
}

// localProfilePath 返回兼容旧版的根目录 pc_profile_local.json 路径。
func localProfilePath() string {
	return filepath.Join(exeBaseDir(), "pc_profile_local.json")
}

func loadProfileFile(path string) *MemoryProfile {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var prof MemoryProfile
	if err := json.Unmarshal(buf, &prof); err != nil {
		return nil
	}
	if !prof.Verified || len(prof.StaticChains) == 0 {
		return nil
	}
	if prof.ID == "" {
		base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		prof.ID = base
	}
	if prof.Name == "" {
		prof.Name = prof.ID
	}
	return &prof
}

// loadExternalProfiles 读取 profiles/*.json 以及兼容的 pc_profile_local.json。
func loadExternalProfiles() []*MemoryProfile {
	var out []*MemoryProfile
	seen := make(map[string]bool)

	if entries, err := os.ReadDir(profilesDir()); err == nil {
		var names []string
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			if p := loadProfileFile(filepath.Join(profilesDir(), name)); p != nil {
				if !seen[p.ID] {
					seen[p.ID] = true
					out = append(out, p)
				}
			}
		}
	}

	if legacy := loadProfileFile(localProfilePath()); legacy != nil {
		if !seen[legacy.ID] {
			out = append(out, legacy)
		}
	}
	return out
}

// saveLocalProfile 将校准生成的配置原子写入 profiles/<id>.json，返回写入路径。
func saveLocalProfile(prof *MemoryProfile) (string, error) {
	if prof == nil {
		return "", fmt.Errorf("nil profile")
	}
	if err := os.MkdirAll(profilesDir(), 0o755); err != nil {
		return "", err
	}
	fileID := prof.ID
	if fileID == "" {
		fileID = "local-calibrated"
	}
	fileID = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, fileID)
	p := filepath.Join(profilesDir(), fileID+".json")
	buf, err := json.MarshalIndent(prof, "", "  ")
	if err != nil {
		return "", err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		return "", err
	}
	return p, nil
}

// selectActiveProfile 按优先级选择当前生效的配置档案：
//  1. 环境变量 TOTK_PC_PROFILE 手动指定（非空且非 "auto"）
//  2. profiles/*.json（及旧 pc_profile_local.json）中 exeSize 精确匹配的配置
//  3. profiles/*.json 中未限定 exeSize 的通用本地配置
//  4. builtinProfiles 中 exeSize 精确匹配的配置
//  5. 默认配置（builtinProfiles[0]）
func selectActiveProfile(exeSize uintptr) *MemoryProfile {
	externals := loadExternalProfiles()

	forced := strings.TrimSpace(os.Getenv("TOTK_PC_PROFILE"))
	if forced != "" && !strings.EqualFold(forced, "auto") {
		for _, p := range externals {
			if p.ID == forced {
				setActiveProfileState(p, true, true)
				return p
			}
		}
		for i := range builtinProfiles {
			if builtinProfiles[i].ID == forced {
				p := builtinProfiles[i]
				setActiveProfileState(&p, true, true)
				return &p
			}
		}
	}

	if exeSize != 0 {
		for _, p := range externals {
			if p.Fingerprint.ExeSize == exeSize {
				setActiveProfileState(p, true, false)
				return p
			}
		}
	}
	for _, p := range externals {
		if p.Fingerprint.ExeSize == 0 {
			setActiveProfileState(p, false, false)
			return p
		}
	}
	if exeSize != 0 {
		for i := range builtinProfiles {
			if builtinProfiles[i].Fingerprint.ExeSize == exeSize {
				p := builtinProfiles[i]
				setActiveProfileState(&p, true, false)
				return &p
			}
		}
	}
	if _, gv := getDetectedVersions(); gv != "" {
		for i := range builtinProfiles {
			if builtinProfiles[i].GameVersion == gv {
				p := builtinProfiles[i]
				setActiveProfileState(&p, true, false)
				return &p
			}
		}
	}
	p := builtinProfiles[0]
	setActiveProfileState(&p, false, false)
	return &p
}

func setActiveProfile(prof *MemoryProfile) {
	setActiveProfileState(prof, true, false)
}

func setActiveProfileState(prof *MemoryProfile, exact, forced bool) {
	activeProfMu.Lock()
	activeProf = prof
	activeProfExact = exact
	activeProfForced = forced
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

func activeProfileMatchTag() string {
	activeProfMu.RLock()
	exact := activeProfExact
	forced := activeProfForced
	activeProfMu.RUnlock()
	if forced {
		return "手动指定"
	}
	if exact {
		return "精确匹配"
	}
	return "默认回退"
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
