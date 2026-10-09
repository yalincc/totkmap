// useCore.js — TOTKNavi GUI 共享状态 + 全部 Wails 调用（V1.1.0 重构）
// 单一数据源：status.json（core 400ms 写，eventBridge 300ms 推）+
// xnavi-gui-core.log（增量读）。前端所有视图组件只从这里取状态/调方法。
import { ref, reactive, computed, watch } from 'vue'

const api = window.go.main.App
const rt = window.runtime

export { api, rt }

// ---- 版本 / 运行 ----
export const ver = ref('v1.2.0')
export const coreRunning = ref(false)
export const isLocating = ref(false)
export const updateInfo = ref(null)

// ---- 头部状态灯 ----
export const syncText = ref('等待坐标流')
export const syncDot = ref('bg-slate-600')
// 状态文字颜色：未激活灰，激活（core 运行）琥珀黄
export const syncClass = computed(() => coreRunning.value ? 'text-amber-400' : 'text-slate-500')

// ---- 定位状态（结构化，来自 status.json）----
export const pos = reactive({
  ok: false, gx: 0, gy: 0, gz: 0, mx: 0, my: 0,
  layer: 18, verified: false, source: '-', copies: 0,
  lockAddr: '', ageSec: 0, pid: 0
})

// ---- 导航目标（core status.json 补 target 字段后可用；未升级时保持 null）----
export const target = ref(null)

// ---- 存档进度（/progress 现算，core 全量 20 类）----
export const progressData = ref({})

// ---- 配置 / 环境 ----
export const cfg = reactive({ saveDirRyujinx: '', saveDirEden: '', emu: 'auto', tls: false })
export const envDetect = reactive({ save: false, saveRyu: false, saveEden: false })
export const statusMapUrl = ref('')

// ---- 日志 ----
export const logs = ref([])
export const logFilter = ref('')

// ---- 层与来源展示 ----
export const LAYER_NAME = { 18: '地上', 19: '地下', 20: '天空' }
export const layerName = computed(() => LAYER_NAME[pos.layer] || String(pos.layer))
export const sourceLabel = computed(() => {
  const s = pos.source
  if (!s || s === '-') return '-'
  if (s === 'known') return '⚡ 秒锁'
  if (s === 'scan') return '扫描'
  if (s === 'probe') return '探针换组'
  if (s === 'consensus') return '共识恢复'
  if (s === 'locating') return '定位中'
  return s
})
export const locked = computed(() => pos.ok && pos.verified)
export const locating = computed(() => coreRunning.value && !pos.ok)

// ---- 状态文本（M2：结构化驱动，不再解析日志文本）----
export const stateText = computed(() => {
  if (!coreRunning.value) return '就绪'
  if (pos.pid === 0 && !pos.ok) return '等待模拟器进程...'
  if (!pos.ok) return '定位中...'
  if (!pos.verified) return pos.source === 'known' ? '⚡ 秒锁 · 待移动确认' : '已锁定 · 待移动确认'
  return '已验证 · 跟随中'
})
export const stateTextClass = computed(() => {
  const t = stateText.value
  if (t.includes('已验证')) return 'text-emerald-400 font-semibold'
  if (t.includes('秒锁') || t.includes('定位') || t.includes('等待')) return 'text-amber-400 font-semibold'
  return 'text-slate-300'
})

// ---- 步骤条（就绪→定位→验证→锁定）----
const stepDefs = ['就绪', '定位中', '验证移动', '已锁定']
export const steps = ref(stepDefs.map(name => ({ name, state: name === '就绪' ? 'done' : 'idle' })))
export function stepClass(s) { return { done: 'text-emerald-400', active: 'text-amber-400 font-semibold', idle: 'text-slate-600' }[s] }
export function stepDot(s) { return { done: 'bg-emerald-400', active: 'bg-amber-400 animate-pulse', idle: 'bg-slate-700' }[s] }
function setStepState() {
  const idx = !coreRunning.value ? 0 : (!pos.ok ? 1 : (!pos.verified ? 2 : 3))
  steps.value.forEach((s, i) => { s.state = i < idx ? 'done' : (i === idx ? 'active' : 'idle') })
}

// ---- 导航目标距离（target 地图坐标 vs pos.mx/my 地图坐标，与 live.js distToTarget 同算法）----
export const targetDist = computed(() => {
  const t = target.value
  if (!t || !pos.ok || pos.mx == null) return null
  return Math.sqrt((t.x - pos.mx) * (t.x - pos.mx) + (t.y - pos.my) * (t.y - pos.my))
})
export const targetCrossLayer = computed(() => {
  const t = target.value
  if (!t || t.layer == null || !pos.ok) return false
  return Number(t.layer) !== Number(pos.layer)
})

// ---- 地图 ----
export const mapUrl = computed(() => statusMapUrl.value || 'https://totk.yalin.site/')
export function buildMapUrl() {
  const sep = mapUrl.value.includes('?') ? '&' : '?'
  return `${mapUrl.value}${sep}follow=1&game=totk`
}
export function openMap() { rt.BrowserOpenURL(buildMapUrl()) }
// 在系统默认浏览器打开外部链接（wails runtime，避免 webview 内导航）
export function openExternal(url) { rt.BrowserOpenURL(url) }

// ---- 日志 ----
export const filteredLogs = computed(() => {
  const kw = logFilter.value.trim().toLowerCase()
  if (!kw) return logs.value
  return logs.value.filter(l => (l.text + ' ' + l.level).toLowerCase().includes(kw))
})
function pushLogs(lines) {
  if (!lines || !lines.length) return
  const items = lines.map(l => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) ?(.*)$/)
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
}
export function clearLogs() { logs.value = [] }

// ---- 操作 ----
export async function toggleLocating() {
  if (isLocating.value) { await api.StopCore(); isLocating.value = false }
  else { await api.StartCore(); isLocating.value = true }
}
export async function clearTarget() { await api.ClearTarget() }

// ---- 坐标校准（V1.4.0：GUI 提交游戏 HUD 坐标 → core 全内存精确匹配定位）----
export const coordsState = reactive({ busy: false, result: null })
export async function submitCoords(x, y, z) {
  // 校准是独立入口：core 未运行时自动拉起（校准需要 core 读内存做全内存扫描）。
  // core 启动后 coordsLoop 会自动处理 coords-req.json，无需用户先手动开始定位。
  if (!coreRunning.value) await api.StartCore()
  coordsState.busy = true
  coordsState.result = null
  const r = await api.SubmitCoords(Number(x), Number(y), Number(z))
  if (!r || !r.submitted) {
    coordsState.busy = false
    coordsState.result = { ok: false, error: (r && r.error) || '提交失败' }
    return
  }
  pollCoordsResult(Date.now() + 60000) // 60s 超时兜底（含 core 启动时间，全内存扫描约 10-15s）
}
function pollCoordsResult(deadline) {
  api.PollCoordsResult().then(r => {
    if (r && r.ready) {
      coordsState.busy = false
      coordsState.result = r
      return
    }
    if (Date.now() > deadline) {
      coordsState.busy = false
      coordsState.result = { ok: false, error: '校准超时：core 未响应（请确认已开始定位后重试）' }
      return
    }
    setTimeout(() => pollCoordsResult(deadline), 1000)
  })
}
export async function pickSave(which) {
  const d = await api.PickDir('选择存档目录（可选，默认自动探测）')
  if (d) {
    if (which === 'ryu') cfg.saveDirRyujinx = d
    else cfg.saveDirEden = d
  }
}
export async function saveSettings() {
  await api.SaveConfig({ saveDirRyujinx: cfg.saveDirRyujinx, saveDirEden: cfg.saveDirEden, emu: cfg.emu, tls: cfg.tls })
  const det = await api.EnvDetect()
  envDetect.save = !!det.save
  envDetect.saveRyu = !!det.saveRyu
  envDetect.saveEden = !!det.saveEden
}
export async function openLogDir() { await api.OpenLogDir() }
export async function exportDiag() { await api.ExportDiagnostics() }
export function checkUpdate() { rt.EventsEmit('update:check') }
// 手动检查更新：调用 Go 绑定拿明确结果（前端据此提示）
export async function checkForUpdates() {
  const r = await api.CheckForUpdates()
  if (r.status === 'available') updateInfo.value = { latest: r.latest, url: r.url }
  return r
}

// ---- 事件订阅 / 初始化 ----
let mapAutoOpened = false
function applyStatus(st) {
  coreRunning.value = !!st.running
  if (st.pos) {
    pos.gx = st.pos.gx || 0; pos.gy = st.pos.gy || 0; pos.gz = st.pos.gz || 0
    pos.mx = st.pos.mx || 0; pos.my = st.pos.my || 0
  }
  if (st.layer != null) pos.layer = st.layer
  pos.ok = !!st.ok
  pos.verified = !!st.verified
  if (st.source) pos.source = st.source
  pos.copies = st.copies || 0
  if (st.lockAddr) pos.lockAddr = st.lockAddr
  pos.ageSec = st.ageSec || 0
  pos.pid = st.pid || 0
  if (st.target !== undefined) target.value = st.target
  if (st.progress && st.progress.counts) progressData.value = st.progress
  if (st.map_url) statusMapUrl.value = st.map_url
  // core 未运行：不展示残留坐标/锁定态（status.json 残留上次会话数据）
  if (!st.running) {
    pos.ok = false
    pos.verified = false
    pos.pid = 0
  }
  setStepState()
  updateSync()
}
// 锁定后才自动打开地图网页：仅本次会话用户点击「开始定位」(isLocating) 后、
// 且 verified 从 false→true 真实锁定才打开（延迟 1.5s）。避免启动时读到残留 status.json 误开。
watch(locked, (val, old) => {
  if (val && !old && isLocating.value && !mapAutoOpened) {
    mapAutoOpened = true
    setTimeout(() => rt.BrowserOpenURL(buildMapUrl()), 1500)
  }
})
function updateSync() {
  if (coreRunning.value && pos.ok) {
    syncText.value = '坐标流同步中'
    syncDot.value = 'bg-emerald-400'
  } else if (coreRunning.value) {
    syncText.value = pos.pid > 0 ? `已附加 pid=${pos.pid}，定位中...` : '等待模拟器进程...'
    syncDot.value = 'bg-amber-400 animate-pulse'
  } else {
    syncText.value = '等待坐标流'
    syncDot.value = 'bg-slate-600'
  }
}

export async function initCore() {
  mapAutoOpened = false // 每次启动重置，仅本次会话真实锁定后才自动开地图
  logs.value = []
  steps.value.forEach(s => { s.state = s.name === '就绪' ? 'done' : 'idle' })
  ver.value = await api.Version()
  const c = await api.LoadConfig()
  if (c.saveDirRyujinx) cfg.saveDirRyujinx = c.saveDirRyujinx
  if (c.saveDirEden) cfg.saveDirEden = c.saveDirEden
  if (c.emu) cfg.emu = c.emu
  cfg.tls = !!c.tls
  const det = await api.EnvDetect()
  envDetect.save = !!det.save
  envDetect.saveRyu = !!det.saveRyu
  envDetect.saveEden = !!det.saveEden
  const initial = await api.TailLog()
  pushLogs(initial)
  rt.EventsOn('log:append', pushLogs)
  rt.EventsOn('status:update', applyStatus)
  rt.EventsOn('update:available', info => { updateInfo.value = info })
  rt.EventsOn('update:latest', () => { /* 最新版静默 */ })
}
