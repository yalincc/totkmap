// log_ts.go — 所有 stdout 输出统一加时间戳前缀。
//
// 移植自 totknavi/log_ts.go（同一套 GUI 壳，格式要求完全一致）。
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

var (
	logPipeW *os.File
	logDone  chan struct{}
)

// enableLogTimestamps 在 main 最开头调用，让 fmt.Printf/Println 全部带时间戳。
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
func flushLog() {
	if logPipeW == nil {
		return
	}
	logPipeW.Close()
	<-logDone
	logPipeW = nil
}
