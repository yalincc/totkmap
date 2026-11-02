// monitor_pc.go — 对接 totknavi-gui 的 status.json 写入器与 coords-req.json 文件通道。

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func statusPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "status.json")
}

func coordsReqPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-req.json")
}

func coordsRespPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-resp.json")
}

// startStatusAndCoordsLoop 启动对 totknavi-gui 的 status.json 状态同步与坐标校准通道。
func startStatusAndCoordsLoop(p Platform) {
	go statusLoop(p)
	go coordsFileLoop()
}

func statusLoop(p Platform) {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		s := &pstate
		s.mu.RLock()
		ok := s.ok
		gx, gy, gz := s.gx, s.gy, s.gz
		mx, my := s.mx, s.my
		verified := s.verified
		source := s.source
		lockedAddr := s.lockedAddr
		pid := s.pid
		ageSec := time.Since(s.updated).Seconds()
		locks := s.locks
		rescans := s.rescans
		s.mu.RUnlock()

		if !ok {
			ageSec = 999
		}

		layer := 18
		if ok {
			layer = layerOf(gx, gy, gz)
		}
		obj := map[string]any{
			"time":     time.Now().Format(time.RFC3339),
			"pid":      pid,
			"ok":       ok,
			"game":     "totk",
			"emulator": "TotK-PC",
			"mode":     "PC-live",
			"lockAddr": fmt.Sprintf("0x%X", lockedAddr),
			"verified": verified,
			"source":   source,
			"layer":    layer,
			"pos": map[string]any{
				"gx": gx,
				"gy": gy,
				"gz": gz,
				"mx": mx,
				"my": my,
			},
			"ageSec":  ageSec,
			"map_url": "https://totk.yalin.site/?follow=1",
			"counters": map[string]any{
				"locks":     locks,
				"relocates": 0,
				"jumps":     0,
				"scans":     rescans,
			},
			"target": getTargetPC(),
		}
		if lanURL != "" {
			obj["lanUrl"] = lanURL
		}

		if progress != nil {
			if ok2, body, _ := progress.snapshot(); ok2 && len(body) > 0 {
				var raw struct {
					Save   string  `json:"save"`
					Mtime  float64 `json:"mtime"`
					Counts map[string]struct {
						Done  int `json:"done"`
						Total int `json:"total"`
					} `json:"counts"`
				}
				if json.Unmarshal(body, &raw) == nil && raw.Counts != nil {
					obj["progress"] = map[string]any{"save": raw.Save, "counts": raw.Counts, "mtime": raw.Mtime}
					obj["save"] = raw.Save
					obj["saveMtime"] = raw.Mtime
				}
			}
		}

		buf, err := json.Marshal(obj)
		if err == nil {
			sp := statusPath()
			tmp := sp + ".tmp"
			if os.WriteFile(tmp, buf, 0644) == nil {
				os.Rename(tmp, sp)
			}
		}
	}
}

func coordsFileLoop() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		p := coordsReqPath()
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		os.Remove(p)
		data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
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
		logEvent("  [coords] 收到 GUI 坐标校准请求: HUD (%.1f, %.1f, %.1f)", req.X, req.Y, req.Z)
		RequestSetCoords([3]float32{float32(req.X), float32(req.Y), float32(req.Z)})

		resp := map[string]any{
			"ok":    true,
			"ready": true,
		}
		buf, _ := json.Marshal(resp)
		os.WriteFile(coordsRespPath(), buf, 0644)
	}
}

