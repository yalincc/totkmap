<template>
  <section class="bg-[#0d1117] border border-slate-800 rounded-md flex flex-col text-[11px] min-h-0 flex-1">
    <div class="px-2.5 py-1.5 border-b border-slate-800/80 shrink-0">
      <span class="text-white font-sans text-[11px] font-semibold uppercase tracking-wider">{{ t('log.title') }}</span>
    </div>
    <div ref="logBox" class="flex-1 overflow-y-auto px-2.5 py-1.5 space-y-0.5 leading-relaxed text-slate-400 min-h-0 select-text font-mono">
      <div v-for="(log, idx) in filteredLogs" :key="idx" :class="log.color">
        <span class="text-slate-600">[{{ log.time }}]</span>
        <span class="mr-1.5 font-mono text-[10px]" :class="log.levelColor">[{{ log.level }}]</span>{{ log.text }}
      </div>
      <div v-if="!filteredLogs.length" class="text-slate-600 py-4 text-center">{{ t('log.none') }}</div>
    </div>
    <div v-if="showUpload" class="flex items-center gap-2 px-2.5 py-1.5 border-t border-slate-800/80 bg-[#161b22] shrink-0 text-[11px] font-sans">
      <input v-model="uploadNote" :placeholder="t('buttons.notePlaceholder')" class="flex-1 bg-[#0d1117] border border-slate-700 rounded px-2 py-0.5 text-[11px] text-white focus:border-blue-500 focus:outline-none placeholder-slate-500" @keyup.enter="doUpload" />
      <span v-if="uploadMsg" class="text-[11px] text-amber-400 shrink-0">{{ uploadMsg }}</span>
      <button :disabled="uploading" class="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2.5 py-0.5 rounded" @click="doUpload">{{ t('buttons.send') }}</button>
      <button class="text-slate-400 hover:text-white px-1" @click="showUpload = false">{{ t('buttons.cancel') }}</button>
    </div>
    <div class="flex items-center justify-end gap-3 px-2.5 py-1.5 border-t border-slate-800/80 shrink-0 text-[11px] font-sans">
      <input v-model="filter" :placeholder="t('log.filter')" class="w-28 bg-[#161b22] border border-slate-800 rounded px-2 py-0.5 text-[11px] text-white focus:border-blue-500 focus:outline-none placeholder-slate-600" />
      <span class="text-slate-400">{{ shown }} / {{ total }}</span>
      <button class="text-white hover:text-slate-300" @click="clearLogs">{{ t('buttons.clear') }}</button>
      <button class="text-sky-400 hover:text-sky-300" @click="showUpload = !showUpload; uploadMsg = ''">{{ t('buttons.uploadDiag') }}</button>
      <button class="text-white hover:text-slate-300" @click="exportDiag">{{ t('buttons.exportDiag') }}</button>
      <button class="text-white hover:text-slate-300" @click="openLogDir">{{ t('buttons.openDir') }}</button>
    </div>
  </section>
</template>

<script setup>
import { ref, watch, nextTick, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { logs, filteredLogs, logFilter, clearLogs, exportDiag, uploadDiag, openLogDir } from '../composables/useCore'

const { t } = useI18n()

const showUpload = ref(false)
const uploadNote = ref('')
const uploadMsg = ref('')
const uploading = ref(false)
async function doUpload() {
  if (uploading.value) return
  uploading.value = true
  uploadMsg.value = '...'
  try {
    uploadMsg.value = await uploadDiag(uploadNote.value)
    if (uploadMsg.value.includes('感谢')) uploadNote.value = ''
  } finally {
    uploading.value = false
  }
}

const filter = computed({
  get: () => logFilter.value,
  set: v => { logFilter.value = v }
})
const total = computed(() => logs.value.length)
const shown = computed(() => filteredLogs.value.length)

const logBox = ref(null)
let prevLen = 0
watch(() => logs.value.length, (n) => {
  if (n > prevLen) {
    prevLen = n
    nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
  }
})
</script>
