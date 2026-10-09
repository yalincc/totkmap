// HTTP API：供在线地图页（https://totk.yalin.site/）跨域连接。
// 端点：GET /pos、GET/POST /target、GET /rescan、GET /progress。
// 所有响应带 CORS 头 + Private Network Access 预检头（Chrome 对
// "公网 HTTPS 页面 → http://127.0.0.1" 的请求强制要求）。
//
// V1.0.0 合并新增：
//   - /pos 增加 lanUrl 字段（手机局域网定位镜像，BOTW V1.5.0 同款协议）
//   - /botw/ 静态托管网页（手机同 WiFi 直接访问，与 /pos 同源，
//     规避 Mixed Content / CORS / PNA；BOTW xnavi v3.0.2 同款）
//
// 蓝本：TOTKmap live-go/server.go（V1.8.7）+ BOTWmap xnavi/server.go（v3.0.2）。

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type targetT struct {
	Name  string  `json:"name"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Type  string  `json:"type"`
	Layer any     `json:"layer,omitempty"` // 18/19/20 或 null
	Ts    float64 `json:"ts"`
}

var (
	targetMu sync.Mutex
	target   *targetT
)

// lanURL 局域网镜像地址（main.go 启动时算好；手机同 WiFi 访问入口）。
var lanURL string

// corsHeaders 写入跨域 + PNA 头。
func corsHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Private-Network", "true")
	h.Set("Cache-Control", "no-store")
}

func writeJSON(w http.ResponseWriter, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	corsHeaders(w)
	buf, _ := json.Marshal(obj)
	w.Write(buf)
}

// ---- /botw/ 静态托管 ----
// 网页目录探测顺序：exe 上一级 app/（发布布局：xnavi/ + ../app）→
// 工作目录上级 app/（开发布局：cwd=TOTKmap/xnavi，../app）→
// TOTKmap 开发目录绝对路径 + 相对兜底（BOTW xnavi 同款，release 包也能挂开发目录）。
// 全部缺失时仅 API 可用（核心导航不受影响）。

var botwFS http.Handler
var botwRoot string

func initBotwFS() {
	roots := []string{}
	exe, err := os.Executable()
	if err == nil {
		roots = append(roots,
			filepath.Join(filepath.Dir(exe), "..", "app"),
			filepath.Join(filepath.Dir(exe), "app"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, filepath.Join(wd, "..", "app"))
	}
	// V2.4.0：release 包（release/TOTKNavi-v2.1.0）旁边无 app/ 时，
	// 兜底到开发目录（BOTW server.go botwRoots 同款：绝对路径 + 相对路径）
	roots = append(roots,
		`E:\WorkSpace\TOTKmap\app`,
		`..\TOTKmap\app`,
		`..\..\TOTKmap\app`,
	)
	for _, r := range roots {
		fi, e := os.Stat(r)
		if e == nil && fi.IsDir() {
			botwRoot = r
			break
		}
	}
	if botwRoot == "" {
		return
	}
	botwFS = http.StripPrefix("/botw/", http.FileServer(http.Dir(botwRoot)))
}

type server struct{}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if path == "" {
		path = "/"
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	// 手机镜像静态页（/botw/ 前缀）；未配置目录时落入 API 路由。
	if strings.HasPrefix(path, "/botw/") {
		if botwFS != nil {
			botwFS.ServeHTTP(w, r)
			return
		}
		writeJSON(w, map[string]any{"ok": false, "error": "app dir not found"})
		return
	}

	switch path {
	case "/pos":
		s.handlePos(w, r)
	case "/target":
		if r.Method == http.MethodPost {
			s.handleTargetPost(w, r)
		} else {
			if t := getTarget(); t != nil {
				writeJSON(w, t)
			} else {
				writeJSON(w, map[string]any{"ok": false})
			}
		}
	case "/rescan":
		if r.Method == http.MethodGet {
			requestRescan()
			writeJSON(w, map[string]any{"started": true})
		} else {
			writeJSON(w, map[string]any{"ok": false})
		}
	case "/progress":
		s.handleProgress(w, r)
	case "/set-coords":
		if r.Method == http.MethodPost {
			s.handleSetCoords(w, r)
		} else {
			writeJSON(w, map[string]any{"ok": false})
		}
	default:
		writeJSON(w, map[string]any{"ok": false, "error": "unknown endpoint"})
	}
}

// handleSetCoords 坐标校准 HTTP 入口（Eden 特有；Ryujinx 返回不支持）。
// 同步执行全 RAM 精确扫描（约 10s），命中后经 coordsDone 通知状态机接管。
func (s *server) handleSetCoords(w http.ResponseWriter, r *http.Request) {
	var obj map[string]any
	if err := json.NewDecoder(r.Body).Decode(&obj); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "bad json"})
		return
	}
	gx, gy, gz := flt(obj["x"]), flt(obj["y"]), flt(obj["z"])
	if gx == 0 && gy == 0 && gz == 0 {
		writeJSON(w, map[string]any{"ok": false, "error": "empty coords"})
		return
	}
	cs, ok := currentPlatform().(coordsStarter)
	if !ok {
		writeJSON(w, map[string]any{"ok": false, "error": "该平台不支持坐标校准（Eden 专用）"})
		return
	}
	resp := cs.coordsLocate(float32(gx), float32(gy), float32(gz))
	writeJSON(w, map[string]any{
		"ok": resp.Ok, "addr": resp.Addr,
		"gx": resp.Gx, "gy": resp.Gy, "gz": resp.Gz,
		"copies": resp.Copies, "error": resp.Error, "durMs": resp.DurMs,
	})
}

func (s *server) handlePos(w http.ResponseWriter, r *http.Request) {
	state.mu.RLock()
	payload := map[string]any{
		"ok":       state.ok,
		"gx":       state.gx,
		"gy":       state.gy,
		"gz":       state.gz,
		"mx":       state.mx,
		"my":       state.my,
		"layer":    state.layer,
		"age":      state.age,
		"verified": state.verified,
		"copies":   state.copies,
		"source":   state.source,
	}
	state.mu.RUnlock()
	if lanURL != "" {
		payload["lanUrl"] = lanURL // 手机镜像入口（BOTW V1.5.0 协议）
	}
	targetMu.Lock()
	payload["target"] = target
	targetMu.Unlock()
	if progress != nil {
		_, _, gen := progress.snapshot()
		payload["progressGen"] = gen
	}
	writeJSON(w, payload)
}

// handleProgress 返回 TOTK 服务端现算进度（doneIds + counts，与 live-python 同构）。
func (s *server) handleProgress(w http.ResponseWriter, r *http.Request) {
	if progress == nil {
		writeJSON(w, map[string]any{"ok": false})
		return
	}
	ok, body, _ := progress.snapshot()
	if !ok || len(body) == 0 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		corsHeaders(w)
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":false}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	corsHeaders(w)
	w.Write(body)
}

func (s *server) handleTargetPost(w http.ResponseWriter, r *http.Request) {
	var obj map[string]any
	if err := json.NewDecoder(r.Body).Decode(&obj); err != nil {
		obj = map[string]any{}
	}
	if clear, _ := obj["clear"].(bool); clear {
		clearTarget()
		writeJSON(w, map[string]any{"ok": true, "target": nil})
		return
	}
	t := &targetT{
		Name:  str(obj["name"]),
		X:     flt(obj["x"]),
		Y:     flt(obj["y"]),
		Type:  str(obj["type"]),
		Layer: obj["layer"],
		Ts:    float64(time.Now().UnixNano()) / 1e9,
	}
	setTarget(t)
	writeJSON(w, map[string]any{"ok": true, "target": t})
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func flt(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case float32:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}
