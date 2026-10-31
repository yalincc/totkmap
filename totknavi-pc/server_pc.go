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
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

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
	heading    float32
	hasHeading bool
	verified   bool // 移动确认已通过（对齐 totknavi 的 verified 语义）
}

var pstate = posState{}

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

// serveRun 启动追踪 + HTTP 服务（阻塞）。
func serveRun(p Platform, plat *totkpcPlatform, anchor *[3]float32, addr uintptr, port int, appRoot string) {
	go trackerLoop(p, plat, anchor, addr)

	// 存档进度（探索度/神庙/任务）——直接复用 totknavi 的 progressWatcher，
	// 存档格式与模拟器版一致，数据表共用 app/data。
	if progress == nil {
		progress = newProgressWatcher()
		go progress.loop()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/pos", handlePosPC)
	mux.HandleFunc("/progress", handleProgressPC)

	// 静态托管地图网页：默认指向 ../app（TOTKmap 主项目的网页，**不复制**，
	// 避免两份 8000+ 瓦片文件各自维护）。可用 --app 指定其它目录。
	// 注意：/pos 是精确路径，优先于 "/" 匹配，不会被文件服务吃掉。
	if appRoot == "" {
		if exe, err := os.Executable(); err == nil {
			appRoot = filepath.Join(filepath.Dir(exe), "..", "app")
		}
	}
	if fi, err := os.Stat(appRoot); err == nil && fi.IsDir() {
		mux.Handle("/", http.FileServer(http.Dir(appRoot)))
		fmt.Printf("\n  [server] 地图网页 → http://127.0.0.1:%d/\n", port)
		fmt.Printf("  [server] 网页目录 → %s\n", appRoot)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			fmt.Fprintf(w, "totknavi-pc 定位服务运行中\n\nGET /pos  → 当前位置 JSON\n\n（未找到地图网页目录 %s，用 --app 指定）\n", appRoot)
		})
		fmt.Printf("\n  [server] 未找到网页目录 %s（只提供 /pos）\n", appRoot)
	}

	listenAddr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		fmt.Printf("\n  [server] 端口 %d 启动失败：%v\n", port, err)
		fmt.Printf("  换个端口：--port 8767\n")
		return
	}
	fmt.Printf("  [server] 定位接口 → http://127.0.0.1:%d/pos\n", port)
	fmt.Println("  ------------------------------------------------------------------")

	if err := http.Serve(ln, mux); err != nil {
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
	// 分层判定（18 地底 / 19 地表 / 20 天空）：完全复用 sky.go 的高度图 + 天空多边形 + markers。
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
		"game":     "totk-pc",
	}
	s.mu.RUnlock()

	// 进度代次：前端靠它判断「存档有没有变」，变了才去拉 /progress。
	// 缺了这三个字段，网页上的进度面板永远不会刷新（2026-10-31 踩坑）。
	if progress != nil {
		_, gen, mt, updated := progress.snapshotPos()
		payload["progressGen"] = gen
		payload["save_mtime"] = mt
		payload["save_updated"] = updated
	}
	writeJSONPC(w, payload)
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
