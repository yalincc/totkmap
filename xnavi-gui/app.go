package main

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	stdruntime "runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// guiVersion 导航程序版本（与地图网页版本解耦，见 BOTWmap 项目规则第 3 条）。
const guiVersion = "v1.1.0"

// App Wails 后端：管理核心子进程 + 读 status.json / xnavi-gui-core.log + 网页端端口探测。
// 与核心的通信完全走文件（status.json、xnavi-gui-core.log），不依赖 8766 HTTP——
// 保证 GUI 与网页端两个入口相互独立（ds 双入口原则）：8766 被占时 GUI 照常工作。
type App struct {
	ctx       context.Context
	mu        sync.Mutex
	cmd       *exec.Cmd
	workDir   string
	logBuf    []string
	logMarker string
	cfg       *Config
}

// Config GUI 持久化配置（xnavi-gui-config.json）。
// V1.1.0 精简：只保留 Ryujinx + TOTK（去掉 Cemu/Emulator/Game 选项）。
// 旧 config json 的多余字段由 json.Unmarshal 自动忽略，向前兼容。
type Config struct {
	RyujinxDir string `json:"ryujinxDir"`
	SaveDir    string `json:"saveDir"`
}

func (a *App) configPath() string { return filepath.Join(a.workDir, "xnavi-gui-config.json") }

func (a *App) loadConfig() *Config {
	cfg := &Config{}
	buf, err := os.ReadFile(a.configPath())
	if err == nil {
		json.Unmarshal(buf, cfg)
	}
	return cfg
}

func (a *App) SaveConfig(c Config) string {
	a.cfg = &c
	buf, _ := json.MarshalIndent(c, "", "  ")
	os.WriteFile(a.configPath(), buf, 0644)
	return "已保存"
}

func (a *App) LoadConfig() Config {
	if a.cfg == nil {
		a.cfg = a.loadConfig()
	}
	return *a.cfg
}

func NewApp() *App {
	exe, _ := os.Executable()
	return &App{workDir: filepath.Dir(exe)}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.cfg = a.loadConfig()
	a.tailInit()
	go a.eventBridge(ctx)
	go a.checkUpdate()
	go a.ensureWindowVisible()
	// 手动检查更新
	runtime.EventsOn(ctx, "update:check", func(data ...interface{}) {
		go a.checkUpdate()
	})
}

// ensureWindowVisible 启动后把主窗口移回主屏可见区域。
// 防御性兜底：若窗口因 DPI 缩放/多屏/分辨率切换落在屏幕外（部分超屏），
// 用 EnumWindows 按进程 PID 找主窗口（比 FindWindow 标题匹配可靠），
// 超界则 SetWindowPos 移到主屏居中；窗口本来就在屏内则不动。
func (a *App) ensureWindowVisible() {
	time.Sleep(1 * time.Second)
	user32 := syscall.NewLazyDLL("user32.dll")
	enumWindows := user32.NewProc("EnumWindows")
	getWindowThreadProcessId := user32.NewProc("GetWindowThreadProcessId")
	getWindowRect := user32.NewProc("GetWindowRect")
	getSystemMetrics := user32.NewProc("GetSystemMetrics")
	setWindowPos := user32.NewProc("SetWindowPos")

	const (
		smCxScreen = 0
		smCyScreen = 1
		swpNoZ     = 0x0004
		swpNoAct   = 0x0010
	)

	myPid := uint32(os.Getpid())
	var hwnd uintptr
	cb := syscall.NewCallback(func(h uintptr, lparam uintptr) uintptr {
		var pid uint32
		getWindowThreadProcessId.Call(h, uintptr(unsafe.Pointer(&pid)))
		if pid == myPid {
			hwnd = h
			return 0 // 停止枚举
		}
		return 1
	})
	enumWindows.Call(cb, 0)
	if hwnd == 0 {
		return
	}

	var rect struct {
		Left, Top, Right, Bottom int32
	}
	if r, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); r == 0 {
		return
	}
	sw, _, _ := getSystemMetrics.Call(smCxScreen)
	sh, _, _ := getSystemMetrics.Call(smCyScreen)
	if int32(sw) == 0 || int32(sh) == 0 {
		return
	}
	w := rect.Right - rect.Left
	h := rect.Bottom - rect.Top
	// 窗口完全在屏幕内 → 不动
	if rect.Left >= 0 && rect.Top >= 0 && rect.Right <= int32(sw) && rect.Bottom <= int32(sh) {
		return
	}
	x := (int32(sw) - w) / 2
	y := (int32(sh) - h) / 2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	setWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(w), uintptr(h), swpNoZ|swpNoAct)
	fmt.Println("  [gui] window repositioned to center:", x, y)
}

// checkUpdate 启动时查 GitHub tags 列表，找最新 totknavi- 开头的 tag，有新版弹窗。
func (a *App) checkUpdate() {
	defer func() { recover() }()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.github.com/repos/yalincc/totkmap/tags?per_page=30")
	if err != nil { return }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var tags []struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(body, &tags) != nil { return }
	// 遍历全部 totknavi- tag，取版本号最大的（tags 列表本身按创建时间排序，版本号需自行比较）
	best := ""
	for _, t := range tags {
		if !strings.HasPrefix(t.Name, "totknavi-") { continue }
		v := strings.TrimPrefix(t.Name, "totknavi-")
		if best == "" || verGreater(v, best) {
			best = v
		}
	}
	if best == "" {
		runtime.EventsEmit(a.ctx, "update:latest", nil)
		return
	}
	if verGreater(best, guiVersion) {
		runtime.EventsEmit(a.ctx, "update:available", map[string]string{
			"latest": best,
			"url":    "https://github.com/yalincc/totkmap/releases/tag/totknavi-" + best,
		})
	} else {
		runtime.EventsEmit(a.ctx, "update:latest", nil)
	}
}

// verGreater 比较 "vX.Y.Z" 版本号，x > y 返回 true。
// 非标准格式（缺段/非数字）按 0 补全，保证解析不 panic。
func verGreater(x, y string) bool {
	px := parseVer(x)
	py := parseVer(y)
	for i := 0; i < 3; i++ {
		if px[i] > py[i] { return true }
		if px[i] < py[i] { return false }
	}
	return false
}

func parseVer(s string) [3]int {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "V")
	var r [3]int
	parts := strings.Split(s, ".")
	for i := 0; i < len(parts) && i < 3; i++ {
		n := 0
		for _, c := range parts[i] {
			if c < '0' || c > '9' { break }
			n = n*10 + int(c-'0')
		}
		r[i] = n
	}
	return r
}

func (a *App) PickDir(title string) string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil { return "" }
	return dir
}

func (a *App) onShutdown(ctx context.Context) {
	a.stopCoreLocked()
}

// eventBridge 每 300ms 推一次状态与日志增量（Wails Runtime 事件流）。
// V1.1.0：800ms → 300ms（status.json 由 core 400ms 写，300ms 采样观感更跟手）。
func (a *App) eventBridge(ctx context.Context) {
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			st := a.CoreStatus()
			runtime.EventsEmit(ctx, "status:update", st)
			if lines := a.PollLogs(); len(lines) > 0 {
				runtime.EventsEmit(ctx, "log:append", lines)
			}
		}
	}
}

// Version 返回 GUI 版本号（前端显示用）。
func (a *App) Version() string { return guiVersion }

// Calibrate 基准校准（S3）：把用户从游戏地图读到的坐标写入 calibrate.json，
// core 轮询消费（文件通信，遵守双入口原则）。返回提示文案。
func (a *App) Calibrate(x, y, z float64) string {
	req := map[string]any{"x": x, "y": y, "z": z, "ts": time.Now().UnixNano()}
	buf, _ := json.Marshal(req)
	if err := os.WriteFile(filepath.Join(a.workDir, "calibrate.json"), buf, 0644); err != nil {
		return "写入校准请求失败: " + err.Error()
	}
	return "校准请求已提交（约 5-10 秒出结果，看日志面板 [calib] 行）"
}

// ClearTarget 请求 core 清除导航目标（V1.1.0）。
// 文件通信：写 nav-clear.json，core 的 navClearLoop 消费后 clearTarget() 并删除；
// 地图端 /pos 下一轮读到 target=null，引导线同步消失（双向同步，core 是唯一状态持有者）。
func (a *App) ClearTarget() string {
	if err := os.WriteFile(filepath.Join(a.workDir, "nav-clear.json"), []byte("{}"), 0644); err != nil {
		return "写入清除请求失败: " + err.Error()
	}
	return "已请求清除目标（地图同步取消）"
}

// corePath 核心子进程 exe 路径：与 GUI 同目录的 xnavi-core.exe。
func (a *App) corePath() string {
	return filepath.Join(a.workDir, "xnavi-core.exe")
}

// StartCore 启动核心子进程（xnavi-core.exe --emu=ryujinx --game=totk --no-open [--ryujinx-dir=] [--save-dir=]）。
// V1.1.0：固定 Ryujinx + TOTK，不再有模拟器/游戏选项。
// 重复调用会先停掉旧进程。
func (a *App) StartCore() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopCoreLocked()
	exe := a.corePath()
	if _, err := os.Stat(exe); err != nil {
		return "找不到核心程序 xnavi-core.exe（应放在本程序同目录）"
	}
	args := []string{"--emu=ryujinx", "--game=totk", "--no-open"}
	if a.cfg != nil {
		if a.cfg.RyujinxDir != "" {
			args = append(args, "--ryujinx-dir="+a.cfg.RyujinxDir)
		}
		if a.cfg.SaveDir != "" {
			args = append(args, "--save-dir="+a.cfg.SaveDir)
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = a.workDir
	// core 是控制台程序，但 GUI 已经在日志面板实时显示它的输出，
	// 这里把它的控制台窗口隐藏，避免弹一个黑窗且里面空白（stdout 重定向到了文件）。
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	f, err := os.OpenFile(filepath.Join(a.workDir, "xnavi-gui-core.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		cmd.Stdout = f
		cmd.Stderr = f
	}
	if err := cmd.Start(); err != nil {
		return "启动失败: " + err.Error()
	}
	a.cmd = cmd
	go func() { cmd.Wait(); a.mu.Lock(); if a.cmd == cmd { a.cmd = nil }; a.mu.Unlock() }()
	return "核心已启动（Ryujinx · TOTK）"
}

// StopCore 停止核心子进程。
func (a *App) StopCore() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopCoreLocked()
	return "已停止"
}

func (a *App) stopCoreLocked() {
	if a.cmd != nil && a.cmd.Process != nil {
		a.cmd.Process.Kill()
		a.cmd = nil
	}
}

// CoreRunning 核心子进程是否在运行。
func (a *App) CoreRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cmd != nil && a.cmd.Process != nil && a.cmd.ProcessState == nil
}

// statusPath 核心每 2s 写的会话快照。
func (a *App) statusPath() string { return filepath.Join(a.workDir, "status.json") }

// CoreStatus 读 status.json 并附加 GUI 侧状态（running / webOK / webNote）。
func (a *App) CoreStatus() map[string]any {
	a.mu.Lock()
	running := a.cmd != nil && a.cmd.Process != nil
	a.mu.Unlock()
	obj := map[string]any{"running": running}
	buf, err := os.ReadFile(a.statusPath())
	if err == nil && json.Unmarshal(buf, &obj) == nil {
	} else {
		obj["ok"] = false
		obj["note"] = "核心未写入状态（未运行或启动中）"
	}
	// 网页端可用性：核心运行且 8766 未被外部占用 → 可用。
	// 核心日志里出现 "HTTP 端口被占用" 说明核心启动时 listen 失败。
	obj["webOK"] = !portInUse(8766) || running
	obj["webNote"] = ""
	if !running {
		if portInUse(8766) {
			obj["webOK"] = false
			obj["webNote"] = "端口 8766 被其他程序占用：网页端不可用（GUI 定位不受影响）"
		} else {
			obj["webNote"] = "网页端待核心启动后可用"
		}
	} else if strings.Contains(a.lastLog(), "HTTP 端口被占用") {
		obj["webOK"] = false
		obj["webNote"] = "HTTP 端口被占用：网页端不可用，GUI 定位正常（双入口独立）"
	}
	return obj
}

// TailLog 返回日志缓冲（环形，最多 2000 行）。
func (a *App) TailLog() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.logBuf))
	copy(out, a.logBuf)
	return out
}

// lastLog 最近 N 行拼接（供关键字扫描）。
func (a *App) lastLog() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := len(a.logBuf)
	if n > 50 {
		n = 50
	}
	return strings.Join(a.logBuf[len(a.logBuf)-n:], "\n")
}

// tailInit 首次加载 xnavi-gui-core.log 末尾（最多 2000 行）。
func (a *App) tailInit() {
	os.WriteFile(filepath.Join(a.workDir, "xnavi-gui-core.log"), nil, 0644)
	a.logMarker = ""
}

// appendLines 追加日志到环形缓冲（2000 行上限，ds 提醒 2）。
func (a *App) appendLines(lines []string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, l := range lines {
		if l == "" {
			continue
		}
		a.logBuf = append(a.logBuf, l)
	}
	const max = 2000
	if len(a.logBuf) > max {
		a.logBuf = a.logBuf[len(a.logBuf)-max:]
	}
}

// PollLogs 前端轮询：返回 xnavi-gui-core.log 新增行（增量读）。
func (a *App) PollLogs() []string {
	path := filepath.Join(a.workDir, "xnavi-gui-core.log")
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	content := string(buf)
	// 记录已读字节偏移，避免重发
	if content == a.logMarker {
		return nil
	}
	if strings.HasPrefix(content, a.logMarker) {
		newPart := strings.TrimPrefix(content, a.logMarker)
		lines := strings.Split(strings.ReplaceAll(newPart, "\r\n", "\n"), "\n")
		a.appendLines(lines)
		a.logMarker = content
		return a.lastNLines(lines)
	}
	// 文件被轮转/替换：全量重读
	a.logMarker = content
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	a.appendLines(lines)
	return a.lastNLines(lines)
}

var _ = fmt.Sprintf

func (a *App) lastNLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// OpenLogDir 打开日志/数据目录（方便用户反馈时复制日志）。
func (a *App) OpenLogDir() string {
	exec.Command("explorer", a.workDir).Start()
	return "已打开日志目录"
}

// hostname returns machine name (best effort).
func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

// ExportDiagnostics 一键导出诊断包（zip）：系统信息 + status.json + core 日志 + 事件日志。
// 用户在反馈问题前点这个，选保存位置，把 zip 发回来即可。
func (a *App) ExportDiagnostics() string {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "导出诊断包",
		DefaultFilename: fmt.Sprintf("xnavi-diag-%s.zip", time.Now().Format("20060102-150405")),
		Filters:         []runtime.FileFilter{{DisplayName: "ZIP 压缩包", Pattern: "*.zip"}},
	})
	if err != nil || path == "" {
		return "已取消"
	}
	if !strings.HasSuffix(strings.ToLower(path), ".zip") {
		path += ".zip"
	}
	zipFile, err := os.Create(path)
	if err != nil {
		return "创建失败: " + err.Error()
	}
	defer zipFile.Close()
	w := zip.NewWriter(zipFile)
	defer w.Close()

	// 1) 系统信息
	info := fmt.Sprintf(
		"xnavi diagnostics\n===================\nGUI version: %s\nOS: %s/%s\nArch: %s\nCPU cores: %d\nHostname: %s\nTime: %s\nRyujinxDir configured: %q\nSaveDir override: %q\n\n",
		guiVersion, stdruntime.GOOS, stdruntime.GOARCH, stdruntime.GOARCH,
		stdruntime.NumCPU(), hostname(),
		time.Now().Format("2006-01-02 15:04:05"),
		func() string { if a.cfg != nil { return a.cfg.RyujinxDir }; return "" }(),
		func() string { if a.cfg != nil { return a.cfg.SaveDir }; return "" }(),
	)
	if bw, e := w.Create("info.txt"); e == nil {
		bw.Write([]byte(info))
	}

	// 2) 工作目录下的日志/状态文件（core 写的）
	for _, name := range []string{"status.json", "xnavi-gui-core.log", "run-events.log"} {
		buf, err := os.ReadFile(filepath.Join(a.workDir, name))
		if err != nil {
			continue
		}
		if bw, e := w.Create(name); e == nil {
			bw.Write(buf)
		}
	}
	return "已导出: " + path
}

// portInUse 探测端口是否被占用。
func portInUse(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 400*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// EnvDetect 探测"已配置的"Ryujinx 路径是否存在（仅给前端做提示，不挡开始按钮）。
// V1.1.0：只查 Ryujinx（TOTK 专用）。
func (a *App) EnvDetect() map[string]any {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	res := map[string]any{"ryujinx": false}
	if cfg != nil && cfg.RyujinxDir != "" && pathExists(cfg.RyujinxDir) {
		res["ryujinx"] = true
	}
	return res
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
