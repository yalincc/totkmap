<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3 overflow-y-auto">
    <!-- 总览 -->
    <section class="bg-[#161b22] border border-emerald-500/30 rounded-md p-3 shrink-0">
      <div class="flex items-center justify-between">
        <div class="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">存档进度</div>
        <div class="text-[10px] text-slate-500 font-mono truncate max-w-[60%]" :title="progressData.save">{{ saveBasename }}</div>
      </div>
      <div v-if="progressData.counts" class="flex items-center gap-3 mt-2">
        <div class="text-xs text-slate-400">总体探索度</div>
        <div class="flex-1 h-2 bg-[#0d1117] border border-slate-800 rounded overflow-hidden">
          <div class="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all" :style="{ width: overallPct + '%' }"></div>
        </div>
        <div class="text-sm font-mono text-white">{{ overallPct }}%</div>
      </div>
      <div v-else class="text-[11px] text-slate-500 mt-2">等待读取存档...（需先开始定位）</div>
    </section>

    <!-- 分类列表 -->
    <section v-if="progressData.counts" class="grid grid-cols-1 md:grid-cols-2 gap-2 shrink-0">
      <div v-for="c in categories" :key="c.key" class="bg-[#161b22] border border-slate-800 rounded-md p-2.5">
        <div class="flex items-center justify-between text-xs">
          <span class="text-slate-300">{{ c.label }}</span>
          <span class="font-mono text-white">{{ done(c.key) }}<span class="text-slate-500">/{{ total(c.key) }}</span></span>
        </div>
        <div class="h-1.5 bg-[#0d1117] border border-slate-800 rounded overflow-hidden mt-1.5">
          <div class="h-full bg-emerald-500/80 transition-all" :style="{ width: pct(c.key) + '%' }"></div>
        </div>
      </div>
    </section>

    <section v-else class="text-center text-slate-600 text-xs py-10">暂无存档数据</section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { progressData } from '../composables/useCore'

// 与 progress_totk2.go progressCounts 全量对齐（core status.json 现算）
const categories = [
  { key: '鸟望台', label: '鸟望台' },
  { key: '龙之泪', label: '龙之泪' },
  { key: '神庙', label: '神庙' },
  { key: '树根', label: '树根' },
  { key: '克洛格', label: '克洛格' },
  { key: '双倍克洛格', label: '双倍克洛格' },
  { key: '魔犹伊遗失物', label: '魔犹伊遗失物' },
  { key: '残旧的地图', label: '残旧的地图' },
  { key: '贤者的遗志', label: '贤者的遗志' },
  { key: '设计图石板', label: '设计图石板' },
  { key: '卡邦达立牌', label: '卡邦达立牌' },
  { key: '独眼巨人', label: '独眼巨人' },
  { key: '岩石巨人', label: '岩石巨人' },
  { key: '莫尔德拉吉克', label: '莫尔德拉吉克' },
  { key: '方块魔像', label: '方块魔像' },
  { key: '巨霸伽马', label: '巨霸伽马' },
  { key: '古栗欧克', label: '古栗欧克' },
  { key: '地洞入口', label: '地洞入口' },
  { key: '洞穴入口', label: '洞穴入口' },
  { key: '井', label: '井' }
]

function count(key) { return progressData.value?.counts?.[key] || null }
function done(key) { const c = count(key); return c ? c.done : '-' }
function total(key) { const c = count(key); return c ? c.total : '-' }
function pct(key) {
  const c = count(key)
  if (!c || !c.total) return 0
  return Math.round(c.done / c.total * 100)
}
const overallPct = computed(() => {
  const counts = progressData.value?.counts
  if (!counts) return 0
  let d = 0, t = 0
  for (const k of categories) {
    const c = counts[k]
    if (c && c.total) { d += c.done; t += c.total }
  }
  return t ? Math.round(d / t * 100) : 0
})
const saveBasename = computed(() => {
  const s = progressData.value?.save
  if (!s) return ''
  return s.split(/[\\/]/).slice(-2).join('\\')
})
</script>
