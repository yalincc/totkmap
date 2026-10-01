// spike_as.go — 地址空间探路（一次性试验，带明确失败终点）
//
// 背景：xnavi 的 pointer.go 拿"宿主虚拟地址"去游戏内存里比对找指针，长期 0 命中。
// 根因是模拟器有两套地址空间：guest 数据里存的指针是 **guest 虚拟地址**，
// 而我们扫描/锁定拿到的是**宿主虚拟地址**，两者数值根本对不上，扫多少遍都白搭。
//
// 但线性映射下有一个硬缝隙：**页内偏移天然相等**（host 与 guest 的映射都是 4KB
// 对齐，低 12 位相同）。于是可以：
//   1. 已知正确的宿主地址 M（先正常锁定）
//   2. 全内存找所有 V 满足 (V & 0xFFF) == (M & 0xFFF)，且 V 落在 guest 地址空间
//   3. 若映射是 host = guest + K，则真 K 会被同一对象池里的大量指针重复命中
//      （K = M - V 做直方图，取票数最高的若干候选）
//   4. 把候选 V 翻译回宿主地址 V+K，读三元组验证是否真是玩家坐标
//
// 失败终点写死：top-N 个 K 全部验证失败 → 输出"该槽无数据指针可达"并退出，
// 不许回头调窗口参数继续试。

package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	asProbeBudget   = 120 * time.Second // 全内存扫描时间预算
	asProbeLockWait = 180 * time.Second // 等待锁定（含提示玩家走动）
	asProbeHitsMax  = 4_000_000         // 候选上限（防内存爆）
	asProbeTopK     = 20                // 最多验证多少个 K
	asProbeVerifyN  = 12                // 每个 K 最多验证多少个候选地址
	// 下界只用来排除"明显的小整数噪音"（计数、尺寸、枚举值），**不要**拿
	// "Switch 应用地址空间起点 0x80000000"当过滤线 —— 那样做会误杀真候选：
	// 宿主块 0x035A640A0000 + 玩家槽 0x35AB148235C，按 0x80000000 起点反推出的
	// guest 地址只有约 215MB，说明该起点的假设在这个映射下并不成立。
	// 上界仍取 1TB 以覆盖 36-bit / 39-bit 地址空间。
	asProbeGuestLo = 0x100000
	asProbeGuestHi = 0x10000000000
	asProbeNearM   = 5.0 // 验证时坐标与本锁的最大差（米）
)

type asHit struct {
	val uint64 // 指针值（疑似 guest 地址）
}

// asExit 先刷新日志再退出。os.Stdout 已被 log_ts 换成管道，直接 os.Exit
// 会让管道里没消费完的最后几行丢失（实测吞掉了整个验证结果和结论）。
func asExit(code int) {
	flushLog()
	os.Exit(code)
}

// runASProbe 主流程：锁定 → 页内偏移指纹扫描 → 差分直方图解 K → 验证。
// 只在命令行带 -asprobe 时执行，绝不进入正常定位路径。
func runASProbe() {
	line := "=" + strings.Repeat("=", 63)
	fmt.Println(line)
	fmt.Println(" AS probe — 验证玩家槽是否存在『数据指针可达』路径")
	fmt.Println(line)

	// ---- 0) 附加模拟器 ----
	pid := findPid("ryujinx")
	if pid == 0 {
		fmt.Println("  Ryujinx 未运行，先启动模拟器再跑 -asprobe")
		asExit(1)
	}
	h, err := openProcess(pid)
	if err != nil || h == 0 {
		fmt.Println("  OpenProcess failed（试试以管理员身份运行）")
		asExit(1)
	}
	procHandle, procPID = h, pid
	fmt.Printf("  pid=%d\n", pid)

	// ---- 1) 先正常锁定，拿到"确认正确的"宿主地址 M ----
	progress = newProgressWatcher()
	go progress.loop()
	go stateMachine()

	fmt.Println("  等待锁定玩家坐标（若长时间不动，请在游戏里走一走）…")
	deadline := time.Now().Add(asProbeLockWait)
	graceAt := time.Now().Add(90 * time.Second) // 玩家站着不动时的宽限点
	M := uintptr(0)
	weak := false
	notified := false
	for time.Now().Before(deadline) {
		lock.mu.RLock()
		a := lock.addr
		v := lock.verified
		lock.mu.RUnlock()
		if a != 0 && v {
			M = a
			break
		}
		if a != 0 && !v {
			if !notified {
				notified = true
				fmt.Println("  已锁到候选但未『移动确认』——请在游戏里走动，否则无法确认它就是玩家槽")
			}
			// 站着不动的玩家永远凑不满移动确认（实测有一次干等 180 秒）。
			// 宽限到期后接受该候选并继续，但明确标注可信度较低 ——
			// 免得为了跑一次 spike 逼玩家一直走动。
			if time.Now().After(graceAt) {
				M, weak = a, true
				break
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	if M == 0 {
		fmt.Println("  AS probe 放弃：未能锁定玩家坐标")
		asExit(1)
	}
	if weak {
		fmt.Println("  ⚠ 未达成移动确认就采用该候选：它可能不是玩家槽，本次结果可信度较低")
	}
	state.mu.RLock()
	cur := [3]float32{state.gx, state.gy, state.gz}
	state.mu.RUnlock()
	fmt.Printf("  已锁定：host=0x%X  pos=(%.1f, %.1f, %.1f)\n", M, cur[0], cur[1], cur[2])

	// ---- 2) 页内偏移指纹扫描 ----
	low12 := uint64(M) & 0xFFF
	blocks := guestBlocksCached(h, minBlockMB)
	var total uintptr
	for _, b := range blocks {
		total += b.Size
	}
	fmt.Printf("  扫描 %d 个块（%.1f GB），找 low12 == 0x%X 的 8 字节值…\n",
		len(blocks), float64(total)/(1<<30), low12)

	var hits []asHit
	below := 0 // 低于 guest 地址下界被丢弃的数量（诊断噪音规模用）
	t0 := time.Now()
	const chunk = 4 << 20 // 4MB
	scanned := uintptr(0)
	overBudget := false
	for _, b := range blocks {
		var off uintptr
		for off < b.Size {
			n := uintptr(chunk)
			if b.Size-off < n {
				n = b.Size - off
			}
			buf := readMem(h, b.Base+off, int(n))
			if len(buf) >= 8 {
				for i := 0; i+8 <= len(buf); i += 4 {
					v := binary.LittleEndian.Uint64(buf[i : i+8])
					if v < asProbeGuestLo {
						below++
						continue
					}
					if v >= asProbeGuestHi {
						continue
					}
					if (v & 0xFFF) != low12 {
						continue
					}
					hits = append(hits, asHit{v})
				}
			}
			off += n
			scanned += n
			if len(hits) >= asProbeHitsMax {
				fmt.Printf("  候选已达上限 %d，提前收工\n", asProbeHitsMax)
				break
			}
			if time.Since(t0) > asProbeBudget {
				overBudget = true
				break
			}
		}
		if overBudget || len(hits) >= asProbeHitsMax {
			break
		}
	}
	scanSec := time.Since(t0).Seconds()
	fmt.Printf("  扫了 %.1f GB / %.1fs，命中 %d 个候选（另有 %d 个 < 0x%X 判为噪音丢弃）%s\n",
		float64(scanned)/(1<<30), scanSec, len(hits), below, asProbeGuestLo,
		map[bool]string{true: "（超时间预算，带已有数据收工）", false: ""}[overBudget])
	if len(hits) == 0 {
		fmt.Println("  AS probe 结论：0 候选 —— 该槽无数据指针可达（计算寻址可能性大）")
		asExit(0)
	}

	// ---- 3) 差分直方图：真 K 会被同一对象池的指针重复命中 ----
	hist := map[uint64]int{}
	byK := map[uint64][]uint64{}            // K -> 不同的 V（验证用）
	byKSeen := map[uint64]map[uint64]bool{} // K -> 已收录的 V，用于去重
	for _, hit := range hits {
		if hit.val > uint64(M) {
			continue
		}
		k := uint64(M) - hit.val // 低 12 位相同 → k 必为 4096 的倍数
		if k == 0 {
			continue
		}
		hist[k]++
		// 只保留**不同**的 V。首轮踩坑：同一个值常被上千处引用，不去重的话
		// 每个 K 最终只有 1 个候选，验证样本退化为 1 个（日志里就是 "0/1"）。
		if byKSeen[k] == nil {
			byKSeen[k] = map[uint64]bool{}
		}
		if len(byK[k]) < asProbeVerifyN && !byKSeen[k][hit.val] {
			byKSeen[k][hit.val] = true
			byK[k] = append(byK[k], hit.val)
		}
	}
	type kc struct {
		k uint64
		n int
	}
	var ks []kc
	for k, n := range hist {
		if n >= 2 { // 单票不足信，至少 2 票
			ks = append(ks, kc{k, n})
		}
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i].n > ks[j].n })
	fmt.Printf("  K 候选（票数 ≥2）：%d 个，取前 %d 验证\n", len(ks), asProbeTopK)
	if len(ks) == 0 {
		fmt.Println("  AS probe 结论：无 ≥2 票的 K —— 该槽无数据指针可达")
		asExit(0)
	}

	// 块范围（翻译出的宿主地址必须落在里面，否则是巧合）
	blkLo, blkHi := uintptr(^uint(0)), uintptr(0)
	for _, b := range blocks {
		if b.Base < blkLo {
			blkLo = b.Base
		}
		if e := b.Base + b.Size; e > blkHi {
			blkHi = e
		}
	}

	// ---- 4) 逐个 K 验证 ----
	// 关键：验证基准必须**实时**读。首轮 spike 拿"锁定那一刻的快照"当基准，
	// 而玩家一直在走动，等到 12 秒后验证时早已离开那个位置 → 全部误判为 0。
	lock.mu.RLock()
	curAddr := lock.addr
	lock.mu.RUnlock()
	if curAddr != 0 {
		if d := decodePos(readMem(h, curAddr, 12)); d != nil {
			cur = [3]float32{d[0], d[1], d[2]}
		}
	}
	fmt.Printf("  验证基准（实时读取 0x%X）：pos=(%.1f, %.1f, %.1f)\n", curAddr, cur[0], cur[1], cur[2])
	fmt.Println("  验证（把候选 V 翻译成 host=V+K 后读坐标）：")
	bestK, bestOK, bestValid := uint64(0), 0, 0
	for i, e := range ks {
		if i >= asProbeTopK {
			break
		}
		K := e.k
		seen := map[uint64]bool{}
		var addrs []uintptr
		for _, v := range byK[K] {
			if seen[v] {
				continue
			}
			seen[v] = true
			a := uintptr(v + K)
			if a < blkLo || a >= blkHi {
				continue // 翻译结果不在 guest 块内 → 巧合
			}
			addrs = append(addrs, a)
			if len(addrs) >= asProbeVerifyN {
				break
			}
		}
		validN, hitN := 0, 0
		for _, a := range addrs {
			d := decodePos(readMem(h, a, 12))
			if d == nil {
				continue
			}
			validN++ // 翻译结果能读出合法坐标 → 说明这个 K 的映射大致成立
			if dist3([3]float32{d[0], d[1], d[2]}, cur) < asProbeNearM {
				hitN++ // 正好就是玩家坐标 → 这些 V 里存在指向玩家槽的指针
			}
		}
		fmt.Printf("    K=0x%-14X 票=%-6d 不同V=%-3d 合法坐标=%-3d 玩家坐标命中=%d\n",
			K, e.n, len(addrs), validN, hitN)
		// 判据要防自证：K 本就是由某个 V 定义的（V+K ≡ M），所以"命中玩家坐标"
		// 对任何 K 都必然成立一次。只有**多个不同的 V 都指向玩家坐标**才算证据
		// —— 那说明内存里确实存在一组指向玩家槽的指针，而不是孤证。
		if hitN >= 2 && validN >= 2 {
			if hitN > bestOK {
				bestK, bestOK, bestValid = K, hitN, validN
			}
		}
	}

	// ---- 5) 结论（有明确失败终点）----
	fmt.Println(line)
	if bestOK >= 2 {
		fmt.Printf("  ✅ 成功：host = guest + 0x%X\n", bestK)
		fmt.Printf("     %d 个候选读出玩家坐标，另有 %d 个读出其它合法坐标（说明映射普遍成立）\n", bestOK, bestValid)
		fmt.Printf("     玩家槽 guest 地址 = 0x%X\n", uint64(M)-bestK)
		fmt.Println("     下一步：据此反查指向该 guest 地址的静态指针，逐级回溯到模块基址，")
		fmt.Println("     得到固定链条后即可确定性寻址，彻底摆脱扫描。")
	} else {
		fmt.Printf("  ❌ 失败：前 %d 个 K 全部验证失败（最佳命中 %d，需 ≥2）\n", asProbeTopK, bestOK)
		fmt.Println("     结论：该槽**无数据指针可达**（大概率是『基址 + index × stride』计算寻址）。")
		fmt.Println("     不要再调窗口参数重试 —— 应改用『长期候选池 + 随动投票』路线。")
	}
	fmt.Println(line)
	asExit(0)
}
