<template>
  <aside class="w-40 shrink-0 bg-[#161b22] border-r border-slate-800 flex flex-col">
    <div class="px-3 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-800/60">TOTKNavi</div>
    <nav class="flex-1 py-2 space-y-0.5">
      <button v-for="item in items" :key="item.id" @click="$emit('change', item.id)"
        class="w-full flex items-center gap-2 px-3 py-2 text-left text-xs transition"
        :class="active === item.id ? 'bg-blue-600/15 text-blue-300 border-l-2 border-blue-500' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border-l-2 border-transparent'">
        <span>{{ item.icon }}</span>
        <span>{{ item.label }}</span>
        <span v-if="item.id === 'locate' && isLocating" class="ml-auto w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
      </button>
    </nav>
    <div class="px-3 py-2 border-t border-slate-800/60 text-[10px] text-slate-600 font-mono">
      {{ ver }}
    </div>
  </aside>
</template>

<script setup>
import { ver, isLocating } from '../composables/useCore'
defineProps({
  active: { type: String, required: true }
})
defineEmits(['change'])
const items = [
  { id: 'locate', label: '实时定位', icon: '📡' },
  { id: 'nav', label: '导航目标', icon: '🧭' },
  { id: 'progress', label: '存档进度', icon: '📊' },
  { id: 'settings', label: '设置', icon: '⚙' }
]
</script>
