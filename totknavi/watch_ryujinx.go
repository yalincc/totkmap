// watch_ryujinx.go — Ryujinx 专属追踪管道（TOTK 版，M1 第二步）。
//
// 独立 Tracker 装配：块枚举走 p.Blocks(256.0)（≥512MB 只扫最大 guest DRAM 块，
// 见 platform_ryujinx.go），无 chain / coords（Eden 特有能力），其余语义与
// Eden 管道完全一致（共用 core_totk.go 管道体）。
//
// 架构（对齐 BOTW xnavi v3.2.x）：动力学根地址扫描锁定（Run>=2 门禁）、
// 走动仲裁、移动确认、传送零重扫、神庙进出锚定、hold/lost、骑乘跟随。

package main

import "context"

// RyujinxTracker TOTK Ryujinx 定位管道。
type RyujinxTracker struct {
	p        *ryujinxPlatform
	rescanCh chan *RescanRequest
	stopCh   chan struct{}
}

// NewRyujinxTracker 创建 Ryujinx 管道。
func NewRyujinxTracker(p *ryujinxPlatform) *RyujinxTracker {
	return &RyujinxTracker{
		p:        p,
		rescanCh: make(chan *RescanRequest, 4),
		stopCh:   make(chan struct{}),
	}
}

func (t *RyujinxTracker) Name() string { return "totk-ryujinx" }

func (t *RyujinxTracker) Stop() {
	select {
	case <-t.stopCh:
	default:
		close(t.stopCh)
	}
}

func (t *RyujinxTracker) Rescan(req *RescanRequest) {
	select {
	case t.rescanCh <- req:
	default:
	}
}

// Start 启动管道主循环（阻塞；调度器以 goroutine 运行，ctx 取消 / Stop 即停）。
func (t *RyujinxTracker) Start(ctx context.Context) {
	runTotkPipeline(t.p, trackerOpts{
		name:    "Ryujinx",
		srcScan: "ryujinx-scan",
		blkMB:   256.0,
	}, t.rescanCh, t.stopCh, ctx)
}
