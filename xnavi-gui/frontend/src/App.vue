<template>
  <div class="flex flex-col h-screen w-full bg-[#0d1117] text-slate-200 select-none overflow-hidden font-sans">
    <header class="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-slate-800 shrink-0">
      <div class="flex items-center space-x-2 text-sm font-semibold tracking-wide">
        <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm shadow-blue-500/50"></span>
        <span class="text-white">Xnavi 游戏定位导航</span>
        <span class="text-xs text-slate-400 font-mono">{{ ver }}</span>
      </div>
      <div class="flex items-center space-x-4 text-xs">
        <div class="flex items-center space-x-1.5 font-mono" :class="syncClass">
          <span class="w-2 h-2 rounded-full inline-block" :class="syncDot"></span>
          <span>{{ syncText }}</span>
        </div>
        <button class="text-slate-400 hover:text-white transition" @click="showSettings = true">⚙ 设置</button>
        <button class="text-slate-400 hover:text-white transition" @click="openMap">🌐 地图</button>
        <button class="text-slate-400 hover:text-white transition" @click="showAbout = true">ℹ 关于</button>
      </div>
    </header>
    <main class="flex-1 flex flex-col p-3 gap-3 overflow-hidden">
      <div class="grid grid-cols-12 gap-3 shrink-0">
        <section class="col-span-12 md:col-span-5 bg-[#161b22] border border-slate-800 rounded-md p-3">
          <div class="text-[11px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">运行环境配置</div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-xs text-slate-400 mb-1">模拟器：</label>
              <select v-model="env.emulator" class="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none">
                <option value="auto">Auto (Cemu/Ryujinx)</option>
                <option value="cemu">Cemu</option>
                <option value="ryujinx">Ryujinx</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-slate-400 mb-1">游戏：</label>
              <select v-model="env.game" class="w-full bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none">
                <option value="auto">自动识别</option>
                <option value="botw">旷野之息 (BOTW)</option>
                <option value="totk">王国之泪 (TOTK)</option>
              </select>
            </div>
          </div>
          <div class="text-[11px] font-mono mt-2" :class="hitClass">{{ hitText }}</div>
          <div class="text-[11px] font-mono mt-1 text-slate-500">已识别游戏：<span class="text-slate-300">{{ gameDisplayName }}</span><span v-if="detectedGame" class="text-emerald-400">（core 上报）</span></div>
        </section>
        <section class="col-span-12 md:col-span-2 flex">
          <button @click="toggleLocating"
            :class="isLocating ? 'bg-amber-600 hover:bg-amber-500' : 'bg-blue-600 hover:bg-blue-500'"
            class="w-full rounded flex items-center justify-center font-bold text-sm text-white shadow-lg transition active:scale-95">
            {{ isLocating ? '■ 停止' : '▶ 开始定位' }}
          </button>
        </section>
        <section class="col-span-12 md:col-span-5 bg-gradient-to-r from-emerald-950/30 to-[#161b22] border border-emerald-500/30 rounded-md p-3">
          <div class="flex items-center gap-1.5">
            <div class="relative group">
              <span class="text-slate-500 cursor-help text-xs select-none leading-none">?</span>
              <div class="absolute left-0 top-full mt-1 hidden group-hover:block w-60 p-2 bg-slate-800 border border-slate-600 rounded text-[10px] text-slate-300 z-30 shadow-xl">
                主档自动识别：Ryujinx 取游玩时间最长的槽，Cemu 取最近修改的槽。游戏内保存后约 2 秒自动刷新。
              </div>
            </div>
            <div class="text-[11px] text-emerald-400 font-medium">存档信息</div>
            <div v-if="progressData.save" class="text-[10px] text-slate-500 font-mono truncate ml-1" :title="progressData.save">{{ saveBasename }}</div>
          </div>
          <div class="text-xs text-slate-300 mt-1">{{ emuLabel }}<span v-if="emuVer"> · v{{ emuVer }}</span> · {{ gameDisplayName }}<span v-if="gameVerLabel"> {{ gameVerLabel }}</span></div>
          <div v-if="progressData.counts" class="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 font-mono">
            <div class="text-[12px] text-slate-400">{{ gameLabels.shrine }} <span class="text-white font-bold">{{ progressData.counts.shrine[0] }}<span class="text-slate-500">/{{ progressData.counts.shrine[1] }}</span></span></div>
            <div class="text-[12px] text-slate-400">{{ gameLabels.tower }} <span class="text-white font-bold">{{ progressData.counts.tower[0] }}<span class="text-slate-500">/{{ progressData.counts.tower[1] }}</span></span></div>
            <div class="text-[12px] text-slate-400">{{ gameLabels.korok }} <span class="text-white font-bold">{{ progressData.counts.korok[0] }}<span class="text-slate-500">/{{ progressData.counts.korok[1] }}</span></span></div>
            <div class="text-[12px] text-slate-400">{{ gameLabels.memory }} <span class="text-white font-bold">{{ progressData.counts.memory[0] }}<span class="text-slate-500">/{{ progressData.counts.memory[1] }}</span></span></div>
            <div class="text-[12px] text-slate-400">{{ gameLabels.beast }} <span class="text-white font-bold">{{ progressData.counts.beast[0] }}<span class="text-slate-500">/{{ progressData.counts.beast[1] }}</span></span></div>
            <div class="text-[12px] text-slate-400">时长 <span class="text-white font-bold">{{ playtimeText }}</span></div>
          </div>
          <div v-else class="mt-2 text-[11px] text-slate-500">等待读取存档...</div>
        </section>
      </div>
      <section class="bg-[#161b22] border border-slate-800 rounded-md p-3 shrink-0">
        <div class="flex items-center justify-center gap-4">
          <template v-for="(s, i) in steps" :key="s.name">
            <div class="flex items-center space-x-1.5" :class="stepClass(s.state)">
              <span class="w-2 h-2 rounded-full" :class="stepDot(s.state)"></span>
              <span class="text-xs font-mono">{{ s.name }}</span>
            </div>
            <div v-if="i < steps.length - 1" class="w-6 h-px bg-slate-700"></div>
          </template>
        </div>
        <div class="text-xs mt-2 text-center">
          <span :class="stateTextClass">{{ stateText }}</span>
          <span v-if="scanInfo" class="text-slate-400 ml-2">{{ scanInfo }}</span>
        </div>
      </section>
      <!-- S3 基准校准（TOTK）：游戏地图读坐标输入，独立于自动定位的手工模块 -->
      <section class="bg-[#161b22] border border-slate-800 rounded-md p-2.5 shrink-0 flex items-center gap-2 flex-wrap">
        <span class="text-[11px] font-semibold text-slate-400">基准校准</span>
        <input v-model="calib.x" placeholder="X" class="w-20 bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono focus:border-blue-500 focus:outline-none" />
        <input v-model="calib.y" placeholder="高度" class="w-20 bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono focus:border-blue-500 focus:outline-none" />
        <input v-model="calib.z" placeholder="Z" class="w-20 bg-[#0d1117] border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono focus:border-blue-500 focus:outline-none" />
        <button @click="doCalibrate" class="bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded text-xs">校准</button>
        <span v-if="calibMsg" class="text-[11px] text-slate-400">{{ calibMsg }}</span>
        <span class="text-[10px] text-slate-600 ml-auto">定位模式: {{ locMode || 'idle' }}</span>
      </section>
      <section class="bg-[#0d1117] border border-slate-800 rounded-md p-2.5 flex flex-col font-mono text-[11px] flex-1 min-h-0">
        <div class="flex items-center justify-between pb-1.5 mb-1.5 border-b border-slate-800/80 text-slate-400 text-[10px] shrink-0">
          <span>实时日志</span>
          <div class="space-x-3">
            <button class="hover:text-slate-200" @click="clearLogs">清屏</button>
            <button class="hover:text-slate-200" @click="exportDiag">导出诊断包</button>
            <button class="hover:text-slate-200" @click="openLogDir">打开目录</button>
          </div>
        </div>
        <div ref="logBox" class="flex-1 overflow-y-auto space-y-0.5 leading-relaxed text-slate-400 min-h-0 select-text">
          <div v-for="(log, idx) in logs" :key="idx" :class="log.color">
            <span class="text-slate-500">[{{ log.time }}]</span>
            <span class="mr-1" :class="log.levelColor">{{ log.level }}</span>{{ log.text }}
          </div>
        </div>
      </section>
    </main>
    <div v-if="showSettings" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="showSettings = false">
      <div class="bg-[#161b22] border border-slate-700 rounded-lg p-5 w-96">
        <div class="text-sm font-bold text-white mb-4">设置</div>
        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-slate-400 mb-1">Cemu 路径：</label>
            <div class="flex gap-1">
              <input v-model="paths.cemu" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white focus:border-blue-500 focus:outline-none" />
              <button @click="pickCemu" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
            </div>
          </div>
          <div>
            <label class="block text-slate-400 mb-1">Ryujinx 路径：</label>
            <div class="flex gap-1">
              <input v-model="paths.ryujinx" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white focus:border-blue-500 focus:outline-none" />
              <button @click="pickRyujinx" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
            </div>
          </div>
          <div>
            <label class="block text-slate-400 mb-1">存档路径（留空自动探测）：</label>
            <div class="flex gap-1">
              <input v-model="paths.saveDir" placeholder="自动探测" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white focus:border-blue-500 focus:outline-none" />
              <button @click="pickSave" class="bg-slate-700 hover:bg-slate-600 px-2 rounded text-xs">浏览</button>
            </div>
          </div>
        </div>
        <div class="flex justify-end mt-4">
          <button class="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded text-xs text-white" @click="saveSettings">保存</button>
        </div>
      </div>
    </div>
    <div v-if="updateInfo" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="updateInfo = null">
      <div class="bg-[#161b22] border border-emerald-500/50 rounded-lg p-5 w-96">
        <div class="text-sm font-bold text-emerald-400 mb-2">有新版本可用</div>
        <div class="text-xs text-slate-300">当前：{{ ver }} → 最新：{{ updateInfo.latest }}</div>
        <div class="flex justify-end gap-2 mt-4">
          <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="updateInfo = null">稍后</button>
          <button class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded text-xs text-white" @click="rt.BrowserOpenURL(updateInfo.url); updateInfo = null">下载</button>
        </div>
      </div>
    </div>
    <div v-if="showAbout" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="showAbout = false">
      <div class="bg-[#161b22] border border-slate-700 rounded-lg p-5 w-96 text-xs space-y-2">
        <div class="text-sm font-bold text-white mb-2">关于 xnavi</div>
        <div class="text-slate-300">多游戏定位导航（BOTW + TOTK × Cemu + Ryujinx）</div>
        <div class="text-slate-400">版本：{{ ver }}</div>
        <div class="text-slate-400">地图：<a :href="mapUrl" class="text-blue-400 hover:underline">{{ mapUrl.replace('https://','').replace('/','') }}</a></div>
        <div class="text-slate-400">GitHub：<a href="https://github.com/yalincc/totkmap" class="text-blue-400 hover:underline">yalincc/totkmap</a></div>
        <div class="text-slate-400 mt-2">只读内存，不注入，不修改游戏。</div>
        <div class="flex justify-end gap-2 mt-3">
          <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="checkUpdate">检查更新</button>
          <button class="bg-slate-700 hover:bg-slate-600 px-4 py-1.5 rounded text-xs text-white" @click="showAbout = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>
<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
const api = window.go.main.App
const rt = window.runtime
const ver = ref('v1.0.0')
const coreRunning = ref(false)
const syncText = ref('等待坐标流')
const syncDot = ref('bg-slate-600')
const syncClass = computed(() => coreRunning.value ? 'text-emerald-400' : 'text-slate-500')
const showSettings = ref(false)
const showAbout = ref(false)
const updateInfo = ref(null)
let isInitLog = true
const paths = reactive({ cemu: '', ryujinx: '', saveDir: '' })
const env = reactive({ emulator: 'auto', game: 'auto' })
const envDetect = reactive({ cemu: false, ryujinx: false })
const hitText = computed(() => {
  if (envDetect.cemu && envDetect.ryujinx) return '✓ Cemu + Ryujinx 路径已配置'
  if (envDetect.cemu) return '✓ Cemu 路径已配置'
  if (envDetect.ryujinx) return '✓ Ryujinx 路径已配置'
  return '未配置模拟器路径（点开始后自动探测进程）'
})
const hitClass = computed(() => (envDetect.cemu || envDetect.ryujinx) ? 'text-emerald-400' : 'text-amber-400')
const isLocating = ref(false)
async function toggleLocating() {
  if (isLocating.value) { await api.StopCore(); isLocating.value = false }
  else { await api.StartCore(env.emulator); isLocating.value = true }
}
const stateText = ref('就绪')
const scanInfo = ref('')
const scanPercent = ref(0)
const progressText = ref('')
const percentClass = computed(() => stateText.value.includes('已验证') ? 'text-emerald-400' : 'text-amber-400')
const stateTextClass = computed(() => {
  const t = stateText.value
  if (t.includes('已验证')) return 'text-emerald-400 font-semibold'
  if (t.includes('扫描') || t.includes('重扫')) return 'text-amber-400 font-semibold'
  return 'text-slate-300'
})
const steps = ref([
  { name: '就绪', state: 'done' },
  { name: '扫描中', state: 'idle' },
  { name: '验证移动', state: 'idle' },
  { name: '已锁定', state: 'idle' }
])
function stepClass(s) { return { done: 'text-emerald-400', active: 'text-amber-400 font-semibold', idle: 'text-slate-600' }[s] }
function stepDot(s) { return { done: 'bg-emerald-400', active: 'bg-amber-400 animate-pulse', idle: 'bg-slate-700' }[s] }
function setStep(doneCount, activeName) {
  const names = ['就绪', '扫描中', '验证移动', '已锁定']
  steps.value.forEach(s => { s.state = 'idle' })
  names.slice(0, doneCount).forEach(n => { const st = steps.value.find(x => x.name === n); if (st) st.state = 'done' })
  const act = steps.value.find(x => x.name === activeName)
  if (act) act.state = 'active'
}
const profileText = ref('本地自动档案')
const profileNote = ref('等待定位...')
const progressData = ref({})
const emuVer = ref('')
const mapAutoOpened = ref(false)
const saveTip = '主档自动识别：Ryujinx 取游玩时间最长的槽，Cemu 取最近修改的槽。游戏内保存后约 2 秒自动刷新。'
const emuLabel = computed(() => {
  if (!progressData.value || !progressData.value.save) return '未连接模拟器'
  return progressData.value.save.toLowerCase().includes('ryujinx') ? 'Ryujinx' : 'Cemu'
})
const gameVerLabel = computed(() => '') // BOTW 版本识别（存档版本号）P2b 后接入
const detectedGame = ref('') // core status.json 上报的实际识别游戏（botw/totk）
// S3 基准校准（TOTK）：独立手工模块，不影响自动定位
const calib = reactive({ x: '', y: '', z: '' })
const calibMsg = ref('')
const locMode = ref('')
async function doCalibrate() {
  const x = parseFloat(calib.x), y = parseFloat(calib.y), z = parseFloat(calib.z)
  if (isNaN(x) || isNaN(y) || isNaN(z)) { calibMsg.value = '请输入三个数字（游戏地图上的坐标）'; return }
  calibMsg.value = await api.Calibrate(x, y, z)
  setTimeout(() => { calibMsg.value = '' }, 15000)
}
// 存档卡片五槽标签按游戏切换（TOTK: 龙之泪=回忆位、树根=神兽位）
const gameLabels = computed(() => {
  const g = detectedGame.value || env.game
  return g === 'totk'
    ? { shrine: '神庙', tower: '鸟望台', korok: '呀哈哈', memory: '龙之泪', beast: '树根' }
    : { shrine: '神庙', tower: '塔', korok: '呀哈哈', memory: '回忆', beast: '神兽' }
})
const statusMapUrl = ref('') // core status.json 上报的地图地址（V2.2.0 Q1）
const mapUrl = computed(() => {
  if (statusMapUrl.value) return statusMapUrl.value
  const g = detectedGame.value || 'botw'
  return g === 'totk' ? 'https://totk.yalin.site/' : 'https://botw.yalin.site/'
})
const gameDisplayName = computed(() => {
  const g = detectedGame.value || env.game
  return { 'botw': '旷野之息 (BOTW)', 'totk': '王国之泪 (TOTK)', 'auto': '自动识别' }[g] || g
})
const playtimeText = computed(() => {
  const secs = progressData.value?.playtime || 0
  if (!secs) return '-'
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
  return `${h}h${String(m).padStart(2,'0')}m`
})
const saveBasename = computed(() => {
  const s = progressData.value?.save
  if (!s) return ''
  return s.split(/[\\/]/).slice(-2).join('\\')
})
const logs = ref([])
const logBox = ref(null)
function pushLogs(lines) {
  if (!lines || !lines.length) return
  const items = lines.map(l => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) ?(.*)$/)
    // core 已统一输出时间戳；解析不到时（如分隔线行）兜底用本机当前时间
    const time = m ? m[1].slice(11) : new Date().toTimeString().slice(0, 8)
    let text = m ? m[2] : l
    let level = 'info', color = 'text-slate-400', levelColor = 'text-sky-500'
    if (/ERROR|FAILED|panic/i.test(text)) { level = 'error'; color = 'text-red-400'; levelColor = 'text-red-500' }
    else if (/!!|占用/i.test(text)) { level = 'warn'; color = 'text-amber-400'; levelColor = 'text-amber-500' }
    else if (/confirmed live|confirmed\]/.test(text)) { level = 'ok'; color = 'text-emerald-400'; levelColor = 'text-emerald-500' }
    else if (/\[sm\]/i.test(text)) { level = 'info'; color = 'text-sky-400' }
    text = text.replace(/^\[sm\]\s*/, '')
    return { time, text, level, color, levelColor }
  })
  logs.value = logs.value.concat(items)
  if (logs.value.length > 2000) logs.value = logs.value.slice(logs.value.length - 2000)
  nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
  // 遍历所有新行找状态变化（不只是最后一行）
  if (!isInitLog) {
    for (const it of items) { parseState(it.text) }
  }
}
async function pickCemu() { const d = await api.PickDir("选择 Cemu 目录"); if (d) paths.cemu = d }
async function pickRyujinx() { const d = await api.PickDir("选择 Ryujinx 目录"); if (d) paths.ryujinx = d }
async function pickSave() { const d = await api.PickDir("选择存档目录"); if (d) paths.saveDir = d }
async function saveSettings() { await api.SaveConfig({ cemuDir: paths.cemu, ryujinxDir: paths.ryujinx, saveDir: paths.saveDir, emulator: env.emulator, game: env.game }); showSettings.value = false; const det = await api.EnvDetect(); envDetect.cemu = det.cemu; envDetect.ryujinx = det.ryujinx }
function clearLogs() { logs.value = [] }
function checkUpdate() {
  rt.EventsOn("update:latest", () => { alert("已经是最新版") });
  rt.EventsEmit("update:check");
}
// 协议 v1（2026-10-01）：导航发起打开地图 → URL 追加 follow=1&game=<识别的游戏>。
// game 优先级：core 识别结果 detectedGame → GUI 配置 env.game（auto 时兜底 botw）。
// core 侧 map_url 保持裸地址（不变式：参数一律由 GUI 拼，避免 core/GUI 版本耦合）。
function buildMapUrl() {
  let g = detectedGame.value
  if (!g || g === 'auto') g = (env.game && env.game !== 'auto') ? env.game : 'botw'
  const sep = mapUrl.value.includes('?') ? '&' : '?'
  return `${mapUrl.value}${sep}follow=1&game=${g}`
}
async function openMap() { rt.BrowserOpenURL(buildMapUrl()) }
async function openLogDir() { await api.OpenLogDir() }
async function exportDiag() { await api.ExportDiagnostics() }
function onFirstVerified() {
  if (mapAutoOpened.value) return
  mapAutoOpened.value = true
  rt.BrowserOpenURL(buildMapUrl())
}
function parseState(line) {
  const s = line
  // Q13：新 core 会话（platform selected）→ 重置地图自动打开标记，
  // 否则切换游戏后（TOTK 开过地图 → BOTW 锁定）不再自动打开新游戏地图
  if (/platform\]\s*selected/.test(s)) { mapAutoOpened.value = false }
  if (/fixed offset.*confirmed/.test(s)) {
    stateText.value = '已验证 · 跟随中'
    setStep(3, '已锁定'); scanPercent.value = 100
    onFirstVerified()
  }
  else if (/confirmed live/.test(s)) {
    stateText.value = '已验证 · 跟随中'; setStep(3, '已锁定'); scanPercent.value = 100
    onFirstVerified()
  }
  else if (/probe -> switched/.test(s)) { stateText.value = '已锁定 · 探针换活组'; setStep(2, '验证移动'); scanPercent.value = 80 }
  else if (/scan -> lock/.test(s)) { stateText.value = '已锁定 · 待移动确认'; setStep(2, '验证移动'); scanPercent.value = 70 }
  else if (/structural scan|trying fixed/.test(s)) {
    // Q14：后台重扫（锁定期间）也含 "structural scan" 字样——已锁定/跟随中不回退状态
    if (!/跟随中|已锁定/.test(stateText.value)) {
      stateText.value = '定位中...'; setStep(1, '扫描中'); scanPercent.value = 30
    }
  }
  else if (/UNLOCKED/.test(s)) { stateText.value = '未锁定'; setStep(0, '就绪'); scanPercent.value = 0; mapAutoOpened.value = false }
}
let offLogs
onMounted(async () => {
  logs.value = []
  stateText.value = '就绪'
  scanPercent.value = 0
  profileText.value = '本地自动档案'
  profileNote.value = '等待定位...'
  steps.value.forEach(s => s.state = (s.name === '就绪' ? 'done' : 'idle'))
  ver.value = await api.Version()
  const cfg = await api.LoadConfig()
  if (cfg.cemuDir) paths.cemu = cfg.cemuDir
  if (cfg.ryujinxDir) paths.ryujinx = cfg.ryujinxDir
  if (cfg.saveDir) paths.saveDir = cfg.saveDir
  if (cfg.emulator) env.emulator = cfg.emulator
  if (cfg.game) env.game = cfg.game
  const det = await api.EnvDetect()
  envDetect.cemu = det.cemu
  envDetect.ryujinx = det.ryujinx
  const initial = await api.TailLog()
  pushLogs(initial)
  isInitLog = false
  offLogs = rt.EventsOn('log:append', pushLogs)
  rt.EventsOn('update:available', (info) => { updateInfo.value = info })
  rt.EventsOn('status:update', (st) => {
    coreRunning.value = st.running
    if (st.progress && st.progress.counts) {
      progressData.value = st.progress
    }
    if (st.emuVer) emuVer.value = st.emuVer
    if (st.game) detectedGame.value = st.game
    if (st.mode) locMode.value = st.mode
    if (st.map_url) statusMapUrl.value = st.map_url
    if (st.running && st.ok) {
      syncText.value = '坐标流同步中'
      syncDot.value = 'bg-emerald-400'
    } else if (st.running) {
      syncText.value = (st.pid && st.pid > 0) ? `已附加 pid=${st.pid}，定位中...` : '等待模拟器进程...'
      syncDot.value = 'bg-amber-400 animate-pulse'
    } else {
      syncText.value = '等待坐标流'
      syncDot.value = 'bg-slate-600'
    }
  })
})
onUnmounted(() => { if (offLogs) offLogs() })
// Q13：识别游戏变化（如 totk→botw）→ 重置地图自动打开标记
watch(detectedGame, () => { mapAutoOpened.value = false })
</script>
