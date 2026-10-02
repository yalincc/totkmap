<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3">
    <!-- 顶部：开始/停止 + 环境 -->
    <div class="grid grid-cols-12 gap-3 shrink-0">
      <section class="col-span-12 md:col-span-3 bg-[#161b22] border border-slate-800 rounded-md p-3">
        <div class="text-[11px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">运行环境</div>
        <div class="text-xs text-slate-300 leading-relaxed">
          <div>模拟器：<span class="text-white font-semibold">Ryujinx</span></div>
          <div>游戏：<span class="text-white font-semibold">王国之泪 (TOTK)</span></div>
          <div class="mt-1" :class="ryuHintClass">{{ ryuHintText }}</div>
        </div>
      </section>
      <section class="col-span-12 md:col-span-2 flex">
        <button @click="toggleLocating"
          :class="isLocating ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'"
          class="w-full rounded flex items-center justify-center font-bold text-sm text-white shadow-lg transition active:scale-95">
          {{ isLocating ? '■ 停止' : '▶ 开始定位' }}
        </button>
      </section>
      <section class="col-span-12 md:col-span-7 bg-gradient-to-r from-emerald-950/30 to-[#161b22] border border-emerald-500/30 rounded-md p-3">
        <div class="flex items-center gap-1.5">
          <div class="text-[11px] text-emerald-400 font-medium">存档信息</div>
          <div v-if="progressData.save" class="text-[10px] text-slate-500 font-mono truncate ml-1" :title="progressData.save">{{ saveBasename }}</div>
        </div>
        <div class="text-xs text-slate-300 mt-1">Ryujinx · 王国之泪 (TOTK)</div>
        <div v-if="progressData.counts" class="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 font-mono">
          <div class="text-[12px] text-slate-400">神庙 <span class="text-white font-bold">{{ n('神庙') }}</span></div>
          <div class="text-[12px] text-slate-400">鸟望台 <span class="text-white font-bold">{{ n('鸟望台') }}</span></div>
          <div class="text-[12px] text-slate-400">克洛格 <span class="text-white font-bold">{{ n('克洛格') }}</span></div>
          <div class="text-[12px] text-slate-400">龙之泪 <span class="text-white font-bold">{{ n('龙之泪') }}</span></div>
          <div class="text-[12px] text-slate-400">树根 <span class="text-white font-bold">{{ n('树根') }}</span></div>
          <div class="text-[12px] text-slate-400">魔犹伊 <span class="text-white font-bold">{{ n('魔犹伊遗失物') }}</span></div>
        </div>
        <div v-else class="mt-2 text-[11px] text-slate-500">等待读取存档...</div>
      </section>
    </div>

    <!-- 状态卡（M2） -->
    <section class="bg-[#161b22] border border-slate-800 rounded-md p-3 shrink-0">
      <div class="flex items-center justify-between mb-2">
        <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">实时定位</div>
        <div class="text-[11px] font-mono" :class="stateTextClass">{{ stateText }}</div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 font-mono text-xs">
        <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
          <div class="text-[10px] text-slate-500">游戏坐标</div>
          <div class="text-white mt-0.5">X {{ fmt(pos.gx) }} · Y {{ fmt(pos.gy) }}<div class="text-slate-400">高度 Z {{ fmt(pos.gz) }}</div></div>
        </div>
        <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
          <div class="text-[10px] text-slate-500">地图坐标</div>
          <div class="text-white mt-0.5">{{ fmt(pos.mx) }}, {{ fmt(pos.my) }}</div>
        </div>
        <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
          <div class="text-[10px] text-slate-500">所在层 / 来源</div>
          <div class="text-white mt-0.5">{{ layerName }} <span class="text-slate-500">({{ pos.layer }})</span></div>
          <div class="text-blue-300">{{ sourceLabel }}</div>
        </div>
        <div class="bg-[#0d1117] border border-slate-800 rounded p-2">
          <div class="text-[10px] text-slate-500">锁定状态</div>
          <div class="flex items-center gap-1.5 mt-0.5">
            <span class="w-2 h-2 rounded-full" :class="locked ? 'bg-emerald-400' : (locating ? 'bg-amber-400 animate-pulse' : 'bg-slate-600')"></span>
            <span class="text-white">{{ locked ? '已锁定' : (locating ? '定位中' : '未锁定') }}</span>
          </div>
          <div class="text-slate-500 text-[10px] mt-0.5" v-if="pos.copies > 0">copies {{ pos.copies }}<span v-if="pos.lockAddr"> · 0x{{ pos.lockAddr.slice(-8) }}</span></div>
        </div>
      </div>
      <!-- 步骤条 -->
      <div class="flex items-center justify-center gap-4 mt-3">
        <template v-for="(s, i) in steps" :key="s.name">
          <div class="flex items-center space-x-1.5" :class="stepClass(s.state)">
            <span class="w-2 h-2 rounded-full" :class="stepDot(s.state)"></span>
            <span class="text-xs font-mono">{{ s.name }}</span>
          </div>
          <div v-if="i < steps.length - 1" class="w-6 h-px bg-slate-700"></div>
        </template>
      </div>
    </section>

    <!-- 日志 -->
    <LogPanel />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import LogPanel from '../components/LogPanel.vue'
import {
  pos, steps, stepClass, stepDot, isLocating, toggleLocating, progressData,
  stateText, stateTextClass, locked, locating, layerName, sourceLabel,
  clearTarget, pickRyujinx, pickSave, saveSettings
} from '../composables/useCore'

const ryuHintText = '路径自动探测（按进程名）'
const ryuHintClass = 'text-slate-500'

function fmt(v) { return (v == null) ? '-' : Number(v).toFixed(1) }
function n(key) {
  const c = progressData.value?.counts?.[key]
  if (!c) return '-'
  return `${c.done}/${c.total}`
}
const saveBasename = computed(() => {
  const s = progressData.value?.save
  if (!s) return ''
  return s.split(/[\\/]/).slice(-2).join('\\')
})
</script>
