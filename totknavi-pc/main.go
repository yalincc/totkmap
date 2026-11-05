// main.go — totknavi-pc 定位探针（PC 重编译版）。
//
// 用法：
//   totknavi-pc.exe                      自动附加 totk.exe，用存档锚点扫描
//   totknavi-pc.exe --coords 448 1535 -1313   用游戏内 HUD 坐标做锚点（无存档时）
//   totknavi-pc.exe --blocks             只打印进程内存布局（不开扫）
//   totknavi-pc.exe --full               跳过分级优化，直接全进程扫描
//
// 交互：每轮扫描后回车继续（可验证传送/切层后地址是否延续），Ctrl+C 退出。

package main

import (
	"bufio"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"time"
)

func main() {
	setConsoleTitle("TOTKnavi-PC 定位探针")

	var (
		coordsArg  [3]float32
		haveCoord  bool
		blocksOnly bool
		fullScan   bool
		watchMode  bool
		findMode   bool
		gapSec     = 3
		port       = 8766
		appRoot    string
		logPath    string
		addrArg    uintptr
	)
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--coords":
			if i+3 < len(args) {
				for k := 0; k < 3; k++ {
					v, err := strconv.ParseFloat(args[i+1+k], 32)
					if err != nil {
						fatalf("--coords 参数解析失败: %v", err)
					}
					coordsArg[k] = float32(v)
				}
				haveCoord = true
				i += 3
			}
		case "--addr":
			if i+1 < len(args) {
				s := args[i+1]
				if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X") {
					s = s[2:]
				}
				v, err := strconv.ParseUint(s, 16, 64)
				if err != nil {
					fatalf("--addr 解析失败: %v", err)
				}
				addrArg = uintptr(v)
				i++
			}
		case "--watch":
			watchMode = true
		case "--serve":
			// 默认即为 serve
		case "--no-open":
			// 兼容 totknavi-gui 传入的 --no-open
		case "--emu=auto", "--emu=ryujinx", "--emu=eden", "--emu=pc":
			// 兼容 totknavi-gui 传入的 --emu 参数
		case "--find":
			findMode = true
		case "--log":
			if i+1 < len(args) {
				logPath = args[i+1]
				i++
			} else {
				logPath = "pos.log"
			}
		case "--app":
			if i+1 < len(args) {
				appRoot = args[i+1]
				i++
			}
		case "--gap":
			if i+1 < len(args) {
				n, err := strconv.Atoi(args[i+1])
				if err != nil || n <= 0 {
					fatalf("--gap 参数非法: %s", args[i+1])
				}
				gapSec = n
				i++
			}
		case "--port":
			if i+1 < len(args) {
				n, err := strconv.Atoi(args[i+1])
				if err != nil || n <= 0 || n > 65535 {
					fatalf("--port 参数非法: %s", args[i+1])
				}
				port = n
				i++
			}
		case "--blocks":
			blocksOnly = true
		case "--full":
			fullScan = true
		case "-h", "--help":
			usage()
			return
		}
	}

	// Ctrl+C 优雅退出
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt)
	go func() {
		<-sig
		fmt.Println("\n[exit] 收到中断，退出。")
		os.Exit(0)
	}()

	p := probePlatform()
	if p == nil {
		fatalf("没有可用平台驱动")
	}
	plat, ok := p.(*totkpcPlatform)
	if !ok {
		fatalf("平台驱动类型异常")
	}
	if !p.Attach() {
		fatalf("未检测到 totk.exe 游戏进程。请先启动游戏并进入 3D 画面，再运行定位。")
	}
	setPlatform(p)
	h := p.Handle()

	if logPath != "" {
		if err := openPosLog(logPath); err != nil {
			fmt.Printf("  [!] 日志文件创建失败：%v\n", err)
		} else {
			fmt.Printf("  [ok] 逐拍日志 → %s\n", logPath)
		}
	}

	fmt.Println("==================================================================")
	fmt.Printf(" TOTKnavi-PC 定位探针  |  %s\n", plat.describe())
	fmt.Println("==================================================================")

	// 主模块基址校验
	mb := plat.MainBase()
	if mb == 0 {
		fmt.Println("  [warn] 主模块镜像自适应探测未命中，将回退至特征扫描模式")
	} else {
		fmt.Printf("  [ok] 主模块镜像已确认：0x%X（自适应探测成功）\n", mb)
	}
	eb, es := plat.ExeBase()
	fmt.Printf("  [ok] totk.exe 加载基址：0x%X  镜像 %.1fMB（ASLR，每次启动会变）\n", eb, float64(es)/1048576.0)

	// 内存块统计
	blks := p.Blocks(0.0625)
	total := uintptr(0)
	for _, b := range blks {
		total += b.Size
	}
	fmt.Printf("  [ok] 扫描范围：%d 块 / %.1fMB（主模块 + exe 数据段 + 主堆）\n", len(blks), float64(total)/1048576.0)
	if blocksOnly {
		dumpBlocks(plat, blks)
		return
	}

	// 锚点
	var anchor *[3]float32
	if haveCoord {
		// HUD 序 (gx 东, gy 北, gz 高) → 内存序 (X, Z_stored, Y_north)
		// 注意：hud 定义是 gy = **-Y_north**（见 tracker.go 注释），所以第三轴要取反。
		// 2026-10-31 修复：之前漏了取反，锚点会跑到天南地北，导致按距离排序全错。
		mem := [3]float32{coordsArg[0], coordsArg[2] + elevBias, -coordsArg[1]}
		anchor = &mem
		fmt.Printf("  [锚] 手动 HUD 坐标 (%.1f, %.1f, %.1f) → 内存序 (%.1f, %.1f, %.1f)\n",
			coordsArg[0], coordsArg[1], coordsArg[2], mem[0], mem[1], mem[2])
	} else {
		anchors := readAnchors(p)
		if len(anchors) > 0 {
			a := anchors[0].Pos
			anchor = &a
			fmt.Printf("  [锚] 存档 (%.1f, %.1f, %.1f) 内存序  |  %s\n", a[0], a[1], a[2], anchors[0].Path)
			if len(anchors) > 1 {
				fmt.Printf("       另有 %d 个存档锚点（已按 slot/时间排序）\n", len(anchors)-1)
			}
			fmt.Printf("       注意：锚点是你【上次存档】的位置；若之后走远了，请用 --coords 指定当前坐标\n")
		} else {
			fmt.Println("  [锚] 未读到存档锚点 → 将全范围扫描（候选较多，建议用 --coords 指定 HUD 坐标）")
		}
	}

	if findMode {
		findMoving(p, plat, anchor, time.Duration(gapSec)*time.Second)
		return
	}

	if watchMode {
		watchRun(p, plat, anchor, addrArg)
		return
	}

	// 默认启动定位服务（提供 8766 HTTP 端口与 status.json 供 GUI 独立窗口使用）
	serveRun(p, plat, anchor, addrArg, port, appRoot)
	return

	rd := bufio.NewReader(os.Stdin)
	var prevTop *ptkHit
	round := 0
	for {
		round++
		fmt.Printf("\n=== 第 %d 轮扫描 ===\n", round)
		start := time.Now()
		var pctMu sync.Mutex
		lastPct := -1
		progress := func(done, tot uintptr) {
			if tot == 0 {
				return
			}
			pct := int(float64(done) / float64(tot) * 100)
			pctMu.Lock()
			show := pct != lastPct && pct/25 != lastPct/25
			if show {
				lastPct = pct
			}
			pctMu.Unlock()
			if show {
				fmt.Printf("    ... 扫描进度 %d%%\n", pct)
			}
		}

		_ = fullScan
		hits := ptkScanBlocks(h, blks, anchor, 0, progress)

		// Run>=2 真身门禁
		var ident []ptkHit
		for _, x := range hits {
			if x.Run >= 2 {
				ident = append(ident, x)
			}
		}
		groups := ptkGroupHits(ident)
		fmt.Printf("  原始坐标候选 %d → Run>=2 门禁后 %d → 聚合 %d 组（耗时 %.2fs）\n",
			len(hits), len(ident), len(groups), time.Since(start).Seconds())

		if len(groups) == 0 {
			fmt.Println("  [!] 未命中 Run>=2 结构槽。排查方向：")
			fmt.Println("      1) 角色是否已在 3D 世界里（标题/加载画面槽位未初始化）")
			fmt.Println("      2) 用 --coords 指定当前 HUD 坐标再试")
			fmt.Println("      3) 该版本 Recomp 可能改了结构（跑 --full 全扫看看）")
		} else {
			show := groups
			if len(show) > 10 {
				show = groups[:10]
			}
			fmt.Println("  ------------------------------------------------------------------")
			for i, g := range show {
				hdStr := "--"
				if g.HasHeading {
					hdStr = fmt.Sprintf("%.1f°", g.Heading)
				}
				fmt.Printf("  #%-2d addr=0x%-12X run=%-2d copies=%-3d 朝向=%-8s hud=(%.1f, %.1f, %.1f) 块偏移=0x%X\n",
					i+1, g.Addr, g.Run, g.Copies, hdStr,
					g.P[0], -g.P[2], g.P[1]-elevBias, g.Addr-g.Chunk)
			}
			fmt.Println("  ------------------------------------------------------------------")

			if prevTop != nil {
				if prevTop.Addr == groups[0].Addr {
					fmt.Printf("  对比上轮：top1 地址 0x%X 延续 ✓\n", groups[0].Addr)
				} else {
					fmt.Printf("  对比上轮：top1 由 0x%X 变为 0x%X（候选轮换）\n", prevTop.Addr, groups[0].Addr)
				}
			}
			prevTop = &groups[0]

			// 连续读验证
			top := groups[0]
			fmt.Printf("\n  锁定 top1 = 0x%X，连续读 10 秒验证 —— 请在这 10 秒内【走动几步】或【转个身】\n", top.Addr)
			var last [3]float32
			haveLast := false
			moved := 0.0
			for t := 0; t < 20; t++ {
				pos, hd, hasH, ok := ptkReadSlot(h, top.Addr)
				if ok {
					line := fmt.Sprintf("    %s hud=(%.2f, %.2f, %.2f)", time.Now().Format("15:04:05"), pos[0], pos[1], pos[2])
					if hasH {
						line += fmt.Sprintf("  朝向=%.1f°", hd)
					}
					if haveLast {
						delta := dist3(pos, last)
						moved += float64(delta)
						line += fmt.Sprintf("  位移=%.2fm", delta)
					}
					last = pos
					haveLast = true
					fmt.Println(line)
				} else {
					fmt.Printf("    %s addr=0x%X <invalid>\n", time.Now().Format("15:04:05"), top.Addr)
				}
				time.Sleep(500 * time.Millisecond)
			}
			if moved > 3 {
				fmt.Printf("\n  ✓ 跟随验证通过：10 秒内累计位移 %.1fm，坐标跟着角色在动 —— 这就是玩家真身槽。\n", moved)
			} else {
				fmt.Printf("\n  ? 跟随验证存疑：累计位移仅 %.1fm。如果角色确实动了，说明锁错了候选。\n", moved)
			}
		}

		fmt.Print("\n  回车扫下一轮（可先传送/切层，验证地址是否延续）；Ctrl+C 退出\n> ")
		if _, err := rd.ReadString('\n'); err != nil {
			return
		}
	}
}

func dumpBlocks(p Platform, blks []MemBlock) {
	tp, _ := p.(*totkpcPlatform)
	mb := uintptr(0)
	eb, es := uintptr(0), uintptr(0)
	if tp != nil {
		mb = tp.MainBase()
		eb, es = tp.ExeBase()
	}
	fmt.Println("\n  base              size(MB)  分类")
	var sum uintptr
	for _, b := range blks {
		sum += b.Size
		kind := "other"
		if mb != 0 && b.Base >= mb && b.Base < mb+0x10000000 {
			kind = "MAIN-MODULE"
		} else if eb != 0 && b.Base >= eb && b.Base < eb+es {
			kind = "EXE-DATA"
		}
		if b.Size >= 8<<20 || kind != "other" {
			fmt.Printf("  0x%-12X %9.1f  %s\n", b.Base, float64(b.Size)/1048576.0, kind)
		}
	}
	fmt.Printf("  合计 %.1fMB / %d 块\n", float64(sum)/1048576.0, len(blks))
}

func usage() {
	fmt.Println(`totknavi-pc — TOTK PC 重编译版定位

  totknavi-pc.exe                     交互式探针（存档锚点扫描）
  totknavi-pc.exe --watch             控制台追踪（看坐标 + 朝向）
  totknavi-pc.exe --serve             起服务 + 自动打开网页地图
  totknavi-pc.exe --coords gx gy gz   手动指定锚点（存档太旧时用）
  totknavi-pc.exe --addr 0x...        直接锁已知地址

  排查用：
  --log out.log                       把每拍数据写文件（分析漂移/跳变）
  --port 8767                         换端口
  --blocks                            只打印内存布局
  --app DIR                           指定网页目录（默认 ../app）

  gx/gy/gz = 游戏地图界面显示的 X / Y / Z（东 / 北 / 高）`)
}

func fatalf(format string, a ...any) {
	fmt.Printf("[错误] "+format+"\n", a...)
	os.Exit(1)
}
