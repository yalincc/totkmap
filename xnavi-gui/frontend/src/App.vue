<template>
  <div class="flex h-screen w-full bg-[#0d1117] text-slate-200 select-none overflow-hidden font-sans">
    <SideNav :active="view" @change="view = $event" />
    <div class="flex-1 flex flex-col min-w-0">
      <header class="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-slate-800 shrink-0">
        <div class="flex items-center space-x-2 text-sm font-semibold tracking-wide">
          <span class="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm shadow-blue-500/50"></span>
          <span class="text-white">TOTKNavi 定位导航</span>
          <span class="text-xs text-slate-400 font-mono">{{ ver }}</span>
        </div>
        <div class="flex items-center space-x-4 text-xs">
          <div class="flex items-center space-x-1.5 font-mono" :class="syncClass">
            <span class="w-2 h-2 rounded-full inline-block" :class="syncDot"></span>
            <span>{{ syncText }}</span>
          </div>
          <button class="text-slate-400 hover:text-white transition" @click="openMap">🌐 地图</button>
          <button class="text-slate-400 hover:text-white transition" @click="openLogDir">📁 目录</button>
        </div>
      </header>
      <main class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <LocateView v-if="view === 'locate'" />
        <NavView v-else-if="view === 'nav'" />
        <ProgressView v-else-if="view === 'progress'" />
        <SettingsView v-else />
      </main>
    </div>

    <!-- 更新弹窗 -->
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
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import SideNav from './components/SideNav.vue'
import LocateView from './views/LocateView.vue'
import NavView from './views/NavView.vue'
import ProgressView from './views/ProgressView.vue'
import SettingsView from './views/SettingsView.vue'
import {
  ver, syncText, syncDot, syncClass, updateInfo, initCore, openMap, openLogDir, rt
} from './composables/useCore'

const view = ref('locate')
onMounted(initCore)
</script>
