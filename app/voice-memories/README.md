# TOTKmap · 声之记忆（Voice Memories · 240 条）独立模块

本目录为完全独立、可插拔的《声之记忆》子模块，遵循与 `app/voice/` 一致的零耦合设计：
- **资料独立隔离**：240 条权威数据内置于本目录 `vm-data.js`，不写入 `app/data/`、`catalogs.js` 或 `markers.js`。
- **进度独立隔离**：收集进度独立存储在 `localStorage['totkmap.vm.done.v1']`，不进入左侧栏，也绝不会被 `progress.sav` 存档同步清空；支持面板内一键导出/导入 JSON。
- **原声仅在导航网站按需读取**：不内置进 `TOTKNavi` 桌面程序，避免桌面端体积膨胀。

## 目录结构

```text
app/voice-memories/
├── vm-data.js      ← 240 条声之记忆数据（劳鲁 35 + 塞尔达 150 + 可盖 55）
├── vm-player.js    ← 独立引擎（底栏开关、三角色剧情卡、35m 自动共鸣、本地/线上音频回退）
├── vm-style.css    ← 独立样式（劳鲁青绿 / 塞尔达金 / 可盖暗红，PC + 手机双端适配）
├── audio-ja/       ← 240 条日文原声 libopus 16k VOIP .webm（默认配音，约 11.1 MB，随线上站部署）
├── audio/          ← 240 条中文配音 libopus 16k VOIP .webm（edge-tts 按官方简中生成，待克隆配音替换）
└── README.md       ← 本说明文档
```

## 原声音频配置方式（网站端读取）

配音语言在「设置 → 语音 → 声之记忆 → 配音」切换：**日文原声（默认）** 读 `audio-ja/`，**中文** 读 `audio/`，两目录文件名一致。

1. **本地站点直读**：按唯一 ID 命名放入对应目录：
   - 天空·劳鲁：`vm_rauru_001.webm` ~ `vm_rauru_035.webm`
   - 地上·塞尔达：`vm_zelda_001.webm` ~ `vm_zelda_150.webm`
   - 地下·可盖：`vm_kohga_001.webm` ~ `vm_kohga_055.webm`
2. **云端 CDN / 对象存储流式读取**：配置 `window.TOTK_VM_AUDIO_BASE = 'https://your-cdn.example.com/voice-memories/'`（指向含 `audio/`、`audio-ja/` 的根目录；或 `VoiceMemories.setConfig({ audioBase: '...' })`）；默认本地未命中时自动回退至 `https://totk.yalin.site/voice-memories/<audio|audio-ja>/`（本身在线上站时不重复请求）。
3. **无音频包静默降级**：若本地与线上均加载失败（如纯断网），剧情卡保留完整台词阅读并提示“语音加载失败（请检查网络）”，绝不回退机械系统 TTS，0 报错。

## 卸载方式

只需删除 `app/voice-memories/` 文件夹，并移除 `app/index.html` 中对应的 3 行引入即可，原项目零影响。
