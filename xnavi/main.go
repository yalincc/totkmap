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
// 用法：xnavi.exe [port] [--emu=auto|ryujinx|eden] [--no-open] [--no-save]

package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
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
	for _, a := range os.Args[1:] {
		switch {
		case a == "--no-open":
			autoOpen = false
		case a == "--no-save":
			useSaveScan = false
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
		lanURL = makeLanURL(port, "totk")
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

// makeLanURL 构造移动端镜像 URL：http://<IP>:<port>/botw/?follow=1&game=totk
func makeLanURL(port int, game string) string {
	ip := defaultRouteIPv4()
	if ip == "" {
		if ips := lanIPv4s(); len(ips) > 0 {
			ip = ips[0]
		}
	}
	if ip == "" {
		return ""
	}
	return fmt.Sprintf("http://%s:%d/botw/?follow=1&game=%s", ip, port, game)
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
