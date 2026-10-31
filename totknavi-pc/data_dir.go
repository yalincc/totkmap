// data_dir.go — 定位前端数据目录（app/data）。
//
// progress_totk2.go 需要读 data/totk_save_hashes.js 和 data/explore_save_map.js，
// 这两个文件在 TOTKmap 的 app/data 下，PC 版与模拟器版共用同一份（任务/神庙/探索
// 数据结构完全一样），所以这里只做目录探测，不复制数据。

package main

import (
	"os"
	"path/filepath"
)

// dataDir 依次尝试：<exe>/app/data、<exe>/../app/data、<exe>/data、<exe>/../data。
func dataDir() string {
	isDir := func(p string) bool {
		fi, err := os.Stat(p)
		return err == nil && fi.IsDir()
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, p := range []string{
			filepath.Join(dir, "app", "data"),
			filepath.Join(dir, "..", "app", "data"),
			filepath.Join(dir, "data"),
			filepath.Join(dir, "..", "data"),
		} {
			if isDir(p) {
				return p
			}
		}
	}
	return filepath.Join("..", "app", "data")
}
