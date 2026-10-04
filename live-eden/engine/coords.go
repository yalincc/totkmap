// coords.go — 坐标校准定位（2026-10-04 方案 A 落地之一）
//
// 背景：Eden 全量扫描的 copies 排序/窗口扫描在"玩家远离存档位置"时失效
// （占位槽 copies 海量霸榜、probe 拒绝低 copies 真槽 → 无限重扫死循环）。
// 游戏 HUD 直接显示玩家坐标，据此做"三轴精确匹配"是全内存确定性定位：
// 换算内存三轴 (X, alt+105, -Y北) 后全 RAM 扫 float32 三元组（±1.5m），
// 命中即真槽——不需要窗口、不需要 copies 排序、不会把正确地址排除。
//
// 触发方式：GUI 写 coords-req.json（{x,y,z,ts}）→ coordsLoop 消费 →
// 命中后经 coordsCh 通知状态机锁定 + 写 known_addrs.json（下次启动秒锁）。
// 与 nav-clear.json 同模式（双入口文件通道，GUI 不依赖 8766 HTTP）。

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// coordsLockReq 坐标定位成功后发给状态机的接管指令。
type coordsLockReq struct {
	addr   uintptr
	pos    [3]float32 // hud 序 (X, -Y北, alt)
	copies int
}

var coordsCh = make(chan coordsLockReq, 1)

// coordsBusy 防止坐标搜索期间状态机同时全量扫描（双扫描竞争浪费 10s+）。
var (
	coordsMu   sync.Mutex
	coordsBusy bool
)

func coordsReqPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-req.json")
}
func coordsRespPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-resp.json")
}

func setCoordsBusy(v bool) {
	coordsMu.Lock()
	coordsBusy = v
	coordsMu.Unlock()
}
func isCoordsBusy() bool {
	coordsMu.Lock()
	defer coordsMu.Unlock()
	return coordsBusy
}

// coordsLoop 每 250ms 轮询 GUI 的坐标请求文件（与 nav-clear.json 同模式）。
func coordsLoop() {
	for {
		time.Sleep(250 * time.Millisecond)
		p := coordsReqPath()
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		os.Remove(p)
		var req struct {
			X  float64 `json:"x"`
			Y  float64 `json:"y"`
			Z  float64 `json:"z"`
			Ts float64 `json:"ts"`
		}
		if json.Unmarshal(data, &req) != nil {
			continue
		}
		if req.X == 0 && req.Y == 0 && req.Z == 0 {
			continue
		}
		fmt.Printf("  [coords] GUI calibration: game hud (%.1f, %.1f, %.1f)\n", req.X, req.Y, req.Z)
		resp := runCoordsLocate(float32(req.X), float32(req.Y), float32(req.Z))
		buf, _ := json.Marshal(resp)
		os.WriteFile(coordsRespPath(), buf, 0644)
		fmt.Printf("  [coords] result: ok=%v addr=%s copies=%d dur=%dms err=%s\n",
			resp.Ok, resp.Addr, resp.Copies, resp.DurMs, resp.Error)
	}
}

// coordsResp GUI 轮询的结果结构。
type coordsResp struct {
	Ok     bool    `json:"ok"`
	Addr   string  `json:"addr,omitempty"`
	Gx     float64 `json:"gx,omitempty"` // hud 序（校准后的锁定坐标）
	Gy     float64 `json:"gy,omitempty"`
	Gz     float64 `json:"gz,omitempty"`
	Copies int     `json:"copies,omitempty"`
	Error  string  `json:"error,omitempty"`
	DurMs  int64   `json:"durMs"`
}

// runCoordsLocate 执行坐标引导定位（同步，全 RAM 扫描约 10s；GUI/HTTP 均入口）。
func runCoordsLocate(gx, gy, gz float32) coordsResp {
	t0 := time.Now()
	if isCoordsBusy() {
		return coordsResp{Error: "另一路坐标搜索进行中，请稍候", DurMs: 0}
	}
	if !reopenProcess() {
		return coordsResp{Error: "Eden 进程未附加", DurMs: elapsedMs(t0)}
	}
	h := procHandleNow()

	// 游戏 HUD 坐标序 = decodePos 输出序 (X, -Y北, alt)：
	// 内存序 (X, Z_stored, Y_north)，Z_stored = alt + elevBias(105)，Y_north = -gy。
	target := [3]float32{gx, gz + elevBias, -gy}
	fmt.Printf("  [coords] target mem (%.1f, %.1f, %.1f)\n", target[0], target[1], target[2])

	setCoordsBusy(true)
	defer setCoordsBusy(false)
	blocks := guestBlocksCached(h, minBlockMB)
	var hits []Hit
	scanAll(h, blocks, [][3]float32{target}, 1.5, &hits)

	// 校验命中：结构有效（rotOK）优先；无 rotOK 时接受任意解码有效槽
	// （相机槽/精简槽也可能无完整旋转矩阵，但三轴精确匹配的误中率本就极低）。
	var cands []uintptr
	for _, hit := range hits {
		if d := decodePos(readMem(h, hit.Addr, 12)); d != nil {
			if rotOK(h, hit.Addr) {
				cands = append(cands, hit.Addr)
			}
		}
	}
	if len(cands) == 0 {
		for _, hit := range hits {
			if decodePos(readMem(h, hit.Addr, 12)) != nil {
				cands = append(cands, hit.Addr)
			}
		}
	}
	if len(cands) == 0 {
		return coordsResp{
			Error: fmt.Sprintf("未命中：目标内存坐标 (%.1f, %.1f, %.1f)，扫描 %d 个区域 0 匹配。请保持角色站桩后重试（游戏内坐标需与角色实际位置一致）",
				target[0], target[1], target[2], len(blocks)),
			DurMs: elapsedMs(t0),
		}
	}
	addr := cands[0]
	pos := decodePos(readMem(h, addr, 12))
	select {
	case coordsCh <- coordsLockReq{addr: addr, pos: [3]float32{pos[0], pos[1], pos[2]}, copies: len(cands)}:
	default:
	}
	// 写 known：保存全部命中地址（副本簇，knownCap=10 截断）。副本轮换时
	// knownWatch/共识观察有活槽可换，避免"只有 1 条地址 → 轮换后全死"卡死。
	// 神庙本地槽会被 knownSlotOK 过滤，不会污染 known。
	saveKnown(cands, 0)
	return coordsResp{
		Ok:     true,
		Addr:   fmt.Sprintf("0x%X", addr),
		Gx:     float64(pos[0]),
		Gy:     float64(pos[1]),
		Gz:     float64(pos[2]),
		Copies: len(cands),
		DurMs:  elapsedMs(t0),
	}
}

func elapsedMs(t0 time.Time) int64 {
	return time.Since(t0).Milliseconds()
}
