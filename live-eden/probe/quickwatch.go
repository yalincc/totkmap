// quickwatch：采样一组已知地址，观察玩家移动时哪些地址在动（副本轮换验证）。
// 用法：quickwatch.exe eden  <addr1> <addr2> ...（地址用 0x 前缀）
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	k32        = syscall.NewLazyDLL("kernel32.dll")
	openProc   = k32.NewProc("OpenProcess")
	readMem    = k32.NewProc("ReadProcessMemory")
	closeH     = k32.NewProc("CloseHandle")
	psapi      = syscall.NewLazyDLL("psapi.dll")
	enumMods   = psapi.NewProc("EnumProcessModules")
	getModBase = psapi.NewProc("GetModuleBaseNameW")
	enumProc   = psapi.NewProc("EnumProcesses")
)

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_VM_READ = 0x0010

func findPid(name string) uint32 {
	var pids [4096]uint32
	var needed uint32
	enumProc.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)*4), uintptr(unsafe.Pointer(&needed)))
	n := needed / 4
	for i := uint32(0); i < n; i++ {
		h, _, _ := openProc.Call(uintptr(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ), 0, uintptr(pids[i]))
		if h == 0 {
			continue
		}
		var mods [64]uintptr
		var cb uint32
		if em, _, _ := enumMods.Call(h, uintptr(unsafe.Pointer(&mods[0])), uintptr(len(mods)*8), uintptr(unsafe.Pointer(&cb))); em != 0 {
			var buf [260]uint16
			if gm, _, _ := getModBase.Call(h, mods[0], uintptr(unsafe.Pointer(&buf[0])), 260); gm > 0 {
				nm := strings.ToLower(syscall.UTF16ToString(buf[:]))
				if nm == name {
					closeH.Call(h)
					return pids[i]
				}
			}
		}
		closeH.Call(h)
	}
	return 0
}

func rd(h uintptr, addr uintptr) (float32, float32, float32, bool) {
	var b [12]byte
	var n uintptr
	r, _, _ := readMem.Call(h, addr, uintptr(unsafe.Pointer(&b[0])), 12, uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return 0, 0, 0, false
	}
	x := *(*float32)(unsafe.Pointer(&b[0]))
	y := *(*float32)(unsafe.Pointer(&b[4]))
	z := *(*float32)(unsafe.Pointer(&b[8]))
	return x, y, z, true
}

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: quickwatch.exe <procname> <addr1> <addr2> ...")
		return
	}
	pid := uint32(0)
	if v, err := strconv.ParseUint(os.Args[1], 10, 32); err == nil {
		pid = uint32(v)
	} else {
		pid = findPid(os.Args[1])
	}
	if pid == 0 {
		fmt.Println("process not found")
		return
	}
	h, _, _ := openProc.Call(uintptr(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ), 0, uintptr(pid))
	if h == 0 {
		fmt.Println("OpenProcess failed")
		return
	}
	defer closeH.Call(h)

	var addrs []uintptr
	for _, s := range os.Args[2:] {
		v, err := strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64)
		if err != nil {
			fmt.Println("bad addr:", s)
			return
		}
		addrs = append(addrs, uintptr(v))
	}

	// 首次采样基准
	bases := make([][3]float32, len(addrs))
	valid := make([]bool, len(addrs))
	for i, a := range addrs {
		x, y, z, ok := rd(h, a)
		bases[i] = [3]float32{x, y, z}
		valid[i] = ok
	}
	fmt.Printf("pid=%d addrs=%d  (0 = invalid base)\n", pid, len(addrs))
	for i := range addrs {
		fmt.Printf("  [%2d] 0x%012X  base=(%.2f, %.2f, %.2f) valid=%v\n", i, addrs[i], bases[i][0], bases[i][1], bases[i][2], valid[i])
	}

	// 30 拍，每拍 400ms，输出位移
	for tick := 1; tick <= 30; tick++ {
		time.Sleep(400 * time.Millisecond)
		line := fmt.Sprintf("t%02d:", tick)
		for i, a := range addrs {
			x, y, z, ok := rd(h, a)
			if !ok {
				line += fmt.Sprintf(" [%d]X", i)
				continue
			}
			d := 0.0
			if valid[i] {
				dx, dy, dz := float64(x-bases[i][0]), float64(y-bases[i][1]), float64(z-bases[i][2])
				d = sqrt(dx*dx + dy*dy + dz*dz)
				if d > 0.4 {
					fmt.Printf("  t%02d: addr[%d] 0x%012X MOVED %.1fm  cur=(%.2f, %.2f, %.2f)\n",
						tick, i, a, d, x, y, z)
				}
			}
			bases[i] = [3]float32{x, y, z}
			valid[i] = true
		}
		_ = line
	}
	fmt.Println("done 30 ticks")
}

func sqrt(v float64) float64 {
	x := v
	if x <= 0 {
		return 0
	}
	for i := 0; i < 24; i++ {
		x = (x + v/x) / 2
	}
	return x
}
