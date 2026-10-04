// HTTP API：供在线地图页（https://totk.yalin.site/）跨域连接。
// 端点：GET /pos、GET/POST /target、GET /rescan、GET /progress。
// 所有响应带 CORS 头 + Private Network Access 预检头（Chrome 对
// "公网 HTTPS 页面 → http://127.0.0.1" 的请求强制要求）。

package main

import (
	"encoding/json"
	"net/http"
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
	default:
		writeJSON(w, map[string]any{"ok": false, "error": "unknown endpoint"})
	}
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
