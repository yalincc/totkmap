<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-2 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{{ t('about.title') }}</div>
    <div class="text-slate-300">{{ t('about.subtitle') }}</div>
    <div class="text-slate-400 font-mono">{{ t('about.version') }}：{{ ver }}</div>
    <div class="text-slate-400">{{ t('about.map') }}：<button class="text-blue-400 hover:underline" @click="openExternal(mapUrl)">{{ mapUrl.replace('https://','').replace(/\/$/,'') }}</button></div>
    <div class="text-slate-400">{{ t('about.github') }}：<button class="text-blue-400 hover:underline" @click="openExternal('https://github.com/yalincc/totkmap')">yalincc/totkmap</button></div>
    <div class="text-slate-500">{{ t('about.readOnly') }}</div>
    <div class="flex gap-2 pt-1">
      <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="doCheckUpdate">{{ t('buttons.checkUpdate') }}</button>
      <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="exportDiag">{{ t('buttons.exportDiag') }}</button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { ver, mapUrl, openExternal, exportDiag, checkForUpdates } from '../composables/useCore'
import { goMsg } from '../i18n/gomsg'

const { t } = useI18n()

async function doCheckUpdate() {
  const r = await checkForUpdates()
  if (r.status === 'available') return // 有新版本：更新弹窗已由 updateInfo 打开
  // 已是最新 / 检查失败：右下角临时提示（绿 / 红）
  const ok = r.status !== 'error'
  const msg = ok ? t('about.latest') : t('about.checkFailed', { msg: goMsg(r.msg) })
  const btn = document.createElement('div')
  btn.textContent = msg
  btn.style.cssText = `position:fixed;bottom:20px;right:20px;background:#161b22;border:1px solid ${ok ? '#22c55e' : '#ef4444'};color:${ok ? '#4ade80' : '#f87171'};padding:8px 14px;border-radius:8px;font-size:12px;z-index:999;font-family:ui-monospace,monospace;`
  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 2500)
}
</script>
