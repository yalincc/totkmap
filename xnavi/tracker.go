// tracker.go — TOTK 动力学根追踪管道接口与全局状态发布（M1 第二步）。
// 对齐 BOTW xnavi v3.2.x 架构（tracker.go 同款）：
//   - Tracker 接口：各平台定位管道全生命周期自闭环，输出只有统一原子状态发布 publishState；
//   - lockT / stateT 全局：server.go（/pos）、monitor.go（status.json）只读消费；
//   - watch.go 调度器只负责平台探测与管道生命周期，不参与定位逻辑。
//
// 坐标语义（TOTK 特有，与 BOTW 严格区分）：
//   - 内存序 (X_east, Z_stored, Y_north)，Z_stored = 真实海拔 + elevBias(105.0)
//   - hud 序 (gx=X_east, gy=-Y_north, gz=Z_stored-elevBias) = decode 输出序；
//     管道内部全部用 hud 序计算（等距变换，欧氏距离与内存序一致）
//   - state.mx,my = (-gy, gx)（地图像素）、state.layer = layerOf(hud 序)：
//     与老路行为完全一致（watch.go v2.2.0 同口径），不可改动

package main

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// RescanRequest 重扫请求（对齐 BOTW tracker.go；Pos 预留目标扫描，M1 暂不使用）。
type RescanRequest struct {
	Pos *[3]float32
}

// Tracker 定位追踪管道接口。每个平台/游戏组合作为一个独立 Tracker。
type Tracker interface {
	Name() string
	Start(ctx context.Context)
	Stop()
	Rescan(req *RescanRequest)
}

// lockT 锁定状态（monitor.go statusLoop 读）。
type lockT struct {
	mu       sync.RWMutex
	addr     uintptr
	verified bool
	copies   int
	source   string
}

var lock = lockT{}

// stateT 发布状态（server.go /pos、monitor.go status.json 读）。
// gx=X东, gy=-Y北, gz=Z高（hud 序）；mx,my = 地图像素（Leaflet latlng = (Z北, X东)）。
type stateT struct {
	mu         sync.RWMutex
	ok         bool
	gx, gy, gz float32
	mx, my     float32
	layer      int
	age        float64
	verified   bool
	copies     int
	source     string
}

var state = stateT{}

var (
	rescanReqCh = make(chan *RescanRequest, 5)
	useSaveScan = true
)

// procPID 当前附加进程 PID（monitor.go statusLoop 用）。
var procPID uint32

func setLock(addr uintptr, verified bool, copies int, source string) {
	lock.mu.Lock()
	lock.addr = addr
	lock.verified = verified
	lock.copies = copies
	lock.source = source
	lock.mu.Unlock()
}

// goUnlocked 解锁并发布"定位中"状态（对齐 BOTW；不依赖 locator 接口）。
func goUnlocked(reason string) {
	setLock(0, false, 0, "locating...")
	state.mu.Lock()
	state.ok = false
	state.source = "locating..."
	state.mu.Unlock()
	fmt.Printf("  [sm] -> UNLOCKED (%s)\n", reason)
}

// publishState 发布全局统一位置状态（TOTK 版）。
// ok=false 时只更新 ok/source（保留上一帧位置字段），与 BOTW 同语义。
func publishState(ok bool, gx, gy, gz float32, verified bool, copies int, source string) {
	state.mu.Lock()
	state.ok = ok
	if ok {
		state.gx, state.gy, state.gz = gx, gy, gz
		// 与老路 watch.go 同口径：hud 序 → 地图像素 (Y北, X东)；层判定用 hud 序
		state.mx, state.my = -gy, gx
		state.layer = layerOf(gx, gy, gz)
		state.age = float64(time.Now().UnixNano()) / 1e9
		state.verified = verified
		state.copies = copies
	}
	state.source = source
	state.mu.Unlock()
}

// requestRescan /rescan HTTP 入口（server.go 调用，非阻塞，保持签名）。
func requestRescan() {
	select {
	case rescanReqCh <- &RescanRequest{}:
	default:
	}
}

// dist3 两点距离（hud 序 = decode 序：东、北取反、高；等距变换下与内存序一致）。
func dist3(a, b [3]float32) float32 {
	dx, dy, dz := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return float32(math.Sqrt(float64(dx*dx + dy*dy + dz*dz)))
}

// isShrineScale TOTK 神庙/试炼场本地尺度判定（进庙信号，v3.4）。
//
// ★ M1 真机修复（2026-10-24）：TOTK 神庙为独立本地场景，玩家坐标切到以神庙
// 原点为中心的本地坐标系，三轴绝对值都小。实测样本：
//   - 无尽洞窟（2026-10-04 老路）：hud X∈[0,32], gy∈[-87,-54], gz∈[-135,-117]
//   - 伊修达古恩神庙（2026-10-24 M1 真机）：hud (20.5, 54.5, 12.0)
//     —— gz=+12 为正！老路 alt<0 判据（isShrinePos）只覆盖地下类神庙，
//     地表神庙 gz>0 会被漏判 → 进庙被误判为传送（warp 1599.9m）。
// ★ v3.4 修订（2026-10-24 用户拍板 + romfs 152 庙全量统计）：
//   旧判据 |gx|<200 & |gy|<200 & |gz|<300 约 1/4 神庙超界（Dungeon055 gx±305、
//   gy±337、gz 至 -770；Dungeon045 gy 至 460）→ 庙内深处被误判出庙。
//   新判据 |gx|<400 & |gy|<400 & |gz|<800（覆盖 romfs 全量对象范围 gx±305/gy±337/
//   gz[-770,238]），暂定值，待实测校准。
// ★ 用途变化：v3.4 起仅作"进庙信号"（量级骤降确认），不再单独判进庙——
//   进庙 = 入口匹配（必要，nearestShrine <30m）+ 本信号，防原点附近大世界误判。
func isShrineScale(pos [3]float32) bool {
	return math.Abs(float64(pos[0])) < 400.0 &&
		math.Abs(float64(pos[1])) < 400.0 &&
		math.Abs(float64(pos[2])) < 800.0
}

// formatDestName 识别传送或神庙位置对应的地标名称（对齐 BOTW xnavi v3.2.2 tracker.go）。
func formatDestName(pos [3]float32) string {
	if name, _ := nearestShrine(pos); name != "" {
		return "神庙: " + name
	}
	switch layerOf(pos[0], pos[1], pos[2]) {
	case 20:
		return "天空"
	case 19:
		return "地底"
	default:
		return "大世界"
	}
}

// ---- 导航目标（targetT 定义于 server.go；存取函数与 BOTW tracker.go 同构）----

func setTarget(t *targetT) {
	targetMu.Lock()
	target = t
	targetMu.Unlock()
}

func getTarget() *targetT {
	targetMu.Lock()
	defer targetMu.Unlock()
	return target
}

func clearTarget() {
	targetMu.Lock()
	defer targetMu.Unlock()
	target = nil
}
