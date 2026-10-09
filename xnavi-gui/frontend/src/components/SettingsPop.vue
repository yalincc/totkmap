<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-3 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">设置</div>
    <div>
      <label class="block text-slate-400 mb-1">Ryujinx 存档路径（可选，自动探测不到时手动指定）：</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDirRyujinx" placeholder="自动探测（%APPDATA%\Ryujinx\bis\user\save）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave('ryu')" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
      </div>
      <div class="text-[10px] text-slate-600 mt-1" :class="saveRyuOk ? 'text-emerald-400' : ''">{{ saveRyuHint }}</div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">Eden 存档路径（可选，自动探测不到时手动指定）：</label>
      <div class="flex gap-1">
        <input v-model="cfg.saveDirEden" placeholder="自动探测（Eden 进程目录 / 常见便携根）" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white font-mono focus:border-blue-500 focus:outline-none placeholder-slate-600" />
        <button @click="pickSave('eden')" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
      </div>
      <div class="text-[10px] text-slate-600 mt-1" :class="saveEdenOk ? 'text-emerald-400' : ''">{{ saveEdenHint }}</div>
    </div>
    <div>
      <label class="block text-slate-400 mb-1">工作目录（xnavi.exe 的日志 / known / status.json 所在）：</label>
      <div class="flex gap-1 items-center">
        <span class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-slate-300 font-mono text-[11px] truncate">exe 同目录（与 xnavi.exe 一起）</span>
        <button @click="openLogDir" class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs">打开目录</button>
      </div>
    </div>
    <div class="text-[10px] text-slate-500">模拟器在主界面选择（自动探测 / Ryujinx / Eden），游戏固定为王国之泪（TOTK）。存档留空时 core 自动探测；手动指定仅在检测不到时兜底。</div>
    <div>
      <label class="flex items-center gap-2 cursor-pointer select-none py-1">
        <input v-model="cfg.tls" type="checkbox" class="accent-blue-600 w-3.5 h-3.5" />
        <span class="text-slate-300">手机防息屏（Https）</span>
      </label>
      <div class="text-[10px] text-slate-600 mt-0.5">手机镜像页走 HTTPS，防息屏用系统 Wake Lock 而非视频保亮。首次使用需先在手机安装 rootCA.pem（certs/ 目录），装一次长期有效；下次启动导航生效。</div>
    </div>
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
const saveRyuOk = computed(() => envDetect.saveRyu)
const saveEdenOk = computed(() => envDetect.saveEden)
const saveRyuHint = computed(() => {
  if (cfg.saveDirRyujinx) return envDetect.saveRyu ? '✓ 路径有效' : '路径不存在（core 将回退自动探测）'
  return '留空时 core 自动探测（APPDATA\\Ryujinx\\bis\\user\\save）'
})
const saveEdenHint = computed(() => {
  if (cfg.saveDirEden) return envDetect.saveEden ? '✓ 路径有效' : '路径不存在（core 将回退自动探测）'
  return '留空时 core 按 Eden 进程目录 / 常见便携根自动推导'
})

async function doSave() {
  await saveSettings()
  savedMsg.value = '已保存'
  savedMsgClass.value = 'text-emerald-400'
  setTimeout(() => { savedMsg.value = '' }, 2000)
}
</script>
