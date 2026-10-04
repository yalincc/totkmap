# live-eden

《王国之泪》（The Legend of Zelda: Tears of the Kingdom）在 **Eden 模拟器**（Yuzu 系，GPLv3 开源）下的实时定位程序。

## 功能

- 实时读取游戏内玩家坐标（东 X / 北 Y / 高 Z），输出与游戏 HUD 一致的坐标口径
- 定位方式（自动切换）：
  - **known 快路径**：记住玩家槽绝对地址，同会话内秒锁（<0.5s），Eden 内存布局稳定时跨重启也可能直接命中
  - **全量扫描**：known 失效（重启/场景切换）时，扫描全内存 RW 区域，按存档锚点窗口匹配玩家坐标槽
  - **冻结共识**：锁读数停滞 30s 后，在扫描候选池里找一致簇，玩家一动平滑换锁到活副本，站桩不误换
- 坐标口径已三重验证（游戏 HUD / UltraCam mod / 引擎读数）：`Z_stored = 高度 + 105`，内存序 `(X, Z_stored, Y_north)`
- HTTP API：`http://127.0.0.1:8766/pos` 返回 JSON 坐标，`/rescan` 强制重新扫描

## 使用

1. 启动 Eden 模拟器并进入《王国之泪》游戏
2. 运行 `engine/xnavi-core-eden.exe`
3. 浏览器/程序访问 `http://127.0.0.1:8766/pos` 获取坐标

## 目录

- `engine/`：定位引擎（Go，编译产物 xnavi-core-eden.exe）
- `probe/`：内存诊断与探针工具（开发用）

详见《live-eden V1.0.0技术方案与验证归档》。
