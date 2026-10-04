// 运行监督：事件日志（run-events.log）+ 计数器 + 状态文件（status.json）。
// 目的：BotwNavi 偶发定位卡顿/漂移时，不用复制 cmd 窗口日志，
// 直接看 run-events.log（带时间戳的事件流）和 status.json（会话健康快照）。
//
// 用法：
//   eLog("...")            —— 事件行：原样打印到控制台（保持 cmd 外观），
//                             同时带时间戳 append 到 run-events.log（>2MB 自动轮转 .1）
//   incCounter("locks")    —— 会话计数器（locks/relocates/jumps/scans）
//   statusLoop()           —— 每 2s 写一次 status.json（exe 同目录，原子替换）

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

var (
	cntLocks     atomic.Int64 // watch 锁定/换锁次数
	cntRelocates atomic.Int64 // relocalize 触发次数
	cntJumps     atomic.Int64 // poll 接受大跳变次数
	cntScans     atomic.Int64 // locate 全量扫描次数
)

// ---- 事件日志 ----

var (
	evMu   sync.Mutex
	evFile *os.File
)

const evLogMax = 2 << 20 // 2MB 轮转

func evLogPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "run-events.log")
}

func openEvLog() {
	if evFile != nil {
		return
	}
	f, err := os.OpenFile(evLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	if fi, err := f.Stat(); err == nil && fi.Size() > evLogMax {
		f.Close()
		os.Rename(evLogPath(), evLogPath()+".1")
		if f2, err := os.OpenFile(evLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			f = f2
		} else {
			return
		}
	}
	evFile = f
}

// eLog 事件行：控制台原样输出（不带时间戳，保持现有外观），文件带时间戳。
func eLog(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Print(msg)
	evMu.Lock()
	defer evMu.Unlock()
	openEvLog()
	if evFile != nil {
		evFile.WriteString(time.Now().Format("2006-01-02 15:04:05.000") + " " + msg)
	}
}

// ---- 计数器 ----

func incCounter(name string) {
	switch name {
	case "locks":
		cntLocks.Add(1)
	case "relocates":
		cntRelocates.Add(1)
	case "jumps":
		cntJumps.Add(1)
	case "scans":
		cntScans.Add(1)
	}
}

// ---- 导航清除（V1.1.0）----
// GUI 点"清除目标"→ 写 nav-clear.json（GUI 同目录，文件通信，双入口原则）
// → 本循环消费 → clearTarget() → 删除文件。
// 与 server.go POST /target {clear:true} 走同一 clearTarget()，无竞争。

func navClearPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "nav-clear.json")
}

// navClearLoop 每 200ms 检查 nav-clear.json，存在即清目标并删除。
func navClearLoop() {
	for {
		time.Sleep(200 * time.Millisecond)
		if _, err := os.Stat(navClearPath()); err != nil {
			continue
		}
		clearTarget()
		os.Remove(navClearPath())
		fmt.Println("  [nav] clear target requested by GUI (nav-clear.json)")
	}
}

// ---- status.json ----

func statusPath() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "status.json")
}

// statusLoop 每 2s 写一次会话健康快照（原子替换，避免读到半截）。
func statusLoop() {
	for {
		// 原为 2s：GUI 面板位置最多每 2 秒才变一次（实测观感"1~3 秒一跳"）。
		// status.json 只有几百字节，写入成本可忽略；配合前端 eventBridge 800ms
		// 采样，面板刷新观感落到 1 秒以内。定位逻辑完全不受影响。
		time.Sleep(400 * time.Millisecond)
		lock.mu.RLock()
		addr := lock.addr
		src := lock.source
		verified := lock.verified
		copies := lock.copies
		lock.mu.RUnlock()

		state.mu.RLock()
		ok := state.ok
		gx, gy, gz := state.gx, state.gy, state.gz
		mx, my := state.mx, state.my
		layer := state.layer
		age := state.age
		state.mu.RUnlock()

		ageSec := 0.0
		if age > 0 {
			ageSec = float64(time.Now().UnixNano())/1e9 - age
		}
		obj := map[string]any{
			"time":     time.Now().Format(time.RFC3339),
			"pid":      procPID,
			"ok":       ok,
			"pos":      map[string]any{"gx": gx, "gy": gy, "gz": gz, "mx": mx, "my": my},
			"layer":    layer,
			"source":   src,
			"verified": verified,
			"copies":   copies,
			"lockAddr": fmt.Sprintf("0x%X", addr),
			"ageSec":   ageSec,
			"counters": map[string]any{
				"locks":     cntLocks.Load(),
				"relocates": cntRelocates.Load(),
				"jumps":     cntJumps.Load(),
				"scans":     cntScans.Load(),
			},
			// V1.1.0：导航目标同步（GUI 显示目标状态；地图 /pos 同源）。
			// nil 时 JSON 输出 null，GUI st.target === null 判断"无目标"。
			"target": getTarget(),
		}

		// ---- GUI 套壳兼容字段 ----
		// 让 xnavi-gui（Wails 前端）能直接显示 TOTK 的状态与进度。
		// V1.1.0：progress 直接透传 /progress 的 counts（中文 key + {done,total} 对象，
		// 全量 20 类），前端 ProgressView 按表渲染；旧版 GUI 只认英文 key，发布时
		// GUI+core 同包更新，不兼容旧壳。
		obj["game"] = "totk"
		obj["emulator"] = "Eden"
		obj["map_url"] = mapURL
		obj["mode"] = src
		if ok2, body, _ := progress.snapshot(); ok2 && len(body) > 0 {
			var raw struct {
				Save   string `json:"save"`
				Counts map[string]struct {
					Done  int `json:"done"`
					Total int `json:"total"`
				} `json:"counts"`
			}
			if json.Unmarshal(body, &raw) == nil && raw.Counts != nil {
				obj["progress"] = map[string]any{"save": raw.Save, "counts": raw.Counts}
			}
		}

		buf, err := json.MarshalIndent(obj, "", " ")
		if err != nil {
			continue
		}
		tmp := statusPath() + ".tmp"
		if os.WriteFile(tmp, buf, 0644) == nil {
			os.Rename(tmp, statusPath())
		}
	}
}
