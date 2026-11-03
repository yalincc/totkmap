// server_pc.go — HTTP 定位服务（--serve），协议对齐 totknavi/server.go 的 /pos。
//
// 网页端（app/）只认 /pos 这个接口，所以字段名与语义必须与模拟器版一致：
//   gx = X 东（HUD 显示值）
//   gy = -Y北（HUD 的 Y 取反；TOTK 内存存的是 +Y 北，HUD 显示有时取反）
//   gz = 真实高度（= Z_stored - elevBias）
//   mx,my = (-gy, gx)  → Leaflet latlng = (Z北, X东)，与 totknavi tracker.go 同口径
//
// 暂不支持的能力（PC 版差异，前端需容忍）：
//   - layer 分层判定：依赖天空高度图 + markers 数据（totknavi 的 sky.go），
//     这里先返回 null，前端按"未知层"处理
//   - /progress（存档进度）：存档格式已确认可用，后续单独接
//   - /set-coords：PC 版直接用 --coords 启动参数代替

package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

//go:embed gui.html
var guiHTML []byte

// posState 定位状态（HTTP /pos 读取；tracker goroutine 写）。
type posState struct {
	mu         sync.RWMutex
	ok         bool
	gx, gy, gz float32
	mx, my     float32
	copies     int
	source     string
	updated    time.Time
	locks      int // 本会话重锁次数
	rescans    int // 本会话重扫次数

	// 朝向：方位角，北=0°、东=90°（顺时针递增）。hasHeading=false 时字段无效。
	heading     float32
	hasHeading  bool
	verified    bool // 移动确认已通过（对齐 totknavi 的 verified 语义）
	gameRunning bool
	pid         uint32
	lockedAddr  uintptr
}

var pstate = posState{gameRunning: true}

func (s *posState) setGameStatus(running bool, pid uint32, locked uintptr) {
	s.mu.Lock()
	s.gameRunning = running
	s.pid = pid
	s.lockedAddr = locked
	if !running {
		s.ok = false
	}
	s.mu.Unlock()
}

func (s *posState) publish(g [3]float32, heading float32, hasHeading bool, verified bool, source string) {
	s.mu.Lock()
	s.ok = true
	s.gx, s.gy, s.gz = g[0], g[1], g[2]
	s.mx, s.my = -g[1], g[0] // 与 totknavi tracker.go 同口径
	s.heading = heading
	s.hasHeading = hasHeading
	s.verified = verified
	s.source = source
	s.updated = time.Now()
	s.mu.Unlock()
}

func (s *posState) markLost() {
	s.mu.Lock()
	s.ok = false
	s.mu.Unlock()
}

func (s *posState) bumpLock() {
	s.mu.Lock()
	s.locks++
	s.mu.Unlock()
}

func (s *posState) bumpRescan() {
	s.mu.Lock()
	s.rescans++
	s.mu.Unlock()
}

// targetT 导航目标（对齐 totknavi/server.go，供网页端 /target 读写与连线）
type targetT struct {
	Id    any      `json:"id,omitempty"`
	Name  string   `json:"name"`
	X     float64  `json:"x"`
	Y     float64  `json:"y"`
	Z     *float64 `json:"z,omitempty"`
	Type  string   `json:"type"`
	Layer any      `json:"layer"`
	Ts    float64  `json:"ts"`
}

var (
	targetMu  sync.Mutex
	curTarget *targetT
)

func setTargetPC(t *targetT) {
	targetMu.Lock()
	curTarget = t
	targetMu.Unlock()
}

func getTargetPC() *targetT {
	targetMu.Lock()
	defer targetMu.Unlock()
	return curTarget
}

func clearTargetPC() {
	targetMu.Lock()
	defer targetMu.Unlock()
	curTarget = nil
}

// serveRun 启动追踪 + HTTP 服务（阻塞）。
func serveRun(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr, port int, appRoot string) {
	loadShrineEntrances()
	go trackerLoop(p, plat, anchor, addr)
	startStatusAndCoordsLoop(p)

	// 存档进度（探索度/神庙/任务）——直接复用 totknavi 的 progressWatcher，
	// 存档格式与模拟器版一致，数据表共用 app/data。
	if progress == nil {
		progress = newProgressWatcher()
		go progress.loop()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/pos", handlePosPC)
	mux.HandleFunc("/target", handleTargetPC)
	mux.HandleFunc("/progress", handleProgressPC)
	mux.HandleFunc("/rescan", handleRescanPC)
	mux.HandleFunc("/set-coords", handleSetCoordsPC)
	mux.HandleFunc("/save", handleSavePC)
	mux.HandleFunc("/logs", handleLogsPC)
	mux.HandleFunc("/save-info", handleSaveInfoPC)
	mux.HandleFunc("/gui", handleGuiPC)

	initLanURL(port)

	// 智能多级探测地图网页目录（必须包含 index.html）
	appRoot = findAppDir(appRoot)
	if appRoot != "" {
		fileServer := http.FileServer(http.Dir(appRoot))
		// /botw/ 路由：手机镜像专用（契约：live.js 依此识别同源局域网服务）
		mux.Handle("/botw/", http.StripPrefix("/botw/", fileServer))
		mux.Handle("/", fileServer)
		fmt.Printf("\n  [server] 地图网页 → http://127.0.0.1:%d/\n", port)
		if lanURL != "" {
			fmt.Printf("  [server] 手机镜像 → %s\n", lanURL)
		}
		fmt.Printf("  [server] 网页目录 → %s\n", appRoot)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprintf(w, "totknavi-pc 定位服务运行中\n\nGET /pos  → 当前位置 JSON\n\n（未找到地图网页目录 app/，可用 --app 指定）\n")
		})
		fmt.Printf("\n  [server] 未找到网页目录（仅提供 /pos 定位接口）\n")
	}

	// 全接口监听（0.0.0.0:port），允许同一 WiFi 下手机扫码连入
	listenAddr := fmt.Sprintf(":%d", port)
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		fmt.Printf("\n  [server] 端口 %d 启动失败：%v\n", port, err)
		fmt.Printf("  换个端口：--port 8767\n")
		return
	}
	fmt.Printf("  [server] 控制台面板 → http://127.0.0.1:%d/gui\n", port)
	fmt.Printf("  [server] 定位接口   → http://127.0.0.1:%d/pos\n", port)
	fmt.Println("  ------------------------------------------------------------------")

	// 统一包装跨域 CORS、PNA（私有网络访问预检）与自定义暴露头
	corsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Expose-Headers", "X-Save-Slot, X-Save-Mtime")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})

	if err := http.Serve(ln, corsHandler); err != nil {
		fmt.Printf("  [server] 已停止：%v\n", err)
	}
}

func handlePosPC(w http.ResponseWriter, r *http.Request) {
	s := &pstate
	s.mu.RLock()
	age := time.Since(s.updated).Seconds()
	var heading any // 前端按 number 判断，无朝向时给 null
	if s.hasHeading {
		heading = s.heading
	}
	// 分层判定（18 地底 / 19 地表 / 20 天空）：四级漏斗地形高度图 + 天空多边形 + 3D点云
	var layerVal any
	if s.ok {
		layerVal = layerOf(s.gx, s.gy, s.gz)
	}
	payload := map[string]any{
		"ok":       s.ok,
		"gx":       s.gx,
		"gy":       s.gy,
		"gz":       s.gz,
		"mx":       s.mx,
		"my":       s.my,
		"heading":  heading, // 方位角：北=0°、东=90°；null = 未取到
		"layer":    layerVal,
		"age":      age,
		"verified": s.verified,
		"copies":   s.copies,
		"source":   s.source,
		"locks":    s.locks,
		"rescans":  s.rescans,
		"game":         "totk-pc",
		"game_running": s.gameRunning,
		"pid":          s.pid,
		"locked_addr":  fmt.Sprintf("0x%X", s.lockedAddr),
	}
	s.mu.RUnlock()

	targetMu.Lock()
	payload["target"] = curTarget
	targetMu.Unlock()

	// 进度代次：前端靠它判断「存档有没有变」，变了才去拉 /progress。
	// 缺了这三个字段，网页上的进度面板永远不会刷新（2026-10-31 踩坑）。
	if progress != nil {
		_, gen, mt, updated := progress.snapshotPos()
		payload["progressGen"] = gen
		payload["save_mtime"] = mt
		payload["save_updated"] = updated
	}
	if lanURL != "" {
		payload["lanUrl"] = lanURL
	}
	writeJSONPC(w, payload)
}

func handleTargetPC(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		var obj map[string]any
		if err := json.NewDecoder(r.Body).Decode(&obj); err != nil {
			obj = map[string]any{}
		}
		if clear, _ := obj["clear"].(bool); clear {
			clearTargetPC()
			writeJSONPC(w, map[string]any{"ok": true, "target": nil})
			return
		}
		var zPtr *float64
		if obj["z"] != nil {
			zv := fltPC(obj["z"])
			zPtr = &zv
		}
		t := &targetT{
			Id:    obj["id"],
			Name:  strPC(obj["name"]),
			X:     fltPC(obj["x"]),
			Y:     fltPC(obj["y"]),
			Z:     zPtr,
			Type:  strPC(obj["type"]),
			Layer: obj["layer"],
			Ts:    float64(time.Now().UnixNano()) / 1e9,
		}
		setTargetPC(t)
		writeJSONPC(w, map[string]any{"ok": true, "target": t})
	} else {
		if t := getTargetPC(); t != nil {
			writeJSONPC(w, t)
		} else {
			writeJSONPC(w, map[string]any{"ok": false})
		}
	}
}

func strPC(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func fltPC(v any) float64 {
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

// handleProgressPC 返回服务端现算的进度（doneIds + counts），语义同 totknavi。
func handleProgressPC(w http.ResponseWriter, r *http.Request) {
	if progress == nil {
		writeJSONPC(w, map[string]any{"ok": false})
		return
	}
	ok, body, _ := progress.snapshot()
	progress.clearUpdated()
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Cache-Control", "no-store")
	if !ok || len(body) == 0 {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"ok":false}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Write(body)
}

// handleRescanPC 处理前端请求重扫。
func handleRescanPC(w http.ResponseWriter, r *http.Request) {
	RequestRescan()
	writeJSONPC(w, map[string]any{"ok": true, "started": true})
}

// handleSetCoordsPC 手动提交 HUD 坐标校准重锁。
func handleSetCoordsPC(w http.ResponseWriter, r *http.Request) {
	var obj map[string]any
	if err := json.NewDecoder(r.Body).Decode(&obj); err != nil {
		writeJSONPC(w, map[string]any{"ok": false, "error": "bad json"})
		return
	}
	flt := func(v any) float32 {
		switch t := v.(type) {
		case float64:
			return float32(t)
		case float32:
			return t
		case int:
			return float32(t)
		default:
			return 0
		}
	}
	gx, gy, gz := flt(obj["x"]), flt(obj["y"]), flt(obj["z"])
	if gx == 0 && gy == 0 && gz == 0 {
		writeJSONPC(w, map[string]any{"ok": false, "error": "empty coords"})
		return
	}
	RequestSetCoords([3]float32{gx, gy, gz})
	writeJSONPC(w, map[string]any{"ok": true, "message": "calibrating"})
}

// handleSavePC 返回原始 progress.sav 字节（必须走完全共享读取）。
func handleSavePC(w http.ResponseWriter, r *http.Request) {
	mt, path := findLatestProgress()
	if path == "" {
		w.WriteHeader(http.StatusNotFound)
		writeJSONPC(w, map[string]any{"ok": false, "error": "no save file"})
		return
	}
	data, err := readFileShared(path)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		writeJSONPC(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Save-Slot", filepath.Base(filepath.Dir(path)))
	w.Header().Set("X-Save-Mtime", fmt.Sprintf("%.0f", mt))
	w.Write(data)
}

func writeJSONPC(w http.ResponseWriter, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	w.Header().Set("Cache-Control", "no-store")
	buf, _ := json.Marshal(obj)
	w.Write(buf)
}

// trackerLoop 把追踪结果发布到 pstate（HTTP /pos 消费）。
// 追踪逻辑全在 tracker.go，这里只做状态发布。
func trackerLoop(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr) {
	runTracker(p, plat, anchor, addr, func(pos [3]float32, hd float32, hasH, verified bool, src string) {
		if src == "lost" || src == "no-anchor" {
			pstate.markLost()
			return
		}
		pstate.publish(pos, hd, hasH, verified, src)
	})
}

func handleLogsPC(w http.ResponseWriter, r *http.Request) {
	writeJSONPC(w, map[string]any{
		"ok":   true,
		"logs": getRecentLogs(),
	})
}

func handleSaveInfoPC(w http.ResponseWriter, r *http.Request) {
	anchors := readAnchors(currentPlatform())
	if len(anchors) == 0 {
		writeJSONPC(w, map[string]any{"ok": false, "error": "未检测到存档"})
		return
	}
	a := anchors[0]
	hud := [3]float32{a.Pos[0], -a.Pos[2], a.Pos[1] - elevBias}
	writeJSONPC(w, map[string]any{
		"ok":    true,
		"path":  a.Path,
		"time":  a.Mod.Format("2006-01-02 15:04:05"),
		"hud":   hud,
		"total": len(anchors),
	})
}

func handleGuiPC(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(guiHTML)
}

var lanURL string

func initLanURL(port int) {
	ip := defaultRouteIPv4()
	if ip == "" {
		if ips := lanIPv4s(); len(ips) > 0 {
			ip = ips[0]
		}
	}
	if ip != "" {
		lanURL = fmt.Sprintf("http://%s:%d/botw/?follow=1&game=totk", ip, port)
	}
}

// defaultRouteIPv4 取本机出公网的默认路由 IPv4（UDP dial 不发包，仅选路）；
// 手机与 PC 同 WiFi 时，这个 IP 就是手机能直达的局域网地址。
func defaultRouteIPv4() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if la, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return la.IP.String()
	}
	return ""
}

// lanIPv4s 列出本机非回环 IPv4 地址（移动端局域网镜像 URL 用）。
func lanIPv4s() []string {
	var out []string
	ifas, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, ifa := range ifas {
		if ifa.Flags&net.FlagUp == 0 || ifa.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifa.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue
			}
			out = append(out, ip.String())
		}
	}
	return out
}

// findAppDir 智能多级探测包含 index.html 的网页目录
func findAppDir(custom string) string {
	candidates := []string{}
	if custom != "" {
		candidates = append(candidates, custom)
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "app"),
			filepath.Join(dir, "..", "app"),
			filepath.Join(dir, "..", "..", "app"),
			filepath.Join(dir, "..", "..", "..", "app"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "app"),
			filepath.Join(wd, "..", "app"),
		)
	}
	// 工作区默认绝对路径兜底（开发环境）
	candidates = append(candidates,
		`E:\WorkSpace\TOTKmap\app`,
		`..\TOTKmap\app`,
		`..\..\TOTKmap\app`,
	)
	for _, cand := range candidates {
		idx := filepath.Join(cand, "index.html")
		if fi, err := os.Stat(idx); err == nil && !fi.IsDir() {
			if abs, err := filepath.Abs(cand); err == nil {
				return abs
			}
			return cand
		}
	}
	return ""
}
