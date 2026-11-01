// data_dir.go — 定位前端数据目录（app/data）。

package main

import (
	"os"
	"path/filepath"
)

// dataDir 依次尝试本地与上级各层目录。
func dataDir() string {
	isDataDir := func(p string) bool {
		fi, err := os.Stat(p)
		if err != nil || !fi.IsDir() {
			return false
		}
		// 必须包含关键数据文件之一
		for _, f := range []string{"heightmap_downsampled.bin", "markers.js", "area_sky.js"} {
			if _, err := os.Stat(filepath.Join(p, f)); err == nil {
				return true
			}
		}
		return false
	}

	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, p := range []string{
			filepath.Join(dir, "data"),
			filepath.Join(dir, "app", "data"),
			filepath.Join(dir, "..", "data"),
			filepath.Join(dir, "..", "app", "data"),
			filepath.Join(dir, "..", "..", "data"),
			filepath.Join(dir, "..", "..", "app", "data"),
			filepath.Join(dir, "..", "..", "..", "data"),
			filepath.Join(dir, "..", "..", "..", "app", "data"),
		} {
			if isDataDir(p) {
				return p
			}
		}
	}
	return filepath.Join("..", "app", "data")
}
