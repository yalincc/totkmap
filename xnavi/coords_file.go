// coords_file.go — GUI 坐标校准文件通道（coords-req.json → coords-resp.json）。
//
// 与 nav-clear.json 同模式（双入口：GUI 不依赖 8766 HTTP，8766 被占时校准照常）。
// GUI 写 coords-req.json（{x,y,z,ts}）→ 本循环消费 → 调当前平台的 coordsLocate
// （Eden 全内存三轴精确匹配，同步约 10s）→ 写 coords-resp.json 供 GUI 轮询。
// 移植自 live-eden engine/coords.go，入口统一到 locator 接口的 coordsStarter。

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func coordsReqPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-req.json")
}
func coordsRespPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "coords-resp.json")
}

// coordsFileLoop 每 250ms 轮询 GUI 的坐标请求文件（与 nav-clear.json 同模式）。
func coordsFileLoop() {
	for {
		time.Sleep(250 * time.Millisecond)
		p := coordsReqPath()
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		os.Remove(p)
		// 防 BOM：外部工具（PowerShell Set-Content -Encoding utf8 等）写入可能带 BOM。
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
		fmt.Printf("  [coords] GUI calibration: game hud (%.1f, %.1f, %.1f)\n", req.X, req.Y, req.Z)
		var resp coordsResp
		if plat := currentPlatform(); plat != nil {
			if cs, ok := plat.(coordsStarter); ok {
				// 校准是独立入口（GUI 可在 core 刚启动时提交），状态机可能尚未
				// attach —— 先 ensureAttach 保证句柄就绪（原版 reopenProcess 同职责）。
				ensureAttach()
				resp = cs.coordsLocate(float32(req.X), float32(req.Y), float32(req.Z))
			} else {
				resp = coordsResp{Error: "当前平台不支持坐标校准（仅 Eden）"}
			}
		} else {
			resp = coordsResp{Error: "平台未就绪，请先启动定位"}
		}
		buf, _ := json.Marshal(resp)
		os.WriteFile(coordsRespPath(), buf, 0644)
		fmt.Printf("  [coords] result: ok=%v addr=%s copies=%d dur=%dms err=%s\n",
			resp.Ok, resp.Addr, resp.Copies, resp.DurMs, resp.Error)
	}
}
