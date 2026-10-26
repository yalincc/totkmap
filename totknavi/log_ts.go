// log_ts.go — 所有 stdout 输出统一加时间戳前缀。
//
// 移植自 BOTWmap/xnavi/log_ts.go（同一套 GUI 壳，格式要求完全一致）。
// 背景：GUI 前端按 "YYYY-MM-DD HH:mm:ss.SSS" 前缀解析 core 日志（App.vue 正则），
// core 原本裸输出导致 GUI 时间列显示 "--:--:--" / 全部挤成同一时刻，诊断包无时间线。
// 方案：包装 os.Stdout，每行行首自动插入时间戳，所有打印点零改动。
// 格式与 GUI 正则匹配：2006-01-02 15:04:05.000 （GUI 取 slice(11) 显示 HH:mm:ss.SSS）。
package main

import (
	"io"
	"os"
	"sync"
	"time"
)

type tsWriter struct {
	w           io.Writer
	mu          sync.Mutex
	atLineStart bool
}

func (t *tsWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []byte
	for _, b := range p {
		if t.atLineStart {
			out = append(out, time.Now().Format("2006-01-02 15:04:05.000 ")...)
			t.atLineStart = false
		}
		out = append(out, b)
		if b == '\n' {
			t.atLineStart = true
		}
	}
	if _, err := t.w.Write(out); err != nil {
		return 0, err
	}
	return len(p), nil
}

// enableLogTimestamps 在 main 最开头调用，让 fmt.Printf/Println 全部带时间戳。
// os.Stdout 是 *os.File 具体类型无法直接替换，用 pipe 中转：
// os.Stdout → pipe 写端 → 后台协程读 → 逐行加时间戳 → 写回真实 stdout（GUI 重定向的目标）。
var (
	logPipeW *os.File
	logDone  chan struct{}
)

func enableLogTimestamps() {
	r, w, err := os.Pipe()
	if err != nil {
		return
	}
	real := os.Stdout
	os.Stdout = w
	logPipeW = w
	logDone = make(chan struct{})
	go func() {
		defer close(logDone)
		ts := &tsWriter{w: real, atLineStart: true}
		buf := make([]byte, 8192)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				ts.Write(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()
}

// flushLog 关闭管道写端并等待后台协程把剩余输出全部写出。
//
// 必须在任何 os.Exit 之前调用：os.Stdout 已被换成管道，os.Exit 会立刻终止
// 进程，管道里尚未被消费的最后若干行会直接丢失。
// 实测踩坑（2026-10-02 AS probe）：日志停在 "K 候选 449 个，取前 20 验证"，
// 后面所有验证结果与结论全部消失 —— 看起来像验证逻辑挂了，实际只是没刷出来。
func flushLog() {
	if logPipeW == nil {
		return
	}
	logPipeW.Close() // 写端关闭 → 读端收到 EOF → 协程 return → close(logDone)
	<-logDone
	logPipeW = nil
}
