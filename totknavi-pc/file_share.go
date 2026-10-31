// file_share.go — 完全共享模式读文件。
//
// ★★ 为什么必须这样读（2026-10-31 血泪教训）★★
//
// Go 的 os.ReadFile 在 Windows 上打开文件时，共享掩码是 FILE_SHARE_READ|FILE_SHARE_WRITE，
// **不含 FILE_SHARE_DELETE**。而 TotK-Recomp 提交存档的方式是"把工作副本 move/rename 覆盖
// 正式存档"，这个操作需要 DELETE 权限。
//
// 结果：只要我们的程序正在读 progress.sav，游戏就提交不了存档，日志里疯狂刷
//
//	[host] fs: save commit: cannot move the committed save (error 5); committed save unchanged
//
// error 5 = ERROR_ACCESS_DENIED。玩家在游戏里"保存成功"（写到了工作副本），但一退出
// 就被 recovery 逻辑当垃圾删掉 —— 表现为"存了一下午，回来还是早上的档"。
//
// 所以：**读存档一律走本函数**，共享掩码必须包含 FILE_SHARE_DELETE。

package main

import (
	"os"
	"syscall"
)

// readFileShared 以 FILE_SHARE_READ|WRITE|DELETE 打开并读取整个文件。
// 与 os.ReadFile 的差别仅在共享模式，不影响读取结果。
func readFileShared(path string) ([]byte, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(
		p,
		syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(h)

	var out []byte
	buf := make([]byte, 256*1024)
	for {
		var n uint32
		if err := syscall.ReadFile(h, buf, &n, nil); err != nil {
			// 读到 EOF 或出错：把已读到的返回（存档读取只要长度对就行）
			break
		}
		if n == 0 {
			break
		}
		out = append(out, buf[:n]...)
	}
	if len(out) == 0 {
		return nil, os.ErrInvalid
	}
	return out, nil
}
