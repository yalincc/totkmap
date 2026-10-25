// useCore.js — TOTKNavi GUI 共享状态 + 全部 Wails 调用（V1.1.0 重构）
// 单一数据源：status.json（core 400ms 写，eventBridge 300ms 推）+
// xnavi-gui-core.log（增量读）。前端所有视图组件只从这里取状态/调方法。
import { ref, reactive, computed, watch } from 'vue'
import { i18n, isEnglish } from '../i18n'

// 非组件上下文（composable）里的翻译入口：与模板 $t 同一实例，随语言切换实时生效
const t = (...args) => i18n.global.t(...args)

const api = window.go.main.App
const rt = window.runtime

export { api, rt }

// ---- 版本 / 运行 ----
// 初值留空：真实版本由 initCore() 调 api.Version()（= app.go guiVersion）异步填入。
// 不要在这里硬编码版本号——那是 xnavi/version.go CoreVersion 的唯一职责，
// 两处各写一份必然漂移（历史遗留：此处曾写死 v1.2.0）。
export const ver = ref('')
export const coreRunning = ref(false)
export const isLocating = ref(false)
export const updateInfo = ref(null)

// ---- 头部状态灯 ----
// syncText/syncDot 由 computed 驱动（含语言切换实时刷新，不再靠 updateSync 赋值）
export const syncText = computed(() => {
  if (coreRunning.value && pos.ok) return t('sync.syncing')
  if (coreRunning.value) {
    return pos.pid > 0 ? t('sync.attached', { pid: pos.pid }) : t('sync.waitingProcess')
  }
  return t('sync.waiting')
})
export const syncDot = computed(() => {
  if (coreRunning.value && pos.ok) return 'bg-emerald-400'
  if (coreRunning.value) return 'bg-amber-400 animate-pulse'
  return 'bg-slate-600'
})
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
export const cfg = reactive({ saveDirRyujinx: '', saveDirEden: '', emu: 'auto', tls: false, autoOpenMap: true })
export const envDetect = reactive({ save: false, saveRyu: false, saveEden: false })
export const statusMapUrl = ref('')

// ---- 手机镜像（v2.1.2 A-fix：core status.json 补 lanUrl/appReady 后可用）----
export const lanUrl = ref('')
export const appReady = reactive({ ok: false, root: '', reason: '' })
export const appReadyText = computed(() => {
  if (!lanUrl.value) return t('mirror.noUrl')
  if (appReady.ok) return t('mirror.ready')
  if (appReady.reason === 'no_index') return t('mirror.noIndex')
  if (appReady.reason === 'not_found') return t('mirror.notFound')
  return t('mirror.unknown')
})

// ---- 日志 ----
export const logs = ref([])
export const logFilter = ref('')

// ---- 层与来源展示 ----
const LAYER_KEYS = ['18', '19', '20']
export const layerName = computed(() => {
  const k = String(pos.layer)
  return LAYER_KEYS.includes(k) ? t(`layer.${k}`) : k
})
const SOURCE_KEYS = ['known', 'chain', 'scan', 'probe', 'consensus', 'locating']
export const sourceLabel = computed(() => {
  const s = pos.source
  if (!s || s === '-') return '-'
  return SOURCE_KEYS.includes(s) ? t(`source.${s}`) : s
})
export const locked = computed(() => pos.ok && pos.verified)
export const locating = computed(() => coreRunning.value && !pos.ok)

// ---- 状态文本（M2：结构化驱动，不再解析日志文本）----
export const stateText = computed(() => {
  if (!coreRunning.value) return t('state.ready')
  if (pos.pid === 0 && !pos.ok) return t('state.waitingProcess')
  if (!pos.ok) return t('state.locating')
  if (!pos.verified) {
    return pos.source === 'known' ? t('state.knownUnconfirmed') : t('state.lockedUnconfirmed')
  }
  return t('state.verified')
})
// 颜色按结构化状态判断（不能 includes 中文——英文界面会全掉成灰色）
export const stateTextClass = computed(() => {
  if (!coreRunning.value) return 'text-slate-300'
  if (!pos.ok) return 'text-amber-400 font-semibold'
  if (pos.verified) return 'text-emerald-400 font-semibold'
  // 未确认：秒锁琥珀 / 普通锁定灰（与原中文匹配行为一致）
  return pos.source === 'known' ? 'text-amber-400 font-semibold' : 'text-slate-300'
})

// ---- 步骤条（就绪→定位→验证→锁定）----
// name 存 i18n key，模板里 t(`steps.${s.key}`) 实时取当前语言文案
const STEP_KEYS = ['ready', 'locating', 'verifying', 'locked']
export const steps = ref(STEP_KEYS.map(key => ({ key, state: key === 'ready' ? 'done' : 'idle' })))
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

// ---- 存档时间戳与相对时间 ----
export const saveMtime = ref(0)
export const nowSec = ref(Math.floor(Date.now() / 1000))
setInterval(() => {
  nowSec.value = Math.floor(Date.now() / 1000)
}, 1000)

export const saveTimeAgoText = computed(() => {
  if (!saveMtime.value || saveMtime.value <= 0) return ''
  const diff = Math.max(0, nowSec.value - saveMtime.value)
  if (diff < 60) return t('locate.justNow')
  const mins = Math.floor(diff / 60)
  if (mins < 60) return t('locate.minsAgo', { m: mins })
  const hours = Math.floor(mins / 60)
  return t('locate.hoursAgo', { h: hours })
})

export const saveTimeAgoClass = computed(() => {
  if (!saveMtime.value || saveMtime.value <= 0) return 'text-slate-400'
  const diff = Math.max(0, nowSec.value - saveMtime.value)
  if (diff < 120) return 'text-emerald-400 font-semibold'
  if (diff < 3600) return 'text-slate-300'
  return 'text-amber-400'
})

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

    // 提取行首的 [tag] 真实标签
    const tagMatch = text.match(/^\s*\[([a-zA-Z0-9_\-]+)\]\s*(.*)$/)
    let rawTag = ''
    if (tagMatch) {
      rawTag = tagMatch[1].toLowerCase()
      text = tagMatch[2]
    }

    let level = rawTag ? rawTag.toUpperCase() : 'INFO'
    let color = 'text-slate-400'
    let levelColor = 'text-slate-400'

    if (rawTag === 'lock' || /confirmed live|confirmed!|fully locked/i.test(text)) {
      level = 'LOCK'
      color = 'text-emerald-300'
      levelColor = 'text-emerald-400 font-semibold'
    } else if (rawTag === 'shrine') {
      level = 'SHRINE'
      color = 'text-teal-300'
      levelColor = 'text-teal-400 font-semibold'
    } else if (rawTag === 'warp') {
      level = 'WARP'
      color = 'text-cyan-300'
      levelColor = 'text-cyan-400 font-semibold'
    } else if (rawTag === 'scan') {
      level = 'SCAN'
      color = 'text-sky-300'
      levelColor = 'text-sky-400'
    } else if (rawTag === 'verify') {
      level = 'VERIFY'
      color = 'text-amber-300'
      levelColor = 'text-amber-400 font-semibold'
    } else if (rawTag === 'hold') {
      level = 'HOLD'
      color = 'text-slate-300'
      levelColor = 'text-blue-400'
    } else if (rawTag === 'pipeline') {
      level = 'PIPELINE'
      color = 'text-slate-300'
      levelColor = 'text-purple-400'
    } else if (rawTag === 'platform') {
      level = 'PLATFORM'
      color = 'text-slate-300'
      levelColor = 'text-indigo-400'
    } else if (rawTag === 'progress') {
      level = 'PROGRESS'
      color = 'text-slate-300'
      levelColor = 'text-emerald-500'
    } else if (rawTag === 'coords') {
      level = 'COORDS'
      color = 'text-teal-300'
      levelColor = 'text-teal-400'
    } else if (rawTag === 'mount') {
      level = 'MOUNT'
      color = 'text-amber-300'
      levelColor = 'text-amber-400'
    } else if (rawTag === 'lost' || /ERROR|FAILED|panic/i.test(text)) {
      level = rawTag ? rawTag.toUpperCase() : 'ERROR'
      color = 'text-rose-400'
      levelColor = 'text-rose-400 font-bold'
    } else if (/!!|占用/i.test(text)) {
      level = rawTag ? rawTag.toUpperCase() : 'WARN'
      color = 'text-amber-400'
      levelColor = 'text-amber-400 font-semibold'
    } else if (rawTag === 'sm') {
      level = 'SM'
      color = 'text-slate-400'
      levelColor = 'text-slate-500'
    }

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
    // submitFailed 标记：前端按当前语言取「提交失败」文案（不在此烘死语言）
    coordsState.result = { ok: false, error: (r && r.error) || '', submitFailed: true }
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
      coordsState.result = { ok: false, timeout: true }
      return
    }
    setTimeout(() => pollCoordsResult(deadline), 1000)
  })
}
export async function pickSave(which) {
  const d = await api.PickDir(t('go.pickDirTitle'))
  if (d) {
    if (which === 'ryu') cfg.saveDirRyujinx = d
    else cfg.saveDirEden = d
  }
}
// 校准失败展示文本（实时日志用）：按当前语言取 Go 双语错误（errorEn 优先），
// 前端兜底文案（提交失败/超时/未命中）走 i18n——切换语言后重试即生效
export function coordsErrorText(r) {
  if (r && r.timeout) return t('cal.timeout')
  if (r && r.error) return isEnglish() ? (r.errorEn || r.error) : r.error
  if (r && r.submitFailed) return t('cal.submitFailed')
  return t('cal.missDefault')
}
export async function saveSettings() {
  await api.SaveConfig({ saveDirRyujinx: cfg.saveDirRyujinx, saveDirEden: cfg.saveDirEden, emu: cfg.emu, tls: cfg.tls, autoOpenMap: cfg.autoOpenMap !== false })
  await detectSave()
}
export async function pickSaveFile() {
  const f = await api.PickSaveFile()
  if (f) {
    await api.ApplySavePath(f)
    await detectSave()
  }
}

export async function pickSaveDir() {
  const d = await api.PickDir("选择存档所在目录")
  if (d) {
    await api.ApplySavePath(d)
    await detectSave()
  }
}

export async function doOpenSave() {
  return await api.OpenSaveDir()
}

export async function resetSaveDetection() {
  const msg = await api.ResetSaveDetection()
  await detectSave()
  return msg
}

export async function detectSave() {
  const det = await api.EnvDetect()
  envDetect.save = !!det.save
  envDetect.saveRyu = !!det.saveRyu
  envDetect.saveEden = !!det.saveEden
  return det
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
  if (st.saveMtime) {
    saveMtime.value = st.saveMtime
  } else if (st.progress && st.progress.mtime) {
    saveMtime.value = st.progress.mtime
  }
  if (st.progress && st.progress.counts) progressData.value = st.progress
  if (st.save) {
    if (!progressData.value) progressData.value = {}
    progressData.value.save = st.save
  } else if (st.progress && st.progress.save) {
    if (!progressData.value) progressData.value = {}
    progressData.value.save = st.progress.save
  }
  if (st.map_url) statusMapUrl.value = st.map_url
  if (st.lanUrl) lanUrl.value = st.lanUrl
  if (st.appReady) {
    appReady.ok = !!st.appReady.ok
    appReady.root = st.appReady.root || ''
    appReady.reason = st.appReady.reason || ''
  }
  // core 未运行：不展示残留坐标/锁定态（status.json 残留上次会话数据）
  if (!st.running) {
    pos.ok = false
    pos.verified = false
    pos.pid = 0
    lanUrl.value = ''
    appReady.ok = false
    appReady.reason = ''
    saveMtime.value = 0
  }
  setStepState()
}
// 锁定后才自动打开地图网页：仅本次会话用户点击「开始定位」(isLocating) 后、
// 且 verified 从 false→true 真实锁定才打开（延迟 1.5s）。避免启动时读到残留 status.json 误开。
watch(locked, (val, old) => {
  if (val && !old && isLocating.value && !mapAutoOpened && (cfg.autoOpenMap !== false)) {
    mapAutoOpened = true
    setTimeout(() => rt.BrowserOpenURL(buildMapUrl()), 1500)
  }
})
export async function initCore() {
  mapAutoOpened = false // 每次启动重置，仅本次会话真实锁定后才自动开地图
  logs.value = []
  steps.value.forEach(s => { s.state = s.key === 'ready' ? 'done' : 'idle' })
  ver.value = await api.Version()
  const c = await api.LoadConfig()
  if (c.saveDirRyujinx) cfg.saveDirRyujinx = c.saveDirRyujinx
  if (c.saveDirEden) cfg.saveDirEden = c.saveDirEden
  if (c.emu) cfg.emu = c.emu
  cfg.tls = !!c.tls
  if (c.autoOpenMap !== undefined) cfg.autoOpenMap = !!c.autoOpenMap
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
