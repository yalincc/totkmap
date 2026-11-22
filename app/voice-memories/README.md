# TOTKmap · 声之记忆（Voice Memories · 240 条）独立模块

本目录为完全独立、可插拔的《声之记忆》子模块，遵循与 `app/voice/` 一致的零耦合设计：
- **资料独立隔离**：240 条权威数据内置于本目录 `vm-data.js`，不写入 `app/data/`、`catalogs.js` 或 `markers.js`。
- **进度独立隔离**：收集进度独立存储在 `localStorage['totkmap.vm.done.v1']`，不进入左侧栏，也绝不会被 `progress.sav` 存档同步清空；支持面板内一键导出/导入 JSON。
- **原声仅在导航网站按需读取**：不内置进 `TOTKNavi` 桌面程序，避免桌面端体积膨胀。

## 目录结构

```text
app/voice-memories/
├── vm-data.js      ← 240 条声之记忆数据（劳鲁 35 + 塞尔达 150 + 可盖 55）
├── vm-player.js    ← 独立引擎（入口胶囊、抽屉面板、三角色剧情卡、20m 自动共鸣、TTS 兜底）
├── vm-style.css    ← 独立样式（劳鲁青绿 / 塞尔达金 / 可盖暗红，PC + 手机双端适配）
├── audio/          ← 网站端原声 MP3 存放目录（按需读取，可选）
└── README.md       ← 本说明文档
```

## 原声音频配置方式（网站端读取）

1. **本地站点直读**：将切分好的 `.mp3` 放入 `app/voice-memories/audio/`，按唯一 ID 命名：
   - 天空·劳鲁：`vm_rauru_001.mp3` ~ `vm_rauru_035.mp3`
   - 地上·塞尔达：`vm_zelda_001.mp3` ~ `vm_zelda_150.mp3`
   - 地下·可盖：`vm_kohga_001.mp3` ~ `vm_kohga_055.mp3`
2. **云端 CDN / 对象存储流式读取**：在网页中配置 `window.TOTK_VM_AUDIO_BASE = 'https://your-cdn.example.com/vm-audio/'`（或在控制台调用 `VoiceMemories.setConfig({ audioBase: '...' })`）。
3. **无音频包优雅降级**：若未放置原声 `.mp3` 或断网，点击播放自动切换为角色音色 TTS 朗读卡片台词，0 报错。

## 卸载方式

只需删除 `app/voice-memories/` 文件夹，并移除 `app/index.html` 中对应的 3 行引入即可，原项目零影响。
