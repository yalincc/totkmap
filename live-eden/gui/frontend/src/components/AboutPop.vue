<template>
  <div class="bg-[#161b22] border border-slate-700 rounded-xl p-4 shadow-2xl text-xs space-y-2 w-[380px]" style="--wails-draggable:no-drag;">
    <div class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">关于</div>
    <div class="text-slate-300">TOTKNavi · 王国之泪 (TOTK) 定位导航程序</div>
    <div class="text-slate-400 font-mono">版本：{{ ver }}</div>
    <div class="text-slate-400">地图：<button class="text-blue-400 hover:underline" @click="openExternal(mapUrl)">{{ mapUrl.replace('https://','').replace(/\/$/,'') }}</button></div>
    <div class="text-slate-400">GitHub：<button class="text-blue-400 hover:underline" @click="openExternal('https://github.com/yalincc/totkmap')">yalincc/totkmap</button></div>
    <div class="text-slate-500">只读内存，不注入，不修改游戏。</div>
    <div class="flex gap-2 pt-1">
      <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="doCheckUpdate">检查更新</button>
      <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="exportDiag">导出诊断包</button>
    </div>
  </div>
</template>

<script setup>
import { ver, mapUrl, openExternal, exportDiag, checkForUpdates } from '../composables/useCore'

async function doCheckUpdate() {
  const r = await checkForUpdates()
  if (r.status === 'available') return
  // 已是最新：临时提示
  const btn = document.createElement('div')
  btn.textContent = '已是最新版本'
  btn.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#161b22;border:1px solid #22c55e;color:#4ade80;padding:8px 14px;border-radius:8px;font-size:12px;z-index:999;font-family:ui-monospace,monospace;'
  document.body.appendChild(btn)
  setTimeout(() => btn.remove(), 2500)
}
</script>
