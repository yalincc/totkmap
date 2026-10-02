<template>
  <section class="bg-[#0d1117] border border-slate-800 rounded-md flex flex-col text-[11px] min-h-0 flex-1">
    <div class="px-2.5 py-1.5 border-b border-slate-800/80 shrink-0">
      <span class="text-white font-sans text-[11px] font-semibold uppercase tracking-wider">实时日志</span>
    </div>
    <div ref="logBox" class="flex-1 overflow-y-auto px-2.5 py-1.5 space-y-0.5 leading-relaxed text-slate-400 min-h-0 select-text font-mono">
      <div v-for="(log, idx) in filteredLogs" :key="idx" :class="log.color">
        <span class="text-slate-600">[{{ log.time }}]</span>
        <span class="mr-1" :class="log.levelColor">{{ log.level }}</span>{{ log.text }}
      </div>
      <div v-if="!filteredLogs.length" class="text-slate-600 py-4 text-center">暂无日志</div>
    </div>
    <div class="flex items-center justify-end gap-3 px-2.5 py-1.5 border-t border-slate-800/80 shrink-0 text-[11px] font-sans">
      <input v-model="filter" placeholder="过滤..." class="w-28 bg-[#161b22] border border-slate-800 rounded px-2 py-0.5 text-[11px] text-white focus:border-blue-500 focus:outline-none placeholder-slate-600" />
      <span class="text-slate-400">{{ shown }} / {{ total }}</span>
      <button class="text-white hover:text-slate-300" @click="clearLogs">清屏</button>
      <button class="text-white hover:text-slate-300" @click="exportDiag">导出诊断包</button>
      <button class="text-white hover:text-slate-300" @click="openLogDir">打开目录</button>
    </div>
  </section>
</template>

<script setup>
import { ref, watch, nextTick, computed } from 'vue'
import { logs, filteredLogs, logFilter, clearLogs, exportDiag, openLogDir } from '../composables/useCore'

const filter = computed({
  get: () => logFilter.value,
  set: v => { logFilter.value = v }
})
const total = computed(() => logs.value.length)
const shown = computed(() => filteredLogs.value.length)

const logBox = ref(null)
let prevLen = 0
watch(() => logs.value.length, (n) => {
  if (n > prevLen) {
    prevLen = n
    nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
  }
})
</script>
