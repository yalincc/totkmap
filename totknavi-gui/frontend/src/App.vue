<template>
  <div class="flex h-screen w-full bg-[#0d1117] text-slate-200 select-none overflow-hidden font-sans">
    <main class="flex-1 flex flex-col min-h-0 overflow-hidden">
      <LocateView />
    </main>

    <!-- 更新弹窗 -->
    <div v-if="updateInfo" class="fixed inset-0 bg-black/60 flex items-center justify-center z-50" @click.self="updateInfo = null">
      <div class="bg-[#161b22] border border-emerald-500/50 rounded-lg p-5 w-96">
        <div class="text-sm font-bold text-emerald-400 mb-2">{{ t('update.available') }}</div>
        <div class="text-xs text-slate-300">{{ t('update.current') }}：{{ ver }} → {{ t('update.latest') }}：{{ updateInfo.latest }}</div>
        <div class="flex justify-end gap-2 mt-4">
          <button class="bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded text-xs" @click="updateInfo = null">{{ t('buttons.later') }}</button>
          <button class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 rounded text-xs text-white" @click="rt.BrowserOpenURL(updateInfo.url); updateInfo = null">{{ t('buttons.download') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import LocateView from './views/LocateView.vue'
import {
  ver, updateInfo, initCore, rt
} from './composables/useCore'

const { t } = useI18n()

onMounted(initCore)
</script>
