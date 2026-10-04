<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-3 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">设置</div>
    <div>
      <label class="block text-slate-400 mb-1">Eden 路径（留空自动探测）：</label>
      <div class="flex gap-1">
        <input v-model="cfg.edenDir" placeholder="自动探测（按进程名）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickEden" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
      </div>
      <div class="text-[10px] text-slate-600 mt-1" :class="ryuOk ? 'text-emerald-400' : ''">{{ ryuHint }}</div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">存档路径（留空自动探测）：</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDir" placeholder="自动探测（%APPDATA%\Eden）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
      </div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">数据目录（日志 / known_addrs.json / status.json 所在）：</label>
      <div class="flex gap-1 items-center">
        <span class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-300 font-mono text-[11px] truncate">exe 同目录（live-gui）</span>
        <button @click="openLogDir" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs">打开目录</button>
      </div>
    </div>
    <div class="text-[10px] text-slate-500">模拟器与游戏固定为 Eden + 王国之泪（TOTK），无切换选项。</div>
    <div class="flex items-center gap-2 pt-1">
      <button class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white" @click="doSave">保存</button>
      <span v-if="savedMsg" class="text-[11px] font-mono" :class="savedMsgClass">{{ savedMsg }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { cfg, envDetect, pickEden, pickSave, saveSettings, openLogDir } from '../composables/useCore'

const savedMsg = ref('')
const savedMsgClass = ref('text-emerald-400')
const ryuHint = computed(() => {
  if (cfg.edenDir) return '已配置：' + cfg.edenDir
  return envDetect.eden ? '自动探测：检测到 Eden 运行中' : '未配置路径（点击开始后按进程名自动探测）'
})
const ryuOk = computed(() => !!(cfg.edenDir || envDetect.eden))

async function doSave() {
  await saveSettings()
  savedMsg.value = '已保存'
  savedMsgClass.value = 'text-emerald-400'
  setTimeout(() => { savedMsg.value = '' }, 2000)
}
</script>
