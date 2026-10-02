<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3 overflow-y-auto">
    <!-- 设置 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-4 max-w-xl">
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">设置</div>
      <div class="space-y-3 text-xs">
        <div>
          <label class="block text-slate-400 mb-1">Ryujinx 路径（留空自动探测）：</label>
          <div class="flex gap-1">
            <input v-model="cfg.ryujinxDir" placeholder="自动探测（按进程名）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
            <button @click="pickRyujinx" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
          </div>
          <div class="text-[10px] text-slate-600 mt-1" :class="ryuOk ? 'text-emerald-400' : ''">{{ ryuHint }}</div>
        </div>
        <div>
          <label class="block text-slate-400 mb-1">存档路径（留空自动探测）：</label>
          <div class="flex gap-1">
            <input v-model="cfg.saveDir" placeholder="自动探测（%APPDATA%\Ryujinx）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
            <button @click="pickSave" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
          </div>
        </div>
        <div class="text-[10px] text-slate-500">模拟器与游戏固定为 Ryujinx + 王国之泪（TOTK），无切换选项。</div>
      </div>
      <div class="flex items-center gap-2 mt-4">
        <button class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white" @click="doSave">保存</button>
        <span v-if="savedMsg" class="text-[11px] text-emerald-400 font-mono">{{ savedMsg }}</span>
      </div>
    </section>

    <!-- 关于 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-4 max-w-xl text-xs space-y-2">
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">关于</div>
      <div class="text-slate-300">TOTKNavi · 王国之泪 (TOTK) 定位导航程序</div>
      <div class="text-slate-400 font-mono">版本：{{ ver }}</div>
      <div class="text-slate-400">地图：<a :href="mapUrl" class="text-blue-400 hover:underline">{{ mapUrl.replace('https://','').replace(/\/$/,'') }}</a></div>
      <div class="text-slate-400">GitHub：<a href="https://github.com/yalincc/totkmap" class="text-blue-400 hover:underline">yalincc/totkmap</a></div>
      <div class="text-slate-500">只读内存，不注入，不修改游戏。</div>
      <div class="flex gap-2 pt-2">
        <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="checkUpdate">检查更新</button>
        <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="exportDiag">导出诊断包</button>
        <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="openLogDir">打开目录</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import {
  cfg, envDetect, ver, mapUrl, pickRyujinx, pickSave, saveSettings,
  checkUpdate, exportDiag, openLogDir
} from '../composables/useCore'

const savedMsg = ref('')
const ryuOk = computed(() => envDetect.ryujinx)
const ryuHint = computed(() => envDetect.ryujinx ? '✓ Ryujinx 路径已配置' : '未配置路径（点开始后按进程名自动探测）')
async function doSave() {
  await saveSettings()
  savedMsg.value = '已保存'
  setTimeout(() => { savedMsg.value = '' }, 3000)
}
</script>
