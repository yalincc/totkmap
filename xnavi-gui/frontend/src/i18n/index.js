// i18n 实例 + 语言检测/持久化（GUI 中英双语）
// 默认跟随系统语言（navigator.language，zh* → 中文，其余 → 英文）；
// 用户在设置里可强制中文 / English，选择存 localStorage（键 totknavi.lang）。
// 值 '' = 跟随系统（不落盘，每次启动重新探测）。
import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import enUS from './en-US'

export const LOCALES = { SYSTEM: '', ZH: 'zh-CN', EN: 'en-US' }
const STORAGE_KEY = 'totknavi.lang'

function detectSystem() {
  const nav = (navigator.language || 'en').toLowerCase()
  return nav.startsWith('zh') ? LOCALES.ZH : LOCALES.EN
}

// 初始语言：用户持久化选择 > 系统探测
function initialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === LOCALES.ZH || saved === LOCALES.EN) return saved
  } catch { /* 隐私模式等场景下 localStorage 不可用，走系统探测 */ }
  return detectSystem()
}

export const i18n = createI18n({
  legacy: false,        // Composition API 模式（Vue3 + script setup）
  globalInjection: true, // 模板里可直接用 $t()
  locale: initialLocale(),
  fallbackLocale: LOCALES.EN, // 翻译缺 key 时回落英文（两包 key 完全一致，正常不会触发）
  messages: { 'zh-CN': zhCN, 'en-US': enUS },
  missingWarn: false,
  fallbackWarn: false,
})

// 当前生效选择（'' = 跟随系统）：供语言下拉回显
export function currentLocale() {
  try { return localStorage.getItem(STORAGE_KEY) || LOCALES.SYSTEM } catch { return LOCALES.SYSTEM }
}

// 当前是否英文界面：Go 端双语消息（errorEn）与 gomsg 映射的选择依据
export function isEnglish() {
  return i18n.global.locale.value === LOCALES.EN
}

// 切换语言：'' = 跟随系统（清除持久化）；其余持久化
export function setLocale(v) {
  const next = v === LOCALES.SYSTEM ? detectSystem() : v
  i18n.global.locale.value = next
  try {
    if (v === LOCALES.SYSTEM) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, v)
  } catch { /* 忽略持久化失败，本次会话仍生效 */ }
}
