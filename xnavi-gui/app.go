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
// V1.4.9：UI 精简——移除"网页地图选定目标"卡；校准说明文案简化；
//         校准按钮提交中保持原形状；锁定提示只显示地址。
// V2.0.0：合并双平台核心（xnavi.exe，Ryujinx+Eden 统一）——新增模拟器选择
//         （自动/Ryujinx/Eden），存档设置保留，坐标校准文件通道适配新核心。
// V2.1.1：新增「手机防息屏（Https）」开关 —— 核心启动时带 --tls，
//         手机镜像页走 HTTPS（secure context，wakeLock 防息屏生效）。
const guiVersion = "v2.1.1"

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
// V2.1.0：双平台核心（xnavi.exe）——emu 选择模拟器（auto/ryujinx/eden）；
// SaveDirRyujinx / SaveDirEden 为两平台存档目录的手动兜底（自动探测不到时
// 用，经 TOTK_SAVE_DIR_RYUJINX / TOTK_SAVE_DIR_EDEN 环境变量传给 core）。
// V2.1.1：新增 TLS —— 手机防息屏（Https）开关，核心启动带 --tls。
type Config struct {
	SaveDirRyujinx string `json:"saveDirRyujinx,omitempty"`
	SaveDirEden    string `json:"saveDirEden,omitempty"`
	Emu            string `json:"emu,omitempty"` // "auto"（默认）/ "ryujinx" / "eden"
	TLS            bool   `json:"tls,omitempty"` // 手机防息屏（Https）
}

func (a *App) configPath() string { return filepath.Join(a.workDir, "xnavi-gui-config.json") }

func (a *App) loadConfig() *Config {
	cfg := &Config{}
	buf, err := os.ReadFile(a.configPath())
	if err == nil {
		json.Unmarshal(buf, cfg)
	}
	// 兼容 v2.0.0 旧配置：旧 saveDir 是 Eden 存档兜底，迁移到 SaveDirEden。
	type legacy struct{ SaveDir string }
	var lg legacy
	if err == nil {
		json.Unmarshal(buf, &lg)
		if cfg.SaveDirEden == "" && lg.SaveDir != "" {
			cfg.SaveDirEden = lg.SaveDir
		}
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

// fetchLatestTag 查 GitHub tags，返回最新 totknavi- 前缀版本号；网络/解析失败返回空串。
func fetchLatestTag() string {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("https://api.github.com/repos/yalincc/totkmap/tags?per_page=30")
	if err != nil { return "" }
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var tags []struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(body, &tags) != nil { return "" }
	best := ""
	for _, t := range tags {
		if !strings.HasPrefix(t.Name, "totknavi-") { continue }
		v := strings.TrimPrefix(t.Name, "totknavi-")
		if best == "" || verGreater(v, best) {
			best = v
		}
	}
	return best
}

// checkUpdate 启动时 + 事件触发时查 GitHub tags 列表，有新版弹窗，无新版/失败静默（自动检查场景）。
func (a *App) checkUpdate() {
	defer func() { recover() }()
	best := fetchLatestTag()
	if best == "" {
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

// CheckForUpdates 手动检查更新（GUI 按钮）：返回明确结果供前端提示最新/可用/失败。
func (a *App) CheckForUpdates() map[string]string {
	best := fetchLatestTag()
	if best == "" {
		return map[string]string{"status": "error", "msg": "无法连接 GitHub，请检查网络"}
	}
	if verGreater(best, guiVersion) {
		return map[string]string{
			"status": "available",
			"latest": best,
			"url":    "https://github.com/yalincc/totkmap/releases/tag/totknavi-" + best,
		}
	}
	return map[string]string{"status": "latest"}
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

// SubmitCoords GUI 坐标校准（V1.4.0）：写 coords-req.json 到引擎同目录
// （文件通道，与 nav-clear.json 同模式）。core 的 coordsLoop 消费后做
// 全内存三轴精确匹配定位 → 命中即锁 + 写 known。
// 坐标 = 游戏内地图界面显示的 HUD 坐标 (X, Y北显示, 高度)。
func (a *App) SubmitCoords(x, y, z float64) map[string]any {
	req := map[string]any{
		"x":  x,
		"y":  y,
		"z":  z,
		"ts": float64(time.Now().UnixNano()) / 1e9,
	}
	buf, _ := json.Marshal(req)
	if err := os.WriteFile(filepath.Join(a.workDir, "coords-req.json"), buf, 0644); err != nil {
		return map[string]any{"submitted": false, "error": err.Error()}
	}
	return map[string]any{"submitted": true}
}

// PollCoordsResult 读 core 写回的坐标校准结果（coords-resp.json，消费后删除）。
// 前端在提交后轮询（全 RAM 扫描约 10-15s）；core 未写回时返回 ready=false。
func (a *App) PollCoordsResult() map[string]any {
	p := filepath.Join(a.workDir, "coords-resp.json")
	data, err := os.ReadFile(p)
	if err != nil {
		return map[string]any{"ready": false}
	}
	os.Remove(p)
	var obj map[string]any
	json.Unmarshal(data, &obj)
	obj["ready"] = true
	return obj
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

// corePath 核心子进程 exe 路径：与 GUI 同目录的 xnavi.exe（V2.0.0 起双平台统一核心）。
// 命名不以模拟器为前缀：避免 findPid 的 HasPrefix 匹配误认核心进程。
func (a *App) corePath() string {
	return filepath.Join(a.workDir, "xnavi.exe")
}

// StartCore 启动核心子进程（xnavi.exe --no-open --emu=<auto|ryujinx|eden>）。
// V2.0.0：双平台统一核心；模拟器由 Config.Emu 决定（默认 auto 自动探测）。
// 重复调用会先停掉旧进程。
func (a *App) StartCore() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopCoreLocked()
	exe := a.corePath()
	if _, err := os.Stat(exe); err != nil {
		return "找不到核心程序 xnavi.exe（应放在本程序同目录）"
	}
	emu := "auto"
	if a.cfg != nil && a.cfg.Emu != "" {
		emu = a.cfg.Emu
	}
	args := []string{"--no-open", "--emu=" + emu}
	if a.cfg != nil && a.cfg.TLS {
		args = append(args, "--tls") // V2.1.1：手机防息屏（Https）
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = a.workDir
	// 存档目录兜底：按平台传对应环境变量；auto 模式两个都传（core 各自平台
	// 只读自己那个，互不干扰）。留空不传 → core 自动探测。
	if a.cfg != nil {
		if a.cfg.SaveDirRyujinx != "" {
			cmd.Env = append(cmd.Env, "TOTK_SAVE_DIR_RYUJINX="+a.cfg.SaveDirRyujinx)
		}
		if a.cfg.SaveDirEden != "" {
			cmd.Env = append(cmd.Env, "TOTK_SAVE_DIR_EDEN="+a.cfg.SaveDirEden)
		}
	}
	cmd.Env = append(os.Environ(), cmd.Env...)
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
	return fmt.Sprintf("核心已启动（%s · TOTK）", emuLabel(emu))
}

func emuLabel(e string) string {
	switch e {
	case "ryujinx":
		return "Ryujinx"
	case "eden":
		return "Eden"
	default:
		return "自动"
	}
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
	saveRyu, saveEden := "", ""
	if a.cfg != nil {
		saveRyu, saveEden = a.cfg.SaveDirRyujinx, a.cfg.SaveDirEden
	}
	info := fmt.Sprintf(
		"xnavi diagnostics\n===================\nGUI version: %s\nOS: %s/%s\nArch: %s\nCPU cores: %d\nHostname: %s\nTime: %s\nSaveDir Ryujinx: %q\nSaveDir Eden: %q\n\n",
		guiVersion, stdruntime.GOOS, stdruntime.GOARCH, stdruntime.GOARCH,
		stdruntime.NumCPU(), hostname(),
		time.Now().Format("2006-01-02 15:04:05"),
		saveRyu, saveEden,
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

// EnvDetect 探测"已配置的"存档路径是否存在（仅给前端做提示，不挡开始按钮）。
// V2.0.0：双平台核心，仍只查可选存档路径（留空则由 core 自动推导）。
func (a *App) EnvDetect() map[string]any {
	a.mu.Lock()
	cfg := a.cfg
	a.mu.Unlock()
	res := map[string]any{"save": false, "saveRyu": false, "saveEden": false}
	if cfg != nil {
		if cfg.SaveDirRyujinx != "" && pathExists(cfg.SaveDirRyujinx) {
			res["saveRyu"] = true
			res["save"] = true
		}
		if cfg.SaveDirEden != "" && pathExists(cfg.SaveDirEden) {
			res["saveEden"] = true
			res["save"] = true
		}
	}
	return res
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
