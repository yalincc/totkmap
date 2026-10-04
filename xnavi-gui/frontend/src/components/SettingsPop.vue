<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-3 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">设置</div>
    <div>
      <label class="block text-slate-400 mb-1">存档路径（可选，默认自动探测）：</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDir" placeholder="自动探测（Eden 进程目录，一般无需设置）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
      </div>
      <div class="text-[10px] text-slate-600 mt-1">{{ saveHint }}</div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">数据目录（日志 / known_addrs.json / status.json 所在）：</label>
      <div class="flex gap-1 items-center">
        <span class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-300 font-mono text-[11px] truncate">exe 同目录（与 xnavi-eden.exe 一起）</span>
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
import { cfg, envDetect, pickSave, saveSettings, openLogDir } from '../composables/useCore'

const savedMsg = ref('')
const savedMsgClass = ref('text-emerald-400')
const saveHint = computed(() => {
  if (cfg.saveDir) return envDetect.save ? '✓ 存档路径有效' : '路径不存在（core 将回退自动探测）'
  return '留空时 core 按 Eden 进程目录自动推导存档根'
})

async function doSave() {
  await saveSettings()
  savedMsg.value = '已保存'
  savedMsgClass.value = 'text-emerald-400'
  setTimeout(() => { savedMsg.value = '' }, 2000)
}
</script>
