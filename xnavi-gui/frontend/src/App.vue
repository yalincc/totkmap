<template>
  <div class="flex h-screen w-full bg-[#0d1117] text-slate-200 select-none overflow-hidden font-sans">
    <main class="flex-1 flex flex-col min-h-0 overflow-hidden">
      <LocateView />
    </main>

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
import { onMounted } from 'vue'
import LocateView from './views/LocateView.vue'
import {
  ver, updateInfo, initCore, rt
} from './composables/useCore'

onMounted(initCore)
</script>
