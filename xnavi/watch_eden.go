// watch_eden.go — Eden 专属追踪管道（TOTK 版，M1 第二步）。
//
// 独立 Tracker 装配：块枚举走 p.Blocks(0.0625)（全 RW 碎片区域，玩家槽可落
// 0.44MB 微型区，见 platform_eden.go），开 chain 指针链快路径与 coords 校准
// 接管（Eden 特有能力），其余语义与 Ryujinx 管道完全一致（共用 core_totk.go）。
//
// 架构（对齐 BOTW xnavi v3.2.x）：动力学根地址扫描锁定（Run>=2 门禁）、
// 走动仲裁、移动确认、传送零重扫、神庙进出锚定、hold/lost、骑乘跟随。

package main

import "context"

// EdenTracker TOTK Eden 定位管道。
type EdenTracker struct {
	p        *edenPlatform
	rescanCh chan *RescanRequest
	stopCh   chan struct{}
}

// NewEdenTracker 创建 Eden 管道。
func NewEdenTracker(p *edenPlatform) *EdenTracker {
	return &EdenTracker{
		p:        p,
		rescanCh: make(chan *RescanRequest, 4),
		stopCh:   make(chan struct{}),
	}
}

func (t *EdenTracker) Name() string { return "totk-eden" }

func (t *EdenTracker) Stop() {
	select {
	case <-t.stopCh:
	default:
		close(t.stopCh)
	}
}

func (t *EdenTracker) Rescan(req *RescanRequest) {
	select {
	case t.rescanCh <- req:
	default:
	}
}

// Start 启动管道主循环（阻塞；调度器以 goroutine 运行，ctx 取消 / Stop 即停）。
func (t *EdenTracker) Start(ctx context.Context) {
	runTotkPipeline(t.p, trackerOpts{
		name:     "Eden",
		srcScan:  "eden-scan",
		blkMB:    0.0625,
		chainOn:  false, // 对齐 BOTW xnavi v3.2.2：统一采用 Run>=2 动力学刚体扫描，不走旧指针链
		coordsOn: true,  // coords 校准接管（/set-coords，locator_eden.go）
	}, t.rescanCh, t.stopCh, ctx)
}
