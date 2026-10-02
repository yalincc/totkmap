<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3">
    <!-- 当前目标 -->
    <section class="bg-[#161b22] border border-amber-500/30 rounded-md p-4">
      <div class="flex items-center gap-1.5 mb-3">
        <div class="text-[11px] font-semibold text-amber-400 uppercase tracking-wider">导航目标</div>
        <span class="text-[10px] text-slate-500">与地图双向同步（经 core 中转）</span>
      </div>
      <div v-if="target" class="font-mono text-sm space-y-2">
        <div class="flex items-center gap-2">
          <span class="text-slate-400">目标：</span>
          <span class="text-white font-bold text-base">{{ target.name || '未命名目标' }}</span>
          <span v-if="target.type" class="text-[10px] bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5 text-slate-300">{{ target.type }}</span>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
          <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
            <div class="text-[10px] text-slate-500">距离</div>
            <div class="text-white mt-0.5">{{ distText }}</div>
          </div>
          <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
            <div class="text-[10px] text-slate-500">目标层</div>
            <div class="text-white mt-0.5">{{ targetLayerName }}</div>
          </div>
          <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
            <div class="text-[10px] text-slate-500">跨层提示</div>
            <div class="mt-0.5" :class="targetCrossLayer ? 'text-amber-400' : 'text-slate-500'">
              {{ targetCrossLayer ? '目标在其他层，去地图切层' : '同层' }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="text-sm text-slate-500 py-2">
        {{ pos.ok ? '当前无目标。打开地图 → 点击地图上的标记 → 设为导航目标。' : '尚未定位。先回到「实时定位」点开始定位。' }}
      </div>
      <div class="flex gap-2 mt-4">
        <button @click="openMap" class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white font-semibold">🌐 打开地图导航</button>
        <button @click="doClear" :disabled="!target" :class="target ? 'bg-slate-700 hover:bg-slate-600' : 'bg-slate-800 text-slate-600 cursor-not-allowed'"
          class="px-4 py-1.5 rounded text-xs">清除目标</button>
      </div>
      <div v-if="clearMsg" class="text-[11px] text-slate-400 mt-2 font-mono">{{ clearMsg }}</div>
    </section>

    <!-- 使用说明 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-4 text-xs text-slate-400 leading-relaxed">
      <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2">使用说明</div>
      <ul class="space-y-1 list-none">
        <li>① 在「实时定位」点开始定位，秒锁后回到本页；</li>
        <li>② 点「打开地图导航」→ 地图自动跟随玩家并开启导航；</li>
        <li>③ 在地图上点击目标标记 → 金色引导线 + 实时距离；</li>
        <li>④ 本页会同步显示当前目标；点「清除目标」→ 地图引导线同步消失。</li>
      </ul>
    </section>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import {
  target, targetDist, targetCrossLayer, pos, openMap, clearTarget, LAYER_NAME
} from '../composables/useCore'

const clearMsg = ref('')
async function doClear() {
  if (!target.value) return
  clearMsg.value = await clearTarget()
  setTimeout(() => { clearMsg.value = '' }, 5000)
}
const distText = computed(() => {
  const d = targetDist.value
  if (d == null) return '-'
  return Math.round(d) + ' m'
})
const targetLayerName = computed(() => {
  const t = target.value
  if (!t || t.layer == null) return '未指定'
  return LAYER_NAME[Number(t.layer)] || String(t.layer)
})
</script>
