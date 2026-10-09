// xnavi（TOTK live 追踪服务，合并版）
//
// 用途：在本地为互动地图 https://totk.yalin.site/ 提供实时角色追踪。
// 原理：读 Ryujinx / Eden 模拟器进程内存定位玩家坐标 → HTTP API
// （:8766 全接口，手机同 WiFi 可直达 /botw/ 镜像）→ 在线地图页跨域连接
// 显示红点/轨迹/导航。
//
// 合并自 TOTKmap live-go（Ryujinx，V1.8.7）+ live-eden（Eden，V1.1）。
// 定位核心（watch.go）是单一状态机，平台差异全部隔离在 platform*.go。
//
// 用法：xnavi.exe [port] [--emu=auto|ryujinx|eden] [--no-open] [--no-save] [--tls] [--tls-cert-dir=DIR]
// V2.1.1：新增 --tls —— 8766 起 HTTPS（手机镜像页 secure context，wakeLock 防息屏生效）。
// 证书默认取工作目录 certs/server.pem + server.key（certs/gen-cert.ps1 一键生成）。

package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const mapURL = "https://totk.yalin.site/?follow=1" // V2.4.0: 导航转跳地图直接 800% + 跟随

func main() {
	// GUI 壳（xnavi-gui）按 "YYYY-MM-DD HH:mm:ss.SSS" 前缀解析日志时间列。
	enableLogTimestamps()
	setConsoleTitle("xnavi · TOTK Live")

	port := 8766
	autoOpen := true
	emuSel := "auto" // auto | ryujinx | eden
	tlsMode := false // --tls：8766 起 HTTPS（V2.1.1）
	certDir := "certs"
	for _, a := range os.Args[1:] {
		switch {
		case a == "--no-open":
			autoOpen = false
		case a == "--no-save":
			useSaveScan = false
		case a == "--tls":
			tlsMode = true
		case strings.HasPrefix(a, "--tls-cert-dir="):
			certDir = strings.TrimPrefix(a, "--tls-cert-dir=")
		case strings.HasPrefix(a, "--emu="):
			emuSel = strings.TrimPrefix(a, "--emu=")
		case strings.HasPrefix(a, "--"):
			// ignore
		default:
			if n, err := strconv.Atoi(a); err == nil {
				port = n
			}
		}
	}
	switch emuSel {
	case "auto", "ryujinx", "eden":
	default:
		fmt.Printf("  unknown --emu=%s (auto|ryujinx|eden)\n", emuSel)
		flushLog()
		os.Exit(1)
	}

	// 单实例锁（BOTW xnavi 同款）：避免同端口重复进程互相干扰。
	if !acquireMutex("Local\\xnavi-totk") {
		fmt.Println("  another xnavi instance is already running - exiting")
		flushLog()
		os.Exit(1)
	}

	fmt.Println("=" + strings.Repeat("=", 61))
	fmt.Println(" xnavi · TOTK live - auto locating player position")
	fmt.Println("=" + strings.Repeat("=", 61))
	fmt.Printf("  version = %s (core)\n", CoreVersion)

	// ---- 平台选择 ----
	autoPlatform = (emuSel == "auto") // auto 模式下平台可自动切换（Ryujinx ↔ Eden）
	if emuSel != "auto" {
		for _, p := range probeList {
			if strings.EqualFold(p.Name(), emuSel) {
				setPlatform(p)
				break
			}
		}
		if currentPlatform() == nil {
			fmt.Printf("  no platform driver named %q\n", emuSel)
			flushLog()
			os.Exit(1)
		}
	} else {
		p := probePlatform()
		if p == nil {
			fmt.Println("  no emulator running yet - the state machine attaches as soon as one appears.")
		} else if p.Handle() != 0 {
			fmt.Printf("  attached to %s pid=%d\n", p.Name(), p.PID())
		}
	}

	// 块世代检测（启动前置，仅 Ryujinx 语义）：参照块不在 → 游戏重启过 →
	// 只扫当前会话块，避免锁到旧块残留槽（值可读但位置错误、永不更新）。
	// Eden 内存区域动态分配，不可作重启判据（locator.detectNewBlocks 恒 nil），
	// 且其全部块枚举走 edenMinBlockMB（64KB 区域，开销大），此处直接跳过。
	if p := currentPlatform(); p != nil && p.Handle() != 0 {
		if _, isRyu := p.(*ryujinxPlatform); isRyu {
			blks := p.Blocks(minBlockMB)
			if newOnes := detectNewBlocks(blks); newOnes != nil {
				fmt.Printf("  [gen] game-restart detected at startup\n")
				bestBase, bestSize := uintptr(0), uintptr(0)
				for _, b := range blks {
					for _, nb := range newOnes {
						if b.Base == nb && b.Size > bestSize {
							bestBase, bestSize = b.Base, b.Size
						}
					}
				}
				currentSessionBase = bestBase
				fmt.Printf("  [gen] current session block 0x%X\n", currentSessionBase)
			}
		}
	}

	// 手机镜像静态目录（/botw/ 托管网页）。
	initBotwFS()
	if botwRoot != "" {
		fmt.Printf("  web root -> %s\n", botwRoot)
	} else {
		fmt.Println("  [warn] app dir not found - /botw/ mirror disabled (API only)")
	}

	progress = newProgressWatcher()
	go progress.loop()

	go navClearLoop() // GUI 清除目标文件通信
	go coordsFileLoop() // GUI 坐标校准文件通信（coords-req.json）
	go stateMachine()
	go statusLoop()

	time.Sleep(500 * time.Millisecond)

	state.mu.RLock()
	st, _ := json.Marshal(map[string]any{
		"ok": state.ok, "gx": state.gx, "gy": state.gy, "gz": state.gz,
		"mx": state.mx, "my": state.my, "layer": state.layer,
		"age": state.age, "verified": state.verified, "copies": state.copies,
		"source": state.source,
	})
	state.mu.RUnlock()
	fmt.Println("")
	fmt.Printf("  serving -> %s\n", st)
	fmt.Printf("  live map -> %s\n", mapURL)
	if p := currentPlatform(); p != nil {
		lanURL = makeLanURL(port, "totk", tlsMode)
		if lanURL != "" {
			fmt.Printf("  phone mirror (same WiFi) -> %s\n", lanURL)
		} else {
			fmt.Println("  phone mirror unavailable (no LAN IPv4 address)")
		}
	}
	fmt.Println("  (Ctrl+C to stop)")

	if autoOpen {
		openBrowser(mapURL)
	}

	// 全接口监听：手机同 WiFi 访问 /botw/ 镜像（BOTW V1.5.0 同款）。
	addr := fmt.Sprintf(":%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Printf("\n  listen %s failed: %v\n", addr, err)
		fmt.Println("  端口被占用：可能已有 xnavi / TOTKNavi / live-python 服务在运行。")
		if owner := portOwner(port); owner != "" {
			fmt.Printf("  占用进程：%s\n", owner)
			fmt.Println("  请先结束旧进程（任务管理器或执行  taskkill /F /PID <pid>）后再启动。")
		} else {
			fmt.Println("  请检查是否有其他程序占用该端口。")
		}
		fmt.Println("  5 秒后自动退出……")
		time.Sleep(5 * time.Second)
		flushLog() // stdout 已被换成管道，不刷会吞掉上面这些提示
		os.Exit(1)
	}
	// V2.1.1：--tls 模式 → 8766 双协议共存（http + https 同端口）。
	// 手机镜像页 https（secure context，wakeLock 防息屏）；在线地图页
	// （写死 http://127.0.0.1:8766 轮询）、手机旧 http 书签、GUI TCP 探测
	// 继续走明文通道，全部兼容，不再产生 TLS handshake error 刷屏。
	scheme := "http"
	if tlsMode {
		scheme = "https"
		certFile := filepath.Join(certDir, "server.pem")
		keyFile := filepath.Join(certDir, "server.key")
		if _, err := os.Stat(certFile); err != nil {
			fmt.Printf("\n  --tls 证书缺失：%s\n", certFile)
			fmt.Println("  请先运行 certs/gen-cert.ps1 生成证书，或去掉 --tls 以 http 模式启动。")
			fmt.Println("  5 秒后自动退出……")
			flushLog()
			time.Sleep(5 * time.Second)
			os.Exit(1)
		}
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err != nil {
			fmt.Printf("\n  --tls 证书加载失败：%v\n", err)
			fmt.Println("  请重新运行 certs/gen-cert.ps1 生成证书，或去掉 --tls 以 http 模式启动。")
			fmt.Println("  5 秒后自动退出……")
			flushLog()
			time.Sleep(5 * time.Second)
			os.Exit(1)
		}
		tlsCfg := &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		dl := newDualListener(ln, tlsCfg)
		go dl.run()
		hdl := &server{}
		// TLS 通道的握手错误（畸形客户端/预检）属预期，过滤不刷屏；明文通道错误保留。
		errLog := log.New(&errFilter{w: os.Stderr}, "", log.LstdFlags)
		plainSrv := &http.Server{Handler: hdl, ErrorLog: errLog}
		secureSrv := &http.Server{Handler: hdl, ErrorLog: log.New(io.Discard, "", 0)}
		fmt.Printf("  API -> %s://127.0.0.1:%d/pos (http + https dual mode)\n", scheme, port)
		go plainSrv.Serve(dl.plain)
		secureSrv.Serve(dl.secure)
		return
	}
	fmt.Printf("  API -> http://127.0.0.1:%d/pos\n", port)
	http.Serve(ln, &server{})
}

// ---- 单实例锁（BOTW xnavi 同款）----

var mutexHandle uintptr

func acquireMutex(name string) bool {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	createMutexW := kernel32.NewProc("CreateMutexW")
	p, _ := syscall.UTF16PtrFromString(name)
	r, _, lastErr := createMutexW.Call(0, 0, uintptr(unsafe.Pointer(p)))
	if r == 0 {
		return false
	}
	if e, ok := lastErr.(syscall.Errno); ok && e == 183 { // ERROR_ALREADY_EXISTS
		return false
	}
	mutexHandle = r
	return true
}

// makeLanURL 构造移动端镜像 URL：http(s)://<IP>:<port>/botw/?follow=1&game=totk
// V2.1.1：tlsMode 时输出 https（手机镜像页 secure context，wakeLock 防息屏生效）。
func makeLanURL(port int, game string, tlsMode bool) string {
	ip := defaultRouteIPv4()
	if ip == "" {
		if ips := lanIPv4s(); len(ips) > 0 {
			ip = ips[0]
		}
	}
	if ip == "" {
		return ""
	}
	scheme := "http"
	if tlsMode {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%d/botw/?follow=1&game=%s", scheme, ip, port, game)
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

func openBrowser(url string) {
	// 用默认浏览器打开
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	if err := cmd.Start(); err != nil {
		fmt.Printf("  (could not open browser: %v)\n", err)
	}
}

// portOwner 返回占用端口的进程描述（netstat + tasklist）。
func portOwner(port int) string {
	out, err := exec.Command("netstat", "-ano").Output()
	if err != nil {
		return ""
	}
	pat := fmt.Sprintf(":%d", port)
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, pat) && strings.Contains(line, "LISTENING") {
			f := strings.Fields(line)
			if len(f) >= 5 {
				pid := f[4]
				pout, perr := exec.Command("tasklist", "/FI", "PID eq "+pid, "/FO", "CSV", "/NH").Output()
				if perr == nil {
					name := strings.Trim(strings.SplitN(string(pout), ",", 2)[0], "\"")
					return fmt.Sprintf("%s (pid %s)", name, pid)
				}
				return "pid " + pid
			}
		}
	}
	return ""
}

// ---- 双协议监听（V2.1.1）：同端口 http + https 共存 ----
// 原理：Accept 后预读首字节；0x16（TLS 记录头）→ TLS 通道，否则明文 HTTP 通道。
// 连接被立即关闭（如 GUI 的 TCP 端口探测）→ 首字节读取失败 → 静默丢弃，
// 不再走到 TLS 握手，因此不产生 "TLS handshake error: EOF" 之类刷屏日志。

// bufConn 保存预读缓冲的 bufio.Reader，首字节已在其中。
type bufConn struct {
	net.Conn
	r *bufio.Reader
}

func (c *bufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// chanListener 从 channel 接收连接（http.Server.Serve 的 listener 接口）。
type chanListener struct {
	addr net.Addr
	ch   chan net.Conn
	done chan struct{}
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.ch:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *chanListener) Close() error {
	select {
	case <-l.done:
	default:
		close(l.done)
	}
	return nil
}
func (l *chanListener) Addr() net.Addr { return l.addr }

// dualListener 分派器：底层 tcp 监听 → 按首字节分派到明文/TLS 通道。
type dualListener struct {
	ln     net.Listener
	tlsCfg *tls.Config
	plain  *chanListener
	secure *chanListener
}

func newDualListener(ln net.Listener, tlsCfg *tls.Config) *dualListener {
	return &dualListener{
		ln:     ln,
		tlsCfg: tlsCfg,
		plain:  &chanListener{addr: ln.Addr(), ch: make(chan net.Conn, 16), done: make(chan struct{})},
		secure: &chanListener{addr: ln.Addr(), ch: make(chan net.Conn, 16), done: make(chan struct{})},
	}
}

func (d *dualListener) run() {
	for {
		c, err := d.ln.Accept()
		if err != nil {
			d.plain.Close()
			d.secure.Close()
			return
		}
		go d.dispatch(c)
	}
}

func (d *dualListener) dispatch(c net.Conn) {
	br := bufio.NewReader(c)
	first, err := br.Peek(1)
	if err != nil {
		c.Close() // 连接立即关闭（探测类）→ 静默丢弃
		return
	}
	if first[0] == 0x16 { // TLS ClientHello 首字节
		select {
		case d.secure.ch <- tls.Server(&bufConn{Conn: c, r: br}, d.tlsCfg):
		default:
			c.Close()
		}
		return
	}
	select {
	case d.plain.ch <- &bufConn{Conn: c, r: br}:
	default:
		c.Close()
	}
}

// errFilter 过滤预期内的 TLS 握手错误日志，其余原样输出。
type errFilter struct{ w io.Writer }

func (f *errFilter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("TLS handshake error")) {
		return len(p), nil
	}
	return f.w.Write(p)
}
