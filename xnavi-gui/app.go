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

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// guiVersion 导航程序版本（与地图网页版本解耦，见 BOTWmap 项目规则第 3 条）。
const guiVersion = "v1.0.0"

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
type Config struct {
	CemuDir    string `json:"cemuDir"`
	RyujinxDir string `json:"ryujinxDir"`
	SaveDir    string `json:"saveDir"`
	Emulator   string `json:"emulator"` // auto | cemu | ryujinx
	Game       string `json:"game"`     // auto | botw | totk（V2.2.0 双游戏）
}

func (a *App) configPath() string { return filepath.Join(a.workDir, "xnavi-gui-config.json") }

func (a *App) loadConfig() *Config {
	cfg := &Config{Emulator: "auto", Game: "auto"}
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
	// 手动检查更新
	runtime.EventsOn(ctx, "update:check", func(data ...interface{}) {
		go a.checkUpdate()
	})
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
	found := false
	for _, t := range tags {
		if !strings.HasPrefix(t.Name, "totknavi-") { continue }
		latest := strings.TrimPrefix(t.Name, "totknavi-")
		if latest != guiVersion {
			runtime.EventsEmit(a.ctx, "update:available", map[string]string{
				"latest": latest,
				"url":    "https://github.com/yalincc/totkmap/releases/tag/" + t.Name,
			})
		} else {
			runtime.EventsEmit(a.ctx, "update:latest", nil)
		}
		found = true
		break
	}
	if !found {
		runtime.EventsEmit(a.ctx, "update:latest", nil)
	}
}

func (a *App) PickDir(title string) string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil { return "" }
	return dir
}

func (a *App) onShutdown(ctx context.Context) {
	a.stopCoreLocked()
}

// eventBridge 每 800ms 推一次状态与日志增量（Wails Runtime 事件流）。
func (a *App) eventBridge(ctx context.Context) {
	ticker := time.NewTicker(800 * time.Millisecond)
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

// corePath 核心子进程 exe 路径：与 GUI 同目录的 xnavi-core.exe。
func (a *App) corePath() string {
	return filepath.Join(a.workDir, "xnavi-core.exe")
}

// StartCore 启动核心子进程（xnavi-core.exe --emu=<emu> [--game=<game>] --no-open）。
// emu: auto | ryujinx | cemu；game 从已保存配置读取（auto | botw | totk，auto 时不传让 core 自动识别）。
// 重复调用会先停掉旧进程。
func (a *App) StartCore(emu string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopCoreLocked()
	exe := a.corePath()
	if _, err := os.Stat(exe); err != nil {
		return "找不到核心程序 xnavi-core.exe（应放在本程序同目录）"
	}
	args := []string{"--emu=" + emu, "--no-open"}
	game := ""
	if a.cfg != nil {
		game = a.cfg.Game
	}
	if game != "" && game != "auto" {
		args = append(args, "--game="+game)
	}
	if a.cfg.CemuDir != "" {
		args = append(args, "--cemu-dir="+a.cfg.CemuDir)
	}
	if a.cfg.RyujinxDir != "" {
		args = append(args, "--ryujinx-dir="+a.cfg.RyujinxDir)
	}
	if a.cfg.SaveDir != "" {
		args = append(args, "--save-dir="+a.cfg.SaveDir)
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
	msg := "核心已启动（" + emu + "）"
	if game != "" && game != "auto" {
		msg += " · 游戏 " + game
	}
	return msg
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
		"xnavi diagnostics\n===================\nGUI version: %s\nOS: %s/%s\nArch: %s\nCPU cores: %d\nHostname: %s\nTime: %s\nEmulator setting: %s\nCemuDir configured: %q\nRyujinxDir configured: %q\nSaveDir override: %q\n\n",
		guiVersion, stdruntime.GOOS, stdruntime.GOARCH, stdruntime.GOARCH,
		stdruntime.NumCPU(), hostname(),
		time.Now().Format("2006-01-02 15:04:05"),
		func() string {
			if a.cfg != nil {
				return a.cfg.Emulator
			}
			return "auto"
		}(),
		func() string { if a.cfg != nil { return a.cfg.CemuDir }; return "" }(),
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

// EnvDetect 探测"已配置的"模拟器路径是否存在（仅给前端做提示，不挡开始按钮）。
// 真实"是否附加到运行中的模拟器进程"由 core 经 status.json 的 pid 上报，
// 这里不再硬编码开发机盘符——任何用户机器上都不该因为路径猜不到而点不了开始。
func (a *App) EnvDetect() map[string]any {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	res := map[string]any{"ryujinx": false, "cemu": false}
	if cfg != nil {
		if cfg.CemuDir != "" && pathExists(cfg.CemuDir) {
			res["cemu"] = true
		}
		if cfg.RyujinxDir != "" && pathExists(cfg.RyujinxDir) {
			res["ryujinx"] = true
		}
	}
	return res
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
