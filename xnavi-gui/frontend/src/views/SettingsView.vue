<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3 overflow-y-auto">
    <!-- 设置 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-4 max-w-xl">
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">设置</div>
      <div class="space-y-3 text-xs">
        <div>
          <label class="block text-slate-400 mb-1">存档路径（可选，默认自动探测）：</label>
          <div class="flex gap-1">
            <input v-model="cfg.saveDir" placeholder="自动探测（Eden 进程目录，一般无需设置）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
            <button @click="pickSave" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
          </div>
          <div class="text-[10px] text-slate-600 mt-1" :class="saveOk ? 'text-emerald-400' : ''">{{ saveHint }}</div>
        </div>
        <div>
          <label class="block text-slate-400 mb-1">数据目录（日志 / known_addrs.json / status.json 所在）：</label>
          <div class="flex gap-1 items-center">
            <span class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-300 font-mono text-[11px] truncate">exe 同目录（与 xnavi-eden.exe 一起）</span>
            <button @click="openLogDir" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs">打开目录</button>
          </div>
        </div>
        <div class="text-[10px] text-slate-500">模拟器与游戏固定为 Eden + 王国之泪（TOTK），无切换选项。</div>
      </div>
      <div class="flex items-center gap-2 mt-4">
        <button class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white" @click="doSave">保存</button>
        <span v-if="savedMsg" class="text-[11px] font-mono" :class="savedMsgClass">{{ savedMsg }}</span>
      </div>
    </section>

    <!-- 关于 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-4 max-w-xl text-xs space-y-2">
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">关于</div>
      <div class="text-slate-300">TOTKNavi · 王国之泪 (TOTK) 定位导航程序</div>
      <div class="text-slate-400 font-mono">版本：{{ ver }}</div>
      <div class="text-slate-400">地图：<button class="text-blue-400 hover:underline" @click="openExternal(mapUrl)">{{ mapUrl.replace('https://','').replace(/\/$/,'') }}</button></div>
      <div class="text-slate-400">GitHub：<button class="text-blue-400 hover:underline" @click="openExternal('https://github.com/yalincc/totkmap')">yalincc/totkmap</button></div>
      <div class="text-slate-500">只读内存，不注入，不修改游戏。</div>
      <div class="flex gap-2 pt-2">
        <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="doCheckUpdate">检查更新</button>
        <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="exportDiag">导出诊断包</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import {
  cfg, envDetect, ver, mapUrl, pickSave, saveSettings,
  exportDiag, openLogDir, openExternal, checkForUpdates
} from '../composables/useCore'

const savedMsg = ref('')
const savedMsgClass = ref('text-emerald-400')
const saveOk = computed(() => envDetect.save)
const saveHint = computed(() => {
  if (cfg.saveDir) return envDetect.save ? '✓ 存档路径有效' : '路径不存在（core 将回退自动探测）'
  return '留空时 core 按 Eden 进程目录自动推导存档根'
})
async function doSave() {
  await saveSettings()
  savedMsg.value = '已保存'
  savedMsgClass.value = 'text-emerald-400'
  setTimeout(() => { savedMsg.value = '' }, 3000)
}
async function doCheckUpdate() {
  savedMsg.value = '检查中...'
  savedMsgClass.value = 'text-slate-400'
  const r = await checkForUpdates()
  if (r.status === 'available') {
    savedMsg.value = ''  // 有新版本，由更新弹窗提示
  } else if (r.status === 'latest') {
    savedMsg.value = `✓ 已是最新版 v${ver.value}`
    savedMsgClass.value = 'text-emerald-400'
  } else {
    savedMsg.value = '✗ ' + (r.msg || '检查失败')
    savedMsgClass.value = 'text-red-400'
  }
}
</script>
