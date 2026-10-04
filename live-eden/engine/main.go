// TOTKNavi-Eden（TOTK live 追踪服务，Go 版，Eden 模拟器适配）
//
// 用途：在本地为互动地图 https://totk.yalin.site/ 提供实时角色追踪。
// 原理：读 Eden 模拟器进程内存定位玩家坐标 → HTTP API（127.0.0.1:8766）
// → 在线地图页跨域连接显示红点/轨迹/导航。
//
// 定位核心（watch.go）是单一状态机：UNLOCKED（known 快路径/存档锚点扫描）→
// LOCKED（跟随 + 移动确认 + 传送检测 + 30s 站桩核对），自动处理传送、场景
// 切换、游戏重启，无需手动"调整"。
//
// 用法：xnavi-core-eden.exe [port] [--no-open] [--no-save]

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
	"time"
)

const mapURL = "https://totk.yalin.site/"

func main() {
	// GUI 壳（xnavi-gui）按 "YYYY-MM-DD HH:mm:ss.SSS" 前缀解析日志时间列，
	// 这里统一给 stdout 每行加时间戳（移植自 xnavi/log_ts.go，打印点零改动）。
	enableLogTimestamps()
	setConsoleTitle("TOTKNavi-Eden · TOTK Live")

	port := 8766
	autoOpen := true
	for _, a := range os.Args[1:] {
		switch {
		case a == "--no-open":
			autoOpen = false
		case a == "--no-save":
			useSaveScan = false
		case strings.HasPrefix(a, "--"):
			// ignore
		default:
			if n, err := strconv.Atoi(a); err == nil {
				port = n
			}
		}
	}

	fmt.Println("=" + strings.Repeat("=", 61))
	fmt.Println(" TOTKNavi-Eden · TOTK live - auto locating player position")
	fmt.Println("=" + strings.Repeat("=", 61))

	pid := findPid("eden")
	if pid != 0 {
		h, err := openProcess(pid)
		if err != nil || h == 0 {
			fmt.Printf("OpenProcess failed. Try running as administrator.\n")
			return
		}
		procHandle, procPID = h, pid
		fmt.Printf("  pid = %d\n", pid)
	} else {
		fmt.Println("  Eden not running yet - the state machine attaches as soon as it appears.")
	}

	// Eden 版：无块世代检测（区域集合动态变化不可作重启判据，见 watch.go
	// detectNewBlocks）。游戏重启由 known 绝对地址失效 → 全量扫描兜底。

	progress = newProgressWatcher()
	go progress.loop()

	go navClearLoop() // V1.1.0：GUI 清除目标文件通信
	go coordsLoop()   // V1.4.0：GUI 坐标校准定位（coords-req.json 文件通道）
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
	fmt.Println("  (Ctrl+C to stop)")

	if autoOpen {
		openBrowser(mapURL)
	}

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Printf("\n  listen %s failed: %v\n", addr, err)
		fmt.Println("  端口被占用：可能已有 TOTKNavi / live-python 服务在运行。")
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
	fmt.Printf("  API -> http://%s/pos\n", addr)
	http.Serve(ln, &server{})
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
