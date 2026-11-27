package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	stdruntime "runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows/registry"
)

// guiVersion 导航程序版本（与地图网页版本解耦，见 BOTWmap 项目规则第 3 条）。
// V1.4.9：UI 精简——移除"网页地图选定目标"卡；校准说明文案简化；
//         校准按钮提交中保持原形状；锁定提示只显示地址。
// V2.0.0：合并双平台核心（totknavi-core.exe，Ryujinx+Eden 统一）——新增模拟器选择
//         （自动/Ryujinx/Eden），存档设置保留，坐标校准文件通道适配新核心。
// V2.1.1：新增「手机防息屏（Https）」开关 —— 核心启动时带 --tls，
//         手机镜像页走 HTTPS（secure context，wakeLock 防息屏生效）。
// V2.1.2：GUI 状态栏显示手机镜像地址（三色就绪点 + 一键复制）；坐标校准
//         预检弹窗（>50m 警告可强制继续，Vue 悬浮卡）。
// V2.2.0：核心新增第 6 条锁定途径「指针链快路径」（跑动掉锁后毫秒级重锁）；
//         GUI 侧无 UI 改动，仅版本号对齐核心。
// V3.3.4：PC 版端口收口为单一 8766（防 5 端口自占冲突）+ GUI 单实例防双开 + 清理残留核心进程；
//         空壳配置（L1 静态链 0 条）不落盘/不分享；PC 版启动静默同步网站配置单（同内容跳过不重写）；精简设置弹窗。
// V3.3.2：PC 版改为直读 caption.sav 内置游戏存档时间排序，彻底解决开机复制 save-tx 导致 slot_05 虚假最新的定位/读档偏差。
// V3.3.1：PC 版扩大范围扫描改为按三维坐标值反推 LEVEL-1 静态指针链，解决「静态链 0 条」与载具飞行轨迹冻结问题；并合入 L2 静止残影自愈与存档锚点清洗。
// V3.3.0：PC 版支持独立扩大范围扫描、OBS 式进程下拉选择、多端口自动顺延、EdgeOne 诊断直传（同步支持模拟器版）。
// V3.2.0：PC 版独立扩大范围扫描 + 自动生成本地配置 pc_profile_local.json + EdgeOne 诊断直传 + PC 版隐藏模拟器选项。
// V3.1.2：对齐核心版本 v3.1.2，PC 重编译版静态指针链直读秒锁 + 修复存档 mtime 乱序。
// V3.1.1：对齐核心版本 v3.1.1，PC 重编译版补齐 /target 导航目标与状态同步。
// V3.1.0：对齐核心版本 v3.1.0，支持 PC 重编译版与模拟器版并列架构。
// V3.0.1：全线品牌改名 xnavi -> totknavi（窗口标题、包名、镜像页统一）；
//         进度看板新增第 21 类「宝箱」，分类计数文案 20 -> 21。
// V3.0.0：跨场景持久槽定位（传送 / 神庙零重扫，1.5s 秒锁）；
//         GUI 与核心版本解耦后同号对齐。
// defaultDiagUploadURL 诊断日志直发接口（EdgeOne Pages Node Function）。
const defaultDiagUploadURL = "https://botw.yalin.site/api/diag"

// defaultCloudProfilesURL 社区验证过的 PC 版定位配置单静态索引。
const defaultCloudProfilesURL = "https://totk.yalin.site/profiles/index.json"

const guiVersion = "v3.3.5"

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
	AutoOpenMap    *bool  `json:"autoOpenMap,omitempty"` // 锁定后自动打开网页地图（默认 true）
	DiagUrl        string `json:"diagUrl,omitempty"`     // 自定义诊断上传接口（留空走 defaultDiagUploadURL）
	CustomProc        string `json:"customProc,omitempty"`        // PC 版手动指定游戏进程名（留空自动探测）
	Profile           string `json:"profile,omitempty"`           // PC 版手动指定定位配置 ID（留空或 "auto" 自动匹配）
	SharedProfileHash string `json:"sharedProfileHash,omitempty"` // 已成功分享过的本机 L1 配置哈希（防重复发邮件）
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
		if cfg.AutoOpenMap == nil {
		t := true
		cfg.AutoOpenMap = &t
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
	// go a.checkUpdate() // 取消启动自动检查更新
	go a.ensureWindowVisible()
	// PC 版启动时静默同步一次网站配置单（失败无感忽略）
	if appEdition == "pc" {
		go a.SyncCloudProfiles()
	}
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

// winSystemProxyURL 读取 Windows 注册表系统代理（ProxyEnable=1 时返回 http://host:port）。
func winSystemProxyURL() *url.URL {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil
	}
	defer k.Close()
	en, _, err := k.GetIntegerValue("ProxyEnable")
	if err != nil || en == 0 {
		return nil
	}
	srv, _, err := k.GetStringValue("ProxyServer")
	if err != nil || strings.TrimSpace(srv) == "" {
		return nil
	}
	srv = strings.TrimSpace(srv)
	// 支持 "http=127.0.0.1:7890;https=127.0.0.1:7890" 格式
	if strings.Contains(srv, "=") {
		for _, part := range strings.Split(srv, ";") {
			if strings.HasPrefix(part, "https=") {
				srv = strings.TrimPrefix(part, "https=")
				break
			}
			if strings.HasPrefix(part, "http=") {
				srv = strings.TrimPrefix(part, "http=")
			}
		}
	}
	if !strings.Contains(srv, "://") {
		srv = "http://" + srv
	}
	u, err := url.Parse(srv)
	if err != nil {
		return nil
	}
	return u
}

func httpGetText(targetURL string) string {
	var clients []*http.Client
	if pu := winSystemProxyURL(); pu != nil {
		clients = append(clients, &http.Client{
			Timeout:   5 * time.Second,
			Transport: &http.Transport{Proxy: http.ProxyURL(pu)},
		})
	}
	clients = append(clients, &http.Client{Timeout: 5 * time.Second})

	for _, c := range clients {
		req, err := http.NewRequest("GET", targetURL, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TOTKnavi/"+guiVersion)
		resp, err := c.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 200 && len(body) > 0 {
			return string(body)
		}
	}
	return ""
}

// fetchLatestTag 多源查 GitHub 最新 totknavi- 版本号（避开 api.github.com 60次/小时匿名限流 + 自动识别 Windows 系统代理）。
func fetchLatestTag() string {
	tagRe := regexp.MustCompile(`totknavi-(v\d+\.\d+\.\d+)`)

	// 通道 1：GitHub Tags 网页（无 60次/小时 API 限流）
	if html := httpGetText("https://github.com/yalincc/TOTKmap/tags"); html != "" {
		best := ""
		for _, m := range tagRe.FindAllStringSubmatch(html, -1) {
			if len(m) > 1 {
				v := m[1]
				if best == "" || verGreater(v, best) {
					best = v
				}
			}
		}
		if best != "" {
			return best
		}
	}

	// 通道 2：raw version.go 兜底
	if raw := httpGetText("https://raw.githubusercontent.com/yalincc/TOTKmap/master/totknavi/version.go"); raw != "" {
		verRe := regexp.MustCompile(`CoreVersion\s*=\s*"(v\d+\.\d+\.\d+)"`)
		if m := verRe.FindStringSubmatch(raw); len(m) > 1 {
			return m[1]
		}
	}

	// 通道 3：GitHub REST API 兜底
	if apiBody := httpGetText("https://api.github.com/repos/yalincc/totkmap/tags?per_page=30"); apiBody != "" {
		var tags []struct {
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(apiBody), &tags) == nil {
			best := ""
			for _, t := range tags {
				if !strings.HasPrefix(t.Name, "totknavi-") {
					continue
				}
				v := strings.TrimPrefix(t.Name, "totknavi-")
				if best == "" || verGreater(v, best) {
					best = v
				}
			}
			if best != "" {
				return best
			}
		}
	}
	return ""
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

// PickSaveFile 通过文件选择对话框挑选 progress.sav 或任意 .sav 存档文件。
func (a *App) PickSaveFile() string {
	file, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择 TOTK 存档文件 (progress.sav)",
		Filters: []runtime.FileFilter{
			{DisplayName: "TOTK 存档文件 (*.sav)", Pattern: "*.sav;progress.sav"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || file == "" {
		return ""
	}
	return file
}

// OpenSaveDir 在资源管理器中直接高亮当前正在生效的存档文件；若文件不存在则打开目录。
func (a *App) OpenSaveDir() string {
	st := a.CoreStatus()
	savePath := ""
	if prog, ok := st["progress"].(map[string]any); ok {
		if s, ok := prog["save"].(string); ok {
			savePath = s
		}
	}
	if savePath == "" {
		if s, ok := st["save"].(string); ok {
			savePath = s
		}
	}
	if savePath == "" && a.cfg != nil {
		for _, d := range []string{a.cfg.SaveDirRyujinx, a.cfg.SaveDirEden} {
			if d != "" && pathExists(d) {
				savePath = d
				break
			}
		}
	}
	if savePath == "" {
		return "暂无正在生效的存档路径"
	}
	if err := openSaveLocation(savePath); err != nil {
		return "打开失败: " + err.Error()
	}
	return "已在资源管理器中定位存档"
}

// ApplySavePath 手动指定存档路径（支持 .sav 文件或目录），即时生效并持久化。
func (a *App) ApplySavePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return a.ResetSaveDetection()
	}
	fi, err := os.Stat(path)
	if err != nil {
		return "路径不存在: " + path
	}
	cleanPath := filepath.Clean(path)
	if !fi.IsDir() {
		base := strings.ToLower(filepath.Base(cleanPath))
		if !strings.HasSuffix(base, ".sav") {
			return "请选择以 .sav 结尾的存档文件（如 progress.sav）"
		}
	}

	if a.cfg == nil {
		a.cfg = a.loadConfig()
	}

	lower := strings.ToLower(cleanPath)
	emu := a.cfg.Emu
	if emu == "ryujinx" || strings.Contains(lower, "bis") || strings.Contains(lower, "ryujinx") {
		a.cfg.SaveDirRyujinx = cleanPath
	} else if emu == "eden" || strings.Contains(lower, "nand") || strings.Contains(lower, "eden") || strings.Contains(lower, "yuzu") {
		a.cfg.SaveDirEden = cleanPath
	} else {
		a.cfg.SaveDirRyujinx = cleanPath
		a.cfg.SaveDirEden = cleanPath
	}
	a.SaveConfig(*a.cfg)
	return "已应用存档路径: " + cleanPath
}

// ResetSaveDetection 清除手动指定存档路径，恢复全自动探测。
func (a *App) ResetSaveDetection() string {
	if a.cfg == nil {
		a.cfg = a.loadConfig()
	}
	a.cfg.SaveDirRyujinx = ""
	a.cfg.SaveDirEden = ""
	a.SaveConfig(*a.cfg)
	return "已恢复自动检测"
}

func openSaveLocation(savePath string) error {
	if savePath == "" {
		return fmt.Errorf("无有效存档路径")
	}
	savePath = filepath.Clean(savePath)
	fi, err := os.Stat(savePath)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return exec.Command("explorer", savePath).Start()
	}
	return exec.Command("explorer", "/select,", savePath).Start()
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

// Edition 返回发行形态（"emu" 模拟器版 | "pc" PC-Recomp 版）。
func (a *App) Edition() string { return appEdition }

// SubmitDeepScan 触发独立扩大范围/全进程兜底扫描（写 deep-scan-req.json）。
func (a *App) SubmitDeepScan(hasCoords bool, x, y, z float64) map[string]any {
	req := map[string]any{
		"hasCoords": hasCoords,
		"x":         x,
		"y":         y,
		"z":         z,
		"ts":        time.Now().Unix(),
	}
	buf, _ := json.Marshal(req)
	os.Remove(filepath.Join(a.workDir, "deep-scan-resp.json"))
	if err := os.WriteFile(filepath.Join(a.workDir, "deep-scan-req.json"), buf, 0644); err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true}
}

// corePath 核心子进程 exe 路径：与 GUI 同目录的 totknavi-core.exe（V2.0.0 起双平台统一核心）。
// 命名不以模拟器为前缀：避免 findPid 的 HasPrefix 匹配误认核心进程。
func (a *App) corePath() string {
	return filepath.Join(a.workDir, "totknavi-core.exe")
}

// StartCore 启动核心子进程（totknavi-core.exe --no-open --emu=<auto|ryujinx|eden>）。
// V2.0.0：双平台统一核心；模拟器由 Config.Emu 决定（默认 auto 自动探测）。
// 重复调用会先停掉旧进程，并清理可能残留的同名孤儿核心进程，防止 8766 端口冲突。
func (a *App) StartCore() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopCoreLocked()
	killStaleCoreProcesses()
	exe := a.corePath()
	if _, err := os.Stat(exe); err != nil {
		return "找不到核心程序 totknavi-core.exe（应放在本程序同目录）"
	}
	emu := "auto"
	if appEdition == "pc" {
		emu = "pc"
	} else if a.cfg != nil && a.cfg.Emu != "" {
		emu = a.cfg.Emu
	}
	args := []string{"--no-open", "--emu=" + emu}
	if a.cfg != nil && a.cfg.TLS {
		args = append(args, "--tls") // V2.1.1：手机防息屏（Https）
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = a.workDir
	// 存档目录兜底：按平台传对应环境变量；PC 版传递自定义进程名与指定配置单（若有）。
	if appEdition == "pc" && a.cfg != nil {
		if strings.TrimSpace(a.cfg.CustomProc) != "" {
			cmd.Env = append(cmd.Env, "TOTK_PC_PROCESS="+strings.TrimSpace(a.cfg.CustomProc))
		}
		if p := strings.TrimSpace(a.cfg.Profile); p != "" && p != "auto" {
			cmd.Env = append(cmd.Env, "TOTK_PC_PROFILE="+p)
		}
	}
	if appEdition != "pc" && a.cfg != nil {
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
		return "PC-Recomp"
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

func tailLinesText(path string, maxLines int) string {
	buf, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(buf), "\r\n"), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n")
}

// UploadDiagnostics 将脱敏诊断摘要（含本地校准配置 pc_profile_local.json）直接 POST 到 EdgeOne 中转接口。
func (a *App) UploadDiagnostics(note string) string {
	targetURL := defaultDiagUploadURL
	if a.cfg != nil && strings.TrimSpace(a.cfg.DiagUrl) != "" {
		targetURL = strings.TrimSpace(a.cfg.DiagUrl)
	}
	if targetURL == "" {
		return "未配置上传接口，请先使用「导出诊断包」"
	}

	statusBuf, _ := os.ReadFile(filepath.Join(a.workDir, "status.json"))
	isShareProfile := strings.Contains(note, "[分享本机 L1 配置]")
	var profileBuf []byte
	var shareHash string
	if isShareProfile {
		profileBuf, shareHash = a.readLocalShareProfiles()
		if len(profileBuf) == 0 {
			return "当前暂无本机新生成的 L1 配置（官方已有配置无需重复分享），请先在游戏中完成校准适配后再分享"
		}
		if a.cfg != nil && a.cfg.SharedProfileHash != "" && a.cfg.SharedProfileHash == shareHash {
			return "当前本机配置已分享过，无需重复提交，感谢支持"
		}
	} else {
		profileBuf = a.readDiagnosticsProfiles()
	}

	emu := "auto"
	if appEdition == "pc" {
		emu = "pc"
	} else if a.cfg != nil && a.cfg.Emu != "" {
		emu = a.cfg.Emu
	}
	saveRyu, saveEden := "", ""
	if appEdition != "pc" && a.cfg != nil {
		saveRyu, saveEden = a.cfg.SaveDirRyujinx, a.cfg.SaveDirEden
	}
	info := fmt.Sprintf(
		"totknavi diagnostics\n====================\nGUI version: %s\nEdition: %s\nOS: %s/%s\nCPU cores: %d\nHostname: %s\nTime: %s\nSaveDir Ryujinx: %q\nSaveDir Eden: %q\n",
		guiVersion, appEdition, stdruntime.GOOS, stdruntime.GOARCH,
		stdruntime.NumCPU(), hostname(),
		time.Now().Format("2006-01-02 15:04:05"),
		saveRyu, saveEden,
	)

	payload := map[string]any{
		"game":      "totk",
		"version":   guiVersion,
		"edition":   appEdition,
		"emulator":  emu,
		"note":      strings.TrimSpace(note),
		"info":      info,
		"status":    string(statusBuf),
		"pcProfile": string(profileBuf),
		"coreLog":   tailLinesText(filepath.Join(a.workDir, "xnavi-gui-core.log"), 200),
		"eventsLog": tailLinesText(filepath.Join(a.workDir, "run-events.log"), 50),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "打包失败: " + err.Error()
	}

	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(targetURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return "上传失败: " + err.Error()
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Sprintf("上传失败 (HTTP %d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	if isShareProfile && shareHash != "" {
		if a.cfg == nil {
			a.cfg = a.loadConfig()
		}
		a.cfg.SharedProfileHash = shareHash
		a.SaveConfig(*a.cfg)
	}
	// 服务端按「游戏版本 + L1 链」去重：已收录时不发邮件，只回执感谢。
	// 两条文案都含「感谢」，前端现有 msg.includes('感谢') 判断不变，UI 零改动。
	var ack struct {
		Duplicate bool `json:"duplicate"`
	}
	if json.Unmarshal(respBody, &ack) == nil && ack.Duplicate {
		return "该版本配置云端已收录，感谢支持"
	}
	return "已发送给开发者，感谢反馈"
}

// readLocalShareProfiles 只收集本机校准生成的有效 L1 配置（profiles/local-*.json 或旧版 pc_profile_local.json），
// 排除官方内置或从网站同步下来的配置单；返回拼接字节与 SHA-256 哈希（用于防重复分享）。
func (a *App) readLocalShareProfiles() ([]byte, string) {
	isValidL1 := func(b []byte) bool {
		var m struct {
			Verified     bool              `json:"verified"`
			StaticChains []json.RawMessage `json:"staticChains"`
		}
		return json.Unmarshal(b, &m) == nil && m.Verified && len(m.StaticChains) > 0
	}
	var parts []string
	profDir := filepath.Join(a.workDir, "profiles")
	if entries, err := os.ReadDir(profDir); err == nil {
		var names []string
		for _, e := range entries {
			low := strings.ToLower(e.Name())
			if !e.IsDir() && strings.HasPrefix(low, "local-") && strings.HasSuffix(low, ".json") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			if b, err := os.ReadFile(filepath.Join(profDir, name)); err == nil && isValidL1(b) {
				parts = append(parts, fmt.Sprintf("// %s\n%s", name, string(bytes.TrimSpace(b))))
			}
		}
	}
	if len(parts) == 0 {
		if b, err := os.ReadFile(filepath.Join(a.workDir, "pc_profile_local.json")); err == nil && isValidL1(b) {
			parts = append(parts, fmt.Sprintf("// pc_profile_local.json\n%s", string(bytes.TrimSpace(b))))
		}
	}
	if len(parts) == 0 {
		return nil, ""
	}
	joined := []byte(strings.Join(parts, "\n\n"))
	sum := sha256.Sum256(joined)
	return joined, hex.EncodeToString(sum[:])
}

// killStaleCoreProcesses 清理上次异常退出可能残留的 totknavi-core.exe，防止 8766 端口冲突。
func killStaleCoreProcesses() {
	snap, _, _ := procK32Toolhelp.Call(0x00000002, 0)
	if snap == 0 || snap == ^uintptr(0) {
		return
	}
	defer procK32CloseH.Call(snap)
	var e winProcEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procK32ProcFirst.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		if e.ProcessID != 0 {
			name := strings.ToLower(syscall.UTF16ToString(e.ExeFile[:]))
			if name == "totknavi-core.exe" {
				if p, err := os.FindProcess(int(e.ProcessID)); err == nil {
					_ = p.Kill()
				}
			}
		}
		r, _, _ = procK32ProcNext.Call(snap, uintptr(unsafe.Pointer(&e)))
	}
}

// readDiagnosticsProfiles 收集 profiles/*.json 或旧版 pc_profile_local.json 供诊断上传使用。
func (a *App) readDiagnosticsProfiles() []byte {
	var parts []string
	profDir := filepath.Join(a.workDir, "profiles")
	if entries, err := os.ReadDir(profDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
				if b, err := os.ReadFile(filepath.Join(profDir, e.Name())); err == nil && len(b) > 0 {
					parts = append(parts, fmt.Sprintf("// %s\n%s", e.Name(), string(b)))
				}
			}
		}
	}
	if len(parts) > 0 {
		return []byte(strings.Join(parts, "\n\n"))
	}
	b, _ := os.ReadFile(filepath.Join(a.workDir, "pc_profile_local.json"))
	return b
}

// ListPCProfiles 返回 PC 版可用定位配置单列表（内置默认 + profiles/*.json + 兼容 pc_profile_local.json）。
func (a *App) ListPCProfiles() []map[string]any {
	out := []map[string]any{
		{
			"id":      "profile-1-default",
			"name":    "默认配置 (TotK-Recomp · 1.2.1)",
			"note":    "内置默认偏移",
			"builtin": true,
		},
	}
	seen := map[string]bool{"profile-1-default": true}
	addFile := func(path string) {
		b, err := os.ReadFile(path)
		if err != nil {
			return
		}
		var m struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Note     string `json:"note"`
			Verified bool   `json:"verified"`
		}
		if err := json.Unmarshal(b, &m); err != nil || !m.Verified {
			return
		}
		if m.ID == "" {
			m.ID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
		}
		if m.Name == "" {
			m.Name = m.ID
		}
		if seen[m.ID] {
			return
		}
		seen[m.ID] = true
		out = append(out, map[string]any{
			"id":      m.ID,
			"name":    m.Name,
			"note":    m.Note,
			"builtin": false,
		})
	}
	profDir := filepath.Join(a.workDir, "profiles")
	if entries, err := os.ReadDir(profDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
				addFile(filepath.Join(profDir, e.Name()))
			}
		}
	}
	addFile(filepath.Join(a.workDir, "pc_profile_local.json"))
	return out
}

// OpenProfilesDir 打开（若不存在则创建）PC 版配置单目录 profiles/。
func (a *App) OpenProfilesDir() string {
	dir := filepath.Join(a.workDir, "profiles")
	_ = os.MkdirAll(dir, 0o755)
	_ = exec.Command("explorer", dir).Start()
	return dir
}

// SyncCloudProfiles 从云端静态配置单拉取已验证的 PC 版定位配置，写入本地 profiles/ 目录。
func (a *App) SyncCloudProfiles() map[string]any {
	client := http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(defaultCloudProfilesURL)
	if err != nil {
		return map[string]any{"ok": false, "msg": "同步失败：" + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return map[string]any{"ok": false, "msg": fmt.Sprintf("云端暂未发布配置单 (HTTP %d)", resp.StatusCode)}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return map[string]any{"ok": false, "msg": "读取响应失败：" + err.Error()}
	}
	var idx struct {
		Schema    int               `json:"schema"`
		UpdatedAt string            `json:"updatedAt"`
		Profiles  []json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(body, &idx); err != nil {
		return map[string]any{"ok": false, "msg": "配置单格式解析失败"}
	}
	dir := filepath.Join(a.workDir, "profiles")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return map[string]any{"ok": false, "msg": "创建 profiles 目录失败：" + err.Error()}
	}
	saved := 0
	skipped := 0
	for _, raw := range idx.Profiles {
		var meta struct {
			ID       string `json:"id"`
			Verified bool   `json:"verified"`
		}
		if err := json.Unmarshal(raw, &meta); err != nil || !meta.Verified || meta.ID == "" {
			continue
		}
		safeID := strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
				return r
			}
			return '_'
		}, meta.ID)
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, raw, "", "  "); err != nil {
			continue
		}
		dst := filepath.Join(dir, safeID+".json")
		if existing, err := os.ReadFile(dst); err == nil && bytes.Equal(bytes.TrimSpace(existing), bytes.TrimSpace(pretty.Bytes())) {
			skipped++
			continue
		}
		if err := os.WriteFile(dst, pretty.Bytes(), 0o644); err == nil {
			saved++
		}
	}
	msg := fmt.Sprintf("本地配置已是最新（共 %d 份，无需重复下载）", skipped)
	if saved > 0 && skipped > 0 {
		msg = fmt.Sprintf("已更新 %d 份配置（跳过 %d 份相同）", saved, skipped)
	} else if saved > 0 {
		msg = fmt.Sprintf("已同步 %d 份配置", saved)
	} else if skipped == 0 {
		msg = "云端暂无可用配置"
	}
	return map[string]any{
		"ok":        true,
		"count":     saved + skipped,
		"saved":     saved,
		"skipped":   skipped,
		"updatedAt": idx.UpdatedAt,
		"msg":       msg,
	}
}

// ExportDiagnostics 一键导出诊断包（zip）：系统信息 + status.json + core 日志 + 事件日志 + pc_profile_local.json。
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

	// 2) 工作目录下的日志/状态/校准配置文件（core 写的）
	for _, name := range []string{"status.json", "xnavi-gui-core.log", "run-events.log", "pc_profile_local.json"} {
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

// ProcessItem 运行中进程条目（供 PC 版 OBS 式下拉选择）。
type ProcessItem struct {
	Pid   uint32 `json:"pid"`
	Name  string `json:"name"`
	MemMB uint64 `json:"memMB"`
}

var (
	procK32Toolhelp   = syscall.NewLazyDLL("kernel32.dll").NewProc("CreateToolhelp32Snapshot")
	procK32ProcFirst  = syscall.NewLazyDLL("kernel32.dll").NewProc("Process32FirstW")
	procK32ProcNext   = syscall.NewLazyDLL("kernel32.dll").NewProc("Process32NextW")
	procK32OpenProc   = syscall.NewLazyDLL("kernel32.dll").NewProc("OpenProcess")
	procK32CloseH     = syscall.NewLazyDLL("kernel32.dll").NewProc("CloseHandle")
	procK32GetMemInfo = syscall.NewLazyDLL("kernel32.dll").NewProc("K32GetProcessMemoryInfo")
)

type winProcEntry32W struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

type winProcMemCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

// ListProcesses 枚举当前运行中的用户进程（按 totk/zelda 关键字优先、内存降序排列）。
func (a *App) ListProcesses() []ProcessItem {
	snap, _, _ := procK32Toolhelp.Call(0x00000002, 0)
	if snap == 0 || snap == ^uintptr(0) {
		return nil
	}
	defer procK32CloseH.Call(snap)

	selfPid := uint32(os.Getpid())
	totkByName := make(map[string]ProcessItem)
	fallbackByName := make(map[string]ProcessItem)

	isIgnoredApp := func(low string) bool {
		switch low {
		case "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe",
			"explorer.exe", "code.exe", "wechat.exe", "weixin.exe", "qq.exe",
			"discord.exe", "steam.exe", "steamwebhelper.exe", "searchhost.exe",
			"msmpeng.exe", "antigravity.exe", "node.exe", "powershell.exe", "pwsh.exe":
			return true
		}
		return false
	}

	var e winProcEntry32W
	e.Size = uint32(unsafe.Sizeof(e))
	r, _, _ := procK32ProcFirst.Call(snap, uintptr(unsafe.Pointer(&e)))
	for r != 0 {
		if e.ProcessID != 0 && e.ProcessID != selfPid {
			name := syscall.UTF16ToString(e.ExeFile[:])
			low := strings.ToLower(name)
			if low != "" && !strings.Contains(low, "totknavi") && !strings.Contains(low, "xnavi") && !strings.Contains(low, "xlate") &&
				low != "svchost.exe" && low != "conhost.exe" && low != "csrss.exe" &&
				low != "smss.exe" && low != "services.exe" && low != "lsass.exe" &&
				low != "wininit.exe" && low != "winlogon.exe" && low != "dwm.exe" {
				var memMB uint64
				h, _, _ := procK32OpenProc.Call(0x1000|0x0010, 0, uintptr(e.ProcessID))
				if h != 0 {
					var pmc winProcMemCounters
					pmc.CB = uint32(unsafe.Sizeof(pmc))
					if ok, _, _ := procK32GetMemInfo.Call(h, uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.CB)); ok != 0 {
						memMB = uint64(pmc.WorkingSetSize) / (1024 * 1024)
					}
					procK32CloseH.Call(h)
				}
				isLikelyGame := strings.Contains(low, "totk") || strings.Contains(low, "zelda") ||
					strings.Contains(low, "tears") || strings.Contains(low, "recomp") || strings.Contains(low, "kingdom")
				if isLikelyGame {
					if prev, ok := totkByName[low]; !ok || memMB > prev.MemMB {
						totkByName[low] = ProcessItem{Pid: e.ProcessID, Name: name, MemMB: memMB}
					}
				} else if memMB >= 800 && !isIgnoredApp(low) {
					if prev, ok := fallbackByName[low]; !ok || memMB > prev.MemMB {
						fallbackByName[low] = ProcessItem{Pid: e.ProcessID, Name: name, MemMB: memMB}
					}
				}
			}
		}
		r, _, _ = procK32ProcNext.Call(snap, uintptr(unsafe.Pointer(&e)))
	}

	chosen := totkByName
	if len(chosen) == 0 {
		chosen = fallbackByName
	}
	out := make([]ProcessItem, 0, len(chosen))
	for _, it := range chosen {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		gi := strings.Contains(li, "totk") || strings.Contains(li, "zelda") || strings.Contains(li, "tears")
		gj := strings.Contains(lj, "totk") || strings.Contains(lj, "zelda") || strings.Contains(lj, "tears")
		if gi != gj {
			return gi
		}
		if out[i].MemMB != out[j].MemMB {
			return out[i].MemMB > out[j].MemMB
		}
		return li < lj
	})
	return out
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
