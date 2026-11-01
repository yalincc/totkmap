// log_ring.go — 内存环形日志缓冲，供终端与 Web GUI 共享。

package main

import (
	"fmt"
	"sync"
	"time"
)

const maxRingLogs = 100

var (
	ringMu   sync.RWMutex
	ringLogs = make([]string, 0, maxRingLogs)
)

// logEvent 格式化打印并保存到内存环形缓冲区。
func logEvent(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	now := time.Now().Format("15:04:05")
	entry := fmt.Sprintf("[%s] %s", now, msg)

	// 控制台输出
	fmt.Println(entry)

	// 环形缓冲
	ringMu.Lock()
	if len(ringLogs) >= maxRingLogs {
		ringLogs = ringLogs[1:]
	}
	ringLogs = append(ringLogs, entry)
	ringMu.Unlock()
}

// getRecentLogs 获取最近的日志列表。
func getRecentLogs() []string {
	ringMu.RLock()
	defer ringMu.RUnlock()
	res := make([]string, len(ringLogs))
	copy(res, ringLogs)
	return res
}

