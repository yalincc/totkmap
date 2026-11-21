# TOTKmap 独立语音导航模块 (`app/voice/`) · 架构与自定义音色替换指南

本目录是 **TOTKmap（网页地图）** 专属的**零耦合、可插拔实时语音导航模块**（语音交互与参数完全收口在网页端，`TOTKNavi` 桌面定位端保持纯粹轻量化，不内置语音）。

---

## 一、目录结构

```text
app/voice/
├── voice-nav.js          ← 独立核心引擎（UMD 纯原生 JS，对外暴露 window.VoiceNav）
├── voice-config.json     ← 音色配置与 32 个标准导航词条定义表
├── zelda/                ← 离线语音包 A：塞尔达公主风（中文 32 个 .mp3 切片）
├── yujie/                ← 离线语音包 B：御姐领航员（中文 32 个 .mp3 切片）
├── en/                   ← 离线语音包 C：英文女声（英式塞尔达风 32 个 .mp3 切片，英文界面自动启用）
└── README.md             ← 本说明文档
```

---

## 二、如何替换或定制属于自己的语音包？

### 方式 1：使用 `tools/build_voice_packs.py` 一键调整微软神经网络音色
1. 打开 `app/voice/voice-config.json`，在 `"packs"` 下修改对应音色的参数：
   - `"voice"`：可更换为任意 `edge-tts` 支持的中文音色（例如 `zh-CN-XiaoyiNeural`、`zh-CN-XiaoxiaoNeural`、`zh-CN-XiaohanNeural`、`zh-CN-YunxiNeural` 等）；
   - `"rate"`：语速微调（如 `"-4%"`、`"+5%"`）；
   - `"pitch"`：音高微调（如 `"+5Hz"`、`"-5Hz"`）；
   - `"clips"`：可自由修改 32 个词条的具体播报台词。
2. 在项目根目录执行：
   ```powershell
   python tools/build_voice_packs.py
   ```
   脚本会自动合成全部 64 个 `.mp3` 并执行 **MPEG 帧级首尾静音裁剪**（无需安装 `ffmpeg`），确保方向、距离与高低差多词条连读紧凑无卡顿。刷新网页地图（或清理缓存）即可生效。

### 方式 2：使用 `GPT-SoVITS` 等 AI 声音克隆模型或真人录音直接替换
只需按照 `voice-config.json` 中 `"clips"` 的 32 个键名，导出同名 `.mp3` 覆盖放入 `app/voice/zelda/` 或 `app/voice/yujie/` 即可（无需改动任何代码）：

| 词条文件名 | 默认台词 | 触发时机 |
|---|---|---|
| `welcome.mp3` | 语音导航已就绪。 | 点击试听或首次开启 |
| `start_nav.mp3` | 开始导航。 | 单点手动点击「导航」 |
| `start_auto.mp3` | 开启自动收集。 | 开启探索/材料自动收集 |
| `next_target.mp3` | 完成！下一个目标， | 当前目标完成，自动续导下一个 |
| `switch_near.mp3` | 发现更近目标， | 跑图中动态切换到更近同类标点 |
| `dir_n.mp3` ~ `dir_nw.mp3` | 正北/东北/正东/东南/正南/西南/正西/西北方向， | 罗盘 8 方位绝对方向播报 |
| `dist_far.mp3` | 距离较远，建议先传送。 | 距离 $>1000\text{m}$ |
| `dist_800.mp3` ~ `dist_50.mp3` | 约八百米 / 约五百米 / 约四百米 / 三百米 / 两百米 / 一百五十米 / 一百米 / 五十米。 | 起步与中途里程碑距离播报 |
| `arrived.mp3` | 已到达目标附近。 | 进入到达距离阈值（默认 $35\text{m}$，可在设置中自定义 $15\sim80\text{m}$） |
| `all_done.mp3` | 太棒了，本层目标已全部完成！ | 自动收集队列全部完成 |
| `alt_up.mp3` / `alt_down.mp3` | 目标在上方。 / 目标在下方。 | 垂直高度差 $|\Delta Z| \ge$ 高低差阈值（默认 $25\text{m}$，可自定义 $10\sim60\text{m}$） |
| `layer_sky.mp3` / `layer_surface.mp3` / `layer_depths.mp3` | 注意，目标在天空/地上/地下层。 | 玩家当前层与目标所在层不一致 |
| `off_course.mp3` | 方向偏离，目标在 | 背离目标（$>120^\circ$）连续移动 6 秒时播报 |
| `korok_near.mp3` / `shrine_near.mp3` | 附近有克洛格的气息哦。 / 感应到神庙反应。 | 到达克洛格或神庙附近时的专属彩蛋语音 |
