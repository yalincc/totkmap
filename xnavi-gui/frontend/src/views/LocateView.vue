<template>
  <div class="flex-1 flex flex-col gap-3 min-h-0 p-3 overflow-y-auto">

    <!-- ① 自绘标题栏：整栏拖拽 + 设置/窗口控制 -->
    <section class="bg-[#161b22] border-b border-slate-800 px-3 py-2.5 shrink-0 flex items-center gap-5" style="--wails-draggable:drag;">
      <div class="flex items-center gap-2.5 shrink-0">
        <span class="w-2.5 h-2.5 rounded-full" :class="syncDot"></span>
        <span class="text-white text-sm font-bold tracking-wide">TOTKNavi 定位导航</span>
        <span class="text-[10px] font-mono text-sky-300 bg-blue-500/10 border border-blue-500/40 rounded px-1.5 py-0.5">v{{ ver.replace('v','') }}</span>
        <span class="text-[11px] text-slate-500 ml-1.5 pl-2.5 border-l border-slate-800">{{ emuLabel }} ➔ totk.yalin.site</span>
      </div>
      <div class="flex items-center gap-1 ml-auto shrink-0" style="--wails-draggable:no-drag;">
        <span class="text-[11px] font-mono mr-2" :class="syncClass">{{ syncText }}</span>
        <!-- 设置卡片（点击齿轮弹出，与关于互斥） -->
        <div class="relative" @click.stop>
          <button class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-slate-700/60" title="设置" @click="toggleSettings">⚙</button>
          <SettingsPop v-if="showSettingsPop" class="absolute right-0 top-full mt-1.5 z-50" />
        </div>
        <!-- 关于卡片（点击问号弹出，与设置互斥） -->
        <div class="relative" @click.stop>
          <button class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-slate-700/60 text-[15px] font-semibold" title="关于" @click="toggleAbout">?</button>
          <AboutPop v-if="showAboutPop" class="absolute right-0 top-full mt-1.5 z-50" />
        </div>
        <button class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-white rounded hover:bg-slate-700/60 text-sm leading-none" title="最小化" @click="minWin">—</button>
        <button class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-rose-400 rounded hover:bg-slate-700/60 text-sm leading-none" title="关闭" @click="closeWin">✕</button>
      </div>
    </section>

    <!-- ② 主操作横幅：步骤状态机 | 打开地图 + 定位 -->
    <section class="bg-[#161b22] border border-slate-800 rounded-lg px-3.5 py-2.5 shrink-0 flex items-center justify-between gap-4">
      <div class="flex items-center gap-2 text-xs font-mono shrink-0 whitespace-nowrap">
        <template v-for="(s, i) in steps" :key="s.name">
          <div v-if="i > 0" class="text-slate-600 mx-0.5">/</div>
          <div class="flex items-center gap-1.5" :class="stepClass(s.state)">
            <span class="w-2 h-2 rounded-full" :class="stepDot(s.state)"></span>
            <span>{{ s.name }}</span>
          </div>
        </template>
      </div>
      <div class="flex items-center gap-2.5 shrink-0">
        <select v-model="cfg.emu" @change="onEmuChange" title="选择模拟器（改后需重启定位）"
          class="bg-[#0d1117] border border-slate-700 rounded-lg px-2 py-2 text-xs font-medium text-slate-300 hover:border-slate-500 focus:outline-none transition">
          <option value="auto">🔄 自动探测</option>
          <option value="ryujinx">Ryujinx</option>
          <option value="eden">Eden</option>
        </select>
        <button @click="openMap" class="w-[136px] py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 text-xs font-medium border border-slate-700 flex items-center justify-center gap-1.5 transition">
          🧭 打开网页地图
        </button>
        <button @click="toggleLocating"
          :class="isLocating
            ? 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/50'
            : 'bg-blue-600 hover:bg-blue-500 shadow-blue-950/50'"
          class="w-[136px] py-2 rounded-lg text-white text-xs font-bold flex items-center justify-center gap-1.5 transition shadow-lg active:scale-95">
          <span>{{ isLocating ? '◉' : '▶' }}</span>
          <span>{{ isLocating ? '正在定位中' : '开始定位' }}</span>
        </button>
      </div>
    </section>

    <!-- ③ 两列：左4 实时数据 ｜ 右6 本地解析进度 -->
    <div class="grid grid-cols-10 gap-3 items-stretch shrink-0">

      <!-- 左 4 列 -->
      <div class="col-span-4 flex flex-col gap-3">

        <!-- 实时同步坐标卡 -->
        <section class="bg-[#161b22] border border-slate-800 rounded-xl p-3.5 flex-1">
          <div class="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80 mb-3">
            <span class="font-bold text-sky-400 flex items-center gap-1.5">实时同步坐标</span>
            <span class="text-[10px] font-mono text-slate-500">偏移量: {{ lockAddrText }}</span>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center font-mono">
            <div class="bg-[#0d1117] p-2 rounded-lg border border-slate-800">
              <div class="text-[10px] text-slate-500">X</div>
              <div class="text-sm font-bold text-white mt-0.5">{{ fmt(pos.gx) }}</div>
            </div>
            <div class="bg-[#0d1117] p-2 rounded-lg border border-slate-800">
              <div class="text-[10px] text-slate-500">Y</div>
              <div class="text-sm font-bold text-white mt-0.5">{{ fmt(pos.gy) }}</div>
            </div>
            <div class="bg-[#0d1117] p-2 rounded-lg border border-slate-800">
              <div class="text-[10px] text-slate-500">Z 高度</div>
              <div class="text-sm font-bold text-white mt-0.5">{{ fmt(pos.gz) }}</div>
            </div>
          </div>
          <div class="mt-2.5 flex items-center justify-between text-xs bg-[#0d1117] px-3 py-2 rounded-lg border border-slate-800">
            <span class="text-slate-400">所在图层:</span>
            <span class="font-bold text-emerald-400">{{ regionText }}<span class="text-blue-300 text-[10px] ml-2">{{ sourceLabel }}</span></span>
          </div>
        </section>

        <!-- 坐标校准卡（V1.4.0：无法定位/秒锁失败时，GUI 提交游戏 HUD 坐标精确匹配） -->
        <section class="bg-[#161b22] border border-slate-800 rounded-xl p-3.5 shrink-0">
          <div class="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80 mb-2.5">
            <span class="font-bold text-emerald-400 flex items-center gap-1.5">🧭 坐标校准</span>
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-slate-500">定位失败时使用</span>
              <button @click="doCalibrate" :disabled="calBusy"
                class="bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 rounded-md text-[10px] font-bold transition flex items-center gap-1 active:scale-95 disabled:opacity-60 disabled:cursor-wait">
                <span>↻</span>
                <span>提交校准</span>
              </button>
            </div>
          </div>
          <div class="text-[10px] text-slate-500 mb-2.5 leading-relaxed">填写右下角地图坐标后提交校准，角色保持站桩</div>
          <div class="flex items-center gap-2">
            <label class="flex-1 bg-[#0d1117] rounded-lg border border-slate-800 px-2 py-1.5 flex items-center gap-1.5">
              <span class="text-[10px] text-slate-500 shrink-0">X</span>
              <input v-model="calX" type="number" step="0.1" placeholder="如 -206.0"
                class="bg-transparent outline-none text-white font-mono text-xs w-full placeholder:text-slate-600" />
            </label>
            <label class="flex-1 bg-[#0d1117] rounded-lg border border-slate-800 px-2 py-1.5 flex items-center gap-1.5">
              <span class="text-[10px] text-slate-500 shrink-0">Y</span>
              <input v-model="calY" type="number" step="0.1" placeholder="如 451.9"
                class="bg-transparent outline-none text-white font-mono text-xs w-full placeholder:text-slate-600" />
            </label>
            <label class="flex-1 bg-[#0d1117] rounded-lg border border-slate-800 px-2 py-1.5 flex items-center gap-1.5">
              <span class="text-[10px] text-slate-500 shrink-0">Z</span>
              <input v-model="calZ" type="number" step="0.1" placeholder="如 21.6"
                class="bg-transparent outline-none text-white font-mono text-xs w-full placeholder:text-slate-600" />
            </label>
          </div>
        </section>
      </div>

      <!-- 右 6 列：本地解析进度（全量 20 类 + 滚动） -->
      <div class="col-span-6 flex flex-col min-h-0">        <section class="bg-[#161b22] border border-slate-800 rounded-xl p-3.5 flex-1 flex flex-col min-h-0">
          <div class="flex items-center justify-between text-xs pb-2 border-b border-slate-800/80 shrink-0">
            <span class="font-bold text-emerald-400">本地解析进度</span>
            <span class="text-[10px] text-slate-500">{{ progressCount }} / 20 类</span>
          </div>
          <div v-if="progressData.counts" class="overflow-y-auto min-h-0 flex-1 pr-0.5">
            <div class="grid grid-cols-3 gap-1.5 py-2.5">
              <div v-for="c in allCategories" :key="c.key"
                class="bg-[#0d1117] p-1.5 px-2 rounded border border-slate-800 flex justify-between text-[11px]">
                <span class="text-slate-400 truncate">{{ c.label }}</span>
                <span class="font-mono text-white font-semibold shrink-0 ml-1">{{ n(c.key) }}</span>
              </div>
            </div>
          </div>
          <div v-else class="flex-1 flex items-center justify-center text-[11px] text-slate-500 my-2">等待读取存档...（需先开始定位）</div>
        </section>
      </div>
    </div>

    <!-- ④ 实时日志 -->
    <LogPanel />
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import LogPanel from '../components/LogPanel.vue'
import SettingsPop from '../components/SettingsPop.vue'
import AboutPop from '../components/AboutPop.vue'
import { findRegion } from '../data/regions'
import {
  pos, steps, stepClass, stepDot, isLocating, toggleLocating, progressData,
  layerName, sourceLabel, openMap, logs,
  ver, syncText, syncClass, syncDot, rt, submitCoords, coordsState, cfg, saveSettings
} from '../composables/useCore'

function minWin() { rt.WindowMinimise() }
// Wails 无边框(Frameless)下 WindowClose() 不触发关闭，改用 Quit() 强制退出
function closeWin() { rt.Quit() }

// 模拟器选择（V2.0.0）：改动即保存；core 运行中则提示需重启定位生效
const emuLabel = computed(() => {
  const e = cfg.emu || 'auto'
  if (e === 'ryujinx') return 'Ryujinx'
  if (e === 'eden') return 'Eden'
  return '自动探测'
})
async function onEmuChange() {
  await saveSettings()
  if (isLocating.value) {
    logs.value.push({ time: new Date().toTimeString().slice(0, 8), text: '⚠ 模拟器已切换：请停止后重新开始定位生效', level: 'warn', color: 'text-amber-400', levelColor: 'text-amber-500' })
  }
}

// 全量 20 类（与 core progressCounts 对齐）
const allCategories = [
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

function fmt(v) { return (!pos.ok || v == null) ? '-' : Number(v).toFixed(1) }
function n(key) {
  const c = progressData.value?.counts?.[key]
  if (!c) return '-'
  return `${c.done}/${c.total}`
}
const progressCount = computed(() => {
  const counts = progressData.value?.counts
  return counts ? Object.keys(counts).filter(k => counts[k] && counts[k].total).length : 0
})

const lockAddrText = computed(() => (pos.lockAddr && pos.lockAddr !== '0x0' ? pos.lockAddr : '—'))

// ---- 坐标校准状态 ----
const calX = ref('')
const calY = ref('')
const calZ = ref('')
const calBusy = ref(false)
// 校准结果写入实时日志（复用 logs 共享 ref）：失败红色 / 成功绿色，不占按钮行空间
function pushCalLog(text, ok) {
  const t = new Date().toTimeString().slice(0, 8)
  logs.value.push(ok
    ? { time: t, text, level: 'ok', color: 'text-emerald-400', levelColor: 'text-emerald-500' }
    : { time: t, text, level: 'error', color: 'text-red-400', levelColor: 'text-red-500' })
  if (logs.value.length > 2000) logs.value = logs.value.slice(logs.value.length - 2000)
}
async function doCalibrate() {
  const x = Number(calX.value), y = Number(calY.value), z = Number(calZ.value)
  if (isNaN(x) || isNaN(y) || isNaN(z) || (x === 0 && y === 0 && z === 0)) {
    pushCalLog('✗ 坐标校准：请填写游戏内坐标（X Y Z）', false)
    return
  }
  calBusy.value = true
  pushCalLog('↻ 坐标校准：提交中…（全内存匹配约 10-15s）', false)
  await submitCoords(x, y, z)
  // 轮询结果：coordsState.result 由 pollCoordsResult 更新（搜索约 10-15s）
  const iv = setInterval(() => {
    if (!coordsState.busy) {
      clearInterval(iv)
      calBusy.value = false
      const r = coordsState.result
      if (!r || !r.ok) {
        pushCalLog(`✗ 坐标校准失败：${(r && r.error) || '未命中，请保持站桩重试'}`, false)
      } else {
        const cp = r.copies ? `（匹配 ${r.copies} 个副本）` : ''
        pushCalLog(`✓ 坐标校准已锁定 ${r.addr}${cp}`, true)
      }
    }
  }, 1000)
}

// 设置/关于卡片：互斥显示（同时只弹一个），点击外部全部关闭
const showSettingsPop = ref(false)
const showAboutPop = ref(false)
function toggleSettings() {
  showAboutPop.value = false
  showSettingsPop.value = !showSettingsPop.value
}
function toggleAbout() {
  showSettingsPop.value = false
  showAboutPop.value = !showAboutPop.value
}
function closePops() {
  showSettingsPop.value = false
  showAboutPop.value = false
}
onMounted(() => document.addEventListener('click', closePops))
onUnmounted(() => document.removeEventListener('click', closePops))

// 所在图层行：地面层显示地区名（TOTKmap areas.js 最近区域匹配），地下/天空仅层名
const regionText = computed(() => {
  if (!pos.ok) return '—'
  const r = findRegion(pos.mx, pos.my, pos.layer)
  return r ? `${r.name} · ${layerName.value} (${pos.layer})` : `${layerName.value} (${pos.layer})`
})

</script>
