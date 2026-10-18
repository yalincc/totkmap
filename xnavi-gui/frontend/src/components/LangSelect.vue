<template>
  <div class="flex items-center gap-2">
    <span class="text-slate-400">{{ t('settings.language') }}</span>
    <select v-model="lang" @change="onChange"
      class="bg-[#0d1117] border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:border-blue-500 focus:outline-none">
      <option value="">{{ t('settings.langSystem') }}</option>
      <option value="zh-CN">{{ t('settings.langZh') }}</option>
      <option value="en-US">{{ t('settings.langEn') }}</option>
    </select>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { currentLocale, setLocale, LOCALES } from '../i18n'

const { t } = useI18n()
const lang = ref(currentLocale())

function onChange() {
  // 写 localStorage 并即时切换（'' = 跟随系统，重新探测）
  setLocale(lang.value === LOCALES.SYSTEM || lang.value === '' ? LOCALES.SYSTEM : lang.value)
}
</script>
